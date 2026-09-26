# Collaudo sul CT Jarvis — da eseguire dopo l'installazione

Nulla di questo è stato eseguito sul CT. Installazione: README. Utente `jarvis`,
sorgente in `/opt/jarvis-lite`, venv in `/opt/jarvis-lite/.venv`.

## Automatico

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install '/opt/jarvis-lite[dev]'
runuser -u jarvis -- bash /opt/jarvis-lite/scripts/ct-acceptance.sh
# con browser installato:
runuser -u jarvis -- env BROWSER=chromium CONFIG=config/lite-chromium.toml bash /opt/jarvis-lite/scripts/ct-acceptance.sh
runuser -u jarvis -- env BROWSER=obscura CONFIG=config/lite-obscura.toml bash /opt/jarvis-lite/scripts/ct-acceptance.sh
```

Lo script scrive `acceptance-<data>/` con ambiente (OS, glibc, Python, SQLite/FTS5,
Playwright), log per passo e `live-acceptance.json`, e stampa PASS/FAIL per:

1. suite completa — su Linux devono **passare**, non essere saltati, i test
   symlink/hardlink (vault e file_read) e FIFO; attesi al massimo lo smoke opt-in
   come skip;
2. `jarvis check` — Ollama `192.168.1.252:11434`, modello esatto, `/srv/jarvis-state`
   e `/srv/jarvis-vault` scrivibili;
3. con `BROWSER`: `check --browser` (probe reale) e `tests/test_browser_smoke.py`;
4. `scripts/live_acceptance.py` con MiniCPM reale su vault temporaneo:
   write, file su disco, search, modifica esterna + search, read, memoria separata
   dal vault, retrieve, (browser).

`SKIP_LIVE=1` salta il passo 4. Un FAIL non va trasformato in successo: annotarlo.

## Manuale (vault reale e Obsidian)

1. `ask --json 'Usa notes_write per creare collaudo.md con il testo ORCHIDEA-742'`,
   poi verificare `/srv/jarvis-vault/collaudo.md` sul disco.
2. Aprire il vault con Obsidian (via mount/sync), modificare `collaudo.md`,
   poi `ask --json 'Cerca <testo nuovo> nelle note'`: deve trovarlo.
3. Rinominare e poi cancellare il file da Obsidian: la ricerca deve seguire.
4. `ask --json --pack knowledge 'Leggi ../etc/passwd'` e `'Leggi .obsidian/app.json'`:
   il tool deve rifiutare.
5. `ask --json 'Memorizza nella memoria: …'`: cambia solo `/srv/jarvis-state/memory.db`.
6. Browser: `ask --json 'Apri https://example.com'` ok; `'Apri http://192.168.1.252:11434'`
   deve essere bloccato. Click/type: `chat` o `ask --confirm`.
7. Obscura: resta EXPERIMENTAL finché passi 3 (check --browser + smoke) non sono
   PASS sul CT. Non disattivare il probe, non usare `--allow-private-network`.
8. Rete: porta CDP 9222 non raggiungibile dalla LAN (`ss -ltnp | grep 9222` deve
   mostrare solo `127.0.0.1`). Consigliato firewall Proxmox egress per il CT Jarvis.
9. Backup separati di `/srv/jarvis-vault` (Markdown) e `/srv/jarvis-state`.

Annotare Debian/Ubuntu, Python, Playwright, Obscura, tempi, esiti, RAM.
Controllare sempre `tool_results`, non solo la risposta in linguaggio naturale.
