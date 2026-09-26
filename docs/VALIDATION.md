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
