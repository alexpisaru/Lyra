#!/usr/bin/env bash
# Collaudo sul CT Lyra (Linux). NON installa nulla: usa il venv già creato.
# Va eseguito COME UTENTE lyra: Playwright cerca Chromium nella cache dell'utente
# che lo lancia (/var/lib/lyra/.cache/ms-playwright). Comando verificato sul CT:
#   runuser -u lyra -- bash -c '
#   cd /opt/lyra
#   BROWSER=chromium \
#   CONFIG=config/lite-chromium.toml \
#   bash scripts/ct-acceptance.sh
#   '
# Varianti (sempre come lyra, da /opt/lyra):
#   bash scripts/ct-acceptance.sh             # senza browser: suite + check + modello reale
#   BROWSER=obscura CONFIG=config/lite-obscura.toml bash scripts/ct-acceptance.sh  # EXPERIMENTAL, CDP già avviato
# Con BROWSER impostato serve un CONFIG con tools.browser=true e lo stesso backend.
# Variabili: CONFIG (default config/lite.toml), VENV (default .venv), SKIP_LIVE=1.
# Ogni passo stampa PASS/FAIL; nessun passo fallito viene nascosto. Exit 1 se uno fallisce.
set -u
cd "$(dirname "$0")/.."
CONFIG="${CONFIG:-config/lite.toml}"
VENV="${VENV:-.venv}"
PY="$VENV/bin/python"
LYRA="$VENV/bin/lyra"
OUT="${OUT:-acceptance-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$OUT"
failed=0

step() {
  local name="$1"; shift
  echo "=== $name"
  if "$@" >"$OUT/$name.log" 2>&1; then
    echo "PASS $name"
  else
    echo "FAIL $name (vedi $OUT/$name.log)"; failed=1
  fi
  tail -n 3 "$OUT/$name.log"
}

{
  echo "date: $(date -Is)"; uname -a; cat /etc/os-release 2>/dev/null | head -2
  getconf GNU_LIBC_VERSION; "$PY" --version
  "$PY" -c 'import sqlite3; c=sqlite3.connect(":memory:"); c.execute("create virtual table t using fts5(x)"); print("sqlite", sqlite3.sqlite_version, "FTS5 ok")'
  "$PY" -m pip show playwright 2>/dev/null | head -2
} | tee "$OUT/environment.txt"

# Suite completa: su Linux girano anche i test symlink/hardlink/FIFO saltati su Windows.
step unit-tests "$PY" -m pytest -q -rs -p no:cacheprovider
step lyra-check "$LYRA" --config "$CONFIG" check

probe_browser() {
  # PASS only if the configured backend really started and interception was proven.
  local out
  out="$("$LYRA" --config "$CONFIG" check --browser 2>&1)"; local rc=$?
  echo "$out"
  [ "$rc" = 0 ] && grep -q "\[OK\] browser: $BROWSER attivo, intercettazione verificata" <<<"$out" \
    && ! grep -q "FALLBACK" <<<"$out"
}

case "${BROWSER:-}" in
  chromium|obscura)
    # The config must enable the browser with the same backend (tools.browser=true).
    step "browser-probe-$BROWSER" probe_browser
    step "browser-smoke-$BROWSER" env JARVIS_BROWSER_SMOKE="$BROWSER" \
      JARVIS_CDP_URL="${JARVIS_CDP_URL:-ws://127.0.0.1:9222}" \
      "$PY" -m pytest -q -rs -p no:cacheprovider tests/test_browser_smoke.py
    ;;
  "") echo "--- browser non collaudato (BROWSER non impostato)";;
  *) echo "BROWSER deve essere chromium oppure obscura"; failed=1;;
esac

if [ "${SKIP_LIVE:-0}" != "1" ]; then
  browser_flag=()
  [ -n "${BROWSER:-}" ] && browser_flag=(--browser)
  step live-model "$PY" scripts/live_acceptance.py --config "$CONFIG" \
    --out "$OUT/live-acceptance.json" "${browser_flag[@]}"
fi

echo "Risultati in $OUT/"
[ "$failed" = 0 ] && echo "COLLAUDO: tutti i passi PASS" || echo "COLLAUDO: almeno un passo FAIL"
exit "$failed"
