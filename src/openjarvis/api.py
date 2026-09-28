"""Lyra API: a thin HTTP + WebSocket layer over one JarvisSystem.

Not a second runtime: every chat goes through ``JarvisSystem.ask`` (the same call
``lyra ask``/``lyra chat`` make). WebSocket events are forwarded from the
runtime's own EventBus (INFERENCE_*, TOOL_CALL_*), not polled.

Single user: at most one agentic request at a time; a concurrent one gets 409.
Requires the optional extra: pip install '.[api]'.
"""

from __future__ import annotations

import asyncio
import hmac
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from typing import Any, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, HTTPException, Query, Request, WebSocket
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from starlette.websockets import WebSocketDisconnect

from openjarvis.core.events import EventType
from openjarvis.core.types import Message, Role
from openjarvis.tools.packs import PACKS
from openjarvis.voice.routes import ID_HEADERS as VOICE_ID_HEADERS
from openjarvis.voice.routes import install_voice_routes

Pack = Literal["auto", "chat", "general", "files", "memory", "knowledge", "browser"]
MAX_MESSAGE_CHARS = 4000
_INCOMPLETE = (
    "missing_tool_use",
    "context_limit",
    "tool_call_limit",
    "tool_timeout",
    "invalid_tool_calls",
    "max_turns_exceeded",
    "truncated",
)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    message: str = Field(min_length=1, max_length=MAX_MESSAGE_CHARS)
    pack: Pack = "auto"


class _Hub:
    """Fan-out of runtime events to connected WebSocket clients.

    Bus callbacks run in the worker thread executing JarvisSystem.ask; they are
    handed to the event loop with call_soon_threadsafe. Slow clients drop events
    instead of blocking the runtime.
    """

    def __init__(self):
        self.loop: asyncio.AbstractEventLoop | None = None
        self.clients: set[asyncio.Queue] = set()
        self.state = "idle"

    def emit(self, event: dict):
        if event.get("type") == "state":
            if event["state"] == self.state:
                return  # e.g. API "thinking" followed by the runtime's INFERENCE_START
            self.state = event["state"]
        loop = self.loop
        if loop is None or loop.is_closed():
            return
        loop.call_soon_threadsafe(self._fan_out, event)

    def _fan_out(self, event):
        for queue in list(self.clients):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:
                pass

    # EventBus subscribers (worker thread).
    def on_inference_start(self, _event):
        self.emit({"type": "state", "state": "thinking"})

    def on_tool_start(self, event):
        self.emit({"type": "state", "state": "using_tool"})
        self.emit({"type": "tool_started", "tool": event.data.get("tool")})

    def on_tool_end(self, event):
        self.emit(
            {
                "type": "tool_finished",
                "tool": event.data.get("tool"),
                "success": bool(event.data.get("success")),
            }
        )
        self.emit({"type": "state", "state": "thinking"})


def _same_origin(origin: str, host: str | None) -> bool:
    parts = urlsplit(origin)
    return bool(host) and parts.netloc.lower() == host.lower()


def create_app(config, *, system=None, health_engine=None, voice=None) -> FastAPI:
    """Build the app. *system*/*health_engine*/*voice* are injectable for tests."""
    from openjarvis import __version__

    api = config.api
    hub = _Hub()
    busy = threading.Lock()
    history: list[Message] = []
    status_cache: dict[str, Any] = {"at": 0.0, "reachable": None}
    owned = system is None
    if voice is None and config.voice.enabled:
        from openjarvis.voice import VoiceService

        voice = VoiceService.from_config(config.voice)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        nonlocal system, health_engine
        hub.loop = asyncio.get_running_loop()
        if system is None:
            from openjarvis.system.builder import SystemBuilder

            system = await asyncio.to_thread(SystemBuilder(config).build)
        if health_engine is None:
            from openjarvis.engine.ollama import OllamaEngine

            health_engine = OllamaEngine(config.engine.host, timeout=5)
        subscriptions = [
            (EventType.INFERENCE_START, hub.on_inference_start),
            (EventType.TOOL_CALL_START, hub.on_tool_start),
            (EventType.TOOL_CALL_END, hub.on_tool_end),
        ]
        for event_type, callback in subscriptions:
            system.bus.subscribe(event_type, callback)
        app.state.system = system
        # Voice models load in the background: the API is usable while they warm up.
        warming = asyncio.create_task(asyncio.to_thread(voice.warm)) if voice else None
        try:
            yield
        finally:
            if warming is not None:
                await asyncio.gather(warming, return_exceptions=True)
            for event_type, callback in subscriptions:
                system.bus.unsubscribe(event_type, callback)
            health_engine.close()
            if owned:
                await asyncio.to_thread(system.close)

    app = FastAPI(
        title="Lyra API",
        version=__version__,
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    if api.allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(api.allowed_origins),
            allow_methods=["GET", "POST"],
            allow_headers=["Authorization", "Content-Type", *VOICE_ID_HEADERS],
            expose_headers=list(VOICE_ID_HEADERS),
        )

    def _token_ok(presented: str | None) -> bool:
        if not api.api_key:
            return True
        return presented is not None and hmac.compare_digest(
            presented.encode(), api.api_key.encode()
        )

    def _origin_ok(origin: str | None, host: str | None) -> bool:
        # Non-browser clients send no Origin. Browsers must be same-origin or allowlisted:
        # blocks cross-site requests and WebSocket hijacking from other web pages.
        return origin is None or origin in api.allowed_origins or _same_origin(origin, host)

    async def guard(request: Request):
        if not _origin_ok(request.headers.get("origin"), request.headers.get("host")):
            raise HTTPException(403, "Origin not allowed")
        header = request.headers.get("authorization", "")
        token = header[7:] if header[:7].lower() == "bearer " else None
        if not _token_ok(token):
            raise HTTPException(401, "Missing or invalid API key", {"WWW-Authenticate": "Bearer"})

    async def json_only(request: Request):
        # A non-JSON POST is a "simple" cross-site request without CORS preflight.
        ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise HTTPException(415, "Content-Type must be application/json")

    def _vault():
        vault = getattr(app.state.system, "knowledge_vault", None)
        if vault is None:
            raise HTTPException(404, "Knowledge vault is disabled")
        return vault

    def _reachable():
        now = time.monotonic()
        if (
            status_cache["reachable"] is None
            or now - status_cache["at"] >= api.status_cache_seconds
        ):
            try:
                reachable = health_engine.health() and (
                    config.intelligence.model in health_engine.list_models()
                )
            except Exception:
                reachable = False
            status_cache.update(at=now, reachable=bool(reachable))
        return status_cache["reachable"]

    @app.get("/api/status", dependencies=[Depends(guard)])
    async def status():
        reachable = await asyncio.to_thread(_reachable)
        return {
            "status": "ok",
            "name": "Lyra",
            "version": __version__,
            "state": hub.state,
            "busy": busy.locked(),
            "model": {
                "provider": "ollama",
                "model": config.intelligence.model,
                "reachable": reachable,
            },
            "memory": {"enabled": config.memory.enabled},
            "knowledge": {"enabled": config.knowledge.enabled},
            "browser": {
                "enabled": config.tools.browser,
                "backend": config.browser.backend if config.tools.browser else None,
            },
            "packs": ["auto", *PACKS],
            "voice": voice.status() if voice else {"enabled": False},
        }

    def _ask(message, pack):
        system = app.state.system
        hub.emit({"type": "state", "state": "thinking"})
        try:
            result = system.ask(
                message,
                pack=None if pack == "auto" else pack,
                prior_messages=list(history),
            )
        except Exception as exc:
            hub.emit({"type": "error", "message": str(exc)})
            hub.emit({"type": "state", "state": "error"})
            hub.emit({"type": "state", "state": "idle"})
            raise
        history.extend(
            [
                Message(role=Role.USER, content=message),
                Message(role=Role.ASSISTANT, content=result["content"]),
            ]
        )
        history[:] = system._history(history, config.agent.history_chars)
        hub.emit({"type": "response", "content": result["content"]})
        hub.emit({"type": "state", "state": "idle"})
        return result

    @app.post("/api/chat", dependencies=[Depends(guard), Depends(json_only)])
    async def chat(body: ChatRequest):
        if not busy.acquire(blocking=False):
            raise HTTPException(409, "Lyra is busy with another request; retry later")
        try:
            result = await asyncio.to_thread(_ask, body.message, body.pack)
        except ValueError as exc:
            # Unknown/disabled pack or ambiguous auto-routing: the caller must choose.
            raise HTTPException(400, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(502, f"Lyra Core error: {exc}") from exc
        finally:
            busy.release()
        metadata = result["metadata"]
        return {
            "content": result["content"],
            "pack": metadata.get("pack"),
            "turns": result["turns"],
            "complete": not any(metadata.get(key) for key in _INCOMPLETE),
            "tool_results": [asdict(t) for t in result["tool_results"]],
            "metadata": metadata,
        }

    @app.post("/api/chat/reset", dependencies=[Depends(guard)])
    async def chat_reset():
        # Clears only the in-RAM conversation; memory.db and the vault are untouched.
        if not busy.acquire(blocking=False):
            raise HTTPException(409, "Lyra is busy with another request; retry later")
        try:
            cleared = len(history) // 2
            history.clear()
        finally:
            busy.release()
        return {"status": "ok", "cleared_exchanges": cleared}

    @app.get("/api/knowledge/notes", dependencies=[Depends(guard)])
    async def knowledge_notes():
        # Same confined scan as search (no links, hidden entries or non-.md files);
        # only relative vault paths and titles leave the server.
        vault = _vault()
        try:
            notes, skipped = await asyncio.to_thread(vault.list_notes)
        except (ValueError, OSError, RuntimeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return {"notes": [{"path": path, "title": title} for path, title in notes], "skipped": skipped}

    @app.get("/api/knowledge/search", dependencies=[Depends(guard)])
    async def knowledge_search(q: str = Query(min_length=1, max_length=300)):
        vault = _vault()
        try:
            results, skipped = await asyncio.to_thread(vault.search, q)
        except (ValueError, OSError, RuntimeError) as exc:
            raise HTTPException(400, str(exc)) from exc
        return {
            "results": [
                {"path": r.source, "excerpt": " ".join(r.content[:240].split())} for r in results
            ],
            "skipped": skipped,
        }

    @app.get("/api/knowledge/note", dependencies=[Depends(guard)])
    async def knowledge_note(path: str = Query(min_length=1, max_length=512)):
        vault = _vault()
        try:
            content = await asyncio.to_thread(vault.read, path)
        except FileNotFoundError as exc:
            raise HTTPException(404, "Note not found") from exc
        except (ValueError, OSError, UnicodeError, RuntimeError) as exc:
            # Same MarkdownVault checks as notes_read: traversal, hidden, links, size.
            raise HTTPException(400, str(exc)) from exc
        return {"path": path, "content": content}

    # Lyra Voice: STT/TTS only; spoken text goes through POST /api/chat like typed text.
    install_voice_routes(app, guard, json_only)

    @app.websocket("/ws")
    async def websocket(ws: WebSocket):
        origin_ok = _origin_ok(ws.headers.get("origin"), ws.headers.get("host"))
        header = ws.headers.get("authorization", "")
        token = header[7:] if header[:7].lower() == "bearer " else None
        subprotocol = None
        # Browsers cannot set headers on WebSocket: accept "bearer.<token>" subprotocol.
        for proto in ws.scope.get("subprotocols", []):
            if proto.startswith("bearer."):
                token, subprotocol = proto[7:], proto
        if not origin_ok or not _token_ok(token):
            await ws.close(code=1008)
            return
        await ws.accept(subprotocol=subprotocol)
        queue: asyncio.Queue = asyncio.Queue(maxsize=256)
        hub.clients.add(queue)
        receiver = getter = None
        try:
            await ws.send_json({"type": "state", "state": hub.state})
            # Server -> client only. Client frames are read just to notice a close;
            # chat requests go through POST /api/chat.
            receiver = asyncio.create_task(ws.receive())
            while True:
                getter = asyncio.create_task(queue.get())
                done, _ = await asyncio.wait(
                    {getter, receiver}, return_when=asyncio.FIRST_COMPLETED
                )
                if receiver in done:
                    if receiver.result()["type"] == "websocket.disconnect":
                        break
                    receiver = asyncio.create_task(ws.receive())
                if getter in done:
                    await ws.send_json(getter.result())
                else:
                    getter.cancel()
        except WebSocketDisconnect:
            pass
        finally:
            hub.clients.discard(queue)
            for task in (receiver, getter):
                if task is not None:
                    task.cancel()

    app.state.hub = hub
    app.state.voice = voice
    app.state.history = history
    app.state.busy = busy
    return app


def serve(config):  # pragma: no cover - thin uvicorn wrapper, exercised by the smoke test
    import uvicorn

    # Access log off: request lines would record personal queries (?q=...).
    uvicorn.run(
        create_app(config),
        host=config.api.host,
        port=config.api.port,
        access_log=False,
        log_level="info",
        ws="auto",
    )
