"""Canonical data types shared across all OpenJarvis primitives."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional  # noqa: I001

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------


class Role(str, Enum):
    """Chat message roles (OpenAI-compatible)."""

    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL = "tool"


# ---------------------------------------------------------------------------
# Message types
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ToolCall:
    """A single tool invocation request embedded in an assistant message."""

    id: str
    name: str
    arguments: str  # JSON string


@dataclass(slots=True)
class Message:
    """A single chat message (OpenAI-compatible structure)."""

    role: Role
    content: str | None = ""
    name: Optional[str] = None
    tool_calls: Optional[List[ToolCall]] = None
    tool_call_id: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    # Base64-encoded image data for vision-capable models (e.g. gemma3,
    # qwen2.5-vl). Forwarded to Ollama's /api/chat "images" field; None or
    # empty for text-only messages (the common case).
    images: Optional[List[str]] = None

    @property
    def text(self) -> str:
        """Return message content as text, treating ``None`` as empty."""
        return self.content or ""


@dataclass(slots=True)
class Conversation:
    """Ordered list of messages with an optional sliding-window cap."""

    messages: List[Message] = field(default_factory=list)
    max_messages: Optional[int] = None

    def add(self, message: Message) -> None:
        """Append a message, trimming oldest if *max_messages* is set."""
        self.messages.append(message)
        if self.max_messages is not None and len(self.messages) > self.max_messages:
            self.messages = self.messages[-self.max_messages :]

    def window(self, n: int) -> List[Message]:
        """Return the last *n* messages."""
        if n <= 0:
            return []
        return self.messages[-n:]


# ---------------------------------------------------------------------------
# Model / tool / telemetry records
# ---------------------------------------------------------------------------


@dataclass(slots=True)
class ToolResult:
    """Result returned by a tool invocation."""

    tool_name: str
    content: str
    success: bool = True
    usage: Dict[str, Any] = field(default_factory=dict)
    cost_usd: float = 0.0
    latency_seconds: float = 0.0
    metadata: Dict[str, Any] = field(default_factory=dict)


def _message_to_dict(msg: "Message") -> Dict[str, Any]:
    """Serialize a Message to a JSON-safe dict."""
    d: Dict[str, Any] = {"role": msg.role.value, "content": msg.content}
    if msg.name:
        d["name"] = msg.name
    if msg.tool_calls:
        d["tool_calls"] = [
            {"id": tc.id, "name": tc.name, "arguments": tc.arguments} for tc in msg.tool_calls
        ]
    if msg.tool_call_id:
        d["tool_call_id"] = msg.tool_call_id
    return d
