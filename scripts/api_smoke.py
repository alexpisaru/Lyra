"""Opt-in smoke test against a RUNNING `lyra api` (real model, real tools). Starts nothing.

Usage (on the CT, API already started):
    python scripts/api_smoke.py [--base-url http://127.0.0.1:8787] [--note-term ametista]
    [--out api-smoke.json]
If the API has an api_key, pass it via the LYRA_API_KEY environment variable
(not as an argument: it would be visible in the process list).

Checks: GET /api/status; WebSocket connect + real runtime events; POST /api/chat
calculator (17 * 23 -> 391); POST /api/chat knowledge search; GET /api/knowledge/search.
"ok" grades tool calls and tool output, not the model's prose. Exit 1 if any check fails.
Note: resets the API's in-RAM conversation at the end (memory and vault untouched).
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
import threading
import time
from pathlib import Path

import httpx
from websockets.sync.client import connect


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:8787")
    parser.add_argument("--note-term", default="ametista", help="a word present in a vault note")
    parser.add_argument("--out", default="api-smoke.json")
    args = parser.parse_args()

    key = os.environ.get("LYRA_API_KEY", "")
    headers = {"Authorization": f"Bearer {key}"} if key else {}
    http = httpx.Client(base_url=args.base_url, headers=headers, timeout=300)
    results = []

    def record(label, ok, **data):
        entry = {"label": label, "ok": bool(ok), **data}
        results.append(entry)
        print(json.dumps(entry, ensure_ascii=False), flush=True)

    status = http.get("/api/status")
    body = status.json() if status.status_code == 200 else {}
    record(
        "status",
        status.status_code == 200 and body.get("model", {}).get("reachable") is True,
        http=status.status_code,
        version=body.get("version"),
        model=body.get("model"),
        browser=body.get("browser"),
    )

    events, stop = [], threading.Event()
    ws_url = args.base_url.replace("http", "ws", 1) + "/ws"
    stack = contextlib.ExitStack()
    ws = stack.enter_context(connect(ws_url, additional_headers=headers, open_timeout=10))

    def listen():
        while not stop.is_set():
            try:
                events.append(json.loads(ws.recv(timeout=0.5)))
            except TimeoutError:
                continue
            except Exception:
                return

    listener = threading.Thread(target=listen, daemon=True)
    listener.start()
    time.sleep(0.5)
    record("websocket_connect", events[:1] and events[0].get("type") == "state", first=events[:1])

    def chat(label, message, tool, expect):
        start = time.monotonic()
        reply = http.post("/api/chat", json={"message": message, "pack": "auto"})
        seconds = round(time.monotonic() - start, 2)
        data = (
            reply.json()
            if reply.headers.get("content-type", "").startswith("application/json")
            else {}
        )
        calls = [(t["tool_name"], t["success"]) for t in data.get("tool_results", [])]
        outputs = " ".join(t["content"] for t in data.get("tool_results", []))
        ok = (
            reply.status_code == 200 and (tool, True) in calls and expect.lower() in outputs.lower()
        )
        record(
            label,
            ok,
            http=reply.status_code,
            seconds=seconds,
            pack=data.get("pack"),
            tool_calls=calls,
            answer=str(data.get("content", data.get("detail", "")))[:300],
        )

    before = len(events)
    chat("chat_calculator", "Calcola 17 * 23 usando calculator", "calculator", "391")
    time.sleep(0.5)
    seen = events[before:]
    wanted = [
        {"type": "state", "state": "thinking"},
        {"type": "tool_started", "tool": "calculator"},
        {"type": "tool_finished", "tool": "calculator", "success": True},
        {"type": "state", "state": "idle"},
    ]
    record(
        "websocket_real_events",
        all(w in seen for w in wanted) and any(e.get("type") == "response" for e in seen),
        events=seen,
    )
    chat(
        "chat_knowledge",
        f"Cerca nei miei appunti {args.note_term}",
        "notes_search",
        args.note_term,
    )
    search = http.get("/api/knowledge/search", params={"q": args.note_term})
    hits = search.json().get("results", []) if search.status_code == 200 else []
    record(
        "knowledge_search",
        search.status_code == 200 and hits,
        http=search.status_code,
        results=hits,
    )

    reset = http.post("/api/chat/reset")
    record("chat_reset", reset.status_code == 200, http=reset.status_code)
    stop.set()
    listener.join(5)
    stack.close()

    Path(args.out).write_text(
        json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    passed = sum(r["ok"] for r in results)
    print(f"PASSED {passed} of {len(results)} -> {args.out}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
