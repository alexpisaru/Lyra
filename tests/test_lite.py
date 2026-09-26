"""Lite acceptance tests exercise the real builder, agent, executor and Ollama adapter."""

from __future__ import annotations

import copy
import json
import sys
import threading
from unittest.mock import MagicMock

import httpx
import pytest
from click.testing import CliRunner

from openjarvis.agents.orchestrator import OrchestratorAgent
from openjarvis.cli import cli
from openjarvis.core.config import JarvisConfig, load_config
from openjarvis.core.types import Message, Role, ToolCall, ToolResult
from openjarvis.engine.ollama import OllamaEngine
from openjarvis.system import SystemBuilder
from openjarvis.tools._stubs import BaseTool, ToolExecutor, ToolSpec
from openjarvis.tools.calculator import CalculatorTool
from openjarvis.tools.packs import PACKS, route_pack, select_tools
from openjarvis.tools.storage.sqlite import SQLiteMemory


def call(name, arguments):
    return {"content": "", "tool_calls": [{"name": name, "arguments": arguments}]}


def make_agent(responses, **kwargs):
    engine = MagicMock()
    captured = []
    responses = iter(responses)

    def generate(messages, **options):
        captured.append((copy.deepcopy(messages), copy.deepcopy(options)))
        return next(responses)

    engine.generate.side_effect = generate
    agent = OrchestratorAgent(
        engine, "test", tools=[CalculatorTool()], temperature=0.1, max_tokens=512, **kwargs
    )
    return agent, captured


@pytest.fixture
def config(tmp_path):
    cfg = JarvisConfig()
    cfg.tools.workspace = str(tmp_path / "workspace")
    cfg.memory.db_path = str(tmp_path / "memory.db")
    return cfg


def test_real_stack_ollama_payload_and_tool_roundtrip(config):
    with SystemBuilder(config).build() as system:
        payloads = []

        def respond(request):
            payload = json.loads(request.content)
            payloads.append(payload)
            if len(payloads) == 1:
                return httpx.Response(
                    200,
                    json={
                        "message": {
                            "content": "",
                            "tool_calls": [
                                {
                                    "function": {
                                        "name": "calculator",
                                        "arguments": {"expression": "7*8"},
                                    }
                                }
                            ],
                        }
                    },
                )
            return httpx.Response(200, json={"message": {"content": "56"}, "done_reason": "stop"})

        system.engine._client.close()
        system.engine._client = httpx.Client(
            transport=httpx.MockTransport(respond), base_url=config.engine.host
        )
        result = system.ask("Quanto fa 7*8?", pack="general")
    assert result["content"] == "56"
    assert result["tool_results"][0].success
    assert "56" in payloads[1]["messages"][-1]["content"]
    for payload in payloads:
        assert [t["function"]["name"] for t in payload["tools"]] == ["calculator"]
        assert payload["model"] == "openbmb/minicpm5-2b:q8_0"
        assert payload["options"]["num_ctx"] == 8192
        assert payload["options"]["temperature"] == 0.1


@pytest.mark.parametrize(
    "bad", ["{", "[]", '{"expression":42}', '{"expression":"2+2","shell":"x"}', "{}"]
)
def test_invalid_arguments_recover_without_execution(bad):
    agent, captured = make_agent(
        [call("calculator", bad), call("calculator", '{"expression":"2+2"}'), {"content": "4"}]
    )
    result = agent.run("calcola")
    assert [r.success for r in result.tool_results] == [False, True]
    assert "Invalid arguments" in captured[1][0][-1].content
    assert result.content == "4"


def test_tool_outside_pack_not_executable(config):
    with SystemBuilder(config).build() as system:
        system.engine.generate = MagicMock(
            side_effect=[call("memory_store", '{"content":"bad"}'), {"content": "non disponibile"}]
        )
        result = system.ask("calcola", pack="general")
        assert not result["tool_results"][0].success
        assert system.memory_backend.count() == 0


@pytest.mark.parametrize(
    ("query", "pack"),
    [
        ("Ricorda il mio colore", "memory"),
        ("Leggi il file", "files"),
        ("Leggi https://example.com", "browser"),
        ("Quanto fa 12*9?", "general"),
    ],
)
def test_routing(query, pack):
    assert route_pack(query) == pack


def test_pack_limits_allowlist_and_ambiguity(monkeypatch):
    with pytest.raises(ValueError, match="più capability"):
        route_pack("memorizza il file")
    with pytest.raises(ValueError, match="disabled"):
        select_tools("x", "browser", {})
    with pytest.raises(ValueError, match="Unknown"):
        select_tools("x", "cloud", {})
    monkeypatch.setitem(PACKS, "oversize", tuple(str(i) for i in range(6)))
    with pytest.raises(ValueError, match="5 tools"):
        select_tools("x", "oversize", {})
    assert select_tools("x", "chat", {}) == ("chat", [])


def test_context_and_call_limits():
    agent, captured = make_agent([{"content": "unused"}], max_prompt_bytes=100)
    assert agent.run("x" * 1000).metadata["context_limit"]
    assert not captured
    agent, captured = make_agent([call("calculator", '{"expression":"2+2"}')] * 3, max_tool_calls=1)
    result = agent.run("calcola")
    assert result.metadata["tool_call_limit"]
    assert len(result.tool_results) == 1


def test_multi_call_rejected_and_turn_limit_honest():
    batch = {"tool_calls": [call("calculator", "{}")["tool_calls"][0]] * 2}
    agent, captured = make_agent([batch] * 2, max_turns=2)
    result = agent.run("x")
    assert result.metadata["max_turns_exceeded"]
    assert not result.tool_results


def test_strict_config(tmp_path):
    for text in (
        "[learning]\nenabled=true",
        "[agent]\nmax_turns=0",
        '[tools]\nenabled=["shell_exec"]',
        '[tools]\nbrowser="false"',
        "[memory]\nenabled=false",
    ):
        path = tmp_path / "bad.toml"
        path.write_text(text)
        with pytest.raises(ValueError):
            load_config(path)


def test_memory_persists_retrieves_deletes_and_rolls_back(tmp_path):
    path = tmp_path / "notes.db"
    db = SQLiteMemory(path)
    doc = db.store("Il colore preferito è verde", source="user")
    db.close()
    db = SQLiteMemory(path)
    assert db.retrieve('"verde" OR')[0].content == "Il colore preferito è verde"
    with pytest.raises(ValueError):
        db.replace_source("user", [("sostituzione", None), ("", None)])
    assert db.count() == 1
    assert db.retrieve("verde")
    assert db.delete(doc)
    assert not db.retrieve("verde")
    db.close()


def test_memory_through_executor_and_duplicate_guard(config):
    with SystemBuilder(config).build() as system:
        system.engine.generate = MagicMock(
            side_effect=[call("memory_store", '{"content":"colore verde"}')] * 2
            + [{"content": "salvato"}]
        )
        result = system.ask("Ricorda colore verde", pack="memory")
        assert system.memory_backend.count() == 1
        assert [r.success for r in result["tool_results"]] == [True, False]


def test_no_silent_tool_fallback_on_http400():
    engine = OllamaEngine("http://test")
    engine._client.close()
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(400, json={"error": "model does not support tools"})

    engine._client = httpx.Client(transport=httpx.MockTransport(respond), base_url="http://test")
    with pytest.raises(RuntimeError, match="400"):
        engine.generate(
            [Message(role=Role.USER, content="x")],
            model="test",
            tools=[CalculatorTool().to_openai_function()],
        )
    assert len(requests) == 1
    engine.close()


def test_browser_native_session_thread_affinity():
    from openjarvis.tools.browser import _BrowserSession, BrowserExtractTool

    session = _BrowserSession()
    threads = []
    page = MagicMock()
    page.inner_text.side_effect = lambda *_: threads.append(threading.get_ident()) or "page"
    session._page = page
    executor = ToolExecutor([BrowserExtractTool(session)])
    for _ in range(4):
        assert executor.execute(ToolCall(id="1", name="browser_extract", arguments="{}")).success
    session._browser = MagicMock()
    session._browser.close.side_effect = lambda: threads.append(threading.get_ident())
    session.close()
    assert len(set(threads)) == 1
    assert threads[0] != threading.get_ident()


def test_import_and_cli_have_no_removed_subsystems():
    result = CliRunner().invoke(cli, ["--help"])
    assert result.exit_code == 0
    assert "ask" in result.output and "check" in result.output
    assert "train" not in result.output
    forbidden = (
        "openjarvis.learning",
        "openjarvis.telemetry",
        "openjarvis.channels",
        "openjarvis.engine.cloud",
    )
    assert not any(name.startswith(forbidden) for name in sys.modules)


def test_history_only_complete_pairs(config):
    with SystemBuilder(config).build() as system:
        history = [
            Message(role=Role.SYSTEM, content="old"),
            Message(role=Role.USER, content="u"),
            Message(role=Role.ASSISTANT, content="a"),
            Message(role=Role.TOOL, content="orphan"),
        ]
        assert [m.content for m in system._history(history, 2)] == ["u", "a"]
        assert system._history(history, 1) == []


def test_all_pack_schemas_stay_small(config, tmp_path):
    config.tools.browser = True
    config.tools.enabled.extend(PACKS["browser"] + PACKS["knowledge"])
    config.knowledge.enabled = True
    config.knowledge.vault_path = str(tmp_path / "vault")
    with SystemBuilder(config).build() as system:
        sizes = {}
        for pack in PACKS:
            _, tools = select_tools("x", pack, system.tools)
            schemas = [tool.to_openai_function() for tool in tools]
            assert len(schemas) <= 5
            sizes[pack] = len(json.dumps(schemas).encode())
            assert sizes[pack] < 6000
        assert "playwright" not in sys.modules  # truly lazy


def test_output_limit_and_generation_truncation():
    agent, captured = make_agent(
        [
            call("calculator", '{"expression":"2+2"}'),
            {"content": "partial", "finish_reason": "length"},
        ],
        max_tool_output_chars=1,
    )
    result = agent.run("x")
    assert result.tool_results[0].metadata["truncated"]
    assert result.metadata["truncated"]
    assert len(captured) == 2  # no invisible continuation calls


def test_no_memory_and_allowlist_empty(config):
    config.memory.enabled = False
    config.tools.enabled = []
    with SystemBuilder(config).build() as system:
        assert system.memory_backend is None
        assert not system.tools
        system.engine.generate = MagicMock(return_value={"content": "ciao"})
        assert system.ask("ciao", pack="chat")["content"] == "ciao"
        assert "tools" not in system.engine.generate.call_args.kwargs


def test_timeout_stops_without_automatic_retry():
    gate = threading.Event()

    class SlowTool(BaseTool):
        @property
        def spec(self):
            return ToolSpec(
                name="slow",
                description="Slow test",
                parameters={"type": "object"},
                timeout_seconds=0.01,
            )

        def execute(self, **kwargs):
            gate.wait(2)
            return ToolResult(tool_name="slow", content="done", success=True)

    engine = MagicMock()
    engine.generate.return_value = call("slow", "{}")
    agent = OrchestratorAgent(engine, "test", tools=[SlowTool()], temperature=0.1, max_tokens=512)
    try:
        result = agent.run("run")
        assert result.metadata["tool_timeout"]
        assert result.tool_results[0].metadata["outcome_unknown"]
        assert engine.generate.call_count == 1
    finally:
        gate.set()


def test_malformed_tool_name_never_executes():
    agent, _ = make_agent([call([], "{}")])
    assert agent.run("x").metadata["invalid_tool_calls"]


def test_browser_click_requires_existing_confirmation_gate():
    from openjarvis.tools.browser import BrowserClickTool, _BrowserSession

    session = _BrowserSession()
    executor = ToolExecutor([BrowserClickTool(session)])
    try:
        result = executor.execute(
            ToolCall(id="1", name="browser_click", arguments='{"selector":"submit"}')
        )
        assert not result.success
        assert "confirmation" in result.content
        assert session._page is None
    finally:
        session.close()


def test_memory_queries_route_automatically_and_get_only_memory_hint(config):
    for query in ("Ti ricordi il colore?", "Cerca nella memoria salvata"):
        assert route_pack(query) == "memory"
    with SystemBuilder(config).build() as system:
        system.engine.generate = MagicMock(return_value={"content": "ok"})
        system.ask("Cerca nella memoria salvata")
        messages = system.engine.generate.call_args.args[0]
        assert "DEVI chiamare memory_retrieve" in messages[0].content
        assert "browser_navigate" not in messages[0].content


def test_missing_tool_response_is_repaired_once_then_fails_honestly():
    agent, captured = make_agent([{"content": "I checked"}] * 2, require_tool_use=True)
    result = agent.run("check")
    assert len(captured) == 2
    assert result.metadata["missing_tool_use"]
    assert "I checked" not in result.content
    agent, captured = make_agent(
        [{"content": "4"}, call("calculator", '{"expression":"2+2"}'), {"content": "4"}],
        require_tool_use=True,
    )
    result = agent.run("calculate")
    assert result.content == "4"
    assert result.tool_results[0].success
    assert len(captured) == 3


def test_file_paths_relative_to_workspace_and_traversal_denied(config, tmp_path):
    with SystemBuilder(config).build() as system:
        from pathlib import Path

        workspace = Path(config.tools.workspace)
        (workspace / "note.txt").write_text("local note")
        (tmp_path / "outside.txt").write_text("outside")
        executor = ToolExecutor([system.tools["file_read"]])
        result = executor.execute(
            ToolCall(id="1", name="file_read", arguments='{"path":"note.txt"}')
        )
        assert result.success and result.content == "local note"
        denied = executor.execute(
            ToolCall(id="2", name="file_read", arguments='{"path":"../outside.txt"}')
        )
        assert not denied.success and "outside allowed" in denied.content


def test_generation_timeout_is_not_reported_as_unreachable():
    from openjarvis.engine._base import EngineConnectionError

    engine = OllamaEngine("http://test", timeout=12)
    engine._client.close()

    def timeout(request):
        raise httpx.ReadTimeout("slow model", request=request)

    engine._client = httpx.Client(transport=httpx.MockTransport(timeout), base_url="http://test")
    with pytest.raises(EngineConnectionError, match="timed out after 12s"):
        engine.generate([Message(role=Role.USER, content="x")], model="test")
    engine.close()


def test_cli_incomplete_result_has_nonzero_exit_and_valid_json(monkeypatch):
    system = MagicMock()
    system.__enter__.return_value = system
    system.ask.return_value = {
        "content": "Non verificato",
        "tool_results": [],
        "turns": 2,
        "metadata": {"missing_tool_use": True},
    }
    monkeypatch.setattr(SystemBuilder, "build", lambda _: system)
    result = CliRunner().invoke(cli, ["ask", "Ricordi?", "--pack", "memory", "--json"])
    assert result.exit_code == 2
    assert json.loads(result.output)["metadata"]["missing_tool_use"]


def _check_config(tmp_path, extra=""):
    vault, state = tmp_path / "vault", tmp_path / "state"
    path = tmp_path / "config.toml"
    path.write_text(
        f'[engine]\nhost = "http://ollama.test:11434"\nmodel = "m:q8"\n'
        f"[knowledge]\nenabled = true\nvault_path = {json.dumps(str(vault))}\n"
        f"[memory]\ndb_path = {json.dumps(str(state / 'memory.db'))}\n{extra}"
    )
    return path, vault, state


def test_cli_check_reports_ollama_vault_memory_and_browser(monkeypatch, tmp_path):
    monkeypatch.setattr(OllamaEngine, "health", lambda self: True)
    monkeypatch.setattr(OllamaEngine, "list_models", lambda self: ["m:q8"])
    path, vault, state = _check_config(tmp_path, '[tools]\nbrowser = true\n[browser]\nbackend = "obscura"')
    result = CliRunner().invoke(cli, ["--config", str(path), "check"])
    # Directories are reported, never created by check.
    assert result.exit_code == 1 and "controlli falliti: memory, knowledge" in result.output
    assert not vault.exists() and not state.exists()
    assert "obscura (EXPERIMENTAL)" in result.output and "check --browser" in result.output
    vault.mkdir()
    state.mkdir()
    result = CliRunner().invoke(cli, ["--config", str(path), "check"])
    assert result.exit_code == 0, result.output
    assert "[OK] ollama: http://ollama.test:11434, modello m:q8" in result.output
    monkeypatch.setattr(OllamaEngine, "list_models", lambda self: ["other"])
    result = CliRunner().invoke(cli, ["--config", str(path), "check"])
    assert result.exit_code == 1 and "modello assente: m:q8" in result.output


def test_cli_check_browser_probe_failure_is_explicit(monkeypatch, tmp_path):
    from openjarvis.tools.browser import _BrowserSession

    monkeypatch.setattr(OllamaEngine, "health", lambda self: True)
    monkeypatch.setattr(OllamaEngine, "list_models", lambda self: ["m:q8"])

    def no_interception(self):
        raise RuntimeError("Browser does not implement required request interception")

    monkeypatch.setattr(_BrowserSession, "_ensure_browser", no_interception)
    path, vault, state = _check_config(tmp_path, '[tools]\nbrowser = true\n[browser]\nbackend = "obscura"')
    vault.mkdir()
    state.mkdir()
    result = CliRunner().invoke(cli, ["--config", str(path), "check", "--browser"])
    assert result.exit_code == 1
    assert "[ERRORE] browser: avvio/probe falliti" in result.output
    assert "interception" in result.output
