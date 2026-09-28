"""SSRF policy per request kind (false positive on www.amazon.it).

A tracker hostname sinkholed by the local DNS (unagi.amazon.it -> 0.0.0.0) used to
fail the whole browser_navigate. Policy now:
- main-frame navigation or validated redirect to a forbidden address: blocked, the
  tool call fails (unchanged);
- subresource or sub-frame (iframe) request to a forbidden address: only that
  request is aborted, before any network traffic; the page still loads.

Unit tests always run. The real-Chromium tests are opt-in like the browser smoke
(JARVIS_BROWSER_SMOKE=chromium) and use two local servers: a "public" site
(allowed by port in the test) and a private service that counts every hit.
"""

from __future__ import annotations

import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import MagicMock
from urllib.parse import urlsplit

import pytest

from openjarvis.core.config import BrowserConfig
from openjarvis.tools.browser import BrowserNavigateTool, _BrowserSession

# ---------------------------------------------------------------- unit level


def _route(session, url, *, navigation, main_frame):
    route = MagicMock()
    route.request.url = url
    route.request.is_navigation_request.return_value = navigation
    route.request.frame = session._page.main_frame if main_frame else MagicMock()
    return route


@pytest.fixture
def session():
    s = _BrowserSession()
    s._page = MagicMock()
    try:
        yield s
    finally:
        s._page = None
        s.close()


@pytest.mark.parametrize("resource", ["http://0.0.0.0/pixel.gif", "http://[::]/ping"])
def test_sinkholed_subresource_is_aborted_without_failing_the_page(session, resource):
    route = _route(session, resource, navigation=False, main_frame=True)
    session._guard(route)
    route.abort.assert_called_once()
    assert not route.fetch.called and not route.fulfill.called
    session.check_requests()  # the page is not failed
    assert "0.0.0.0" in session._blocked_subresources[0] or "::" in session._blocked_subresources[0]


def test_private_iframe_navigation_is_aborted_not_fetched(session):
    route = _route(session, "http://192.168.1.1/admin", navigation=True, main_frame=False)
    session._guard(route)
    route.abort.assert_called_once()
    assert not route.fetch.called  # nothing is ever sent to the LAN address
    session.check_requests()


def test_private_main_navigation_still_fails(session):
    route = _route(session, "http://0.0.0.0/", navigation=True, main_frame=True)
    session._guard(route)
    assert not route.fetch.called
    with pytest.raises(RuntimeError, match="0.0.0.0"):
        session.check_requests()


def test_navigate_succeeds_when_only_subresources_are_blocked(session):
    """browser_navigate end to end on the session: goto triggers guarded subrequests."""
    page = session._page

    def goto(url, **_):
        for sub in ("http://0.0.0.0/unagi", "http://127.0.0.1:11434/api/tags"):
            session._guard(_route(session, sub, navigation=False, main_frame=True))
        return MagicMock(status=200)

    page.goto.side_effect = goto
    session._ensure_browser = lambda: None
    page.title.return_value = "Amazon.it"
    page.inner_text.return_value = "shop"
    page.url = "https://www.amazon.it/"
    session.runner.submit = lambda fn, **kw: _Done(fn(**kw))
    result = BrowserNavigateTool(session).execute(url="https://example.com/")
    assert result.success, result.content
    assert result.metadata["blocked_subresources"] == 2


class _Done:
    def __init__(self, value):
        self._value = value

    def result(self, timeout=None):
        return self._value


def test_cleanup_is_quiet_after_a_block():
    """Closing drops the route guard first; late route callbacks cannot raise."""
    s = _BrowserSession()
    context = MagicMock()
    s._context, s._browser, s._page = context, MagicMock(), MagicMock()
    s.close()
    context.unroute_all.assert_called_once_with(behavior="ignoreErrors")
    assert context.method_calls.index(
        next(c for c in context.method_calls if c[0] == "unroute_all")
    ) < context.method_calls.index(next(c for c in context.method_calls if c[0] == "close"))

    # A route whose page is already gone: abort/dispose failures are swallowed.
    s2 = _BrowserSession()
    s2._page = MagicMock()
    route = _route(s2, "http://0.0.0.0/x", navigation=False, main_frame=True)
    route.abort.side_effect = RuntimeError("Target page, context or browser has been closed")
    s2._guard(route)  # does not raise
    s2._page = None
    s2.close()


# ---------------------------------------------------------------- real Chromium (opt-in)

REAL = os.environ.get("JARVIS_BROWSER_SMOKE") == "chromium"
real = pytest.mark.skipif(not REAL, reason="set JARVIS_BROWSER_SMOKE=chromium")


def _serve(handler_cls):
    server = ThreadingHTTPServer(("127.0.0.1", 0), handler_cls)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class _Private(BaseHTTPRequestHandler):
    hits: list[str] = []

    def do_GET(self):  # noqa: N802
        _Private.hits.append(self.path)
        self.send_response(200)
        self.send_header("Content-Type", "text/html")
        self.end_headers()
        self.wfile.write(b"<title>LAN secret</title>secret")

    def log_message(self, *args):
        pass


def _public_handler(private_url):
    class Public(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", private_url + "/after-redirect")
                self.end_headers()
                return
            body = f"""<!doctype html><title>Public page</title>
<h1>Hello</h1>
<img src="http://0.0.0.0/unagi.gif">
<img src="{private_url}/img">
<script src="{private_url}/script.js"></script>
<iframe src="{private_url}/iframe"></iframe>
<iframe id="late"></iframe>
<script>
  fetch("{private_url}/fetch").catch(() => {{}});
  navigator.sendBeacon && navigator.sendBeacon("http://0.0.0.0/beacon", "x");
  document.getElementById("late").src = "{private_url}/js-iframe";
</script>"""
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args):
            pass

    return Public


@pytest.fixture
def servers(monkeypatch):
    import openjarvis.security.ssrf as ssrf

    _Private.hits = []
    private = _serve(_Private)
    private_url = f"http://127.0.0.1:{private.server_address[1]}"
    public = _serve(_public_handler(private_url))
    public_port = public.server_address[1]
    original = ssrf.check_ssrf
    # Only the public test server counts as public; everything else keeps the real policy.
    monkeypatch.setattr(
        ssrf,
        "check_ssrf",
        lambda url: None if urlsplit(url).port == public_port else original(url),
    )
    try:
        yield f"http://127.0.0.1:{public_port}", private_url
    finally:
        public.shutdown()
        private.shutdown()


def _run(session, fn, **kwargs):
    return session.runner.submit(fn, **kwargs).result(90)


@real
def test_real_public_page_with_blocked_subresources_and_iframes(servers):
    public_url, _ = servers
    session = _BrowserSession(BrowserConfig(backend="chromium"))
    try:
        result = _run(session, BrowserNavigateTool(session).execute, url=public_url + "/")
        assert result.success, result.content
        assert result.metadata["title"] == "Public page"
        assert result.metadata["blocked_subresources"] >= 4
        assert "secret" not in result.content
        assert _Private.hits == []  # img, script, fetch, iframes: none reached it
    finally:
        session.close()


@real
def test_real_private_main_url_is_blocked(servers):
    _, private_url = servers
    session = _BrowserSession(BrowserConfig(backend="chromium"))
    try:
        result = _run(session, BrowserNavigateTool(session).execute, url=private_url + "/")
        assert not result.success and "SSRF" in result.content
        # Also through the session itself (no tool pre-check): the guard blocks it.
        with pytest.raises(RuntimeError, match="blocked"):
            _run(session, session.navigate, url=private_url + "/direct", wait_until="load")
        assert _Private.hits == []
    finally:
        session.close()


@real
def test_real_public_redirect_to_private_is_blocked(servers):
    public_url, _ = servers
    session = _BrowserSession(BrowserConfig(backend="chromium"))
    try:
        result = _run(session, BrowserNavigateTool(session).execute, url=public_url + "/redirect")
        assert not result.success and "blocked destination" in result.content
        assert _Private.hits == []
    finally:
        session.close()


@real
def test_real_close_after_block_is_quiet(servers, capfd):
    public_url, private_url = servers
    session = _BrowserSession(BrowserConfig(backend="chromium"))
    try:
        _run(session, BrowserNavigateTool(session).execute, url=public_url + "/")
        _run(session, BrowserNavigateTool(session).execute, url=public_url + "/redirect")
    finally:
        session.close()
    err = capfd.readouterr().err
    assert "TargetClosedError" not in err and "Traceback" not in err
