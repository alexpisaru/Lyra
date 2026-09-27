# Lyra Core (ex OpenJarvis Lite) — piano di riduzione

Base reale: https://github.com/open-jarvis/OpenJarvis, commit
`13eefab4a993809c1a28739eebc32a67500e393f` (clone del 26 settembre 2026).
Questo file è il piano autorevole. Target: server Linux personale, Ollama con
`openbmb/minicpm5-2b:q8_0`. Il PC Windows serve solo per preparare e testare il codice.

## Evidenze dal codice

- `agents/orchestrator.py` passa tutti i tool dell'esecutore al modello; non fa
  capability routing. La modalità structured importa il registro prompt di learning.
- `agents/__init__.py`, `tools/__init__.py`, `engine/__init__.py` registrano
  automaticamente agenti avanzati, catalogo tool e provider diversi.
- `system/builder.py` collega memoria, canali, skill, scheduler, learning,
  telemetria e agent manager. Disattivare solo training non elimina questo percorso.
- `engine/ollama.py` ritenta HTTP 400 senza tool, nascondendo incompatibilità.
- `tools/storage/sqlite.py` richiede Rust nonostante esista uno schema Python.
- `pyproject.toml` installa dataset, cloud SDK, Telegram e telemetria di base.
- Il browser usa una sessione Playwright condivisa, mentre ToolExecutor esegue
  su worker diversi: serve affinità a un singolo thread per questa risorsa.

## Matrice tenere / modificare / eliminare

| Moduli | Azione e motivazione |
|---|---|
| core/types, registry, events, paths | Tenere contratti e primitive upstream |
| agents/orchestrator, _stubs, loop_guard | Tenere loop function calling; togliere structured/training e parallelismo; limiti espliciti e errori recuperabili |
| tools/_stubs | Tenere esecutore, timeout e protezioni; validare JSON/schema prima dell'esecuzione |
| engine/ollama, _base, _stubs, _http_async | Solo Ollama; nessun fallback silenzioso senza tool o verso cloud |
| system/builder, core; sdk; cli | Ridurre sul posto alle API build/ask/close e comandi ask/chat/check; nessun secondo runtime |
| tools/calculator, file_read, storage_tools | Tenere calcolo, lettura limitata al workspace, store/retrieve; eliminare index/search duplicati |
| tools/browser | Tenere navigazione/click/type/extract opzionali; togliere screenshot non utile al modello testuale; stessa sessione/thread |
| tools/storage/sqlite | Stesso MemoryBackend, implementazione stdlib SQLite/FTS5; nessuna dipendenza Rust |
| tools/packs (piccolo modulo nuovo) | Routing deterministico o selezione esplicita; un pack per richiesta, massimo 5 tool, mai catalogo completo nel prompt |
| security | Tenere controlli effettivamente usati da lettura/browser/esecutore; nessun rilassamento implicito delle conferme |
| learning, evals, mining, telemetry, traces | Rimuovere dal fork Lite; test mirati al posto di piattaforma di benchmark/training |
| agenti avanzati, provider cloud, canali, skill, speech, workflow, scheduler, operators, server desktop | Rimuovere; reintroduzione futura solo con esigenza verificata |
| MCP | Rimuovere dalla prima distribuzione; conservare semantica tools.enabled come allowlist esterna ai pack. Nessuna discovery automatica |
| Rust, frontend, deploy e documentazione full | Rimuovere dalla distribuzione; upstream resta recuperabile dal commit Git |

## Contratto

Una richiesta -> un pack validato -> OrchestratorAgent upstream ridotto ->
Ollama -> ToolExecutor upstream -> risposta. Pack: general (calculator),
files (file_read), memory (store/retrieve), knowledge (quattro tool Markdown), browser (navigate/click/type/extract).
Chat senza tool resta possibile. Richieste ambigue richiedono pack esplicito;
nessun planner LLM né caricamento di tutti gli schema. Laya in futuro potrà
passare solo il nome del pack alla medesima API, soggetto alla stessa allowlist.

Il modello non può eseguire tool esterni al pack. Config sconosciuta o pack
troppo grande falliscono all'avvio. Errori JSON/schema tornano al modello;
turni, chiamate, output e contesto sono limitati. SQLite conserva solo note
esplicitamente memorizzate; nessun embedding, riassunto automatico o training.
Cronologia conversazione limitata e in RAM; memoria disattivabile.

## Passi e verifica

1. Ridurre packaging/config/import/CLI e wiring esistenti. Verificare installazione
   minimale, import e help senza Rust/cloud/training; configurazione fallisce chiusa.
2. Aggiungere pack e ridurre il loop esistente. Testare payload Ollama con <=5
   schema, isolamento dei pack, JSON non valido, tool ignoto, duplicati, timeout,
   limiti, cronologia e risposta finale; HTTP 400 non deve ritentare senza tool.
3. Ripristinare SQLite Python e browser opzionale. Testare persistenza/ricerca,
   isolamento del workspace e affinità del thread browser; prove browser reali
   e MiniCPM vanno distinte dai mock.
4. Rimuovere file inutilizzati sulla base delle dipendenze; conservare test
   upstream pertinenti e aggiungere regressioni Lite. Consegnare README operativo,
   config esempio, report verifiche e repository con base Git recuperabile.

## Limiti e recupero

Non è autorizzato né necessario modificare il server esistente per consegnare
il fork. La validazione specifica di questa estensione su Linux e MiniCPM non è
stata eseguita; lo storico delle prove precedenti è distinto in VALIDATION.md.
Usare una nuova directory dati Lite: nessuna migrazione distruttiva dei database
precedenti. Ripristino del sorgente tramite commit upstream; nessun push/deploy
automatico. Le compatibilità API/config full non mantenute sono documentate.

## Estensione 0.2 — vault e backend browser

- `tools/knowledge.py`: un solo piccolo adattatore per quattro schema. Riusa
  `SQLiteMemory`/FTS5 in RAM e la policy file sensibili; Markdown autorevole.
  Non riusa `FileReadTool` per le operazioni vault perché il target Linux
  richiede apertura descriptor-relative con `O_NOFOLLOW` e scrittura atomica.
- Builder, config, system e CLI modificati sul posto; chiusura dell'indice con
  il sistema. La memoria personale su disco resta separata e non viene migrata.
- `knowledge.vault_path` assoluto e allowlist esplicita. Scansione limitata,
  hash contenuti per recepire modifiche esterne anche a parità di timestamp.
- Routing note/appunti/Markdown → knowledge; memoria esplicita → memory.
  Nessun pack combina knowledge e browser; i follow-up usano `/pack`.
- `tools/browser.py`: stessa sessione/thread e quattro tool. Selezione
  `browser.backend`, CDP loopback per Obscura, Chromium locale altrimenti.
  Verifica intercettazione all'avvio, fallback solo se configurato e segnalato.
- Redirect HTTP bloccati prima di seguirli, anche pubblici, per il limite di
  routing Playwright. Stessa policy su entrambi i backend; nessun allentamento LAN.
- Obscura v0.2.3 documentato per Linux x86_64/glibc 2.35+, ma lo smoke Windows
  fallisce il probe. Chromium rimane default fino a collaudo Linux positivo.
- Nessuna nuova dipendenza base. Extra Playwright >=1.48 per blocco WebSocket.

Installazione completa e collaudo: README e BROWSER.md. Nessun passo server
è stato eseguito. I risultati aggiornati sono in VALIDATION.md.

## Completamento 0.2.1

Nessun nuovo sottosistema, dipendenza, agente o router LLM. Architettura invariata:
router deterministico → un pack (0–5 tool) → MiniCPM → ToolExecutor.

- Knowledge: `knowledge.enabled` esplicito; output dei tool notes etichettato
  per il modello 2B. Markdown resta source of truth, indice FTS solo in RAM.
- Routing: «nota … in memoria» → memory; vault/Obsidian/appunti + memoria → ambiguo.
- Config: `engine.model` accettato come alternativa a `intelligence.model`.
- Browser: stessi quattro tool; Chromium stabile/default, Obscura EXPERIMENTAL.
  Redirect della navigazione principale validati e riaperti come nuove
  navigazioni sorvegliate (un 3xx non arriva mai al browser); WebRTC disabilitato;
  pagina 403 locale per navigazioni bloccate.
- SSRF: tutto ciò che non è globale (incluso CGNAT/Tailscale, NAT64, 6to4).
- `lyra check` (allora `jarvis check`) copre vault, memoria e (con `--browser`) il probe del backend.
- Collaudo CT separato: `scripts/ct-acceptance.sh`, `scripts/live_acceptance.py`.

Laya resta fuori: potrà solo passare un nome pack a `JarvisSystem.ask`.

## Stato dopo il collaudo Linux

**LYRA CORE 0.2.1 — TARGET LINUX CT: VERIFIED** (Debian 13, Python 3.13.5,
Chromium; suite 269 passed / 1 skipped / 0 failed, live acceptance 9/9; dettagli
in VALIDATION.md). Base stabile per il prossimo sviluppo, che resta fuori da 0.2.1:

- Lyra API: realizzata in 0.3.0 (sotto), con `config/lyra-api.service`.
- GUI, voce, Laya, provider Windows: non iniziati.
- Obscura resta EXPERIMENTAL finché `check --browser` e smoke non passano sul CT.

## Lyra API 0.3.0

Livello sottile sopra il core, non un secondo runtime (`src/openjarvis/api.py`):

- `/api/chat` chiama `JarvisSystem.ask` come `lyra ask`/`chat`; `pack="auto"` usa
  `route_pack`; una conversazione in RAM come `lyra chat`, `/api/chat/reset`.
- `/api/knowledge/search|note` chiamano `MarkdownVault.search/read`: stesse
  protezioni dei tool notes, nessuna logica duplicata; nessuna scrittura via API.
- `/ws` inoltra `INFERENCE_START` e `TOOL_CALL_START/END` già pubblicati
  sull'EventBus dal runtime; nessun hook nuovo nel core.
- Single user: lock non bloccante, seconda richiesta agentica → 409.
- Sicurezza: bind 127.0.0.1 di default, API key opzionale (Bearer, confronto in
  tempo costante), controllo Origin, CORS solo per origin espliciti, nessun
  endpoint browser generico. FastAPI/Uvicorn/websockets nell'extra `api`.
- `lyra api` è il primo processo persistente: `config/lyra-api.service`.

Prossimi passi (non iniziati): GUI/PWA, conferma click/type e scrittura note via
API, Voice, Laya, provider Windows 4B.
