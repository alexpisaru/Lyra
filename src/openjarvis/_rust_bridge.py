"""Single point of contact between Python and the Rust ``openjarvis_rust`` module.

Every Python module that wants to delegate to Rust should import helpers from
here rather than importing ``openjarvis_rust`` directly.  The Rust backend is
optional — if it cannot be imported, a hard ``ImportError`` is raised.
"""

from __future__ import annotations

import functools
import json
from typing import TYPE_CHECKING, List

if TYPE_CHECKING:
    import types as _types

# ---------------------------------------------------------------------------
# Mandatory import — Rust backend is required
# ---------------------------------------------------------------------------


@functools.lru_cache(maxsize=1)
def get_rust_module() -> _types.ModuleType:
    """Return the ``openjarvis_rust`` module.

    Raises ``ImportError`` if the compiled extension is not available.
    The Rust backend is optional for all modules that have Rust
    implementations — callers provide Python fallbacks.
    """
    import openjarvis_rust  # type: ignore[import-untyped]

    return openjarvis_rust


def _detect_rust() -> bool:
    """Return ``True`` if the compiled ``openjarvis_rust`` extension is importable.

    Computed once at import time. Modules with a Python fallback (e.g.
    ``security.ssrf``) consult this flag instead of hardcoding availability,
    so the fallback is actually reachable when the extension was not built.
    """
    try:
        get_rust_module()
    except ImportError:
        return False
    return True


RUST_AVAILABLE: bool = _detect_rust()


# ---------------------------------------------------------------------------
# JSON -> Python dataclass converters
# ---------------------------------------------------------------------------


def injection_result_from_json(json_str: str) -> object:
    """Convert Rust ``InjectionScanner.scan()`` JSON to dataclass."""
    from openjarvis.security.injection_scanner import (
        InjectionScanResult,
    )
    from openjarvis.security.types import ScanFinding, ThreatLevel

    data = json.loads(json_str)
    findings: List[ScanFinding] = []
    for f in data.get("findings", []):
        findings.append(
            ScanFinding(
                pattern_name=f.get("pattern_name", ""),
                matched_text=f.get("matched_text", ""),
                threat_level=ThreatLevel(
                    f.get("threat_level", "low").lower(),
                ),
                start=f.get("start", 0),
                end=f.get("end", 0),
                description=f.get("description", ""),
            )
        )

    threat_raw = data.get("threat_level", "low").lower()
    try:
        threat = ThreatLevel(threat_raw)
    except ValueError:
        threat = ThreatLevel.LOW

    return InjectionScanResult(
        is_clean=data.get("is_clean", True),
        findings=findings,
        threat_level=threat,
    )


# ---------------------------------------------------------------------------
