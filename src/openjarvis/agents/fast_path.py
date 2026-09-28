"""Deterministic fast paths for unambiguous tool intents.

On the CT's CPU the model reads its prompt at ~25 tokens/s, and the first
tool-choosing call of the knowledge/browser packs carries four tool schemas:
30-50 s just to decide an obvious ``notes_search`` or ``browser_navigate``.
For a few high-precision phrasings the first tool call is known in advance, so
the agent skips that model call and runs the tool straight away.

This only chooses the *first* call. The call is still executed by the agent's
own ToolExecutor (argument validation, SSRF guard, vault confinement, taint,
events), and the model still writes the answer from the tool result.

Deliberately conservative: when in doubt, return None and let the model decide.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# After a fast path the model gets only the read-only follow-up tool of the pack
# (small prompt), so it can still read further instead of guessing.
FOLLOWUP_TOOLS = {
    "notes_search": ("notes_read",),
    "browser_navigate": ("browser_extract",),
}


@dataclass(frozen=True)
class FastPath:
    tool: str
    arguments: dict = field(default_factory=dict)


# ---------------------------------------------------------------- knowledge
_SEARCH_VERB = r"(?:cerca|trova|ricerca)"
_NOTES_PLACE = (
    r"(?:nei|nelle|negli|nel|nella|tra\s+i|tra\s+le|fra\s+i|fra\s+le)\s+"
    r"(?:miei\s+|mie\s+)?(?:appunti|note|knowledge|vault)"
)
_SEARCH_PLACE_FIRST = re.compile(
    rf"^{_SEARCH_VERB}\s+{_NOTES_PLACE}\s*[:,\-]?\s+(?P<query>.+)$", re.IGNORECASE | re.DOTALL
)
_SEARCH_PLACE_LAST = re.compile(
    rf"^{_SEARCH_VERB}\s+(?P<query>.+?)\s+{_NOTES_PLACE}\s*[.!?]*$", re.IGNORECASE | re.DOTALL
)
# A search phrase that also asks to change the vault is not a plain search.
_WRITE_INTENT = re.compile(
    r"\b(scrivi|aggiungi|salva|modifica|crea|cancella|elimina|sostituisci|annota)\b", re.IGNORECASE
)
# notes_search accepts 1..300 characters (tools/knowledge.py).
_MAX_QUERY = 300


def _knowledge(text: str) -> FastPath | None:
    if _WRITE_INTENT.search(text):
        return None
    match = _SEARCH_PLACE_FIRST.match(text) or _SEARCH_PLACE_LAST.match(text)
    if not match:
        return None
    query = match.group("query").strip().rstrip(".!?;:,").strip()
    if not re.search(r"\w{2,}", query) or len(query) > _MAX_QUERY:
        return None
    return FastPath("notes_search", {"query": query})


# ---------------------------------------------------------------- browser
_URL = re.compile(r"https?://[^\s<>\"'`]+", re.IGNORECASE)
_NAV_VERB = (
    r"(?:apri|visita|vai\s+(?:su|a|al|alla|sul)|naviga(?:\s+(?:su|a|verso|al|alla|sul))?"
    r"|open|visit|go\s+to|navigate\s+to)"
)
_NAVIGATE = re.compile(
    rf"^{_NAV_VERB}\s+(?:(?:la\s+pagina|il\s+sito|l'indirizzo|the\s+page)\s+)?(?P<url>https?://\S+)"
    r"(?P<rest>\s.*)?$",
    re.IGNORECASE | re.DOTALL,
)
# Interactive follow-ups need the model's planning: never fast-path them.
_INTERACTION = re.compile(
    r"\b(clicca|click|premi|scrivi|digita|compila|inserisci|accedi|login|registrati|invia|"
    r"acquista|compra|paga|type|fill|submit)\b",
    re.IGNORECASE,
)


def _browser(text: str) -> FastPath | None:
    urls = _URL.findall(text)
    if len(urls) != 1:
        return None  # no URL is never invented; several URLs are ambiguous
    match = _NAVIGATE.match(text)
    if not match:
        return None
    if _INTERACTION.search(match.group("rest") or ""):
        return None
    url = match.group("url").rstrip(".,;:!?)]}»\"'")
    if url != urls[0].rstrip(".,;:!?)]}»\"'"):
        return None
    return FastPath("browser_navigate", {"url": url})


def detect_fast_path(
    query: str, pack: str, available: set[str] | frozenset[str]
) -> FastPath | None:
    """The first tool call for *query* in *pack*, or None when the model must decide."""
    text = " ".join(query.split())
    if not text:
        return None
    if pack == "knowledge" and "notes_search" in available:
        return _knowledge(text)
    if pack == "browser" and "browser_navigate" in available:
        return _browser(text)
    return None


__all__ = ["FOLLOWUP_TOOLS", "FastPath", "detect_fast_path"]
