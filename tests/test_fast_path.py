"""Performance pass: deterministic fast paths, Ollama keep_alive, profiling.

The fast path only replaces the model's *first, obvious* tool choice. The call
still runs through the agent's ToolExecutor and the tools' own policies, the
model still writes the answer, and the WebSocket events stay the same.
"""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import httpx
import pytest
from fastapi.testclient import TestClient

from openjarvis.agents.fast_path import FastPath, detect_fast_path
from openjarvis.agents.final_path import SYNTHESIS_INSTRUCTION
from openjarvis.agents.orchestrator import OrchestratorAgent
from openjarvis.api import create_app
from openjarvis.core.config import JarvisConfig, load_config
from openjarvis.core.events import EventBus, EventType
from openjarvis.engine.ollama import OllamaEngine
from openjarvis.system import SystemBuilder
from openjarvis.tools._stubs import ToolExecutor
from openjarvis.tools.browser import BrowserExtractTool, BrowserNavigateTool
from openjarvis.tools.calculator import CalculatorTool
from openjarvis.tools.packs import PACKS

KNOWLEDGE = set(PACKS["knowledge"])
BROWSER = set(PACKS["browser"])


# ---------------------------------------------------------------- detection: knowledge


@pytest.mark.parametrize(
    ("query", "expected"),
    [
        (
            "Cerca nei miei appunti qual è il colore segreto",
            "qual è il colore segreto",
        ),
        ("Cerca nelle note: progetto CRM.", "progetto CRM"),
        ("Trova nei miei appunti la password del wifi?", "la password del wifi"),
        ("Cerca nel knowledge il piano di collaudo", "il piano di collaudo"),
        ("cerca il colore segreto nei miei appunti", "il colore segreto"),
        ("Ricerca fra le note  Petalo", "Petalo"),
    ],
)
def test_explicit_notes_search_is_fast_pathed_with_its_query(query, expected):
    assert detect_fast_path(query, "knowledge", KNOWLEDGE) == FastPath(
        "notes_search", {"query": expected}
    )


@pytest.mark.parametrize(
    "query",
    [
        "Parlami dei miei appunti",
        "Cosa sai di Petalo?",
        "Cosa dicono le note sul progetto?",
        "Riassumi i miei appunti",
        "Leggi la nota idee.md",
        "Cerca nei miei appunti",  # nothing to search for
        "Cerca nei miei appunti Petalo e aggiungi una riga",  # also a write
        "Trova nelle note X e scrivi un riepilogo in idee.md",
        "Cerca Petalo",  # no explicit place: ambiguous
    ],
)
def test_ambiguous_or_mixed_knowledge_requests_are_left_to_the_model(query):
    assert detect_fast_path(query, "knowledge", KNOWLEDGE) is None


def test_fast_path_needs_the_pack_and_the_tool():
    query = "Cerca nei miei appunti Petalo"
    assert detect_fast_path(query, "general", {"calculator"}) is None
    assert detect_fast_path(query, "knowledge", {"notes_read"}) is None
    too_long = "Cerca nei miei appunti " + "x" * 301
    assert detect_fast_path(too_long, "knowledge", KNOWLEDGE) is None


# ---------------------------------------------------------------- detection: browser


@pytest.mark.parametrize(
    ("query", "url"),
    [
        ("Apri https://example.com", "https://example.com"),
        ("Vai su https://example.com/docs.", "https://example.com/docs"),
        ("Naviga su https://example.com", "https://example.com"),
        ("Apri https://example.com e dimmi il titolo", "https://example.com"),
        ("apri la pagina https://example.com/a?b=1", "https://example.com/a?b=1"),
        ("Visita https://example.com, poi riassumila", "https://example.com"),
    ],
)
def test_navigation_verb_with_explicit_url_is_fast_pathed(query, url):
    assert detect_fast_path(query, "browser", BROWSER) == FastPath("browser_navigate", {"url": url})


@pytest.mark.parametrize(
    "query",
    [
        "https://example.com",  # URL without a navigation verb
        "Cosa c'è su https://example.com?",
        "Riassumi https://example.com",
        "Apri il sito di Example",  # verb without URL: never invented
        "Vai su example.com",  # not an explicit http(s) URL
        "Apri https://a.example e https://b.example",  # two URLs: ambiguous
        "Apri https://example.com e clicca su Login",  # interactive: model plans
        "Apri https://example.com e compila il modulo",
    ],
)
def test_browser_requests_without_verb_and_url_are_conservative(query):
    assert detect_fast_path(query, "browser", BROWSER) is None


# ---------------------------------------------------------------- execution through the agent


def scripted_engine(*responses):
    engine = MagicMock()
    calls = []

    def generate(messages, **options):
        calls.append({"messages": list(messages), "options": options})
        return responses[len(calls) - 1]

    engine.generate.side_effect = generate
    engine._publishes_events = False  # like OllamaEngine: the agent publishes INFERENCE_*
    return engine, calls


class StubSession:
    """Browser session double: only reached when the tool's own guard lets a URL through."""

    active_backend = "chromium"
    fallback_reason = None
    runner = ThreadPoolExecutor(max_workers=1)  # the real session runs tools on its own thread
    _blocked = None
    _blocked_subresources: list = []

    def __init__(self):
        self.visited = []
        self._page = MagicMock(url="https://example.com/")
        self._page.title.return_value = "Example Domain"
        self._page.inner_text.return_value = "This domain is for use in examples."

    def navigate(self, url, wait_for):
        self.visited.append(url)
        return MagicMock(status=200), []


def browser_agent(engine, session, bus=None):
    tools = [BrowserNavigateTool(session), BrowserExtractTool(session)]
    fast = detect_fast_path("Apri https://example.com e dimmi il titolo", "browser", BROWSER)
    return OrchestratorAgent(
        engine, "m", tools=tools, bus=bus, temperature=0.1, max_tokens=512, fast_path=fast
    )


def test_browser_fast_path_runs_navigate_through_the_tool_executor(monkeypatch):
    executed = []
    real_execute = ToolExecutor.execute

    def spy(self, call):
        executed.append((call.name, json.loads(call.arguments)))
        return real_execute(self, call)

    monkeypatch.setattr(ToolExecutor, "execute", spy)
    engine, calls = scripted_engine({"content": "Il titolo è Example Domain."})
    session = StubSession()
    result = browser_agent(engine, session).run("Apri https://example.com e dimmi il titolo")

    assert executed == [("browser_navigate", {"url": "https://example.com"})]
    assert session.visited == ["https://example.com"]
    assert result.content == "Il titolo è Example Domain."
    assert result.metadata["fast_path"] == "browser_navigate"
    # One model call only: the answer. It sees the tool result and only the
    # read-only follow-up tool (small prompt), never the whole pack.
    assert len(calls) == 1
    assert "Example Domain" in calls[0]["messages"][-1].content
    offered = [t["function"]["name"] for t in calls[0]["options"]["tools"]]
    assert offered == ["browser_extract"]


def test_private_url_is_still_blocked_by_the_real_browser_policy():
    engine, calls = scripted_engine({"content": "Non posso aprirla."})
    session = StubSession()
    fast = FastPath("browser_navigate", {"url": "http://127.0.0.1:11434/api/tags"})
    agent = OrchestratorAgent(
        engine,
        "m",
        tools=[BrowserNavigateTool(session), BrowserExtractTool(session)],
        temperature=0.1,
        max_tokens=512,
        fast_path=fast,
    )
    result = agent.run("Apri http://127.0.0.1:11434/api/tags")
    assert not result.tool_results[0].success
    assert "SSRF blocked" in result.tool_results[0].content
    assert session.visited == []  # the browser never saw the private address


def test_fast_path_keeps_tool_events_and_the_final_inference():
    bus = EventBus()
    seen = []
    for event_type in (
        EventType.INFERENCE_START,
        EventType.TOOL_CALL_START,
        EventType.TOOL_CALL_END,
    ):
        bus.subscribe(event_type, lambda e, t=event_type: seen.append(t))
    engine, _ = scripted_engine({"content": "Example Domain"})
    browser_agent(engine, StubSession(), bus=bus).run("Apri https://example.com")
    # tool_started -> tool_finished -> (thinking) the model writes the answer
    assert seen == [EventType.TOOL_CALL_START, EventType.TOOL_CALL_END, EventType.INFERENCE_START]


def test_fast_path_is_ignored_when_the_tool_is_not_in_the_turn():
    engine, calls = scripted_engine({"content": "4"})
    agent = OrchestratorAgent(
        engine,
        "m",
        tools=[CalculatorTool()],
        temperature=0.1,
        max_tokens=512,
        fast_path=FastPath("browser_navigate", {"url": "https://example.com"}),
    )
    result = agent.run("2+2")
    assert result.tool_results == [] and "fast_path" not in result.metadata
    assert len(calls) == 1


# ---------------------------------------------------------------- whole system: knowledge


@pytest.fixture
def knowledge_system(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "collaudo-lyra.md").write_text(
        "# Collaudo\n\nIl colore segreto è ametista.\n", encoding="utf-8"
    )
    # Longer than the 240-char search excerpt: the answer may need notes_read.
    (vault / "architettura.md").write_text(
        "# Architettura\n\n" + "Moduli, confini e contratti del sistema. " * 12, encoding="utf-8"
    )
    cfg = JarvisConfig()
    cfg.knowledge.enabled = True
    cfg.knowledge.vault_path = str(vault)
    cfg.memory.db_path = str(tmp_path / "memory.db")
    cfg.tools.workspace = str(tmp_path / "workspace")
    cfg.tools.enabled.extend(PACKS["knowledge"])
    with SystemBuilder(cfg).build() as system:
        yield system


def test_explicit_knowledge_search_skips_the_first_model_call(knowledge_system):
    engine, calls = scripted_engine({"content": "Il colore segreto è ametista."})
    knowledge_system.engine.generate = engine.generate
    result = knowledge_system.ask("Cerca nei miei appunti colore segreto")
    assert result["metadata"]["fast_path"] == "notes_search"
    assert result["tool_results"][0].success
    assert "collaudo-lyra.md" in result["tool_results"][0].content
    assert result["content"] == "Il colore segreto è ametista."
    # One short note, shown whole in the excerpt: the answer is written from a
    # minimal prompt (no tool schemas, no pack hint, no history).
    assert result["metadata"]["final_path"] == "minimal_synthesis"
    assert len(calls) == 1
    assert "tools" not in calls[0]["options"]
    assert calls[0]["messages"][0].content == SYNTHESIS_INSTRUCTION
    assert "ametista" in calls[0]["messages"][-1].content


def test_fast_path_follow_up_can_still_use_a_tool(knowledge_system):
    # A note longer than its excerpt: the agent loop stays, with notes_read offered.
    engine, calls = scripted_engine(
        {
            "content": "",
            "tool_calls": [{"name": "notes_read", "arguments": '{"path": "architettura.md"}'}],
        },
        {"content": "moduli e contratti"},
    )
    knowledge_system.engine.generate = engine.generate
    result = knowledge_system.ask("Cerca nelle note architettura")
    assert result["metadata"]["final_path"] == "agent_loop"
    assert [t["function"]["name"] for t in calls[0]["options"]["tools"]] == ["notes_read"]
    assert [r.tool_name for r in result["tool_results"]] == ["notes_search", "notes_read"]
    assert all(r.success for r in result["tool_results"])
    assert result["content"] == "moduli e contratti"


def test_vault_confinement_holds_on_the_fast_path_follow_up(knowledge_system):
    engine, _ = scripted_engine(
        {"content": "", "tool_calls": [{"name": "notes_read", "arguments": '{"path": "../x.md"}'}]},
        {"content": "non posso"},
    )
    knowledge_system.engine.generate = engine.generate
    result = knowledge_system.ask("Cerca nelle note architettura")
    assert not result["tool_results"][1].success


def test_ambiguous_knowledge_request_still_asks_the_model_first(knowledge_system):
    engine, calls = scripted_engine(
        {
            "content": "",
            "tool_calls": [{"name": "notes_search", "arguments": '{"query": "Petalo"}'}],
        },
        {"content": "niente"},
    )
    knowledge_system.engine.generate = engine.generate
    result = knowledge_system.ask("Cosa dicono i miei appunti su Petalo?")
    assert "fast_path" not in result["metadata"]
    assert len(calls) == 2
    assert len(calls[0]["options"]["tools"]) == len(PACKS["knowledge"])


def test_fast_path_can_be_disabled(knowledge_system):
    knowledge_system.config.agent.fast_path = False
    engine, calls = scripted_engine(
        {"content": "", "tool_calls": [{"name": "notes_search", "arguments": '{"query": "x"}'}]},
        {"content": "ok"},
    )
    knowledge_system.engine.generate = engine.generate
    result = knowledge_system.ask("Cerca nei miei appunti Petalo")
    assert "fast_path" not in result["metadata"] and len(calls) == 2


def test_websocket_sequence_with_fast_path(knowledge_system):
    engine, _ = scripted_engine({"content": "ametista"})
    knowledge_system.engine.generate = engine.generate
    cfg = knowledge_system.config
    client = TestClient(create_app(cfg, system=knowledge_system, health_engine=MagicMock()))
    with client:
        with client.websocket_connect("/ws") as ws:
            ws.receive_json()  # initial state
            body = client.post(
                "/api/chat", json={"message": "Cerca nei miei appunti il colore segreto"}
            ).json()
            events = []
            while True:
                event = ws.receive_json()
                events.append(event)
                if event == {"type": "state", "state": "idle"}:
                    break
    assert body["complete"] is True and body["content"] == "ametista"
    kinds = [e.get("state") or e["type"] for e in events]
    assert kinds == [
        "thinking",
        "using_tool",
        "tool_started",
        "tool_finished",
        "thinking",
        "response",
        "idle",
    ]


def test_profile_reports_where_the_time_goes(knowledge_system):
    engine, _ = scripted_engine(
        {"content": "ametista", "engine_timing": {"prompt_eval_duration": 2_000_000_000}},
        {"content": "ametista"},
    )
    knowledge_system.engine.generate = engine.generate
    meta = knowledge_system.ask("Cerca nei miei appunti il colore segreto", profile=True)[
        "metadata"
    ]
    timing = meta["timing"]
    assert [c["phase"] for c in timing["llm_calls"]] == ["minimal_synthesis"]
    assert timing["llm_calls"][0]["prompt_eval_seconds"] == 2.0
    assert [t["tool"] for t in timing["tools"]] == ["notes_search"]
    assert "route_seconds" in timing and timing["total_seconds"] >= 0
    # Not profiled: no timing in the public metadata.
    assert "timing" not in knowledge_system.ask("Cerca nei miei appunti il colore")["metadata"]


# ---------------------------------------------------------------- Ollama keep_alive


def capture_payloads(engine):
    payloads = []

    def respond(request):
        payloads.append(json.loads(request.content))
        return httpx.Response(200, json={"message": {"content": "ok"}, "done_reason": "stop"})

    engine._client.close()
    engine._client = httpx.Client(
        transport=httpx.MockTransport(respond), base_url="http://127.0.0.1:11434"
    )
    return payloads


def test_keep_alive_default_is_30_minutes_and_is_forwarded(tmp_path):
    cfg = JarvisConfig()
    cfg.memory.db_path = str(tmp_path / "memory.db")
    cfg.tools.workspace = str(tmp_path / "workspace")
    assert cfg.engine.keep_alive == "30m"
    with SystemBuilder(cfg).build() as system:
        payloads = capture_payloads(system.engine)
        system.ask("Rispondi soltanto con: ok", pack="chat")
    assert payloads[0]["keep_alive"] == "30m"


def test_keep_alive_custom_value_and_opt_out(tmp_path):
    config = tmp_path / "config.toml"
    config.write_text(
        f'[engine]\nkeep_alive = "2h"\n[memory]\ndb_path = "{(tmp_path / "m.db").as_posix()}"\n'
    )
    assert load_config(config).engine.keep_alive == "2h"
    engine = OllamaEngine("http://127.0.0.1:11434", keep_alive="-1")
    payloads = capture_payloads(engine)
    engine.generate([], model="m")
    assert payloads[0]["keep_alive"] == "-1"
    # Empty / not set: nothing sent, Ollama's own default applies.
    plain = OllamaEngine("http://127.0.0.1:11434")
    payloads = capture_payloads(plain)
    plain.generate([], model="m")
    assert "keep_alive" not in payloads[0]


@pytest.mark.parametrize("value", ["forever", "30 minutes", "m30", "5d"])
def test_keep_alive_rejects_non_ollama_durations(value):
    cfg = JarvisConfig()
    cfg.engine.keep_alive = value
    with pytest.raises(ValueError, match="keep_alive"):
        cfg.validate()
