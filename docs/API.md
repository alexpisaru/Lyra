# Lyra API 0.3.1

Livello HTTP + WebSocket sottile sopra Lyra Core, per la futura GUI/PWA.
**Non è un secondo runtime**: ogni chat passa da `JarvisSystem.ask`, la stessa
chiamata di `lyra ask`/`lyra chat` (stesso router, stessi pack da 0–5 tool,
stesso OrchestratorAgent, ToolExecutor, memoria, vault e browser con tutte le
protezioni). Codice: `src/openjarvis/api.py`.

```
Client (curl, script, futura PWA)
   │  HTTP / WebSocket  (localhost o LAN/Tailscale)
   v
Lyra API  ── origin check, API key opzionale, 1 richiesta agentica alla volta
   │  JarvisSystem.ask(...)            EventBus del runtime ──> /ws
   v
Lyra Core ──> Ollama/MiniCPM, memory, knowledge, Chromium, tool pack
```

## Avvio

```bash
python -m pip install '.[api]'            # oppure '.[browser,api]'
lyra --config config/lite-chromium.toml api
```

`lyra api` richiede `[api] enabled = true` e usa host/porta del config. Log di
accesso di uvicorn disattivato (le URL conterrebbero ricerche personali); la
API key non viene mai loggata. Docs interattive/OpenAPI disattivate.

```toml
[api]
enabled = true
host = "127.0.0.1"      # default sicuro; "0.0.0.0" per LAN/Tailscale
port = 8787
api_key = ""            # vuota = nessuna auth
allowed_origins = []    # origin esatti per una GUI su un altro host/porta
status_cache_seconds = 30.0
```

## Endpoint

| Metodo e path | Descrizione |
|---|---|
| `GET /api/status` | Stato, versione, modello (raggiungibilità in cache 30 s), memory/knowledge/browser, `state`, `busy`, pack |
| `POST /api/chat` | `{"message": "...", "pack": "auto"}`; pack: `auto`, `chat`, `general`, `files`, `memory`, `knowledge`, `browser` |
| `POST /api/chat/reset` | Svuota solo la conversazione in RAM (non memory né vault) |
| `GET /api/knowledge/notes` | Elenco delle note del vault: `{"notes": [{"path", "title"}], "skipped"}` |
| `GET /api/knowledge/search?q=...` | Ricerca nel vault (stesso `MarkdownVault` di `notes_search`) |
| `GET /api/knowledge/note?path=...` | Lettura nota (stesso `MarkdownVault.read` di `notes_read`) |
| `GET /ws` | WebSocket eventi in tempo reale (solo server → client) |

### POST /api/chat

- `pack="auto"` usa il router deterministico esistente; richiesta ambigua →
  **400** con il messaggio del router (scegliere un pack esplicito).
- Body JSON rigoroso: campi sconosciuti, messaggio vuoto o > 4000 caratteri →
  **422**; `Content-Type` diverso da `application/json` → **415**.
- Una conversazione in RAM, come `lyra chat`: le coppie domanda/risposta
  precedenti (limite `agent.history_chars`) vengono passate a `ask`. Nessuna
  persistenza: si perde al riavvio.
- Risposta:

```json
{
  "content": "17 × 23 = 391",
  "pack": "general",
  "turns": 2,
  "complete": true,
  "tool_results": [{"tool_name": "calculator", "content": "391.0", "success": true, "...": "..."}],
  "metadata": {"pack": "general", "tools": ["calculator"], "browser_backend": null, "...": "..."}
}
```

`complete=false` corrisponde all'exit code 2 della CLI (es. `missing_tool_use`).
Errore del modello/runtime → **502**. Lyra occupata → **409**.

### Knowledge

Risposte `{"notes": [{"path", "title"}], "skipped": n}` (elenco),
`{"results": [{"path", "excerpt"}], "skipped": n}` e `{"path", "content"}`.
L'elenco usa la stessa scansione confinata della ricerca (`MarkdownVault.list_notes`):
solo `.md` regolari dentro il vault, niente link, file o cartelle nascosti
(`.obsidian/`, `.trash/`), hard link contati in `skipped`; il titolo è il primo
H1 dopo il frontmatter, altrimenti il nome file. Nessun parametro: non è un
file browser generico. Le protezioni sono quelle del vault, non duplicate:
`..`, path assoluti, drive/UNC, backslash, file nascosti (`.obsidian/`), non
`.md`, symlink/hard link → **400**; nota assente → **404**; vault disattivato → **404**.
Nessun endpoint di scrittura in 0.3.1.

## WebSocket `/ws`

Alla connessione arriva lo stato corrente, poi gli eventi prodotti dal runtime
reale: `INFERENCE_START` e `TOOL_CALL_START/END` dell'EventBus di Lyra Core
(pubblicati dall'agente e dal ToolExecutor), più inizio/fine richiesta.
Nessun polling. Stati ripetuti consecutivi non vengono reinviati.

```json
{"type": "state", "state": "idle"}
{"type": "state", "state": "thinking"}
{"type": "state", "state": "using_tool"}
{"type": "tool_started", "tool": "calculator"}
{"type": "tool_finished", "tool": "calculator", "success": true}
{"type": "state", "state": "thinking"}
{"type": "response", "content": "17 × 23 = 391"}
{"type": "state", "state": "idle"}
```

In caso di errore: `{"type": "error", "message": "..."}`, poi `state: error` e
`state: idle`. Stati: `idle`, `thinking`, `using_tool`, `error`. Il client
non invia comandi sul WebSocket: le richieste passano da `POST /api/chat`.
Client lenti perdono eventi (coda 256) invece di bloccare il runtime.

## Concorrenza

Single user. Una sola richiesta agentica alla volta (`/api/chat`, e
`/api/chat/reset` mentre una chat è in corso): la seconda riceve subito **409**
invece di attendere, così browser, sessione e memoria non vengono condivisi tra
richieste. `/api/status`, `/api/knowledge/*` e `/ws` restano disponibili mentre
Lyra lavora (il vault ha un proprio lock).

## Sicurezza

- **Bind**: default `127.0.0.1`. Per LAN/Tailscale `host = "0.0.0.0"` (o l'IP
  Tailscale del CT) **con `api_key`**. Mai aprire la porta sul router, mai reverse
  proxy pubblico. `lyra api` avvisa se ascolta oltre localhost senza chiave.
- **API key** (opzionale, ≥ 16 caratteri, senza spazi): se impostata, tutti gli
  endpoint incluso `/api/status` e `/ws` richiedono `Authorization: Bearer <key>`,
  confrontata in tempo costante (`hmac.compare_digest`). I browser non possono
  impostare header sul WebSocket: in alternativa il subprotocol `bearer.<key>`
  (generare la chiave con `secrets.token_urlsafe(32)`). Niente token nelle URL.
- **Origin**: richieste senza `Origin` (curl, script) ammesse; da browser solo
  stesso origin o `allowed_origins`, altrimenti **403** (anche sul WebSocket).
  Blocca siti terzi che provano a usare Lyra dalla LAN (CSRF, WebSocket hijacking,
  DNS rebinding). Non è "sicurezza via CORS": CORS aggiunge header solo per gli
  origin elencati, mai `*`; senza origin configurati nessun header CORS.
- **Browser**: nessun endpoint generico tipo fetch-any-url. Chromium si raggiunge
  solo tramite `/api/chat` e il pack browser, con SSRF, redirect, WebRTC e
  blocco LAN invariati. `browser_click`/`browser_type` richiedono conferma: l'API
  non ha ancora un canale di conferma, quindi vengono rifiutate (come
  `lyra ask` senza `--confirm`). Arriverà con la GUI.

## Tailscale / LAN

Sul CT: `host = "0.0.0.0"`, `api_key` impostata, poi dal PC:

```bash
curl -H "Authorization: Bearer $LYRA_API_KEY" http://<ip-tailscale-o-lan-del-ct>:8787/api/status
```

Consigliato limitare la porta 8787 alla LAN/tailnet con il firewall Proxmox.

## Esempi

```bash
curl http://127.0.0.1:8787/api/status

curl -X POST http://127.0.0.1:8787/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message":"Quanto fa 17*23?","pack":"general"}'

curl -X POST http://127.0.0.1:8787/api/chat/reset

curl -G http://127.0.0.1:8787/api/knowledge/search --data-urlencode "q=ametista"

curl -G http://127.0.0.1:8787/api/knowledge/note --data-urlencode "path=collaudo-lyra.md"
```

Eventi WebSocket da terminale (venv con l'extra api):

```bash
/opt/lyra/.venv/bin/python -c "from websockets.sync.client import connect
with connect('ws://127.0.0.1:8787/ws') as ws:
    [print(ws.recv()) for _ in range(20)]"
```

## systemd

`config/lyra-api.service` (utente `lyra`, `/opt/lyra`,
`lyra --config /opt/lyra/config/lite-chromium.toml api`, restart on-failure,
hardening di base). Installazione e smoke: [SERVER_ACCEPTANCE.md](SERVER_ACCEPTANCE.md).

## Non ancora implementato

GUI/PWA, Voice (stati listening/speaking/interrupted), Laya, modello 4B Windows,
scrittura note via API, conferma click/type via API, streaming dei token,
persistenza delle conversazioni, multiutente, esposizione Internet/OAuth.
