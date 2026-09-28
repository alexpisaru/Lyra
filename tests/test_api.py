"""Lyra API over a real JarvisSystem (agent, executor, EventBus, vault); only the model is mocked."""

import threading
import time
from unittest.mock import MagicMock

import pytest

pytest.importorskip("fastapi")
from fastapi.testclient import TestClient  # noqa: E402
from starlette.websockets import WebSocketDisconnect  # noqa: E402

from openjarvis.api import create_app  # noqa: E402
from openjarvis.core.config import JarvisConfig, load_config  # noqa: E402
from openjarvis.system.builder import SystemBuilder  # noqa: E402
from openjarvis.tools.packs import PACKS  # noqa: E402

KEY = "k" * 24


def call(name, arguments):
    return {"content": "", "tool_calls": [{"name": name, "arguments": arguments}]}


def make_config(tmp_path, **api):
    cfg = JarvisConfig()
    cfg.tools.workspace = str(tmp_path / "workspace")
    cfg.memory.db_path = str(tmp_path / "state" / "memory.db")
    cfg.knowledge.enabled = True
    cfg.knowledge.vault_path = str(tmp_path / "vault")
    cfg.tools.enabled.extend(PACKS["knowledge"])
    cfg.api.enabled = True
    for key, value in api.items():
        setattr(cfg.api, key, value)
    return cfg.validate()


@pytest.fixture
def lyra(tmp_path):
    """Yield a factory: (config overrides) -> (client, system, health)."""
    opened = []

    def factory(**api):
        cfg = make_config(tmp_path, **api)
        system = SystemBuilder(cfg).build()
        system.engine.generate = MagicMock(return_value={"content": "ok"})
        health = MagicMock()
        health.health.return_value = True
        health.list_models.return_value = [cfg.intelligence.model]
        client = TestClient(create_app(cfg, system=system, health_engine=health))
        client.__enter__()
        opened.append((client, system))
        return client, system, health

    yield factory
    for client, system in opened:
        client.__exit__(None, None, None)
        system.close()


def events_until_idle(ws, limit=40):
    """Collect events after the initial state until the runtime is idle again."""
    events = []
    for _ in range(limit):
        event = ws.receive_json()
        events.append(event)
        if event == {"type": "state", "state": "idle"} and len(events) > 1:
            return events
    raise AssertionError(f"no final idle state: {events}")


def test_status_is_cached_and_reports_config(lyra):
    client, _, health = lyra()
    body = client.get("/api/status").json()
    assert body["status"] == "ok" and body["name"] == "Lyra" and body["version"] == "0.3.1"
    assert body["model"] == {
        "provider": "ollama",
        "model": "openbmb/minicpm5-2b:q8_0",
        "reachable": True,
    }
    assert body["memory"] == {"enabled": True} and body["knowledge"] == {"enabled": True}
    assert body["browser"] == {"enabled": False, "backend": None}
    assert body["state"] == "idle" and body["busy"] is False
    client.get("/api/status")
    assert health.health.call_count == 1  # cached, no Ollama call per request


def test_status_reports_unreachable_model(lyra):
    client, _, health = lyra(status_cache_seconds=0)
    health.list_models.return_value = ["other"]
    assert client.get("/api/status").json()["model"]["reachable"] is False
    health.health.side_effect = RuntimeError("down")
    assert client.get("/api/status").json()["model"]["reachable"] is False


def test_chat_explicit_pack_runs_real_tool_and_streams_events(lyra):
    client, system, _ = lyra()
    system.engine.generate = MagicMock(
        side_effect=[call("calculator", '{"expression": "17 * 23"}'), {"content": "391"}]
    )
    with client.websocket_connect("/ws") as ws:
        assert ws.receive_json() == {"type": "state", "state": "idle"}
        response = client.post("/api/chat", json={"message": "Calcola 17 * 23", "pack": "general"})
        events = events_until_idle(ws)
    assert response.status_code == 200, response.text
    body = response.json()
    # The calculator already answered exactly what was asked: no second model call.
    assert body["content"] == "17 × 23 = 391" and body["pack"] == "general" and body["complete"]
    assert body["metadata"]["final_path"] == "deterministic"
    assert system.engine.generate.call_count == 1
    assert body["tool_results"][0]["tool_name"] == "calculator"
    assert body["tool_results"][0]["success"] and "391" in body["tool_results"][0]["content"]
    assert body["metadata"]["tools"] == ["calculator"]
    # Order produced by the real runtime: thinking -> tool -> thinking -> response -> idle.
    expected = [
        {"type": "state", "state": "thinking"},
        {"type": "state", "state": "using_tool"},
        {"type": "tool_started", "tool": "calculator"},
        {"type": "tool_finished", "tool": "calculator", "success": True},
        {"type": "state", "state": "thinking"},
        {"type": "response", "content": "17 × 23 = 391"},
        {"type": "state", "state": "idle"},
    ]
    remaining = iter(events)
    assert all(any(e == wanted for e in remaining) for wanted in expected), events


def test_failed_tool_is_reported_in_events(lyra):
    client, system, _ = lyra()
    system.engine.generate = MagicMock(
        side_effect=[call("notes_read", '{"path": "../escape.md"}'), {"content": "no"}]
    )
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        client.post("/api/chat", json={"message": "leggi", "pack": "knowledge"})
        events = events_until_idle(ws)
    assert {"type": "tool_finished", "tool": "notes_read", "success": False} in events


def test_chat_auto_pack_uses_existing_router(lyra):
    client, system, _ = lyra()
    body = client.post("/api/chat", json={"message": "Quanto fa 12*9?"}).json()
    assert body["pack"] == "general" and body["metadata"]["tools"] == ["calculator"]
    # An open question about the notes is left to the model (no fast path).
    body = client.post("/api/chat", json={"message": "Cosa dicono i miei appunti su Petalo?"}).json()
    assert body["pack"] == "knowledge" and body["metadata"]["tools"] == list(PACKS["knowledge"])
    assert "fast_path" not in body["metadata"]
    # Knowledge requires a tool call: an answer without one is marked incomplete.
    assert body["complete"] is False and body["metadata"]["missing_tool_use"]


def test_chat_rejects_ambiguous_invalid_and_non_json(lyra):
    client, _, _ = lyra()
    response = client.post("/api/chat", json={"message": "Copia appunti in memoria"})
    assert response.status_code == 400 and "capability" in response.json()["detail"]
    assert client.post("/api/chat", json={"message": "x", "pack": "cloud"}).status_code == 422
    assert client.post("/api/chat", json={"message": "x", "extra": 1}).status_code == 422
    assert client.post("/api/chat", json={"message": ""}).status_code == 422
    assert client.post("/api/chat", json={"message": "x" * 4001}).status_code == 422
    response = client.post(
        "/api/chat", content='{"message": "x"}', headers={"Content-Type": "text/plain"}
    )
    assert response.status_code == 415


def test_chat_keeps_ram_history_and_reset_clears_only_history(lyra):
    client, system, _ = lyra()
    system.memory_backend.store("colore verde", source="test")
    (system.knowledge_vault.root / "nota.md").write_text("Petalo", encoding="utf-8")
    client.post("/api/chat", json={"message": "prima domanda", "pack": "chat"})
    client.post("/api/chat", json={"message": "seconda domanda", "pack": "chat"})
    sent = system.engine.generate.call_args.args[0]
    assert any(m.content == "prima domanda" for m in sent)
    assert client.post("/api/chat/reset").json() == {"status": "ok", "cleared_exchanges": 2}
    client.post("/api/chat", json={"message": "terza", "pack": "chat"})
    sent = system.engine.generate.call_args.args[0]
    assert not any(m.content in ("prima domanda", "seconda domanda") for m in sent)
    assert system.memory_backend.count() == 1
    assert (system.knowledge_vault.root / "nota.md").read_text(encoding="utf-8") == "Petalo"


def test_engine_error_returns_502_and_error_events(lyra):
    client, system, _ = lyra()
    system.engine.generate = MagicMock(side_effect=RuntimeError("Ollama unreachable"))
    with client.websocket_connect("/ws") as ws:
        ws.receive_json()
        response = client.post("/api/chat", json={"message": "ciao", "pack": "chat"})
        events = events_until_idle(ws)
    assert response.status_code == 502 and "Ollama unreachable" in response.json()["detail"]
    assert {"type": "error", "message": "Ollama unreachable"} in events
    assert events[-2:] == [
        {"type": "state", "state": "error"},
        {"type": "state", "state": "idle"},
    ]
    assert client.get("/api/status").json()["busy"] is False


def test_only_one_agentic_request_at_a_time(lyra):
    client, system, _ = lyra()
    release = threading.Event()
    entered = threading.Event()

    def slow_generate(*args, **kwargs):
        entered.set()
        release.wait(10)
        return {"content": "fatto"}

    system.engine.generate = MagicMock(side_effect=slow_generate)
    first = {}
    worker = threading.Thread(
        target=lambda: first.update(
            response=client.post("/api/chat", json={"message": "lento", "pack": "chat"})
        )
    )
    worker.start()
    try:
        assert entered.wait(10)
        second = client.post("/api/chat", json={"message": "altro", "pack": "chat"})
        assert second.status_code == 409 and "busy" in second.json()["detail"]
        assert client.post("/api/chat/reset").status_code == 409
        status = client.get("/api/status").json()  # status stays available
        assert status["busy"] is True and status["state"] == "thinking"
    finally:
        release.set()
        worker.join(10)
    assert first["response"].status_code == 200
    assert client.post("/api/chat", json={"message": "dopo", "pack": "chat"}).status_code == 200


def test_knowledge_search_and_read_use_the_vault(lyra):
    client, system, _ = lyra()
    root = system.knowledge_vault.root
    (root / "progetti").mkdir()
    (root / "progetti" / "crm.md").write_text("# CRM\nProgetto CRM clienti", encoding="utf-8")
    body = client.get("/api/knowledge/search", params={"q": "CRM"}).json()
    assert body["results"] == [{"path": "progetti/crm.md", "excerpt": "# CRM Progetto CRM clienti"}]
    # External edit (Obsidian/Syncthing) is picked up by the next search.
    (root / "progetti" / "crm.md").write_text("Ametista", encoding="utf-8")
    assert client.get("/api/knowledge/search", params={"q": "clienti"}).json()["results"] == []
    found = client.get("/api/knowledge/search", params={"q": "Ametista"}).json()["results"]
    assert found == [{"path": "progetti/crm.md", "excerpt": "Ametista"}]
    note = client.get("/api/knowledge/note", params={"path": "progetti/crm.md"}).json()
    assert note == {"path": "progetti/crm.md", "content": "Ametista"}
    assert client.get("/api/knowledge/note", params={"path": "manca.md"}).status_code == 404
    assert client.get("/api/knowledge/search").status_code == 422


@pytest.mark.parametrize(
    "path",
    [
        "../secret.md",
        "progetti/../../secret.md",
        "/etc/passwd.md",
        "C:/Windows/win.md",
        "..\\secret.md",
        ".obsidian/app.md",
        "progetti/.hidden.md",
        "note.txt",
    ],
)
def test_knowledge_read_keeps_vault_confinement(lyra, tmp_path, path):
    client, system, _ = lyra()
    (tmp_path / "secret.md").write_text("fuori dal vault", encoding="utf-8")
    (system.knowledge_vault.root / ".obsidian").mkdir()
    (system.knowledge_vault.root / ".obsidian" / "app.md").write_text("x", encoding="utf-8")
    response = client.get("/api/knowledge/note", params={"path": path})
    assert response.status_code == 400, response.text
    assert "fuori dal vault" not in response.text


def test_knowledge_disabled_is_404(tmp_path):
    cfg = JarvisConfig()
    cfg.tools.workspace = str(tmp_path / "ws")
    cfg.memory.db_path = str(tmp_path / "memory.db")
    system = SystemBuilder(cfg).build()
    try:
        with TestClient(create_app(cfg, system=system, health_engine=MagicMock())) as client:
            assert client.get("/api/knowledge/search", params={"q": "x"}).status_code == 404
            assert client.get("/api/knowledge/note", params={"path": "a.md"}).status_code == 404
            assert client.get("/api/knowledge/notes").status_code == 404
    finally:
        system.close()


@pytest.mark.parametrize(
    ("method", "path", "kwargs"),
    [
        ("get", "/api/status", {}),
        ("post", "/api/chat", {"json": {"message": "ciao", "pack": "chat"}}),
        ("post", "/api/chat/reset", {}),
        ("get", "/api/knowledge/search", {"params": {"q": "x"}}),
        ("get", "/api/knowledge/note", {"params": {"path": "a.md"}}),
        ("get", "/api/knowledge/notes", {}),
    ],
)
def test_api_key_is_required_everywhere(lyra, method, path, kwargs):
    client, _, _ = lyra(api_key=KEY)
    request = getattr(client, method)
    assert request(path, **kwargs).status_code == 401
    wrong = request(path, headers={"Authorization": "Bearer " + "x" * 24}, **kwargs)
    assert wrong.status_code == 401 and wrong.headers["www-authenticate"] == "Bearer"
    good = request(path, headers={"Authorization": f"Bearer {KEY}"}, **kwargs)
    assert good.status_code in (200, 404), good.text  # 404: a.md does not exist


def test_websocket_auth_header_and_subprotocol(lyra):
    client, _, _ = lyra(api_key=KEY)
    for kwargs in ({}, {"headers": {"Authorization": "Bearer wrong-token-wrong-token"}}):
        with pytest.raises(WebSocketDisconnect) as exc:
            with client.websocket_connect("/ws", **kwargs) as ws:
                ws.receive_json()
        assert exc.value.code == 1008
    with client.websocket_connect("/ws", headers={"Authorization": f"Bearer {KEY}"}) as ws:
        assert ws.receive_json() == {"type": "state", "state": "idle"}
    with client.websocket_connect("/ws", subprotocols=[f"bearer.{KEY}"]) as ws:
        assert ws.accepted_subprotocol == f"bearer.{KEY}"
        assert ws.receive_json()["type"] == "state"


def test_origin_allowlist_cors_and_cross_site_rejection(lyra):
    allowed = "http://192.168.1.50:5173"
    client, _, _ = lyra(allowed_origins=[allowed])
    evil = {"Origin": "https://evil.example"}
    assert client.get("/api/status", headers=evil).status_code == 403
    assert client.post("/api/chat", json={"message": "x"}, headers=evil).status_code == 403
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws", headers=evil) as ws:
            ws.receive_json()
    ok = client.get("/api/status", headers={"Origin": allowed})
    assert ok.status_code == 200
    assert ok.headers["access-control-allow-origin"] == allowed
    preflight = client.options(
        "/api/chat",
        headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"},
    )
    assert preflight.headers.get("access-control-allow-origin") != "*"
    assert "access-control-allow-origin" not in preflight.headers
    # Same-origin browser page (future PWA on the same host) needs no CORS entry.
    same = client.get("/api/status", headers={"Origin": "http://testserver"})
    assert same.status_code == 200


def test_no_cors_headers_by_default(lyra):
    client, _, _ = lyra()
    response = client.get("/api/status")
    assert "access-control-allow-origin" not in response.headers
    assert client.get("/api/status", headers={"Origin": "http://other:1"}).status_code == 403


def test_no_generic_browser_or_write_endpoints(lyra):
    client, _, _ = lyra()
    paths = {route.path for route in client.app.routes}
    assert paths == {
        "/api/status",
        "/api/chat",
        "/api/chat/reset",
        "/api/knowledge/search",
        "/api/knowledge/note",
        "/api/knowledge/notes",
        "/ws",
    }
    assert client.get("/docs").status_code == 404 and client.get("/openapi.json").status_code == 404


def test_api_config_parsing(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text(
        '[api]\nenabled = true\nhost = "0.0.0.0"\nport = 8787\n'
        f'api_key = "{KEY}"\nallowed_origins = ["http://100.64.0.5:8787"]\n'
    )
    cfg = load_config(path)
    assert (cfg.api.enabled, cfg.api.host, cfg.api.port) == (True, "0.0.0.0", 8787)
    assert cfg.api.allowed_origins == ["http://100.64.0.5:8787"]
    default = JarvisConfig().validate().api
    assert (default.enabled, default.host, default.api_key, default.allowed_origins) == (
        False,
        "127.0.0.1",
        "",
        [],
    )
    for bad in (
        'allowed_origins = ["*"]',
        'allowed_origins = ["http://x:1/path"]',
        'allowed_origins = ["ftp://x"]',
        'api_key = "short"',
        'api_key = "has space in the middle!!"',
        "port = 0",
        'port = "8787"',
        "enabled = 1",
        "unknown = true",
    ):
        path.write_text(f"[api]\n{bad}\n")
        with pytest.raises(ValueError):
            load_config(path)


def test_cli_api_requires_enabled_and_calls_server(monkeypatch, tmp_path):
    from click.testing import CliRunner

    import openjarvis.api
    from openjarvis.cli import cli

    path = tmp_path / "config.toml"
    path.write_text("[api]\nenabled = false\n")
    result = CliRunner().invoke(cli, ["--config", str(path), "api"])
    assert result.exit_code == 1 and "enabled = true" in result.output
    served = []
    monkeypatch.setattr(openjarvis.api, "serve", served.append)
    path.write_text('[api]\nenabled = true\nhost = "0.0.0.0"\n')
    result = CliRunner().invoke(cli, ["--config", str(path), "api"])
    assert result.exit_code == 0, result.output
    assert served and served[0].api.host == "0.0.0.0"
    assert "senza api_key" in result.output


def test_api_serves_through_uvicorn_on_a_real_socket(tmp_path):
    """`lyra api` path: real uvicorn, real TCP socket, real WebSocket upgrade."""
    import socket

    import httpx
    import uvicorn
    from websockets.sync.client import connect

    cfg = make_config(tmp_path)
    system = SystemBuilder(cfg).build()
    system.engine.generate = MagicMock(return_value={"content": "pong"})
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(
        uvicorn.Config(
            create_app(cfg, system=system, health_engine=MagicMock()),
            host="127.0.0.1",
            port=port,
            log_level="warning",
            ws="auto",
        )
    )
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.05)
        base = f"http://127.0.0.1:{port}"
        assert httpx.get(base + "/api/status").json()["name"] == "Lyra"
        with connect(f"ws://127.0.0.1:{port}/ws") as ws:
            assert ws.recv(timeout=5) == '{"type":"state","state":"idle"}'
            reply = httpx.post(base + "/api/chat", json={"message": "ping", "pack": "chat"})
            assert reply.json()["content"] == "pong"
            seen = []
            while '"idle"' not in (seen[-1] if seen else ""):
                seen.append(ws.recv(timeout=5))
            assert any('"response"' in s for s in seen)
    finally:
        server.should_exit = True
        thread.join(10)
        system.close()


def test_knowledge_notes_lists_only_confined_markdown(lyra, tmp_path):
    client, system, _ = lyra()
    root = system.knowledge_vault.root
    (root / "progetti").mkdir()
    (root / ".obsidian").mkdir()
    (root / "collaudo-lyra.md").write_text("# Collaudo Lyra\nametista", encoding="utf-8")
    (root / "progetti" / "crm.md").write_text("---\na: b\n---\n# Progetto CRM", encoding="utf-8")
    (root / ".obsidian" / "app.md").write_text("# hidden", encoding="utf-8")
    (root / "photo.png").write_bytes(b"x")
    outside = tmp_path / "outside.md"
    outside.write_text("# Fuori", encoding="utf-8")
    try:
        (root / "link.md").symlink_to(outside)
    except OSError:
        pass  # symlinks not permitted here; the vault-level test covers it on POSIX
    body = client.get("/api/knowledge/notes").json()
    assert body["notes"] == [
        {"path": "collaudo-lyra.md", "title": "Collaudo Lyra"},
        {"path": "progetti/crm.md", "title": "Progetto CRM"},
    ]
    assert "Fuori" not in str(body) and str(root) not in str(body)
    # No arbitrary parameters: the endpoint lists the vault, nothing else.
    assert client.get("/api/knowledge/notes", params={"path": "../"}).json() == body
