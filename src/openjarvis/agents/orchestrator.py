"""OpenJarvis function-calling orchestrator, reduced for a local 2B model."""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, List, Optional

from openjarvis.agents._stubs import AgentContext, AgentResult, ToolUsingAgent
from openjarvis.core.events import EventBus
from openjarvis.core.registry import AgentRegistry
from openjarvis.core.types import Message, Role, ToolCall, ToolResult
from openjarvis.engine._stubs import InferenceEngine
from openjarvis.tools._stubs import BaseTool

logger = logging.getLogger(__name__)


@AgentRegistry.register("orchestrator")
class OrchestratorAgent(ToolUsingAgent):
    """Bounded sequential tool loop over an already selected capability pack."""

    agent_id = "orchestrator"
    _default_temperature = 0.7
    _default_max_tokens = 1024
    _default_max_turns = 10

    def __init__(
        self,
        engine: InferenceEngine,
        model: str,
        *,
        tools: Optional[List[BaseTool]] = None,
        bus: Optional[EventBus] = None,
        max_turns: Optional[int] = None,
        temperature: Optional[float] = None,
        max_tokens: Optional[int] = None,
        system_prompt: Optional[str] = None,
        prompt_builder: Optional[Any] = None,
        interactive: bool = False,
        confirm_callback=None,
        capability_policy: Optional[Any] = None,
        agent_id: Optional[str] = None,
        rate_limiter: Optional[Any] = None,
        engine_options: Optional[dict] = None,
        max_tool_calls: int = 5,
        max_tool_output_chars: int = 1200,
        max_prompt_bytes: int = 12000,
        require_tool_use: bool = False,
        before_tool_call: Optional[Callable[[str, dict[str, Any]], bool]] = None,
    ) -> None:
        super().__init__(
            engine,
            model,
            tools=tools,
            bus=bus,
            max_turns=max_turns,
            temperature=temperature,
            max_tokens=max_tokens,
            interactive=interactive,
            confirm_callback=confirm_callback,
            prompt_builder=prompt_builder,
            loop_guard_config={"max_identical_calls": 2, "warn_before_block": False},
            capability_policy=capability_policy,
            agent_id=agent_id,
            rate_limiter=rate_limiter,
        )
        self._engine_options = engine_options or {}
        self._max_tool_calls = max_tool_calls
        self._max_tool_output_chars = max_tool_output_chars
        self._max_prompt_bytes = max_prompt_bytes
        self._require_tool_use = require_tool_use
        if len(self._tools) > 5:
            raise ValueError("Lite accepts at most five tools per turn")
        self._system_prompt = system_prompt
        self._before_tool_call = before_tool_call

    def run(
        self,
        input: str,
        context: Optional[AgentContext] = None,
        **kwargs: Any,
    ) -> AgentResult:
        return self._run_function_calling(input, context, **kwargs)

    # ------------------------------------------------------------------
    # Governance hook
    # ------------------------------------------------------------------

    @staticmethod
    def _governance_denial(tool_name: str, reason: str) -> ToolResult:
        return ToolResult(
            tool_name=tool_name,
            content=(
                f"[Governance] Tool '{tool_name}' was not approved ({reason}). "
                "Adjust your plan and try a different approach."
            ),
            success=False,
        )

    def _check_tool_allowed(self, tc: ToolCall) -> Optional[ToolResult]:
        """Call before_tool_call hook if set.

        Returns None to allow execution, or a denial ToolResult to inject
        instead of running the tool. Invalid arguments and hook failures deny
        execution so a governance integration cannot fail open.
        """
        if self._before_tool_call is None:
            return None

        try:
            tool_args = json.loads(tc.arguments) if tc.arguments else {}
        except (json.JSONDecodeError, TypeError):
            return self._governance_denial(tc.name, "invalid tool arguments")
        if not isinstance(tool_args, dict):
            return self._governance_denial(tc.name, "tool arguments are not an object")

        try:
            allowed = self._before_tool_call(tc.name, tool_args)
        except Exception:
            logger.exception("before_tool_call hook failed for tool %s", tc.name)
            return self._governance_denial(tc.name, "governance check failed")
        if allowed:
            return None
        return self._governance_denial(tc.name, "policy denied the call")

    def _run_function_calling(
        self,
        input: str,
        context: Optional[AgentContext] = None,
        **kwargs: Any,
    ) -> AgentResult:
        self._emit_turn_start(input)

        # Build initial messages
        messages = self._build_messages(
            input,
            context,
            system_prompt=self._system_prompt,
        )

        # Get OpenAI-format tool definitions
        openai_tools = self._executor.get_openai_tools() if self._tools else []

        all_tool_results: list[ToolResult] = []
        turns = 0
        executed_calls = 0
        stored_notes = set()
        tool_repair_attempted = False
        if self._loop_guard:
            self._loop_guard.reset()
        total_prompt_tokens = 0
        total_completion_tokens = 0

        for _turn in range(self._max_turns):
            turns += 1

            if self._loop_guard:
                messages = self._loop_guard.compress_context(messages)

            # Build generate kwargs
            gen_kwargs: dict[str, Any] = {}
            if openai_tools:
                gen_kwargs["tools"] = openai_tools

            from openjarvis.engine._base import messages_to_dicts

            prompt_size = len(
                json.dumps(
                    {"messages": messages_to_dicts(messages), "tools": openai_tools},
                    ensure_ascii=False,
                ).encode("utf-8")
            )
            if prompt_size > self._max_prompt_bytes:
                return AgentResult(
                    content="Contesto troppo lungo: dividi la richiesta in passi.",
                    tool_results=all_tool_results,
                    turns=turns - 1,
                    metadata={"context_limit": True},
                )
            result = self._generate(messages, **gen_kwargs)

            # Accumulate token usage
            usage = result.get("usage", {})
            total_prompt_tokens += usage.get("prompt_tokens", 0)
            total_completion_tokens += usage.get("completion_tokens", 0)

            content = result.get("content", "")
            raw_tool_calls = result.get("tool_calls", [])

            # No tool calls -> check continuation, then final answer
            if not raw_tool_calls:
                if self._require_tool_use and not any(r.success for r in all_tool_results):
                    if not tool_repair_attempted and not all_tool_results:
                        tool_repair_attempted = True
                        messages.append(
                            Message(
                                role=Role.USER,
                                content=(
                                    "Non hai ancora consultato gli strumenti. "
                                    "Esegui ora il tool pertinente alla richiesta, "
                                    "poi rispondi usando il suo risultato."
                                ),
                            )
                        )
                        continue
                    return AgentResult(
                        content="Non ho ottenuto una verifica dagli strumenti. Non posso confermare il risultato.",
                        tool_results=all_tool_results,
                        turns=turns,
                        metadata={"missing_tool_use": True},
                    )
                content = result.get("content", "")
                content = self._strip_think_tags(content)
                self._emit_turn_end(turns=turns, content_length=len(content))
                return AgentResult(
                    content=content,
                    tool_results=all_tool_results,
                    turns=turns,
                    metadata={
                        "prompt_tokens": total_prompt_tokens,
                        "completion_tokens": total_completion_tokens,
                        "truncated": result.get("finish_reason") == "length",
                        "total_tokens": total_prompt_tokens + total_completion_tokens,
                    },
                )

            if not isinstance(raw_tool_calls, list) or any(
                not isinstance(tc, dict) or not isinstance(tc.get("name"), str)
                for tc in raw_tool_calls
            ):
                return AgentResult(
                    content="Risposta tool non valida dal modello.",
                    tool_results=all_tool_results,
                    turns=turns,
                    metadata={"invalid_tool_calls": True},
                )
            if len(raw_tool_calls) > 1:
                # Reject the whole batch: no partial side effects, no dangling tool messages.
                messages.append(Message(role=Role.USER, content="Chiama un solo tool alla volta."))
                continue
            if executed_calls >= self._max_tool_calls:
                return AgentResult(
                    content="Limite di chiamate tool raggiunto. Richiesta incompleta.",
                    tool_results=all_tool_results,
                    turns=turns,
                    metadata={"tool_call_limit": True},
                )
            executed_calls += 1
            # Build ToolCall objects from raw dicts
            tool_calls = [
                ToolCall(
                    id=f"call_{turns}_{i}",
                    name=tc.get("name", ""),
                    arguments=(
                        json.dumps(tc.get("arguments"))
                        if isinstance(tc.get("arguments"), dict)
                        else tc.get("arguments", "{}")
                    ),
                )
                for i, tc in enumerate(raw_tool_calls)
            ]

            # Append assistant message with tool calls
            messages.append(
                Message(
                    role=Role.ASSISTANT,
                    content=content,
                    tool_calls=tool_calls,
                )
            )

            # Execute each tool (with loop guard check) and append results
            # Sequential execution
            for tc in tool_calls:
                # Never repeat the same successful memory write in one request.
                try:
                    note_key = json.dumps(json.loads(tc.arguments), sort_keys=True)
                except (TypeError, ValueError):
                    note_key = str(tc.arguments)
                if tc.name == "memory_store" and note_key in stored_notes:
                    denial = ToolResult(
                        tool_name=tc.name, content="Nota già salvata.", success=False
                    )
                else:
                    denial = self._check_tool_allowed(tc)
                # Governance hook check before execution
                if denial is not None:
                    all_tool_results.append(denial)
                    messages.append(
                        Message(
                            role=Role.TOOL,
                            content=denial.content,
                            tool_call_id=tc.id,
                            name=tc.name,
                        )
                    )
                    continue

                # Loop guard check before execution
                if self._loop_guard:
                    verdict = self._loop_guard.check_call(
                        tc.name,
                        tc.arguments,
                    )
                    if verdict.blocked:
                        tool_result = ToolResult(
                            tool_name=tc.name,
                            content=f"Loop guard: {verdict.reason}",
                            success=False,
                        )
                        all_tool_results.append(tool_result)
                        messages.append(
                            Message(
                                role=Role.TOOL,
                                content=tool_result.content,
                                tool_call_id=tc.id,
                                name=tc.name,
                            )
                        )
                        continue

                tool_result = self._executor.execute(tc)
                if tool_result.metadata.get("timeout"):
                    all_tool_results.append(tool_result)
                    return AgentResult(
                        content="Tool in timeout; esito incerto. Verifica prima di ripetere l'azione.",
                        tool_results=all_tool_results,
                        turns=turns,
                        metadata={"tool_timeout": True},
                    )
                if tool_result.success and tc.name == "memory_store":
                    stored_notes.add(note_key)
                if len(tool_result.content) > self._max_tool_output_chars:
                    tool_result.content = (
                        tool_result.content[: self._max_tool_output_chars] + "\n[Troncato]"
                    )
                    tool_result.metadata["truncated"] = True
                if not tool_result.success:
                    tool_result.content = "Errore: " + tool_result.content
                all_tool_results.append(tool_result)

                # Append tool response message
                messages.append(
                    Message(
                        role=Role.TOOL,
                        content=tool_result.content,
                        tool_call_id=tc.id,
                        name=tc.name,
                    )
                )

        # Max turns exceeded
        self._emit_turn_end(turns=turns, max_turns_exceeded=True)
        return AgentResult(
            content="Maximum turns reached without a final answer. Richiesta incompleta.",
            tool_results=all_tool_results,
            turns=turns,
            metadata={
                "max_turns_exceeded": True,
                "prompt_tokens": total_prompt_tokens,
                "completion_tokens": total_completion_tokens,
                "total_tokens": total_prompt_tokens + total_completion_tokens,
            },
        )


__all__ = ["OrchestratorAgent"]
