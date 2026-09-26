"""RBAC capability system — fine-grained permission model for tool dispatch."""

from __future__ import annotations

import logging
from enum import Enum
from typing import Any, Dict, List

logger = logging.getLogger(__name__)


class Capability(str, Enum):
    """Fine-grained capability labels."""

    FILE_READ = "file:read"
    FILE_WRITE = "file:write"
    NETWORK_FETCH = "network:fetch"
    CODE_EXECUTE = "code:execute"
    MEMORY_READ = "memory:read"
    MEMORY_WRITE = "memory:write"
    CHANNEL_SEND = "channel:send"
    TOOL_INVOKE = "tool:invoke"
    SCHEDULE_CREATE = "schedule:create"
    SYSTEM_ADMIN = "system:admin"


# Canonical capability requirements for every in-tree tool.  This table is a
# security floor: ToolSpec declarations may add requirements, but they may not
# weaken these.  Keep explicitly-safe tools in the table with an empty list so
# an omitted future built-in can be distinguished from a reviewed safe one.
DEFAULT_TOOL_CAPABILITIES: Dict[str, List[str]] = {
    "calculator": [],
    "file_read": [Capability.FILE_READ],
    "memory_store": [Capability.MEMORY_WRITE],
    "memory_retrieve": [Capability.MEMORY_READ],
    "browser_navigate": [Capability.NETWORK_FETCH],
    "browser_click": [Capability.NETWORK_FETCH],
    "browser_type": [Capability.NETWORK_FETCH],
    "browser_extract": [Capability.NETWORK_FETCH],
}

_SAFE_BUILTIN_PROVENANCE = {
    "calculator": ("openjarvis.tools.calculator", "CalculatorTool"),
}


def canonical_tool_capabilities(tool: Any) -> List[str]:
    """Return the non-bypassable capability floor for *tool*.

    Third-party tools remain governed by their ToolSpec.  An in-tree tool that
    was newly registered without being inventoried fails closed as
    ``system:admin`` instead of silently becoming unrestricted.
    """
    module = type(tool).__module__
    name = tool.spec.name
    is_builtin = (
        module == "openjarvis.tools"
        or module.startswith("openjarvis.tools.")
        or module == "openjarvis.scheduler.tools"
    )
    if module == "openjarvis.tools.mcp_adapter":
        # MCP tool names are remote-controlled.  Resolve adapter provenance
        # before the name table so a server cannot impersonate a reviewed-safe
        # local tool such as ``calculator`` or ``think``.
        return [Capability.TOOL_INVOKE]
    if is_builtin:
        if name in DEFAULT_TOOL_CAPABILITIES:
            canonical = list(DEFAULT_TOOL_CAPABILITIES[name])
            expected = _SAFE_BUILTIN_PROVENANCE.get(name)
            if (
                expected is not None
                and (
                    module,
                    type(tool).__name__,
                )
                != expected
            ):
                logger.error(
                    "Tool %r claimed reviewed-safe built-in provenance from %s.%s",
                    name,
                    module,
                    type(tool).__name__,
                )
                return [Capability.SYSTEM_ADMIN]
            return canonical
        logger.error("Built-in tool %r has no canonical capability inventory", name)
        return [Capability.SYSTEM_ADMIN]
    if name in DEFAULT_TOOL_CAPABILITIES:
        canonical = list(DEFAULT_TOOL_CAPABILITIES[name])
        # Third-party tools that collide with a privileged name retain its
        # security floor.  Reviewed-safe names are safe only for their in-tree
        # implementation and therefore fail closed on foreign provenance.
        return canonical or [Capability.SYSTEM_ADMIN]
    return []
