"""Opt-in latency benchmark for Lyra Core (not part of the unit tests).

Runs a few fixed requests through the real JarvisSystem (same path as the API)
against the configured Ollama model and prints one JSON line per request:
where the time goes (routing, model before/after the tool, tool), whether a
fast path skipped the first model call, and Ollama's own load/prompt/eval split.

    python scripts/perf_smoke.py --config ~/.openjarvis-lite/config.toml
    python scripts/perf_smoke.py --config cfg.toml --only knowledge,browser

Needs a reachable Ollama with the configured model; the knowledge case needs a
vault note containing the "colore segreto" of the Lyra acceptance test.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

CASES = [
    ("chat", "Rispondi soltanto con: Lyra è online."),
    ("calculator", "Calcola 17 * 23 usando calculator."),
    ("knowledge", "Cerca nei miei appunti qual è il colore segreto del collaudo Lyra."),
    ("browser", "Apri https://example.com e dimmi il titolo della pagina."),
    # one short note found: the answer is written from a minimal prompt
    ("knowledge_single", "Cerca nei miei appunti ametista"),
    # multi-step: must keep the agent loop (no deterministic ending)
    ("browser_multistep", "Apri https://example.com e segui il link More information."),
]


def loaded_models(host: str) -> list[dict]:
    """Models Ollama currently keeps in memory (GET /api/ps), with expiry."""
    try:
        with urllib.request.urlopen(host.rstrip("/") + "/api/ps", timeout=5) as resp:
            data = json.load(resp)
    except Exception as exc:  # noqa: BLE001 - diagnostics only
        return [{"error": str(exc)}]
    return [
        {"name": m.get("name"), "expires_at": m.get("expires_at")} for m in data.get("models", [])
    ]


def summarize(name: str, query: str, result: dict, wall: float) -> dict:
    meta = result["metadata"]
    timing = meta.get("timing", {})
    calls = timing.get("llm_calls", [])
    tools = timing.get("tools", [])
    first_tool = tools[0]["start"] if tools else None
    pre = sum(c["end"] - c["start"] for c in calls if first_tool is None or c["end"] <= first_tool)
    post = sum(
        c["end"] - c["start"] for c in calls if first_tool is not None and c["start"] >= first_tool
    )
    return {
        "test": name,
        "pack": meta.get("pack"),
        "total_seconds": round(wall, 2),
        "route_seconds": timing.get("route_seconds"),
        "pre_tool_llm_seconds": round(pre, 2) if tools else None,
        "tool_seconds": round(sum(t["end"] - t["start"] for t in tools), 3),
        "post_tool_llm_seconds": round(post, 2) if tools else None,
        "llm_seconds": round(sum(c["end"] - c["start"] for c in calls), 2),
        "fast_path": meta.get("fast_path"),
        "final_path": meta.get("final_path"),
        "post_tool_seconds": meta.get("post_tool_seconds"),
        "final_prompt_tokens": meta.get("final_prompt_tokens"),
        "final_completion_tokens": meta.get("final_completion_tokens"),
        "tool_calls": [
            {"tool": t["tool"], "seconds": round(t["end"] - t["start"], 3), "ok": t["success"]}
            for t in tools
        ],
        "llm_calls": calls,
        "answer": result["content"][:160],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--config", required=True, help="Lyra config.toml")
    parser.add_argument(
        "--only",
        default="",
        help="comma list: chat,calculator,knowledge,knowledge_single,browser,browser_multistep",
    )
    parser.add_argument(
        "--no-fast-path", action="store_true", help="disable fast paths (agent.fast_path=false)"
    )
    parser.add_argument(
        "--no-fast-final",
        action="store_true",
        help="disable the post-tool endings (agent.fast_final=false)",
    )
    parser.add_argument(
        "--keep-alive", default=None, help='override engine.keep_alive ("" = Ollama default)'
    )
    args = parser.parse_args()

    from openjarvis.core.config import load_config
    from openjarvis.system.builder import SystemBuilder

    config = load_config(args.config)
    if args.no_fast_path:
        config.agent.fast_path = False
    if args.no_fast_final:
        config.agent.fast_final = False
    if args.keep_alive is not None:
        config.engine.keep_alive = args.keep_alive
    print(
        json.dumps(
            {
                "fast_path": config.agent.fast_path,
                "fast_final": config.agent.fast_final,
                "keep_alive": config.engine.keep_alive or None,
            }
        ),
        flush=True,
    )
    wanted = {n for n in args.only.split(",") if n} or {n for n, _ in CASES}
    print(json.dumps({"ollama_loaded_before": loaded_models(config.engine.host)}), flush=True)
    with SystemBuilder(config).build() as system:
        for name, query in CASES:
            if name not in wanted:
                continue
            started = time.perf_counter()
            try:
                result = system.ask(query, profile=True)
            except Exception as exc:  # noqa: BLE001 - report and continue
                print(json.dumps({"test": name, "error": str(exc)}), flush=True)
                continue
            line = summarize(name, query, result, time.perf_counter() - started)
            print(json.dumps(line, ensure_ascii=False), flush=True)
    print(json.dumps({"ollama_loaded_after": loaded_models(config.engine.host)}), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
