# Lyra Core — latenza (performance pass, 28 settembre 2026)

Modello invariato (`openbmb/minicpm5-2b:q8_0` su Ollama 0.34.4, CPU del CT).
Nessuna modifica a GUI, tool, SSRF guard, confinamento del vault, ToolExecutor,
contratto API o nomi degli eventi WebSocket.

## Diagnosi

Misure dal profiling interno (`JarvisSystem.ask(..., profile=True)`, che riporta
i tempi di Ollama `load/prompt_eval/eval` di ogni chiamata al modello).

- **I tool non sono lenti**: `notes_search` 0,02–0,03 s, `browser_navigate` ~1 s.
- **Il modello non "ragiona" a lungo**: la scelta del tool genera 21–24 token
  (~3,5 s). La risposta finale 8–31 token (1–5 s).
- **Il costo è la lettura del prompt** (`prompt_eval`): ~25 token/s sulla CPU
  del CT. Nei pack knowledge e browser la prima chiamata porta 4 schemi di tool:
  656 token (knowledge) e 886 (browser) = 24 s e 35 s senza cache. Nella GUI si
  aggiunge la cronologia della conversazione (fino a 2000 caratteri), da cui i
  46–53 s osservati prima della tool call.
- **La cache dei prompt di Ollama** decide tutto il resto: un prefisso già visto
  (sistema + suggerimento del pack + schemi) viene riletto in ~0,15–0,3 s invece
  di decine di secondi; la chat "pura" va da 1,9 s (in cache) a 12–20 s (no).
- **Caricamento a freddo**: Lyra non inviava `keep_alive`, quindi valeva il
  default di Ollama (5 minuti). Osservato con `/api/ps`: modello scaricato dopo 5
  minuti di inattività; la richiesta successiva paga ~3 s di caricamento e
  soprattutto una cache vuota (primo test da ~31 s).

## Modifiche

1. **`engine.keep_alive`** (default `"30m"`, config `[engine]`): inviato a Ollama
   in ogni richiesta (`generate`, `stream`, `stream_full`). Accetta durate Ollama
   (`"30m"`, `"2h"`, `"-1"` = sempre, `"0"` = scarica subito); `""` = non inviato,
   vale il default di Ollama. Valori non validi fanno fallire l'avvio.
   - Senza: Ollama scarica MiniCPM dopo 5 minuti di inattività.
   - Con: resta in RAM 30 minuti dall'ultima richiesta.
   - Verifica: `curl http://<host-ollama>:11434/api/ps` → `expires_at`
     (lista vuota = modello non caricato).
   - Osservato: una volta impostati 30 minuti, Ollama 0.34 li ha mantenuti anche
     per richieste successive senza `keep_alive`.
2. **Fast-path deterministici** (`src/openjarvis/agents/fast_path.py`,
   `agent.fast_path = true`): per due intenti inequivocabili la prima chiamata
   tool è nota e l'agente salta la prima inferenza.
   - knowledge: verbo di ricerca (cerca/trova/ricerca) + luogo esplicito
     (nei miei appunti / nelle note / nel knowledge / nel vault) + testo da
     cercare → `notes_search {"query": <testo>}` (la ricerca è OR + BM25, la
     frase va bene così com'è);
   - browser: verbo di navigazione (apri/vai su/naviga su/visita/open/go to)
     seguito da **un solo** URL `http(s)://` esplicito → `browser_navigate {"url"}`.
   - La chiamata è costruita come se l'avesse scelta il modello e passa dallo
     stesso codice: governance, loop guard, **ToolExecutor** (validazione degli
     argomenti, capability, taint, timeout, eventi `TOOL_CALL_*`), e dentro il
     tool la guardia SSRF/redirect/indirizzi del browser e il confinamento del
     vault. Nessuna implementazione interna viene chiamata direttamente.
   - Dopo il tool il loop agentico continua: il modello scrive la risposta e può
     ancora chiamare il tool di lettura del pack (`notes_read` /
     `browser_extract`); gli viene offerto solo quello, per tenere il prompt
     piccolo. Il limite di 5 tool, `require_tool_use` e i limiti di turno restano.
   - Eventi `/ws` invariati: `thinking → using_tool → tool_started →
     tool_finished → thinking → response → idle` (il primo `thinking` è breve).
   - Metadata del risultato: `"fast_path": "notes_search"` quando usato.
3. **Profiling minimo**: `ask(..., profile=True)` aggiunge `metadata["timing"]`
   (routing, ogni chiamata al modello con token e tempi Ollama, ogni tool). Solo
   su richiesta: API e CLI non lo espongono. Script opt-in:
   `python scripts/perf_smoke.py --config <config.toml> [--only …]
   [--no-fast-path] [--keep-alive ""]` (JSON lines; non fa parte dei test).

### Fast-path: esempi

Presi: «Cerca nei miei appunti qual è il colore segreto», «Cerca nelle note:
progetto CRM», «Trova nei miei appunti la password del wifi?», «cerca il colore
segreto nei miei appunti», «Apri https://example.com», «Vai su
https://example.com/docs», «Apri https://example.com e dimmi il titolo».

Volutamente **non** presi (decide il modello): «Parlami dei miei appunti»,
«Cosa sai di Petalo?», «Riassumi i miei appunti», «Cerca Petalo» (nessun luogo),
«Cerca nei miei appunti X e aggiungi una riga» (anche scrittura),
«https://example.com» (nessun verbo), «Apri il sito di Example» (nessun URL: mai
inventato), «Vai su example.com» (URL non esplicito), due URL nella stessa frase,
«Apri https://… e clicca su Login» / «… e compila il modulo» (interazione).

### Budget della fase di scelta tool: non modificato

Analizzato e scartato: la scelta del tool genera solo 21–24 token (~3,5 s su
27–38 s di chiamata). Ridurre `num_predict` non farebbe risparmiare quasi nulla e
rischierebbe di troncare una tool call; il costo è nella lettura del prompt.

## Benchmark reale (prima / dopo)

`scripts/perf_smoke.py` contro l'Ollama del CT, senza cronologia di chat. Ordine
dei run come in tabella; "prima" = `--no-fast-path --keep-alive ""`. Dati grezzi:
[perf-smoke-2026-09-28.json](perf-smoke-2026-09-28.json).

| Run | chat | calculator | knowledge (prima LLM / tool / dopo) | browser (prima LLM / tool / dopo) |
|---|---|---|---|---|
| 0 prima, modello scaricato | 20,3 s | 6,4 s | 43,7 s (27,8 / 0,03 / 15,9) | 57,9 s (38,5 / 1,2 / 18,2) |
| 1 dopo, modello scaricato | 20,4 s | 6,6 s | **30,6 s** (0 / 0,02 / 30,6) | **35,4 s** (0 / 1,1 / 34,3) |
| 2 prima | 12,7 s | 6,4 s | 38,4 s (22,4 / 0,01 / 16,0) | 57,7 s (38,4 / 0,9 / 18,3) |
| 3 dopo | 12,7 s | 6,5 s | 30,6 s (0 / 0,02 / 30,6) | **2,8 s** (0 / 0,9 / 1,8) |
| 4 prima | 1,9 s | 6,5 s | 19,7 s (3,9 / 0,03 / 15,8) | 23,2 s (3,6 / 1,0 / 18,7) |
| 5 dopo (solo knowledge) | — | — | **4,7 s** (0 / 0,02 / 4,6) | — |

Lettura: la fase prima del tool (22–38 s) è sparita in tutti i run con
fast-path. Il resto dipende dalla cache: con il prompt di sintesi già in cache
knowledge scende a 4,7 s e browser a 2,8 s; senza cache la sintesi deve leggere
694 (knowledge) / 831 (browser) token e costa 26–33 s, comunque meno del totale
di prima. Chat e calculator invariati (nessun fast-path, come previsto).

## Pass #2 — dopo il tool (28 settembre 2026)

Dopo il pass #1 il collo di bottiglia era la risposta scritta *dopo* il tool
(browser: tool ~1 s, poi ~19 s di modello).

### Cosa rileggeva il modello dopo il tool

Token contati da Ollama sul prompt finale reale (pass #1, senza cronologia):

| Parte | browser | knowledge |
|---|---|---|
| prompt di sistema | 121 | 121 |
| suggerimento del pack | 63 | 88 |
| schema del tool di follow-up + istruzioni tool del template | 263 | 203 |
| richiesta + tool call + risultato (940 / 600 caratteri) | 384 | 282 |
| **totale** | **831** | **694** |
| cronologia (esempio, 2 scambi) | +149 | +149 |

A ~25 token/s senza cache: ~33 s (browser) e ~28 s (knowledge) solo di lettura.

### Come finisce ora una richiesta con un solo tool

`src/openjarvis/agents/final_path.py`, `agent.fast_final = true`. Si applica solo
dopo **una** chiamata tool riuscita, eseguita dal ToolExecutor; altrimenti il
loop agentico continua invariato.

- **`deterministic`** — nessuna seconda chiamata al modello; la risposta è un
  campo strutturato del risultato del tool e la richiesta chiede esattamente quello:
  - browser (dopo il fast-path di navigazione): titolo («… e dimmi il titolo»),
    URL finale («… e dimmi dove sei finito», con i redirect), stato HTTP
    («… e dimmi lo status code»), sola apertura («Apri https://…»);
  - calculator: «Calcola / Quanto fa <espressione>» quando il tool ha calcolato
    esattamente l'espressione scritta dall'utente → «17 × 23 = 391».
- **`minimal_synthesis`** — il modello scrive la risposta da un prompt corto:
  un'istruzione fissa (sempre uguale, quindi riusabile dalla cache di Ollama),
  la richiesta e il risultato del tool. Niente schemi dei tool, suggerimento del
  pack o cronologia; l'ultimo scambio viene aggiunto (max 600 caratteri) solo se
  la richiesta rimanda alla conversazione («come prima», «quella pagina», …).
  Casi: domanda semplice sulla pagina appena aperta («… e riassumila»);
  `notes_search` con **una sola** nota trovata e mostrata per intero
  nell'estratto (nuovo metadata `complete` del tool: estratto = nota intera).
- **`agent_loop`** (invariato) — tutto il resto: più azioni («… e poi vai …»,
  «… e segui il link …», click/compilazione, già esclusi dal fast-path), più note
  trovate, una nota più lunga del suo estratto (serve `notes_read`), tool fallito
  o bloccato, richieste ambigue (nessun fast-path), calcoli in cui il tool ha
  calcolato un'espressione diversa da quella scritta.

Eventi `/ws`: invariati; con `deterministic` non parte una seconda inferenza
(`thinking → using_tool → tool_started → tool_finished → thinking → response → idle`,
il secondo `thinking` è quello che l'API emette sempre a fine tool).
Metadata: `final_path`, `post_tool_seconds`, `final_prompt_tokens`,
`final_completion_tokens`.

### Benchmark reale (prima = pass #1, dopo = pass #2)

`scripts/perf_smoke.py` (`--no-fast-final` per il "prima"), run alternati.
Dati grezzi: [perf-smoke-2026-09-28-post-tool.json](perf-smoke-2026-09-28-post-tool.json).

| Test | Prima: totale (dopo il tool) | Dopo: totale (dopo il tool) | Percorso | Prompt finale |
|---|---|---|---|---|
| browser titolo | 19,9 / 19,7 s (18,9 / 18,7) | **0,98 / 0,93 s** (0,0) | deterministic | 831 → 0 token |
| calculator | 6,2 / 6,4 s (2,9 / 3,0) | **3,5 / 3,4 s** (0,0) | deterministic | 424 → 0 token |
| knowledge, una nota intera | 21,3 s (21,3) | **6,0 / 5,9 s** (6,0 / 5,9); 14,0 s al primo run | minimal_synthesis | 545 → 218 token |
| knowledge, più note | 12,5 / 4,7 s | 4,8 / 4,6 s | agent_loop (invariato) | 694 token |
| browser multi-step | 28,8 / 26,9 s | 9,7 / 12,3 s | agent_loop (invariato) | 828 + 875 token |
| chat | 2,1 / 1,9 s | 1,9 / 2,0 s | — | — |

Le differenze di knowledge "più note" e browser multi-step vengono solo dalla
cache di Ollama (stesso percorso, stessi token); nessun peggioramento.

## Limiti rimasti

- Senza cache la risposta dopo il tool resta lenta (~30 s): è la lettura di
  ~700–830 token a ~25 token/s. La cache di Ollama è opportunistica: un prefisso
  può essere sovrascritto da altre richieste (run 3: knowledge non in cache,
  browser sì).
- Nella GUI la cronologia della conversazione aggiunge token a ogni richiesta.
- Le richieste ambigue non hanno fast-path e seguono ancora il percorso lento.
- Possibili passi successivi (non fatti qui): pre-riscaldare i prefissi dei pack
  all'avvio; accorciare i suggerimenti dei pack; `history_chars` più basso;
  parametri di cache/parallelismo di Ollama sul CT (configurazione del CT, non di
  Lyra).

NOT VERIFIED ON TARGET LINUX CT: le misure usano l'Ollama reale del CT, ma Lyra
girava su Windows (stessa rete), non come servizio sul CT.
