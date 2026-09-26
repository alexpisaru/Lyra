"""Opt-in real browser contract; never starts/installs a browser or contacts Ollama."""

import os
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
        # Controlled redirect source: allow ONLY this exact fixture URL in the test.
        # The redirected private URL remains forbidden; observe actual server hits.
        from openjarvis.security import ssrf

        original_check = ssrf.check_ssrf
        hits = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                hits.append(self.path)
                self.send_response(302 if self.path == "/redirect" else 200)
                if self.path == "/redirect":
                    self.send_header(
                        "Location", f"http://127.0.0.1:{self.server.server_port}/private"
                    )
                self.send_header("Content-Length", "0")
                self.end_headers()

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        fixture_source = f"http://127.0.0.1:{server.server_port}/redirect"
        monkeypatch.setattr(
            ssrf, "check_ssrf", lambda url: None if url == fixture_source else original_check(url)
        )
        try:
            result = nav.execute(url=fixture_source)
            assert not result.success
            assert session._blocked and "redirect" in session._blocked.lower(), result.content
            assert hits == ["/redirect"], hits
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
