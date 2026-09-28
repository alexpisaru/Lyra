"""Opt-in real browser contract; never starts/installs a browser or contacts Ollama."""

import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from openjarvis.core.config import BrowserConfig
from openjarvis.tools.browser import (
    _BrowserSession,
    BrowserNavigateTool,
    BrowserClickTool,
    BrowserTypeTool,
    BrowserExtractTool,
)

BACKEND = os.environ.get("JARVIS_BROWSER_SMOKE")
pytestmark = pytest.mark.skipif(
    BACKEND not in ("obscura", "chromium"),
    reason="set JARVIS_BROWSER_SMOKE for the real browser smoke",
)


def test_real_browser_contract(monkeypatch):
    session = _BrowserSession(
        BrowserConfig(
            backend=BACKEND, cdp_url=os.environ.get("JARVIS_CDP_URL", "ws://127.0.0.1:9222")
        )
    )

    def exercise():
        nav = BrowserNavigateTool(session)
        result = nav.execute(url="https://example.com")
        assert result.success, result.content
        assert "Example Domain" in result.content
        assert session.active_backend == BACKEND and session.fallback_reason is None
        # A deterministic page, fulfilled through real browser request interception.
        fixture_url = "https://example.com/jarvis-smoke"
        session._context.route(
            fixture_url,
            lambda route: route.fulfill(
                status=200,
                content_type="text/html",
                body="""<!doctype html><html><body>
            <label>Name <input id="name"></label>
            <button id="save" onclick="document.querySelector('#result').textContent =
              document.querySelector('#name').value">Save</button><div id="result"></div>
            </body></html>""",
            ),
        )
        result = nav.execute(url=fixture_url)
        assert result.success, result.content
        result = BrowserTypeTool(session).execute(selector="#name", text="ORCHIDEA-742")
        assert result.success, result.content
        result = BrowserClickTool(session).execute(selector="#save")
        assert result.success, result.content
        result = BrowserExtractTool(session).execute(selector="#result")
        assert result.success and "ORCHIDEA-742" in result.content, result.content
        assert not nav.execute(url="http://192.168.1.252:11434").success
        # WebRTC bypasses request interception; page JS must not reach a loopback
        # TCP port through TURN, from the page or from a fresh iframe.
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        listener.settimeout(3)
        try:
            webrtc = session._page.evaluate(
                """async (port) => {
                  const f = document.createElement('iframe');
                  document.body.appendChild(f);
                  const out = [];
                  for (const W of [window, f.contentWindow]) {
                    const PC = W.RTCPeerConnection || W.webkitRTCPeerConnection;
                    if (!PC) { out.push('absent'); continue; }
                    const pc = new PC({iceServers: [{urls: 'turn:127.0.0.1:' + port +
                      '?transport=tcp', username: 'u', credential: 'p'}]});
                    pc.createDataChannel('x');
                    await pc.setLocalDescription(await pc.createOffer());
                    out.push('created');
                  }
                  return out;
                }""",
                listener.getsockname()[1],
            )
            assert webrtc == ["absent", "absent"], webrtc
            with pytest.raises(socket.timeout):
                listener.accept()
        finally:
            listener.close()
        # Controlled redirect server on loopback. The test treats ONLY the listed
        # fixture paths as "public"; every other loopback URL keeps the real
        # SSRF verdict. Server hits prove what actually reached the network.
        from openjarvis.security import ssrf

        original_check = ssrf.check_ssrf
        hits = []
        redirects = {
            "/redirect": "/private",  # 302 to a still-forbidden loopback path
            "/hop1": "/hop2",  # relative Location, allowed chain
            "/hop2": "/final",
            "/sub": "/private",  # page whose subresource redirects privately
        }

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                body = b""
                if self.path in redirects and self.path != "/sub":
                    self.send_response(302)
                    base = f"http://127.0.0.1:{self.server.server_port}"
                    self.send_header("Location", base + redirects[self.path])
                else:
                    self.send_response(200)
                    self.send_header("Content-Type", "text/html")
                    if self.path == "/final":
                        body = b"<body>jarvis-final-page</body>"
                    elif self.path == "/sub":
                        body = b'<body>sub<img src="/redirect"></body>'
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        allowed = {base + p for p in ("/redirect", "/hop1", "/hop2", "/final", "/sub")}
        monkeypatch.setattr(
            ssrf, "check_ssrf", lambda url: None if url in allowed else original_check(url)
        )
        try:
            result = nav.execute(url=base + "/redirect")
            assert not result.success
            assert "blocked destination" in result.content, result.content
            assert hits == ["/redirect"], hits

            hits.clear()
            result = nav.execute(url=base + "/hop1")
            assert result.success, result.content
            assert "jarvis-final-page" in result.content
            assert result.metadata["redirects"] == [base + "/hop2", base + "/final"]
            assert hits == ["/hop1", "/hop2", "/final"], hits

            hits.clear()
            result = nav.execute(url=base + "/sub")
            # The page loads; only its subresource redirecting to a private path is
            # aborted, and that path is never requested.
            assert result.success, result.content
            assert result.metadata["blocked_subresources"] >= 1
            assert "/private" not in hits, hits
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    try:
        future = session.runner.submit(exercise)
        assert future is not None
        future.result(timeout=90)
    finally:
        session.close()
