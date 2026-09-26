"""Bounded capability selection, independent from inference or learning.

A future router (including Laya) passes a pack name to JarvisSystem.ask.
It cannot supply tool instances or bypass tools.enabled.
"""

from __future__ import annotations
import re

PACKS = {
    "chat": (),
    "general": ("calculator",),
    "files": ("file_read",),
    "memory": ("memory_store", "memory_retrieve"),
    "knowledge": ("notes_search", "notes_read", "notes_write", "notes_append"),
    "browser": ("browser_navigate", "browser_click", "browser_type", "browser_extract"),
}

# Short, pack-specific grounding. No full catalog, YAML descriptions or few-shot library.
PACK_HINTS = {
    "chat": "Non hai strumenti in questo turno.",
    "general": "Per i calcoli richiesti usa calculator prima di fornire il risultato.",
    "files": "Per leggere un file devi chiamare file_read. Non conosci il contenuto in anticipo.",
    "memory": (
        "Per cercare o ricordare note già salvate DEVI chiamare memory_retrieve prima di rispondere. "
        "Non dire che una nota manca senza averla cercata. "
        "Per salvare una nuova nota richiesta dall'utente usa memory_store."
    ),
    "knowledge": (
        "Le note sono file Markdown nel vault. Usa notes_search per cercare, notes_read per leggere. "
        "Usa path relativi con estensione .md. notes_write sostituisce tutto il file; "
        "notes_append aggiunge testo senza separatori automatici. Scrivi solo su richiesta. "
        "Non inventare contenuti: devi usare un tool prima di rispondere."
    ),
    "browser": (
        "Per aprire un sito usa browser_navigate; per leggere la pagina corrente usa browser_extract. "
        "Per un click usa browser_click; per compilare un campo usa browser_type. "
        "Non descrivere pagine che non hai letto con gli strumenti."
    ),
}


def route_pack(query: str) -> str:
    text = query.casefold()
    matches = []
    rules = {
        "memory": r"\b(ricorda|ricordi|ricordami|memorizza|memoria|remember|recall|memory)\b",
        "knowledge": r"\b(vault|obsidian|markdown|knowledge|nota|note|notes|appunti)\b|\.md\b",
        "files": r"\b(file|documento|cartella|leggi|read)\b",
        "browser": r"https?://|\b(browser|sito|pagina|web|naviga|clicca|click|site|page)\b",
    }
    for name, pattern in rules.items():
        if re.search(pattern, text):
            matches.append(name)
    # Explicit vault language dominates generic read/remember verbs.
    if "knowledge" in matches:
        matches = [m for m in matches if m != "files"]
        if not re.search(r"\b(memoria|memory)\b", text):
            matches = [m for m in matches if m != "memory"]
    # A URL/page plus 'read' is an unambiguous browser read.
    if set(matches) == {"files", "browser"} and not re.search(r"\b(file|cartella)\b", text):
        return "browser"
    if len(matches) > 1:
        raise ValueError("Richiesta con più capability: scegli --pack e dividila in passi.")
    return matches[0] if matches else "general"


def select_tools(query: str, pack: str | None, tools: dict):
    selected = route_pack(query) if pack is None else pack
    if selected not in PACKS:
        raise ValueError(f"Unknown pack: {selected}. Choose: {', '.join(PACKS)}")
    names = PACKS[selected]
    if len(names) > 5:
        raise ValueError("A Lite pack cannot contain more than 5 tools")
    resolved = [tools[name] for name in names if name in tools]
    if names and not resolved:
        raise ValueError(f"Pack '{selected}' is disabled by tools.enabled")
    return selected, resolved
