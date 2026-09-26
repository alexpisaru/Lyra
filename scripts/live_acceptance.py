"""Live acceptance with the real model: knowledge vault, memory separation, optional browser.

Usage:  python scripts/live_acceptance.py --config config/lite.toml [--real-dirs] [--browser]
            [--out live-acceptance.json]

By default vault and memory go to a temporary directory, so the real vault is not
touched; --real-dirs uses the configured paths (and leaves lyra-collaudo.md there).
Every outcome is recorded, pass or fail. "ok" means: the expected tool ran
successfully and the expected text is in the tool output or answer. It does NOT
grade the model's prose; read the "answer" fields. Exit code 1 if any check fails.
"""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path

from openjarvis.core.config import load_config
from openjarvis.system import SystemBuilder

NOTE = "lyra-collaudo.md"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--real-dirs", action="store_true")
    parser.add_argument("--browser", action="store_true")
    parser.add_argument("--out", default="live-acceptance.json")
    args = parser.parse_args()

    cfg = load_config(args.config)
    tmp = None
    if not args.real_dirs:
        tmp = tempfile.TemporaryDirectory(prefix="lyra-acceptance-")
        cfg.knowledge.enabled = True
        cfg.knowledge.vault_path = str(Path(tmp.name) / "vault")
        cfg.memory.db_path = str(Path(tmp.name) / "state" / "memory.db")
        (Path(tmp.name) / "state").mkdir()
        cfg.validate()
    vault = Path(cfg.knowledge.vault_path)
    results = []

    def record(entry):
        results.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

    def ask(label, query, expect_tool, expect_text=None):
        with SystemBuilder(cfg).build() as system:
            start = time.monotonic()
            try:
                result, error = system.ask(query), None
            except Exception as exc:
                result, error = None, str(exc)
            seconds = round(time.monotonic() - start, 2)
        entry = {"label": label, "query": query, "seconds": seconds}
        if result is None:
            return record({**entry, "ok": False, "error": error})
        calls = [(t.tool_name, t.success) for t in result["tool_results"]]
        blob = result["content"] + " ".join(t.content for t in result["tool_results"])
        ok = any(name == expect_tool and success for name, success in calls)
        if expect_text:
            ok = ok and expect_text.lower() in blob.lower()
        record(
            {
                **entry,
                "ok": ok,
                "pack": result["metadata"]["pack"],
                "tools_offered": result["metadata"]["tools"],
                "tool_calls": calls,
                "browser_backend": result["metadata"].get("browser_backend"),
                "answer": result["content"][:300],
            }
        )

    ask("notes_write", f"Usa notes_write per creare {NOTE} con il testo ORCHIDEA-742", "notes_write")
    path = vault / NOTE
    text = path.read_text(encoding="utf-8") if path.exists() else ""
    record({"label": "file_on_disk", "ok": "ORCHIDEA-742" in text, "path": str(path)})
    ask("notes_search", "Cerca ORCHIDEA nelle mie note", "notes_search", NOTE)
    # External edit, exactly as Obsidian or any editor would do it.
    path.write_text("# Collaudo\nGIRASOLE-913 modificato fuori da Lyra\n", encoding="utf-8")
    ask("search_after_external_edit", "Cerca GIRASOLE nelle note", "notes_search", "GIRASOLE-913")
    ask("notes_read", f"Leggi la nota {NOTE}", "notes_read", "GIRASOLE-913")
    before = sorted(p.relative_to(vault).as_posix() for p in vault.rglob("*.md"))
    ask("memory_store", "Memorizza nella memoria: il mio colore preferito è verde smeraldo",
        "memory_store")
    after = sorted(p.relative_to(vault).as_posix() for p in vault.rglob("*.md"))
    record({"label": "memory_does_not_touch_vault", "ok": before == after})
    ask("memory_retrieve", "Cerca nella memoria il mio colore preferito", "memory_retrieve",
        "smeraldo")
    if args.browser:
        ask("browser_navigate", "Apri https://example.com e dimmi il titolo della pagina",
            "browser_navigate", "Example Domain")

    Path(args.out).write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    passed = sum(bool(r["ok"]) for r in results)
    print(f"PASSED {passed} of {len(results)} -> {args.out}")
    if tmp is not None:
        tmp.cleanup()
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
