# Collaudo sul CT Lyra

**LYRA CORE 0.2.1 — TARGET LINUX CT: VERIFIED.** Collaudo eseguito sul CT reale
(Proxmox LXC, Debian 13 trixie, Python 3.13.5, glibc 2.41, SQLite 3.46.1 con
FTS5, Playwright 1.63.0, Chromium). Esito: tutti i passi PASS; numeri in
[VALIDATION.md](VALIDATION.md). Installazione: README. Utente `lyra`, sorgente in
`/opt/lyra`, venv in `/opt/lyra/.venv`.

## Automatico

Prerequisiti, una volta sola:

```bash
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[dev,browser]'
/opt/lyra/.venv/bin/python -m playwright install-deps chromium
runuser -u lyra -- /opt/lyra/.venv/bin/python -m playwright install chromium
```

Il secondo comando va eseguito come root (installa librerie di sistema); il terzo
**come `lyra`**, perché Playwright usa la cache dell'utente che lo esegue
(`/var/lib/lyra/.cache/ms-playwright`).

Collaudo completo, il comando esatto verificato sul CT target:

```bash
runuser -u lyra -- bash -c '
cd /opt/lyra
BROWSER=chromium \
CONFIG=config/lite-chromium.toml \
bash scripts/ct-acceptance.sh
'
```

Errori tipici:

- lanciato come root o con un altro utente → Playwright cerca Chromium nella
  cache sbagliata e il probe/smoke fallisce;
- senza `CONFIG=config/lite-chromium.toml` → il config base ha il browser
  disattivato e `browser-probe-chromium` fallisce;
- senza `BROWSER` → probe e smoke browser non vengono eseguiti affatto.

Varianti: senza browser, `runuser -u lyra -- bash -c 'cd /opt/lyra && bash
scripts/ct-acceptance.sh'`. Obscura (EXPERIMENTAL, server CDP già avviato):
stesso comando con `BROWSER=obscura` e `CONFIG=config/lite-obscura.toml`.

Lo script scrive `acceptance-<data>/` (ignorata da git) con ambiente (OS, glibc,
Python, SQLite/FTS5, Playwright), log per passo e `live-acceptance.json`, e
stampa PASS/FAIL per:

1. suite completa — su Linux devono **passare**, non essere saltati, i test
   symlink/hardlink (vault e file_read) e FIFO; attesi al massimo lo smoke opt-in
   come skip;
2. `lyra check` — Ollama `192.168.1.252:11434`, modello esatto, `/srv/lyra-state`
   e `/srv/lyra-vault` scrivibili;
3. con `BROWSER`: `check --browser` (probe reale) e `tests/test_browser_smoke.py`;
4. `scripts/live_acceptance.py` con MiniCPM reale su vault temporaneo:
   write, file su disco, search, modifica esterna + search, read, memoria separata
   dal vault, retrieve, (browser).

`SKIP_LIVE=1` salta il passo 4. Un FAIL non va trasformato in successo: annotarlo.

Esito sul CT target: unit-tests 269 passed, 1 skipped (solo lo smoke opt-in),
0 failed; `lyra-check` PASS; `browser-probe-chromium` PASS; `browser-smoke-chromium`
PASS (1 passed in 4.81 s); `live-model` PASS (9/9); finale
`COLLAUDO: tutti i passi PASS`.

## Manuale (vault reale e Obsidian)

1. `ask --json 'Usa notes_write per creare collaudo.md con il testo ORCHIDEA-742'`,
   poi verificare `/srv/lyra-vault/collaudo.md` sul disco.
2. Aprire il vault con Obsidian (via mount/sync), modificare `collaudo.md`,
   poi `ask --json 'Cerca <testo nuovo> nelle note'`: deve trovarlo.
3. Rinominare e poi cancellare il file da Obsidian: la ricerca deve seguire.
4. `ask --json --pack knowledge 'Leggi ../etc/passwd'` e `'Leggi .obsidian/app.json'`:
   il tool deve rifiutare.
5. `ask --json 'Memorizza nella memoria: …'`: cambia solo `/srv/lyra-state/memory.db`.
6. Browser: `ask --json 'Apri https://example.com'` ok; `'Apri http://192.168.1.252:11434'`
   deve essere bloccato. Click/type: `chat` o `ask --confirm`.
7. Obscura: resta EXPERIMENTAL finché passi 3 (check --browser + smoke) non sono
   PASS sul CT. Non disattivare il probe, non usare `--allow-private-network`.
8. Rete: porta CDP 9222 non raggiungibile dalla LAN (`ss -ltnp | grep 9222` deve
   mostrare solo `127.0.0.1`). Consigliato firewall Proxmox egress per il CT Lyra.
9. Backup separati di `/srv/lyra-vault` (Markdown) e `/srv/lyra-state`.

Annotare Debian/Ubuntu, Python, Playwright, Obscura, tempi, esiti, RAM.
Controllare sempre `tool_results`, non solo la risposta in linguaggio naturale.
