import sys
from types import ModuleType
from unittest.mock import MagicMock

import pytest

from openjarvis.core.config import BrowserConfig, JarvisConfig
from openjarvis.tools.browser import _BrowserSession, BrowserNavigateTool


@pytest.fixture
def playwright(monkeypatch):
    api = ModuleType("playwright.sync_api")
    runtime = MagicMock()
    api.sync_playwright = MagicMock()
    api.sync_playwright.return_value.start.return_value = runtime
    monkeypatch.setitem(sys.modules, "playwright.sync_api", api)
    for browser in (
        runtime.chromium.launch.return_value,
        runtime.chromium.connect_over_cdp.return_value,
    ):
        context = browser.new_context.return_value
        page = context.new_page.return_value
        page.inner_text.return_value = "jarvis-route-ok"

        def goto(url, *args, _context=context, **kwargs):
            if url == "https://jarvis-interception.invalid/":
                route = MagicMock()
                route.request.url = url
                _context.route.call_args.args[1](route)

        page.goto.side_effect = goto
    return runtime


@pytest.mark.parametrize("backend", ["obscura", "chromium"])
def test_backend_is_explicit_lazy_isolated_and_guarded(playwright, backend):
    session = _BrowserSession(BrowserConfig(backend=backend))
    assert not playwright.chromium.launch.called and not playwright.chromium.connect_over_cdp.called
    try:
        session._ensure_browser()
        assert session.active_backend == backend
        if backend == "obscura":
            playwright.chromium.connect_over_cdp.assert_called_once_with(
                "ws://127.0.0.1:9222", timeout=5000
            )
            assert not playwright.chromium.launch.called
        else:
            playwright.chromium.launch.assert_called_once_with(
                headless=True,
                timeout=10000,
                args=["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
            )
            assert not playwright.chromium.connect_over_cdp.called
        session._browser.new_context.assert_called_once_with(
            service_workers="block", accept_downloads=False
        )
        # WebRTC removal applies to both backends.
        assert "RTCPeerConnection" in session._context.add_init_script.call_args.args[0]
        assert session._context.route.called and session._context.route_web_socket.called
        context = session._context
        session._ensure_browser()
        assert context.new_page.call_count == 1
    finally:
        session.close()
    assert context.close.called and playwright.stop.called


def test_failure_has_no_silent_fallback(playwright):
    playwright.chromium.connect_over_cdp.side_effect = RuntimeError("CDP offline")
    session = _BrowserSession(BrowserConfig(backend="obscura"))
    try:
        with pytest.raises(RuntimeError, match="offline"):
            session._ensure_browser()
        with pytest.raises(RuntimeError, match="rebuild"):
            session._ensure_browser()
        assert not playwright.chromium.launch.called
        assert playwright.stop.called
    finally:
        session.close()


def test_explicit_fallback_warns_and_reports_backend(playwright):
    playwright.chromium.connect_over_cdp.side_effect = RuntimeError("CDP offline")
    session = _BrowserSession(BrowserConfig(backend="obscura", fallback="chromium"))
    try:
        with pytest.warns(RuntimeWarning, match="explicitly configured"):
            session._ensure_browser()
        assert session.active_backend == "chromium"
        assert session.fallback_reason == "CDP offline"
    finally:
        session.close()


def test_noop_interception_is_rejected(playwright):
    page = playwright.chromium.connect_over_cdp.return_value.new_context.return_value.new_page.return_value
    page.goto.side_effect = None
    session = _BrowserSession(BrowserConfig(backend="obscura"))
    try:
        with pytest.raises(RuntimeError, match="interception"):
            session._ensure_browser()
        assert not playwright.chromium.launch.called
    finally:
        session.close()


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1",
        "http://192.168.1.252:11434",
        "http://169.254.169.254/latest/meta-data",
        "http://[::1]",
        "file:///etc/passwd",
        "http://0x7f000001",
        "http://2130706433",
    ],
)
@pytest.mark.parametrize("backend", ["chromium", "obscura"])
def test_private_requests_block_before_network(url, backend):
    session = _BrowserSession(BrowserConfig(backend=backend))
    route = MagicMock()
    route.request.url = url
    try:
        session._guard(route)
        route.abort.assert_called_once()
        assert not route.fetch.called
        with pytest.raises(RuntimeError, match="blocked"):
            session.check_requests()
    finally:
        session.close()


def _redirect_route(session, location, *, main_frame):
    route = MagicMock()
    route.request.url = "https://example.com/redirect"
    route.request.is_navigation_request.return_value = main_frame
    session._page = MagicMock()
    route.request.frame = session._page.main_frame if main_frame else MagicMock()
    response = route.fetch.return_value
    response.status = 302
    response.headers = {"location": location}
    return route, response


def _assert_not_forwarded(route, *, main_frame):
    """The upstream 3xx never reaches the browser; only a local notice or an abort."""
    for call_ in route.fulfill.call_args_list:
        assert "response" not in call_.kwargs and call_.kwargs["status"] == 403
    if main_frame:
        route.fulfill.assert_called_once()
        assert not route.abort.called
    else:
        route.abort.assert_called_once()
        assert not route.fulfill.called


@pytest.mark.parametrize(
    "location",
    ["http://127.0.0.1:11434", "http://[::1]/", "file:///etc/passwd", "http://169.254.169.254/"],
)
@pytest.mark.parametrize("main_frame", [True, False])
def test_redirect_to_private_is_blocked_and_never_recorded(monkeypatch, location, main_frame):
    import openjarvis.security.ssrf as ssrf

    original = ssrf.check_ssrf
    monkeypatch.setattr(
        ssrf, "check_ssrf", lambda url: None if "example.com" in url else original(url)
    )
    session = _BrowserSession()
    route, response = _redirect_route(session, location, main_frame=main_frame)
    try:
        session._guard(route)
        route.fetch.assert_called_once_with(max_redirects=0, timeout=10000)
        _assert_not_forwarded(route, main_frame=main_frame)
        response.dispose.assert_called_once()
        assert "blocked destination" in session._blocked
        assert session._redirect is None
    finally:
        session._page = None
        session.close()


@pytest.mark.parametrize("main_frame", [True, False])
def test_public_redirect_is_aborted_and_only_main_frame_is_recorded(monkeypatch, main_frame):
    monkeypatch.setattr("openjarvis.security.ssrf.check_ssrf", lambda url: None)
    session = _BrowserSession()
    route, _ = _redirect_route(session, "/final", main_frame=main_frame)
    try:
        session._guard(route)
        _assert_not_forwarded(route, main_frame=main_frame)
        assert "redirect" in session._blocked
        assert session._redirect == ("https://example.com/final" if main_frame else None)
    finally:
        session._page = None
        session.close()


def test_navigate_follows_recorded_hops_as_new_guarded_navigations(playwright, monkeypatch):
    monkeypatch.setattr("openjarvis.security.ssrf.check_ssrf", lambda url: None)
    session = _BrowserSession(BrowserConfig(backend="chromium"))
    try:
        session._ensure_browser()
        chain = {"https://a.example/": "https://b.example/", "https://b.example/": None}
        visited = []

        def goto(url, **kwargs):
            visited.append(url)
            if chain[url]:
                session._redirect = chain[url]
                raise RuntimeError("net::ERR_FAILED")
            return MagicMock(status=200)

        session._page.goto.side_effect = goto
        session._page.inner_text.return_value = "final"
        result = BrowserNavigateTool(session).execute(url="https://a.example/")
        assert result.success, result.content
        assert visited == ["https://a.example/", "https://b.example/"]
        assert result.metadata["redirects"] == ["https://b.example/"]

        def endless(url, **kwargs):
            session._redirect = url + "x"
            raise RuntimeError("net::ERR_FAILED")

        session._page.goto.side_effect = endless
        result = BrowserNavigateTool(session).execute(url="https://loop.example/")
        assert not result.success and "More than 5 HTTP redirects" in result.content
    finally:
        session.close()


def test_navigate_private_url_does_not_initialize_browser():
    session = _BrowserSession(BrowserConfig(backend="obscura"))
    try:
        result = BrowserNavigateTool(session).execute(url="http://192.168.1.252:11434")
        assert not result.success and "SSRF" in result.content
        assert session._playwright is None
    finally:
        session.close()


@pytest.mark.parametrize(
    "kwargs",
    [
        {"backend": "unknown"},
        {"fallback": "auto"},
        {"cdp_url": "ws://192.168.1.252:9222"},
        {"cdp_url": "ws://localhost:9222"},
        {"cdp_url": "ws://127.0.0.1"},
        {"cdp_url": "ws://127.0.0.1:9222?token=secret"},
        {"backend": "chromium", "fallback": "chromium"},
    ],
)
def test_strict_backend_configuration(kwargs):
    cfg = JarvisConfig()
    cfg.browser = BrowserConfig(**kwargs)
    with pytest.raises(ValueError):
        cfg.validate()
