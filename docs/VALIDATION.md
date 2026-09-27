# Lyra Web 0.4 — correzione orb e Brain (27 settembre 2026)

Solo orb e lista note di Brain; resto della GUI invariato.

**Causa della scarsa reattività dell'orb** (verificata contro il `/ws` reale):
1. gli stati arrivavano, ma la resa cambiava di pochi punti percentuali su un solo
   guscio di particelle; 2. gli eventi `tool_started`/`tool_finished`/`response` non
   producevano nessun effetto proprio; 3. con uno strumento veloce (calculator)
   `using_tool` durava ~50 ms, meno della transizione visiva; 4. mancava lo strato viola.

| Verifica | Esito |
|---|---|
| Suite Python | **299 passed, 6 skipped, 0 failed** (+4 test `list_notes` / `/api/knowledge/notes`) |
| ruff | pulito |
| Frontend lint / test | pulito / **36 passed** |
| Build produzione | ok; pannello DEV assente da `dist` (JS e CSS) |
| Sequenza reale `/ws` registrata dalla pagina (chat calculator con MiniCPM) | idle → thinking → using_tool + impulso out → impulso in (+457 ms) → thinking → onda response → response → idle |
| Brain | elenco completo all'apertura, ricerca vuota; desktop e iPhone (lista → nota → indietro) |

Il nuovo endpoint `GET /api/knowledge/notes` richiede Lyra Core aggiornato sul CT:
finché il CT resta alla versione precedente, Brain mostra un errore di caricamento
dell'elenco con l'invito ad aggiornare Lyra Core (la ricerca continua a funzionare).
NOT VERIFIED ON TARGET LINUX CT.

---

# Lyra Web 0.4.0 — PWA (27 settembre 2026)

Frontend nuovo in `web/`; nessuna modifica a Lyra Core/API (resta 0.3.0) né a
routing, tool, memoria, vault, browser o guard di sicurezza. Guida: [WEB.md](WEB.md).

**Stato: verificato su Windows contro la Lyra API reale; NOT VERIFIED ON TARGET
LINUX CT** (Caddy e `/var/www/lyra` non ancora installati sul CT).

| Verifica (Node 24.16, React 19.3, Vite 8.3, Three 0.186, Vitest 5) | Esito |
|---|---|
| `npm run lint` (ESLint + tsc) | pulito, 0 warning |
| `npm run test` | **32 passed, 0 failed** (2 file; fetch e WebSocket simulati, nessun modello) |
| `npm run build` | `web/dist`: JS UI 407 kB (126 kB gzip) + orb Three.js 542 kB (136 kB gzip, chunk separato), 18 file in precache |
| Suite Python esistente | invariata (nessun file Python modificato) |
| UI reale nel browser, Lyra API reale + MiniCPM su Ollama CT | chat calculator («17 * 23 = 391», `calculator ✓`), chat knowledge (`notes_search ✓`, risposta Markdown), Brain search/lettura/wikilink, Activity con eventi reali |
| Orb | WebGL2 reale; stato `thinking`/`idle` pilotato dagli eventi `/ws` reali durante le chat |
| Viewport | desktop 1440×900, iPhone 390×844 (DPR 3, touch), iPhone landscape 844×390: nessun overflow |
| Leak | 30 cambi di vista: sempre 1 canvas, nessun nuovo contesto WebGL |
| `prefers-reduced-motion` | orb presente (WebGL), animazione ridotta |
| PWA in Chromium reale (build di produzione, proxy come Caddy) | service worker registrato e in controllo; offline: shell dalla cache, «Lyra non raggiungibile», `/api/status` non servito dalla cache |

Proxy: la topologia di produzione (statici + `/api/*` e `/ws` verso
127.0.0.1:8787 con Host preservato) è stata provata con il proxy di Vite (dev e
preview) verso la Lyra API reale, WebSocket incluso. Il `config/Caddyfile` non
è stato eseguito: Caddy non è installato in questo ambiente.

Non verificati: Safari/WebKit su iPhone reale (solo emulazione Chromium),
tastiera iOS reale, installazione "Aggiungi a Home", HTTPS Tailscale, Caddy sul CT.

---

# Lyra Core 0.3.0 — Lyra API (27 settembre 2026)

Nuovo livello HTTP + WebSocket (`src/openjarvis/api.py`, `lyra api`) sopra lo
stesso `JarvisSystem`. Nessuna modifica a agente, ToolExecutor, pack, router,
memory, knowledge, browser o guard SSRF/WebRTC/redirect: gli eventi WebSocket
usano l'EventBus che il runtime già pubblicava. Dettagli: [API.md](API.md).

**Stato: verificato su Windows; NOT VERIFIED ON TARGET LINUX CT.** Il nucleo
0.2.1 resta VERIFIED sul CT (sezione sotto).

| Verifica (Windows 11, Python 3.12, FastAPI 0.141.1, Uvicorn 0.54.0, websockets 17.1) | Esito |
|---|---|
| Suite completa `python -m pytest -q -rs` | **295 passed, 6 skipped, 0 failed** (264 precedenti + 31 nuovi test API; stessi 6 skip Windows) |
| Nuovi test API ripetuti 4 volte | 31/31 ogni volta |
| Smoke Chromium reale | 1 passed (browser invariato) |
| ruff check `src tests scripts` | All checks passed |
| build | `lyra_core-0.3.0` sdist + wheel |
| Wheel senza extra in venv pulito | CLI ok, FastAPI assente, `lyra api` → errore chiaro «pip install '.[api]'» |
| Wheel con `[api]` in venv pulito | `lyra --config … api` parte; `/api/status` risponde; Origin estraneo → 403 |
| `scripts/api_smoke.py` contro il server reale (runtime sul PC, MiniCPM sul CT Ollama), 2 giri | **7/7** e **7/7** |

I 31 test API girano su un `JarvisSystem` reale (agente, ToolExecutor,
EventBus, vault) con solo `generate` del modello simulato; uno avvia uvicorn su
un socket TCP reale con WebSocket reale. Coprono: status e cache, chat con pack
esplicito e auto, 400/415/422, cronologia RAM e reset, errore del modello (502 +
eventi error), 409 con richiesta concorrente reale, eventi state/tool in ordine,
tool fallito, knowledge search/read e modifica esterna, traversal/assoluti/
drive/backslash/nascosti/non-.md bloccati, vault disattivato, API key su tutti
gli endpoint e sul WebSocket (header e subprotocol), Origin/CORS allowlist senza
`*`, assenza di endpoint browser/scrittura, parsing config, comando `lyra api`.

Sequenza eventi osservata con il modello reale:
`thinking → using_tool → tool_started calculator → tool_finished (success) →
thinking → response «17 * 23 = 391» → idle`. Chat knowledge: `notes_search`
riuscito e nota trovata, ma la prosa finale di MiniCPM era incompleta
(«Vediamo il file completo:»): stesso limite qualitativo già noto.

Non eseguito: nulla sul CT Linux (API, systemd, LAN/Tailscale, test con extra
api su Linux). Comandi in [SERVER_ACCEPTANCE.md](SERVER_ACCEPTANCE.md).

---

# LYRA CORE 0.2.1 — TARGET LINUX CT: VERIFIED

Collaudo eseguito dall'utente sul CT target reale, dopo il rename (`98ed43a`,
branch `lite`). Le sezioni successive sono storiche: dove dicono
«NOT VERIFIED ON TARGET LINUX CT» valevano prima di questo collaudo.

## Ambiente

| | |
|---|---|
| Host | Proxmox, kernel 7.0.14-6-pve, x86_64 |
| CT | LXC Debian GNU/Linux 13 (trixie) |
| Runtime | Python 3.13.5, glibc 2.41, SQLite 3.46.1 con FTS5, Playwright 1.63.0 (Chromium) |
| Installazione | `/opt/lyra`, utente `lyra`, `/srv/lyra-vault`, `/srv/lyra-state`, `/srv/lyra-workspace` |
| Modello | `openbmb/minicpm5-2b:q8_0` su Ollama remoto `http://192.168.1.252:11434` |

## Risultati

| Verifica | Esito |
|---|---|
| `lyra --config config/lite.toml check` | `[OK] ollama`, `[OK] memory`, `[OK] knowledge`; browser disattivato nel config base (atteso) |
| `lyra --config config/lite-chromium.toml check --browser` | `[OK] browser: chromium attivo, intercettazione verificata` |
| **unit-tests** (suite completa su Linux) | **269 passed, 1 skipped, 0 failed**; l'unico skip è lo smoke browser opt-in della suite normale |
| **browser-probe-chromium** | **PASS** |
| **browser-smoke-chromium** | **PASS** (1 passed in 4.81 s) |
| **live-model** (`scripts/live_acceptance.py`) | **PASS, 9/9** |
| Esito finale dello script | `COLLAUDO: tutti i passi PASS` |

Su Linux i test symlink/hardlink/FIFO, saltati su Windows, sono stati eseguiti e
superati (270 test raccolti = 269 passed + 1 skip opt-in).

Prove manuali con il modello reale:

- **calculator**: «Calcola 17 * 23 usando calculator» → tool chiamato con
  `expression="17 * 23"`, risultato tool `391.0`, risposta finale `391`, `success=true`.
- **memory**: `memory_store` e `memory_retrieve` funzionano, anche con richiesta
  in linguaggio naturale (risposta «verde smeraldo»).
- **knowledge**: `notes_search` su Markdown reale nel vault trova `collaudo-lyra.md`
  e risponde correttamente «ametista»; il Markdown è la source of truth.
- **Chromium**: `browser_navigate("https://example.com")` → status 200, titolo
  «Example Domain», backend `chromium`, nessun fallback.

## Comando di collaudo verificato

```bash
runuser -u lyra -- bash -c '
cd /opt/lyra
BROWSER=chromium \
CONFIG=config/lite-chromium.toml \
bash scripts/ct-acceptance.sh
'
```

Scoperto durante il collaudo: lo script deve girare **come `lyra`** (altrimenti
Playwright cerca Chromium nella cache di un altro utente) e con
`CONFIG=config/lite-chromium.toml` e `BROWSER=chromium` (con il config base il
browser è disattivato). Solo documentazione aggiornata; nessuna modifica al codice.

## Limiti che restano

- MiniCPM 2B talvolta sintetizza male nella prosa finale un risultato tool
  corretto. Non è stato modificato il runtime per questo: controllare `tool_results`.
- Obscura v0.2.3 resta **EXPERIMENTAL** e non è stato collaudato sul CT.
- Nessun `lyra.service`: Lyra Core è una CLI senza daemon/API persistente; il
  servizio systemd arriverà con Lyra API.
- Il firewall egress Proxmox consigliato per il CT resta a cura dell'operatore.

---

# Rename a Lyra — 27 settembre 2026

Solo identità pubblica e operativa: comportamento, routing, pack, sicurezza,
browser, memoria e knowledge invariati. Nuovi nomi: prodotto **Lyra**, runtime
**Lyra Core**, comando `lyra` (alias `jarvis` deprecated), pacchetto `lyra-core`,
utente `lyra`, path `/opt/lyra` e `/srv/lyra-{vault,state,workspace}`. Il package
Python resta `openjarvis`. Le sezioni sotto sono storiche e usano i nomi di allora
(`jarvis`, `/opt/jarvis-lite`, «Blocked by Jarvis»).

| Verifica dopo il rename (Windows 11, Python 3.12) | Esito |
|---|---|
| `python -m pytest -q -rs` | **264 passed, 6 skipped, 0 failed** (stessi 6 skip di prima) |
| Smoke Chromium reale | **1 passed** |
| `python -m ruff check src tests scripts` | All checks passed |
| `bash -n scripts/ct-acceptance.sh` | ok |
| `python -m build` | `lyra_core-0.2.1.tar.gz` e `lyra_core-0.2.1-py3-none-any.whl` |
| Wheel in venv pulito: `lyra --help`, `jarvis --help` (legacy), `__version__` | ok, 0.2.1 |
| Parsing di `lite.toml`, `lite-chromium.toml`, `lite-obscura.toml` | path `/srv/lyra-*`, Ollama/modello invariati |
| `lyra --config <copia di lite.toml con dir temporanee> check` | exit 0 (Ollama e modello presenti) |
| Qualunque cosa sul CT Linux | **NOT VERIFIED ON TARGET LINUX CT** |

Unico cambiamento visibile al modello: il prompt di sistema dice «Sei Lyra» invece
di «Sei Jarvis». Nessun nuovo test MiniCPM eseguito dopo il rename.

---

# Validazione 0.2.1 — 27 settembre 2026

Verifica e completamento del fork 0.2 trovato nella cartella (nessuna riscrittura,
nessuna installazione sul CT). Ambiente: Windows 11, Python 3.12 (venv temporaneo),
Playwright 1.63.0, Chromium headless shell 153.0.8010.12.

## Riepilogo

| Verifica | Esito |
|---|---|
| Suite 0.2 trovata, prima delle modifiche | **232 passed, 6 skipped, 0 failed** |
| Suite 0.2.1 finale | **264 passed, 6 skipped, 0 failed** |
| Ruff `src tests scripts` | Tutti i controlli superati |
| Smoke Chromium reale (`JARVIS_BROWSER_SMOKE=chromium`) | **1 passed**, ripetuto 3+ volte senza flakiness |
| `jarvis check --browser` reale, backend chromium | OK: Ollama + modello presenti, intercettazione verificata |
| MiniCPM reale, pack knowledge/memory/browser (runtime su PC, Ollama sul CT) | 3 giri: 7/7, 9/9, 8/8 a livello tool; prosa: vedi sotto |
| Smoke Obscura | **Non rieseguito** in questa sessione; resta l'esito Windows negativo del 26/09 |
| Qualunque cosa sul CT Linux | **NOT VERIFIED ON TARGET LINUX CT** |

I 6 skip su Windows: 4 test symlink (2 upstream file_read, 2 vault) per permessi
Windows, 1 test FIFO solo POSIX, 1 smoke browser opt-in (eseguito a parte). Su
Linux i primi 5 devono girare: vanno visti passare nel CT (`scripts/ct-acceptance.sh`).

## Problemi trovati e corretti

1. **SSRF, range mancanti.** Il guard permetteva CGNAT `100.64.0.0/10` (reti
   Tailscale), `198.18.0.0/15`, `240.0.0.0/4`, `192.0.0.0/24` e IPv6 NAT64
   `64:ff9b::/96` / 6to4 `2002::/16` che incapsulano IPv4 LAN. Ora è bloccato
   tutto ciò che non è `is_global`, con normalizzazione NAT64/6to4. Test aggiunti.
2. **WebRTC aggirava l'intercettazione.** Verificato con Chromium reale: una pagina
   inviava STUN UDP e apriva TCP (TURN) verso un listener su 127.0.0.1. Il flag
   `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` ferma solo l'UDP;
   aggiunto init script che rimuove i costruttori WebRTC (verificato anche contro
   iframe `about:blank`, `srcdoc` e `window.open`). Asserzione nello smoke.
3. **Redirect: comportamento verificato e migliorato.** Esperimento con server reale:
   se la route consegna un 3xx a Chromium, i salti successivi arrivano alla rete
   **senza** passare dalla route. Il blocco totale 0.2 era quindi corretto ma
   bloccava anche redirect pubblici banali. Ora `browser_navigate` valida il
   `Location` e lo riapre come nuova navigazione sorvegliata (max 5); un 3xx non
   viene mai consegnato al browser; salti verso privati bloccati prima di ogni
   richiesta. Refresh header, meta refresh e redirect JS ripassano dal guard
   (verificato). Smoke esteso: catena `/hop1→/hop2→/final` seguita, redirect verso
   `/private` e redirect privato di una sottorisorsa bloccati, `/private` mai
   raggiunto dal server.
4. **Navigazione dopo un blocco.** Un abort della navigazione principale fa
   caricare a Chromium una pagina `chrome-error://` che interrompeva il `goto`
   successivo (trovato dallo smoke). Ora la navigazione principale bloccata riceve
   una pagina locale 403 «Blocked by Jarvis»; le sottorisorse restano in abort.
5. **Click/type dopo richiesta bloccata** riportavano «Click error» anche se
   l'azione era avvenuta, invitando a ripeterla. Ora il risultato dice che
   l'azione è avvenuta e di non ripeterla.
6. **Routing.** «Salva questa nota in memoria» dava errore di ambiguità: ora va a
   memory quando l'unico indizio knowledge è la parola generica nota/note; con
   vault/Obsidian/appunti/.md + memoria resta ambiguo. Hint memory senza la
   parola «note» per non confondere i due archivi.
7. **Config.** Aggiunti `knowledge.enabled` (esplicito, default false; i tool
   notes lo richiedono) e `engine.model` (alternativa a `intelligence.model`,
   conflitto = errore). Config CT aggiornate e validate da test.
8. **`jarvis check`** controllava solo Ollama. Ora riporta anche memoria, vault,
   backend browser (EXPERIMENTAL per Obscura) e con `--browser` esegue il probe
   reale; nessuna directory viene creata; exit 1 su qualunque errore.
9. **Output notes per un modello 2B.** Con testo nudo MiniCPM ha confuso un estratto
   con un nome file e, dopo un `notes_read` riuscito, ha risposto «nota non trovata».
   Output ora etichettato (`- nota: … / estratto: …`, `Nota X letta correttamente.
   Contenuto:`). Nel giro successivo le risposte erano corrette (un solo giro: non
   è una statistica).
10. Aggiunti `scripts/ct-acceptance.sh` e `scripts/live_acceptance.py` per il
    collaudo separato sul CT.

Nulla è stato indebolito: probe di intercettazione, blocco LAN/metadata, conferme
click/type, allowlist, limite 5 tool, rifiuto argomenti sconosciuti invariati.

## Prove con MiniCPM reale (docs/live-0.2.1.json)

Runtime Jarvis sul PC Windows, inferenza su `http://192.168.1.252:11434`
(`openbmb/minicpm5-2b:q8_0`, solo chiamate `/api/tags` e `/api/chat`, nessuna
modifica al CT Ollama). Vault e memoria in directory temporanee.

- Routing automatico corretto in tutti i casi (knowledge, memory, browser).
- `notes_write` crea il file su disco; `notes_search` trova il testo; dopo una
  modifica esterna del Markdown (come da Obsidian) la ricerca trova il testo nuovo;
  `notes_read` restituisce il contenuto aggiornato; `memory_store`/`memory_retrieve`
  funzionano e non toccano il vault; `browser_navigate` su example.com via Chromium.
- Tempi per richiesta 8–51 s (singole prove, non benchmark).
- Limite osservato: la prosa finale di un modello 2B può contraddire l'output
  dei tool (giri 1–2, prima della correzione 9). Controllare sempre `tool_results`.

## Obscura

Release v0.2.3 ancora l'ultima al 27/09/2026 (API GitHub); digest Linux e Windows
ricontrollati e coincidenti con BROWSER.md. Il binario non è stato rieseguito in
questa sessione. Stato: **EXPERIMENTAL, NOT VERIFIED ON TARGET LINUX CT**; su
Windows il probe di intercettazione fallisce e Jarvis rifiuta il backend.
Certificazione possibile solo con `check --browser` + smoke sul CT.

## Numeri finali

| Comando | Risultato |
|---|---|
| `python -m pytest -q -rs` | **264 passed, 6 skipped, 0 failed** (3.1 s) |
| `JARVIS_BROWSER_SMOKE=chromium python -m pytest -q -rs tests/test_browser_smoke.py` | **1 passed** (4.9 s) |
| `python -m ruff check src tests scripts` | All checks passed |
| `python -m build` | sdist + wheel 0.2.1; wheel installata in venv pulito, `jarvis check` ok |

Non eseguibili qui: suite su Linux (test symlink/hardlink/FIFO), installazione
nel CT, Chromium su Linux, Obscura su Linux, servizio systemd, firewall Proxmox.

---

# Validazione 0.2 — vault e browser, 26 settembre 2026

Modifiche applicate al fork Lite reale già preparato, senza ricostruirlo
dall'upstream e senza installare nulla sul CT. La base Git resta
`13eefab4a993809c1a28739eebc32a67500e393f`; la riduzione 0.1 era ancora
non committata. La consegna include un diff incrementale rispetto a quel Lite,
senza mescolare nel diff le 2101 rimozioni upstream già presenti.

## Esiti attuali

| Verifica | Esito |
|---|---|
| Suite completa Python 3.12 su Windows | **232 passed, 6 skipped** (2.69 s) |
| Ruff `src tests` | Tutti i controlli superati |
| Build sorgente e wheel ricostruita dal sorgente | Riuscita, versione 0.2.0 |
| Smoke Chromium reale, Playwright 1.63.0 / headless shell 153.0.8010.12 | **1 passed** (1.72 s), separato dalla suite |
| Smoke Obscura reale v0.2.3 Windows / Playwright 1.63.0 | **Fallito: probe intercettazione**; backend non promosso |
| Installazione/avvio nel CT Debian/Proxmox | Non eseguiti |
| Nuovo pack knowledge con MiniCPM reale | Non eseguito; wiring verificato con risposte simulate |

I sei skip della suite standard: quattro test symlink (due upstream, due vault)
per permessi Windows; un test FIFO solo POSIX; lo smoke browser opt-in.
Lo smoke Chromium è stato poi eseguito esplicitamente e passa. Non dichiarare
che i test POSIX siano stati eseguiti: vanno ripetuti nel CT dopo installazione.

Le nuove prove coprono read/write/append/search attraverso il vero ToolExecutor,
riapertura del vault, indice ricostruibile, modifiche esterne con stessi timestamp,
rinomina/rimozione, append concorrenti, scritture atomiche fallite senza corruzione,
traversal/drive/UNC/ADS, file nascosti, hard link, formati e dimensioni,
allowlist, quattro schema separati, routing e mancata verifica quando il modello
non chiama tool. Nessun test richiede Obsidian o nuovi servizi.

Per i backend: lazy init, selezione esplicita, sessione isolata, thread unico,
fallback solo configurato e segnalato, chiusura risorse, intercettazione no-op
rifiutata, richieste private/metadata bloccate prima della rete, redirect mai
seguiti. Conferme click/type conservate. L'indice in RAM riusa SQLiteMemory;
non viene introdotta una seconda implementazione di FTS o un database vault.

## Prove browser effettive e limiti

Chromium: navigazione example.com; pagina di form deterministica consegnata
tramite intercettazione reale; type/click/extract con ORCHIDEA-742; navigazione
LAN rifiutata. Per i redirect il test avvia un server HTTP temporaneo su loopback
e autorizza **solo l'URL sorgente del test** tramite monkeypatch: il server riceve
`/redirect` una volta e **nessuna** richiesta a `/private`. Tale eccezione non
esiste nella configurazione o nel runtime. Il server viene fermato alla fine.

Obscura: archivio Windows ufficiale v0.2.3 verificato SHA256
`781a1b8bd12b65ec5aba95842e75e6f56b3101d360397506c0e35fe3f78536e8`.
Processo temporaneo su 127.0.0.1:19222, chiuso dopo ogni prova. CDP raggiungibile,
ma il probe `.invalid` genera un errore di rete invece di completare il fulfill.
Risultato uguale aggiungendo una route sulla pagina; una prova diagnostica con
hostname example.com risolvibile va in timeout al probe (5 s). Non è stata
identificata la causa interna e non si generalizza questo esito a Linux.
La sessione fallisce chiusa; Chromium resta default, Obscura sperimentale.

Fallimenti preparatori conservati qui: primo avvio pytest elevato fermato dai
permessi della directory temporanea (risolto con basetemp dedicata); primo smoke
Chromium arrivato fino al redirect remoto httpbingo, che rispondeva 403 anziché
302. Sostituita quella dipendenza esterna con il server controllato sopra;
nessuna riduzione dei controlli per ottenere il successo.

Il guard HTTP usa `route.fetch(max_redirects=0)` e rifiuta ogni risposta 3xx con
Location: blocca anche redirect pubblici, per evitare hop che Playwright non
reintercetta. Richiede URL finali, con possibili limiti nei login. Service worker,
WebSocket e download restano disabilitati. Nessuna garanzia di sandbox egress o
DNS pinning: i filtri di rete del CT restano necessari per isolamento forte.
Il download Obscura Linux, il servizio systemd e le dipendenze Debian sono
documentati da fonti ufficiali in BROWSER.md, ma non provati nel CT.

## Riproduzione

```bash
python -m pip install '.[dev]'
python -m pytest -q -rs
python -m ruff check src tests
python -m build
# Extra per smoke, da eseguire separatamente:
python -m pip install '.[browser]'
JARVIS_BROWSER_SMOKE=chromium python -m pytest -q -rs tests/test_browser_smoke.py
JARVIS_BROWSER_SMOKE=obscura JARVIS_CDP_URL=ws://127.0.0.1:9222 python -m pytest -q -rs tests/test_browser_smoke.py
```

Prerequisiti e comandi browser in BROWSER.md; comando Chromium richiede il
binario installato, comando Obscura richiede il suo server CDP già avviato.
Nessuna nuova misura RAM/CPU o promessa sulla precisione di MiniCPM.

---

# Storico 0.1 — prove precedenti, non riferite al nuovo pack

# Verifiche — 26 settembre 2026

## Riduzione effettiva

Base ufficiale: `open-jarvis/OpenJarvis`, commit
`13eefab4a993809c1a28739eebc32a67500e393f`.

- Moduli Python sotto `src/openjarvis`: **681 -> 39** (circa -94%).
- Rimossi **2101 file tracciati upstream**, inclusi codice e asset dei sottosistemi
  esclusi; aggiunti piano, configurazione, test Lite e report.
- Tre dipendenze dirette di runtime: click, httpx, jsonschema. Playwright è un extra.
- Restano i moduli originali di agente, esecutore, Ollama e tool; ridotti sul posto
  builder, system, SDK, CLI e SQLite. Nessun secondo framework/loop agentico.
- Nessun import statico verso un modulo OpenJarvis eliminato.

## Prove automatiche

**135 test superati; 2 saltati** perché l'ambiente Windows non consente ai test
di creare symlink. Non sono due difetti rilevati nel runtime. Le prove dei
percorsi esterni e dei file sensibili normali passano. Rust assente durante le prove.

Comandi, dalla directory del repository e con le dipendenze dev installate:

```bash
python -m pytest -q -rs
python -m ruff check src tests --config pyproject.toml
python -m build --no-isolation --outdir ../packages
```

Verificati: percorso builder/agente/esecutore/adapter Ollama completo con HTTP
simulato; contenuto reale dei payload; allowlist e massimo 5 schema; pack disabilitati;
JSON/schema errati senza effetti; chiamate estranee rifiutate; output/turni/chiamate
limitati; timeout senza retry; memoria persistente e transazioni; lettura relativa al
workspace; nessun fallback HTTP 400 senza tool; richiamo singolo e stop quando
manca una verifica; exit code 2 della CLI per risultato incompleto.

Conservati sette file di test upstream pertinenti; adattato un test loop guard
alla semantica Python (blocca oltre il numero consentito, non al secondo accesso
come il vecchio ramo Rust). Test aggiuntivi in `tests/test_lite.py`.

Il browser ha prove con oggetti Playwright simulati per l'affinità al thread,
chiusura e conferma. **Non è stata eseguita una navigazione Chromium reale**.

Distribuzione verificata: build del sorgente `.tar.gz`, wheel costruita da quel
sorgente, installazione della wheel nel venv di test, avvio CLI da Python isolato
(`-I`) e `pip check` senza dipendenze mancanti. Nessuna installazione globale.

## Prove con il MiniCPM reale

Endpoint fornito dall'utente: `http://192.168.1.252:11434`.
Ollama **0.34.4**; tag presente **openbmb/minicpm5-2b:q8_0**.
Il server dichiara **2.5B**, quantizzazione **Q8_0**, capability tools/thinking/completion.
Nessun modello scaricato, nessuna configurazione del server modificata.

Ollama girava sul server; il runtime Lite e i tool di prova sul PC Windows.
Nota e file erano temporanei, nella directory di lavoro del test. La ricerca
finale usa lo stesso database dopo chiusura e ricostruzione del sistema.

| Prova | Esito osservato | Tempo |
|---|---|---:|
| 17 * 23, calculator | Tool eseguito, risposta 391 | 23.56 s |
| Salvataggio nota | memory_store eseguito, nota persistente | 151.38 s |
| Ricerca esplicita, versione finale | memory_retrieve eseguito, verde smeraldo | 9.52 s |
| «Ti ricordi qual è il colore…?», versione finale | Non chiama il tool neppure dopo un richiamo; stop `missing_tool_use` | 27.33 s |
| Lettura prova.txt, versione finale | file_read eseguito, ORCHIDEA-742 | 16.88 s |
| Saluto senza tool | Risposta conversazionale | 40.75 s |

Tempi di singole prove, con cache/stato del server variabili: **non sono un
benchmark**. La risposta al saluto non ha rispettato «soltanto ciao» alla lettera;
il controllo smoke verificava solo presenza del saluto e assenza di tool.

La prima ricerca aveva risposto falsamente di non avere note senza interrogare
SQLite. Le istruzioni brevi per capability hanno corretto la richiesta esplicita.
Il controllo aggiunto al loop impedisce la stessa falsa certezza per richieste
non verificate, ma **non rende infallibile il tool calling del modello**.
Una prima lettura file ha raggiunto 120 s di timeout del modello; la lettura
relativa al workspace con istruzione specifica è poi riuscita in due prove
(19.05 s e 16.88 s). L'errore timeout ora è distinto da endpoint irraggiungibile.

Report grezzi conservati:

- `live-smoke.json`: primo giro, successi e fallimenti inclusi.
- `live-recheck.json`: dopo le istruzioni per capability.
- `live-final.json`: dopo il controllo di mancata verifica.

## Limiti residui e collaudo finale

- Il runtime non è stato installato o avviato nel container/server Linux.
- Browser reale e consumo RAM/CPU del runtime non misurati; browser opzionale spento.
- Router deterministico italiano/inglese: frasi ambigue richiedono pack esplicito.
- Per recuperare note usare richieste esplicite come «Cerca nelle note…».
- I 12000 byte di payload non sono un conteggio esatto dei token del modello.
- Nessun server HTTP, canale remoto, MCP o Laya attivo; SDK pronto per ricevere
  un nome pack da un futuro router.

Per completare la verifica di distribuzione seguire `SERVER_ACCEPTANCE.md`.
La consegna è una implementazione Lite testabile con limiti osservati, non una
certificazione di affidabilità per qualsiasi richiesta a MiniCPM.
