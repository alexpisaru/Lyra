"""Reduced JarvisSystem: same agent and executor, one pack per user turn."""

from __future__ import annotations
from dataclasses import dataclass, field
from threading import Lock
from typing import Any
from openjarvis.agents._stubs import AgentContext
from openjarvis.agents.orchestrator import OrchestratorAgent
from openjarvis.core.types import Conversation, Message, Role
from openjarvis.tools.packs import PACK_HINTS, select_tools


@dataclass
class JarvisSystem:
    config: Any
    bus: Any
    engine: Any
    tools: dict = field(default_factory=dict)
    memory_backend: Any = None
    browser_session: Any = None
    knowledge_vault: Any = None
    _lock: Any = field(default_factory=Lock, repr=False)
    _closed: bool = False

    def ask(self, query, *, pack=None, prior_messages=None, confirm_callback=None):
        # One local user/session per system; browser state and SQLite are shared.
        with self._lock:
            if self._closed:
                raise RuntimeError("JarvisSystem is closed")
            selected, tools = select_tools(query, pack, self.tools)
            cfg = self.config
            agent = OrchestratorAgent(
                self.engine,
                cfg.intelligence.model,
                tools=tools,
                bus=self.bus,
                max_turns=cfg.agent.max_turns,
                temperature=cfg.intelligence.temperature,
                max_tokens=cfg.intelligence.max_tokens,
                system_prompt=cfg.agent.default_system_prompt + "\n" + PACK_HINTS[selected],
                interactive=confirm_callback is not None,
                confirm_callback=confirm_callback,
                max_tool_calls=cfg.agent.max_tool_calls,
                max_tool_output_chars=cfg.agent.max_tool_output_chars,
                max_prompt_bytes=cfg.agent.max_prompt_bytes,
                require_tool_use=selected in ("memory", "knowledge", "files", "browser"),
                engine_options={"num_ctx": cfg.intelligence.num_ctx},
            )
            history = self._history(prior_messages or [], cfg.agent.history_chars)
            result = agent.run(query, AgentContext(conversation=Conversation(messages=history)))
            return {
                "content": result.content,
                "tool_results": result.tool_results,
                "turns": result.turns,
                "metadata": {
                    **result.metadata,
                    "pack": selected,
                    "browser_backend": (
                        self.browser_session.active_backend if self.browser_session else None
                    ),
                    "tools": [t.spec.name for t in tools],
                },
            }

    @staticmethod
    def _history(messages, limit):
        # Complete user/assistant pairs only; no orphan tool calls or old systems.
        pairs = []
        pending = None
        for message in messages:
            if message.role == Role.USER:
                pending = message
            elif message.role == Role.ASSISTANT and pending is not None and not message.tool_calls:
                pairs.append(
                    [
                        Message(role=Role.USER, content=pending.text),
                        Message(role=Role.ASSISTANT, content=message.text),
                    ]
                )
                pending = None
        result = []
        for pair in reversed(pairs):
            size = sum(len(m.text) for m in pair)
            if size > limit:
                break
            limit -= size
            result[0:0] = pair
        return result

    def close(self):
        with self._lock:
            if self._closed:
                return
            try:
                if self.browser_session is not None:
                    self.browser_session.close()
            finally:
                try:
                    if self.memory_backend is not None:
                        self.memory_backend.close()
                finally:
                    try:
                        if self.knowledge_vault is not None:
                            self.knowledge_vault.close()
                    finally:
                        self.engine.close()
                        self._closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
