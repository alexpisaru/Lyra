"""Browser automation tools — Playwright-based web interaction."""

from __future__ import annotations

from typing import Any

from openjarvis.core.registry import ToolRegistry
from openjarvis.core.types import ToolResult
from openjarvis.tools._stubs import BaseTool, ToolSpec, _BoundedToolRunner

MAX_REDIRECTS = 5

# WebRTC (STUN/TURN) opens UDP/TCP sockets that request interception never sees;
# a page could reach LAN hosts with it. The Chromium flag stops non-proxied UDP,
# the init script removes the constructors (also in iframes and popups).
_CHROMIUM_ARGS = ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"]
_NO_WEBRTC = """(() => {
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel',
      'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCIceCandidate',
      'RTCSessionDescription']) {
    try {
      Object.defineProperty(globalThis, name,
        {value: undefined, writable: false, configurable: false});
    } catch (e) {}
  }
})();"""


def _url_error(url):
    """Return why *url* may not be requested, or None for a public HTTP(S) URL."""
    from urllib.parse import urlsplit
    from openjarvis.security.ssrf import check_ssrf

    try:
        if urlsplit(url).scheme not in ("http", "https"):
            return "Only public HTTP(S) requests are allowed"
        return check_ssrf(url)
    except ValueError as exc:
        return str(exc)


class _BrowserSession:
    """One lazy, isolated context; all Playwright calls use the same worker."""

    def __init__(self, config=None) -> None:
        from openjarvis.core.config import BrowserConfig

        self.config = config or BrowserConfig()
        self.config.validate()
        self.runner = _BoundedToolRunner(1, 8)
        self._playwright = self._browser = self._context = self._page = None
        self.active_backend = None
        self.fallback_reason = None
        self._failed = False
        self._blocked = None
        self._redirect = None
        self._probing = False
        self._probe_seen = False

    def _ensure_browser(self) -> None:
        if self._page is not None:
            return
        if self._failed:
            raise RuntimeError("Browser initialization failed; close and rebuild the system")
        try:
            from playwright.sync_api import sync_playwright
        except ImportError:
            raise ImportError("Install the optional browser extra: pip install '.[browser]'")
        self._playwright = sync_playwright().start()
        try:
            try:
                self._connect(self.config.backend)
            except Exception as exc:
                self._dispose_browser()
                if self.config.backend != "obscura" or self.config.fallback != "chromium":
                    raise
                import warnings

                self.fallback_reason = str(exc)
                warnings.warn(
                    "Obscura unavailable; using explicitly configured Chromium fallback",
                    RuntimeWarning,
                    stacklevel=2,
                )
                self._connect("chromium")
        except Exception:
            self._failed = True
            self._close()
            raise

    def _connect(self, backend):
        if backend == "obscura":
            self._browser = self._playwright.chromium.connect_over_cdp(
                self.config.cdp_url, timeout=5000
            )
        else:
            self._browser = self._playwright.chromium.launch(
                headless=True, timeout=10000, args=_CHROMIUM_ARGS
            )
        # Never reuse the CDP server's default context or any personal profile.
        self._context = self._browser.new_context(service_workers="block", accept_downloads=False)
        self._context.add_init_script(_NO_WEBRTC)
        self._context.set_default_timeout(10000)
        self._context.set_default_navigation_timeout(15000)
        self._context.route("**/*", self._guard)
        self._context.route_web_socket("**/*", lambda ws: ws.close())
        self._page = self._context.new_page()
        self._context.on("page", lambda page: page.close() if page != self._page else None)
        # Prove Fetch interception is implemented, not merely accepted as a CDP no-op.
        self._probing = True
        self._probe_seen = False
        try:
            self._page.goto("https://jarvis-interception.invalid/", timeout=5000)
            if not self._probe_seen or self._page.inner_text("body") != "jarvis-route-ok":
                raise RuntimeError("Browser does not implement required request interception")
        finally:
            self._probing = False
        self._page.goto("about:blank")
        self.active_backend = backend

    def _guard(self, route):
        from urllib.parse import urljoin

        url = route.request.url
        if self._probing and url == "https://jarvis-interception.invalid/":
            self._probe_seen = True
            route.fulfill(status=200, content_type="text/html", body="jarvis-route-ok")
            return
        response = None
        try:
            error = _url_error(url)
            if error:
                raise ValueError(error)
            response = route.fetch(max_redirects=0, timeout=10000)
            if 300 <= response.status < 400 and "location" in response.headers:
                # Never hand a 3xx to the browser: Chromium follows it without
                # calling this route again, so later hops would skip the guard.
                target = urljoin(url, response.headers["location"])
                error = _url_error(target)
                if error:
                    raise ValueError(f"HTTP redirect to blocked destination: {error}")
                if self._is_main_navigation(route.request):
                    # browser_navigate re-opens it as a new, guarded navigation.
                    self._redirect = target
                raise ValueError(f"HTTP redirect to {target} not followed")
            route.fulfill(response=response)
        except Exception as exc:
            self._blocked = str(exc)
            try:
                if not self._is_main_navigation(route.request):
                    raise LookupError
                # An aborted main-frame navigation makes Chromium commit an error
                # page later, interrupting the next goto. Serve a local notice
                # instead; nothing is requested from the blocked destination.
                route.fulfill(
                    status=403, content_type="text/plain", body=f"Blocked by Jarvis: {exc}"
                )
            except Exception:
                route.abort()
        finally:
            if response is not None:
                response.dispose()

    def _is_main_navigation(self, request):
        page = self._page
        return (
            page is not None
            and request.is_navigation_request()
            and request.frame == page.main_frame
        )

    @property
    def page(self):
        self._ensure_browser()
        self._blocked = self._redirect = None
        return self._page

    def check_requests(self):
        if self._blocked:
            raise RuntimeError(f"Browser request blocked: {self._blocked}")

    def navigate(self, url, wait_until):
        """Open *url*, following at most MAX_REDIRECTS validated main-frame hops.

        Every hop is a fresh navigation through ``_guard``; a hop to a private or
        non-HTTP(S) destination is blocked before any request is sent to it.
        """
        page = self.page
        hops = []
        for _ in range(MAX_REDIRECTS + 1):
            self._blocked = self._redirect = None
            try:
                response = page.goto(url, wait_until=wait_until)
            except Exception:
                if self._redirect is None:
                    raise
            if self._redirect is None:
                self.check_requests()
                return response, hops
            url = self._redirect
            hops.append(url)
        raise RuntimeError(f"More than {MAX_REDIRECTS} HTTP redirects")

    def close(self) -> None:
        try:
            future = self.runner.submit(self._close)
            if future is not None:
                future.result(timeout=35)
        finally:
            self.runner.shutdown()

    def _dispose_browser(self):
        try:
            if self._context is not None:
                self._context.close()
        finally:
            self._context = self._page = None
            try:
                if self._browser is not None:
                    self._browser.close()
            finally:
                self._browser = None
                self.active_backend = None

    def _close(self) -> None:
        try:
            self._dispose_browser()
        finally:
            if self._playwright is not None:
                self._playwright.stop()
            self._playwright = None


_session = _BrowserSession()


# ---------------------------------------------------------------------------
# Tool 1: BrowserNavigateTool
# ---------------------------------------------------------------------------


@ToolRegistry.register("browser_navigate")
class BrowserNavigateTool(BaseTool):
    """Navigate to a URL in the browser."""

    tool_id = "browser_navigate"
    is_local = False

    def __init__(self, session=None):
        self._session = session if session is not None else _session
        self.execution_runner = self._session.runner

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="browser_navigate",
            description=(
                "Navigate to a URL in the browser. Returns the page title and text content."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "pattern": "^https?://",
                        "description": "Complete public HTTP(S) URL to open.",
                    },
                    "wait_for": {
                        "type": "string",
                        "enum": ["load", "domcontentloaded", "networkidle"],
                        "description": (
                            "Wait condition: 'load', 'domcontentloaded',"
                            " or 'networkidle'. Default: 'load'."
                        ),
                    },
                },
                "required": ["url"],
            },
            category="browser",
            required_capabilities=["network:fetch"],
        )

    def execute(self, **params: Any) -> ToolResult:
        url = params.get("url", "")
        if not url:
            return ToolResult(
                tool_name="browser_navigate",
                content="No URL provided.",
                success=False,
            )

        wait_for = params.get("wait_for", "load")
        if wait_for not in ("load", "domcontentloaded", "networkidle"):
            wait_for = "load"

        # SSRF check before the browser starts — never skipped; the route guard
        # repeats it for every request and redirect hop.
        ssrf_error = _url_error(url)
        if ssrf_error:
            return ToolResult(
                tool_name="browser_navigate",
                content=f"SSRF blocked: {ssrf_error}",
                success=False,
            )

        try:
            response, redirects = self._session.navigate(url, wait_for)
            page = self._session._page
            title = page.title()
            text_content = page.inner_text("body")
            if len(text_content) > 5000:
                text_content = text_content[:5000] + "\n\n[Content truncated]"

            status = response.status if response else None
            return ToolResult(
                tool_name="browser_navigate",
                content=f"Title: {title}\n\n{text_content}",
                success=True,
                metadata={
                    "url": page.url,
                    "title": title,
                    "status": status,
                    "redirects": redirects,
                    "backend": self._session.active_backend,
                    "fallback_reason": self._session.fallback_reason,
                },
            )
        except ImportError:
            return ToolResult(
                tool_name="browser_navigate",
                content=(
                    "Install the optional browser extra: pip install '.[browser]' (see docs/BROWSER.md)"
                ),
                success=False,
            )
        except Exception as exc:
            return ToolResult(
                tool_name="browser_navigate",
                content=f"Navigation error: {self._session._blocked or exc}",
                success=False,
            )


# ---------------------------------------------------------------------------
# Tool 2: BrowserClickTool
# ---------------------------------------------------------------------------


@ToolRegistry.register("browser_click")
class BrowserClickTool(BaseTool):
    """Click an element on the page."""

    tool_id = "browser_click"
    is_local = False

    def __init__(self, session=None):
        self._session = session if session is not None else _session
        self.execution_runner = self._session.runner

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="browser_click",
            description=(
                "Click an element on the current page. Pass the text you see"
                " on the element (button label, link title), a CSS selector,"
                " or a short description like 'first video result'."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": (
                            "Visible text of the element, a CSS selector, or"
                            " a short description (e.g. 'first video result')."
                        ),
                    },
                    "by_text": {
                        "type": "boolean",
                        "description": (
                            "If true, click by text content"
                            " instead of CSS selector. Default: false."
                        ),
                    },
                },
                "required": ["selector"],
            },
            requires_confirmation=True,
            category="browser",
        )

    _ORDINALS = {"first": 0, "second": 1, "third": 2, "fourth": 3, "last": -1}

    # Filler words stripped from natural-language descriptions before
    # keyword matching ("the first video result" -> "video"). Derive the
    # ordinal entries from the supported mapping so adding one cannot leave it
    # behind as a literal role-name keyword.
    _DESC_STOPWORDS = frozenset(
        "the a an top main big red blue green"
        " result results item element link button option entry row".split()
    ) | frozenset(_ORDINALS)

    def execute(self, **params: Any) -> ToolResult:
        # Models routinely name this param `target`, `text`, `element` or
        # `query` instead of `selector`; rejecting those costs the whole
        # workflow, so accept the common aliases.
        selector = str(
            params.get("selector")
            or params.get("target")
            or params.get("text")
            or params.get("element")
            or params.get("query")
            or ""
        ).strip()
        if not selector:
            return ToolResult(
                tool_name="browser_click",
                content=(
                    "No selector provided. Pass the visible text of the element or a CSS selector."
                ),
                success=False,
            )

        by_text = params.get("by_text", False)

        try:
            page = self._session.page
            strategy = self._resolve_and_click(page, selector, by_text)
            if self._session._blocked:
                return ToolResult(
                    tool_name="browser_click",
                    content=(
                        f"Clicked element: {selector}, but a resulting request was blocked: "
                        f"{self._session._blocked}. The click happened; do not repeat it."
                    ),
                    success=False,
                    metadata={"selector": selector, "clicked": True},
                )
            return ToolResult(
                tool_name="browser_click",
                content=f"Clicked element: {selector}",
                success=True,
                metadata={
                    "selector": selector,
                    "by_text": by_text,
                    "strategy": strategy,
                },
            )
        except ImportError:
            return ToolResult(
                tool_name="browser_click",
                content=(
                    "Install the optional browser extra: pip install '.[browser]' (see docs/BROWSER.md)"
                ),
                success=False,
            )
        except Exception as exc:
            return ToolResult(
                tool_name="browser_click",
                content=f"Click error: {exc}",
                success=False,
            )

    def _resolve_and_click(self, page: Any, selector: str, by_text: bool) -> str:
        """Resolve *selector* through a strategy ladder and click it.

        LLMs pass anything from precise CSS to plain descriptions like
        "first video result". Strategies from most to least precise: CSS,
        exact text, fuzzy text, YouTube results video title, role-based
        keyword match. Existence is checked with ``count()`` (instant, no
        actionability wait) so bad strategies cost milliseconds; only a
        strategy that actually matched gets a real click timeout. Searches
        the main frame first, then child iframes (consent dialogs and ad
        overlays live there). Returns the name of the winning strategy;
        raises with a list of visible clickable elements when nothing
        matched, so the model can retry sensibly.
        """
        import re

        words = [w for w in re.split(r"\W+", selector.lower()) if w]
        ordinal = next((self._ORDINALS[w] for w in words if w in self._ORDINALS), None)

        def candidates(frame: Any) -> list:
            cands = []
            if not by_text:
                cands.append(("css", frame.locator(selector)))
            cands.append(("text-exact", frame.get_by_text(selector, exact=True)))
            cands.append(("text-fuzzy", frame.get_by_text(re.compile(re.escape(selector), re.I))))
            # YouTube search results: "first video result" must click a
            # video title, not the "Videos" filter chip — so this outranks
            # the generic role-based keyword match below.
            try:
                url = frame.url or ""
            except Exception:
                url = ""
            if "youtube." in url and ("video" in words or "result" in words):
                cands.append(("youtube-result", frame.locator("a#video-title")))
            keywords = [w for w in words if w not in self._DESC_STOPWORDS]
            if keywords:
                pat = re.compile(".*".join(re.escape(k) for k in keywords), re.I)
                for role in ("link", "button"):
                    cands.append((f"role-{role}", frame.get_by_role(role, name=pat)))
            return cands

        def actionable_matches(locator: Any) -> list[Any]:
            """Return click-ordered matches, excluding hidden or disabled ones."""
            count = locator.count()
            matches = []
            # A locator can match hidden mobile/desktop duplicates before the
            # visible control.  Build the actionable sequence first so an
            # ordinal such as "first" means the first element a user can
            # actually click, not the first raw DOM match.
            for index in range(count):
                match = locator.nth(index)
                try:
                    if not match.is_visible() or not match.is_enabled():
                        continue
                except Exception:
                    # The click remains the final Playwright actionability
                    # check, including stability and event-receivability.
                    pass
                matches.append(match)

            if ordinal is not None:
                index = len(matches) - 1 if ordinal == -1 else ordinal
                return [matches[index]] if 0 <= index < len(matches) else []
            return matches

        last_error: Exception | None = None
        for index, frame in enumerate(page.frames):
            for strategy, locator in candidates(frame):
                try:
                    matches = actionable_matches(locator)
                    if not matches:
                        continue
                except Exception:
                    continue  # e.g. selector isn't valid CSS — next rung
                for match in matches:
                    try:
                        match.click(timeout=8000 if index == 0 else 4000)
                        return strategy
                    except Exception as exc:
                        last_error = exc
                        continue

        hint = ""
        try:
            texts = page.evaluate(
                """(limit) => Array.from(
                    document.querySelectorAll('a, button, [role=button], [role=link]')
                ).map(e => (e.innerText || e.getAttribute('aria-label') || '').trim())
                 .filter(t => t && t.length < 80)
                 .filter((t, i, arr) => arr.indexOf(t) === i)
                 .slice(0, limit)""",
                15,
            )
            if texts:
                hint = " Visible clickable elements: " + "; ".join(texts)
        except Exception:
            pass
        detail = f" Last error: {last_error}" if last_error else ""
        raise RuntimeError(
            f"No element matched '{selector}' in the main page or its"
            f" {len(page.frames) - 1} iframe(s).{hint}{detail}"
        )


# ---------------------------------------------------------------------------
# Tool 3: BrowserTypeTool
# ---------------------------------------------------------------------------


@ToolRegistry.register("browser_type")
class BrowserTypeTool(BaseTool):
    """Type text into a form field."""

    tool_id = "browser_type"
    is_local = False

    def __init__(self, session=None):
        self._session = session if session is not None else _session
        self.execution_runner = self._session.runner

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="browser_type",
            description=(
                "Type text into a form field on the current page."
                " Can clear the field first or append to existing content."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": "CSS selector of the input field.",
                    },
                    "text": {
                        "type": "string",
                        "description": "Text to type into the field.",
                    },
                    "clear": {
                        "type": "boolean",
                        "description": ("If true, clear the field before typing. Default: true."),
                    },
                },
                "required": ["selector", "text"],
            },
            requires_confirmation=True,
            category="browser",
        )

    def execute(self, **params: Any) -> ToolResult:
        selector = params.get("selector", "")
        text = params.get("text", "")

        if not selector:
            return ToolResult(
                tool_name="browser_type",
                content="No selector provided.",
                success=False,
            )
        if not text:
            return ToolResult(
                tool_name="browser_type",
                content="No text provided.",
                success=False,
            )

        clear = params.get("clear", True)

        try:
            page = self._session.page
            if clear:
                page.fill(selector, text)
            else:
                page.type(selector, text)
            if self._session._blocked:
                return ToolResult(
                    tool_name="browser_type",
                    content=(
                        f"Typed text into: {selector}, but a resulting request was blocked: "
                        f"{self._session._blocked}. The text was entered; do not repeat it."
                    ),
                    success=False,
                    metadata={"selector": selector, "typed": True},
                )

            return ToolResult(
                tool_name="browser_type",
                content=f"Typed text into: {selector}",
                success=True,
                metadata={"selector": selector},
            )
        except ImportError:
            return ToolResult(
                tool_name="browser_type",
                content=(
                    "Install the optional browser extra: pip install '.[browser]' (see docs/BROWSER.md)"
                ),
                success=False,
            )
        except Exception as exc:
            return ToolResult(
                tool_name="browser_type",
                content=f"Type error: {exc}",
                success=False,
            )


# ---------------------------------------------------------------------------
# Tool 4: BrowserExtractTool
# ---------------------------------------------------------------------------


@ToolRegistry.register("browser_extract")
class BrowserExtractTool(BaseTool):
    """Extract content from the current page."""

    tool_id = "browser_extract"
    is_local = False

    def __init__(self, session=None):
        self._session = session if session is not None else _session
        self.execution_runner = self._session.runner

    @property
    def spec(self) -> ToolSpec:
        return ToolSpec(
            name="browser_extract",
            description=(
                "Extract content from the current browser page."
                " Supports extracting text, links, or tables."
            ),
            parameters={
                "type": "object",
                "properties": {
                    "selector": {
                        "type": "string",
                        "description": ("CSS selector to extract from. Default: 'body'."),
                    },
                    "extract_type": {
                        "type": "string",
                        "enum": ["text", "links", "tables"],
                        "description": (
                            "Type of extraction: 'text', 'links', or 'tables'. Default: 'text'."
                        ),
                    },
                },
            },
            category="browser",
        )

    def execute(self, **params: Any) -> ToolResult:
        selector = params.get("selector", "body")
        extract_type = params.get("extract_type", "text")

        if extract_type not in ("text", "links", "tables"):
            return ToolResult(
                tool_name="browser_extract",
                content=(
                    f"Invalid extract_type: '{extract_type}'. Must be 'text', 'links', or 'tables'."
                ),
                success=False,
            )

        try:
            page = self._session.page

            if extract_type == "text":
                content = page.inner_text(selector)
                if len(content) > 10000:
                    content = content[:10000] + "\n\n[Content truncated]"
                return ToolResult(
                    tool_name="browser_extract",
                    content=content,
                    success=True,
                    metadata={"selector": selector, "extract_type": extract_type},
                )

            elif extract_type == "links":
                links = page.eval_on_selector_all(
                    f"{selector} a[href]",
                    """elements => elements.map(el => ({
                        href: el.href,
                        text: el.innerText.trim()
                    }))""",
                )
                lines = []
                for link in links:
                    text = link.get("text", "")
                    href = link.get("href", "")
                    lines.append(f"- [{text}]({href})")
                content = "\n".join(lines) if lines else "No links found."
                if len(content) > 10000:
                    content = content[:10000] + "\n\n[Content truncated]"
                return ToolResult(
                    tool_name="browser_extract",
                    content=content,
                    success=True,
                    metadata={
                        "selector": selector,
                        "extract_type": extract_type,
                        "num_links": len(links),
                    },
                )

            else:  # tables
                tables_text = page.eval_on_selector_all(
                    f"{selector} table",
                    """elements => elements.map(el => el.innerText)""",
                )
                if tables_text:
                    content = "\n\n---\n\n".join(tables_text)
                else:
                    content = "No tables found."
                if len(content) > 10000:
                    content = content[:10000] + "\n\n[Content truncated]"
                return ToolResult(
                    tool_name="browser_extract",
                    content=content,
                    success=True,
                    metadata={
                        "selector": selector,
                        "extract_type": extract_type,
                        "num_tables": len(tables_text),
                    },
                )

        except ImportError:
            return ToolResult(
                tool_name="browser_extract",
                content=(
                    "Install the optional browser extra: pip install '.[browser]' (see docs/BROWSER.md)"
                ),
                success=False,
            )
        except Exception as exc:
            return ToolResult(
                tool_name="browser_extract",
                content=f"Extract error: {exc}",
                success=False,
            )


__all__ = [
    "BrowserNavigateTool",
    "BrowserClickTool",
    "BrowserTypeTool",
    "BrowserExtractTool",
]
