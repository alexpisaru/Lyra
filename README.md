# Lyra 0.3.2

**Lyra** è un assistente personale locale per un CT Linux (Proxmox LXC,
Debian/Ubuntu) con Ollama e `openbmb/minicpm5-2b:q8_0`. Il runtime, **Lyra Core**,
è un fork ridotto di [OpenJarvis](https://github.com/open-jarvis/OpenJarvis)
(base `13eefab4a993809c1a28739eebc32a67500e393f`), in precedenza chiamato
«OpenJarvis Lite». Il package Python interno resta `openjarvis` per continuità
con l'upstream; comando, utente, path e pacchetto di distribuzione sono `lyra`.

| | Nome |
|---|---|
| Comando | `lyra` (`jarvis` resta solo come alias **deprecated/legacy**, verrà rimosso) |
| Pacchetto pip | `lyra-core` |
| Utente Linux | `lyra` |
| Sorgente e venv sul CT | `/opt/lyra`, `/opt/lyra/.venv` |
| Dati | `/srv/lyra-vault`, `/srv/lyra-state`, `/srv/lyra-workspace` |

Mantiene `OrchestratorAgent`, `ToolExecutor`, adapter Ollama e tipi upstream:
un solo agente function-calling sequenziale, un **pack** di tool per richiesta
(0–4 tool, massimo 5 per contratto), routing deterministico senza secondo LLM.
Niente MCP, cloud, training, scheduler, workflow, desktop, speech, telemetria,
embedding, vector DB o runtime Rust.

```
Richiesta ─> router deterministico ─> chat | general | files | memory | knowledge | browser
                                        │  (0–5 schema tool, mai il catalogo intero)
                                        v
                                MiniCPM5 2B (Ollama remoto) ─> ToolExecutor
```

Da 0.3.0 **Lyra API** (`lyra api`, HTTP + WebSocket, [docs/API.md](docs/API.md))
espone lo stesso runtime alla futura GUI/PWA: `JarvisSystem.ask` è l'unico
percorso agentico, gli eventi WebSocket vengono dall'EventBus del runtime.

**LYRA CORE 0.2.1 — TARGET LINUX CT: VERIFIED** (Proxmox LXC, Debian 13 trixie,
Python 3.13.5, glibc 2.41, SQLite 3.46.1/FTS5, Playwright 1.63.0; Ollama remoto
`192.168.1.252:11434`, `openbmb/minicpm5-2b:q8_0`). Dettagli in [docs/VALIDATION.md](docs/VALIDATION.md).

| Componente | Stato sul CT Linux |
|---|---|
| Runtime, pack, memoria, vault | **VERIFIED**: suite 269 passed, 1 skipped (smoke opt-in), 0 failed |
| Modello reale (calculator, memory, knowledge, browser) | **VERIFIED**: live acceptance 9/9; la prosa di MiniCPM a volte riassume male un risultato tool corretto |
| Browser Chromium | **VERIFIED, stabile/predefinito**: probe PASS, smoke PASS, nessun fallback |
| Browser Obscura v0.2.3 | **EXPERIMENTAL**, non collaudato sul CT; su Windows il probe di intercettazione fallisce |
| Lyra API 0.3.0 → 0.3.2 | 0.3.0 in esercizio sul CT come `lyra-api.service` (verifica riportata dall'utente); 0.3.1 aggiunge `GET /api/knowledge/notes`; 0.3.2 riduce la latenza (`keep_alive`, fast-path, risposta dopo il tool; campi in più in `metadata`, stessi endpoint), NOT VERIFIED ON TARGET LINUX CT |
| Lyra Web 0.4.0 (PWA) | Verificata su Windows con la Lyra API reale: build/lint/32 test, desktop e viewport iPhone, service worker e offline in Chromium; **NOT VERIFIED ON TARGET LINUX CT** (Caddy non ancora installato) |

## Lyra Web (PWA) 0.4.0

Interfaccia web installabile in `web/` (React + Vite + TypeScript + Three.js), solo
file statici serviti da Caddy sul CT; `/api` e `/ws` inoltrati alla Lyra API che
resta su `127.0.0.1:8787`. Home con il solo orb WebGL che reagisce agli eventi
reali di `/ws`; Chat (composer solo lì, «Come posso aiutarti?»), Brain (vault in
sola lettura), Activity (timeline in tempo reale); stato «● Lyra» a scomparsa.
Guida completa, deploy e limiti: [docs/WEB.md](docs/WEB.md); Caddy: `config/Caddyfile`.

```bash
cd web && npm ci && npm run build                 # sul PC
rsync -a --delete web/dist/ root@IP-CT-LYRA:/var/www/lyra/
```

## Memory vs Knowledge

Due archivi separati, pack separati, nessuna migrazione automatica tra i due.

| | Memory (runtime) | Knowledge (vault) |
|---|---|---|
| Cosa | Fatti brevi da ricordare («il mio colore preferito…») | Note e documenti Markdown |
| Dove | `memory.db_path`, es. `/srv/lyra-state/memory.db` | `knowledge.vault_path`, es. `/srv/lyra-vault` |
| Source of truth | Il database SQLite/FTS5 | **I file `.md`**; l'indice FTS5 è solo in RAM e ricostruibile |
| Tool | `memory_store`, `memory_retrieve` | `notes_search`, `notes_read`, `notes_write`, `notes_append` |
| Routing automatico | ricorda, ricordami, memorizza, memoria, remember, memory | nota/note, appunti, vault, Obsidian, Markdown, file `.md` |

- «Salva questa nota **in memoria**» → memory (l'utente nomina la memoria).
- «Copia gli appunti di Obsidian in memoria» → errore esplicito: sono due capability;
  dividere in passi o usare `--pack`.
- Nessun database diventa source of truth del vault: cancellare l'indice non perde nulla.

## Knowledge vault e Obsidian

Il vault è una normale directory di file Markdown UTF-8. Obsidian **non** è una
dipendenza: si può aprire la stessa directory con Obsidian (o qualunque editor)
tramite mount, Syncthing, rsync, SMB ecc. La sincronizzazione non è inclusa.

- **Modifiche esterne**: a ogni `notes_search` Lyra riscandisce il vault,
  confronta gli hash del contenuto e aggiorna l'indice in RAM solo per i file
  cambiati; rinomine e cancellazioni vengono recepite. Nessun watcher in background.
- Path relativi con `/` e estensione `.md`. Rifiutati: `..`, path assoluti,
  drive/UNC/ADS, componenti nascosti (quindi `.obsidian/`, `.trash/`), symlink,
  hard link, file speciali, file sensibili. Su Linux ogni componente è aperto
  relativo al descrittore della directory con `O_NOFOLLOW`: uno scambio di symlink
  non porta fuori dal vault.
- `notes_write` crea o **sostituisce tutto** il file (scrittura atomica: temp +
  fsync + rename). `notes_append` richiede un file esistente e aggiunge il testo
  esatto, senza newline impliciti.
- Limiti: 20.000 caratteri per scrittura, 256 KiB per nota, 5.000 voci e 16 MiB
  per scansione (oltre: errore esplicito, mai risultati parziali spacciati per
  completi), 3 risultati per ricerca.
- Scritture Lyra serializzate; se Obsidian e Lyra scrivono lo **stesso** file
  nello stesso momento vince l'ultimo (non c'è merge).

```toml
[knowledge]
enabled = true
vault_path = "/srv/lyra-vault"   # assoluto; memory.db deve stare fuori

[memory]
enabled = true
db_path = "/srv/lyra-state/memory.db"
```

## Installazione sul CT Lyra (Debian 12/13 o Ubuntu 24.04, x86_64)

Procedura verificata sul CT target (Debian 13, Python 3.13.5). Requisiti: Python 3.11–3.13
(Debian 12 = 3.11, Debian 13 = 3.13, Ubuntu 24.04 = 3.12; Ubuntu 22.04 **no**),
SQLite con FTS5 (presente nei pacchetti Debian/Ubuntu). Non servono Git, Rust,
Node o Obsidian. Il modello resta nel CT Ollama: Lyra non scarica modelli.

1. Copiare la cartella sorgente sul CT (senza `.git`, che contiene tutta la
   storia upstream, e senza cache/venv locali). Sul PC la cartella si chiama
   ancora `OpenJarvis-Lite/`; sul CT diventa `/opt/lyra`:

   ```bash
   rsync -a \
     --exclude .git \
     --exclude .venv \
     --exclude '.*cache' \
     --exclude __pycache__ \
     OpenJarvis-Lite/ \
     root@IP-CT-LYRA:/opt/lyra/
   ```

   In alternativa `python -m build --sdist` sul PC e `tar -xzf
   lyra_core-0.3.2.tar.gz -C /opt/lyra --strip-components=1` sul CT.

2. Come root nel CT:

   ```bash
   apt update && apt install -y python3 python3-venv ca-certificates

   useradd --system \
     --create-home \
     --home-dir /var/lib/lyra \
     --shell /usr/sbin/nologin \
     lyra

   install -d \
     -o lyra \
     -g lyra \
     -m 0750 \
     /srv/lyra-vault \
     /srv/lyra-state \
     /srv/lyra-workspace

   chown -R lyra:lyra /opt/lyra
   ```

3. Come utente `lyra`:

   ```bash
   runuser -u lyra -- bash -c \
     'cd /opt/lyra && python3 -m venv .venv && .venv/bin/python -m pip install .'

   runuser -u lyra -- \
     /opt/lyra/.venv/bin/lyra \
     --config /opt/lyra/config/lite.toml \
     check
   ```

   Equivalente interattivo: `cd /opt/lyra && python3 -m venv .venv &&
   source .venv/bin/activate && python -m pip install . && lyra --config config/lite.toml check`.

`check` non genera testo e non crea directory: verifica Ollama e presenza del
modello, directory di memoria e vault scrivibili, backend browser configurato.
Esce con codice ≠ 0 se qualcosa manca.

### Collegamento a Ollama remoto

`config/lite.toml` punta già al CT Ollama:

```toml
[engine]
host = "http://192.168.1.252:11434"
model = "openbmb/minicpm5-2b:q8_0"   # equivale a intelligence.model; impostarne uno solo
timeout = 120.0
```

Ollama deve ascoltare sulla LAN (nel CT Ollama `OLLAMA_HOST=0.0.0.0:11434`) e
il firewall Proxmox deve permettere CT Lyra → 192.168.1.252:11434. Il modello
deve essere già scaricato lì (`ollama pull openbmb/minicpm5-2b:q8_0` nel CT Ollama).
L'adapter Ollama non passa dal guard SSRF del browser: il pack browser non può
comunque raggiungere 192.168.1.252.

### Primo utilizzo

```bash
J="runuser -u lyra -- /opt/lyra/.venv/bin/lyra --config /opt/lyra/config/lite.toml"
$J ask --json 'Calcola 17 * 23 usando calculator'
$J ask --json 'Usa notes_write per creare prova.md con il testo ORCHIDEA-742'
$J ask --json 'Cerca ORCHIDEA nelle mie note'
$J ask --json 'Memorizza nella memoria: il mio colore preferito è verde'
$J chat          # /pack <nome>, /auto, /exit
```

Controllare `tool_results` nel JSON: una risposta senza tool riuscito non
certifica l'azione. Esiti incompleti escono con codice 2.

### Collaudo sul CT

Script separato, non installa nulla. Richiede l'extra dev per i test e, per il
browser, Chromium già installato **come utente `lyra`** (README, sezione Browser):

```bash
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[dev,browser,api]'
```

Con l'extra `api` la suite include anche i test di Lyra API (senza, vengono
saltati). Collaudo completo, quello eseguito con successo sul CT target:

```bash
runuser -u lyra -- bash -c '
cd /opt/lyra
BROWSER=chromium \
CONFIG=config/lite-chromium.toml \
bash scripts/ct-acceptance.sh
'
```

Va eseguito come `lyra` (Playwright cerca Chromium nella cache dell'utente che
lo lancia, `/var/lib/lyra/.cache/ms-playwright`) e con `config/lite-chromium.toml`:
con `config/lite.toml` il browser è disattivato e il passo probe fallisce.
Esegue suite completa (su Linux girano anche i test symlink/hardlink/FIFO),
`check`, probe e smoke Chromium e `scripts/live_acceptance.py` con il modello
reale su un vault temporaneo. Procedura completa: [docs/SERVER_ACCEPTANCE.md](docs/SERVER_ACCEPTANCE.md).

### Lyra API e servizio systemd

`lyra api` è il primo processo persistente: server HTTP + WebSocket sopra lo
stesso runtime. Endpoint, eventi, auth e sicurezza in [docs/API.md](docs/API.md).

```bash
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[browser,api]'
runuser -u lyra -- /opt/lyra/.venv/bin/lyra --config /opt/lyra/config/lite-chromium.toml api
curl http://127.0.0.1:8787/api/status
```

Default in ascolto solo su `127.0.0.1:8787`. Per LAN/Tailscale impostare in
`[api]` `host = "0.0.0.0"` e una `api_key`; mai aprire la porta su Internet.
Servizio: `config/lyra-api.service` (utente `lyra`, restart on-failure), da
installare a mano (vedi [docs/SERVER_ACCEPTANCE.md](docs/SERVER_ACCEPTANCE.md)).
`lyra ask`/`chat`/`check` restano CLI e non richiedono il servizio.

## Browser (opzionale)

Il modello vede sempre e solo `browser_navigate`, `browser_click`,
`browser_type`, `browser_extract`. Il backend è un dettaglio interno:

```toml
[tools]
browser = true   # + i quattro nomi browser in tools.enabled

[browser]
backend = "chromium"               # stabile, predefinito
# backend = "obscura"              # EXPERIMENTAL
cdp_url = "ws://127.0.0.1:9222"    # solo Obscura; solo IP loopback con porta
fallback = "none"                  # oppure "chromium", ammesso solo con obscura
```

Chromium, come root per le librerie di sistema e come `lyra` per il browser:

```bash
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[browser]'
/opt/lyra/.venv/bin/python -m playwright install-deps chromium
runuser -u lyra -- /opt/lyra/.venv/bin/python -m playwright install chromium
runuser -u lyra -- /opt/lyra/.venv/bin/lyra --config /opt/lyra/config/lite-chromium.toml check --browser
```

Configurazioni pronte, identiche salvo il browser: `config/lite.toml` (browser
spento), `config/lite-chromium.toml` (Chromium), `config/lite-obscura.toml`
(Obscura EXPERIMENTAL, `fallback="none"`).

Obscura (v0.2.3, unica versione considerata dal codice/doc): installazione Linux,
servizio systemd e smoke in [docs/BROWSER.md](docs/BROWSER.md). **Resta
EXPERIMENTAL**: su Windows non ha superato il probe di intercettazione richieste,
quindi Lyra lo rifiuta. Il probe non va mai disattivato per farlo funzionare.

**Fallback esplicito, mai silenzioso.** Con `fallback="none"` un errore di Obscura
fa fallire il tool e `check --browser`. Con `fallback="chromium"` il ripiego
avviene solo all'avvio della sessione, emette `RuntimeWarning` e riporta
`browser_backend` e `fallback_reason` nei metadati; nessuna azione viene ripetuta.

### Sicurezza del browser

- Ogni richiesta (pagina, iframe, sottorisorse) passa dal route guard: solo
  HTTP(S) verso IP pubblici. Bloccati loopback, RFC1918, link-local, metadata
  cloud, CGNAT/Tailscale `100.64/10`, range riservati, IPv4 mascherati
  (decimale/hex/ottale) e IPv6 che incapsulano IPv4 (mapped, NAT64, 6to4).
  DNS non risolvibile = bloccato.
- Il guard scarica con `route.fetch(max_redirects=0)`. **Un 3xx non viene mai
  consegnato a Chromium**: verificato che Chromium seguirebbe i salti successivi
  senza richiamare il guard. Per la navigazione principale di `browser_navigate`
  la destinazione del `Location` viene validata e aperta come nuova navigazione
  (quindi di nuovo sorvegliata), fino a 5 salti; un salto verso destinazione
  privata viene bloccato prima di qualsiasi richiesta. Redirect di sottorisorse o
  generati da click/type non vengono seguiti e sono segnalati.
- WebRTC disabilitato (costruttori rimossi in pagine, iframe e popup; UDP non
  proxato vietato in Chromium): STUN/TURN aggirerebbero l'intercettazione.
- WebSocket e service worker bloccati, download rifiutati, popup chiusi,
  contesto effimero senza profilo personale, un solo thread.
- Click/type richiedono conferma (`chat`, oppure `ask --confirm`); se l'azione
  è avvenuta ma una richiesta successiva è bloccata, il tool lo dice e chiede di
  non ripeterla. Nessun retry automatico.
- Limiti noti: nessun pinning DNS (DNS rebinding tra controllo e fetch resta
  teoricamente possibile); risoluzioni DNS e preconnect del browser non passano
  dal guard (nessuna richiesta HTTP, ma traffico di rete sì). Per
  isolamento forte aggiungere regole egress nel firewall Proxmox del CT
  (es. vietare al CT Lyra la LAN salvo 192.168.1.252:11434 e DNS).

## Pack

| Pack | Tool |
|---|---|
| `chat` | nessuno |
| `general` | `calculator` |
| `files` | `file_read` nel workspace |
| `memory` | `memory_store`, `memory_retrieve` |
| `knowledge` | `notes_search`, `notes_read`, `notes_write`, `notes_append` |
| `browser` | `browser_navigate`, `browser_click`, `browser_type`, `browser_extract` |

`tools.enabled` è l'allowlist globale e non viene mai inviata per intero al
modello. Pack oltre 5 tool, tool sconosciuti e chiavi di config sconosciute
fanno fallire l'avvio. Argomenti JSON non validi o sconosciuti vengono rifiutati
prima dell'esecuzione. Richieste miste richiedono passi separati e `--pack`.

## Latenza: keep_alive e fast-path

Sul CT il modello legge il prompt a ~25 token/s: il costo di una richiesta è
dominato dai token *nuovi* da leggere (schemi dei tool, cronologia, risultati),
non dai tool. Dettagli e misure: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

- `engine.keep_alive = "30m"` (default): Lyra chiede a Ollama di tenere MiniCPM in
  RAM per 30 minuti dall'ultima richiesta. Senza, Ollama lo scarica dopo 5 minuti
  e la richiesta successiva paga il caricamento a freddo e una cache vuota.
  Verifica: `curl http://<host-ollama>:11434/api/ps` (campo `expires_at`).
- `agent.fast_path = true` (default): per poche frasi inequivocabili la prima
  chiamata tool è nota e Lyra salta la prima inferenza del modello:
  «Cerca nei miei appunti …» → `notes_search`, «Apri https://…» → `browser_navigate`.
  Il tool passa comunque dal ToolExecutor (validazione, SSRF, confinamento del
  vault, eventi) e la risposta la scrive sempre il modello, che può ancora
  leggere oltre (`notes_read` / `browser_extract`). Frasi ambigue restano al modello.
- `agent.fast_final = true` (default): dopo un solo tool che ha chiuso il compito,
  risposta diretta dal risultato strutturato (titolo, URL finale, stato HTTP,
  valore del calcolo) senza seconda inferenza, oppure sintesi da un prompt corto
  senza schemi né cronologia. Multi-step, più risultati e casi ambigui restano al
  loop agentico. `metadata.final_path` dice quale percorso è stato usato.
- Benchmark opt-in: `python scripts/perf_smoke.py --config config/lite-chromium.toml`.

## Limiti runtime

Default: 6 generazioni, 5 chiamate tool sequenziali, output tool 1200 caratteri,
payload 12000 byte, `num_ctx=8192`, `max_tokens=512`, timeout tool 30 s,
timeout modello 120 s. Timeout e risultati incerti non vengono ritentati.
Memoria, vault, file e browser richiedono almeno una chiamata tool; senza, il
risultato è marcato `missing_tool_use`. La cronologia chat resta in RAM.

SDK Python di Lyra Core (nomi interni ereditati da OpenJarvis, invariati di proposito):

```python
from openjarvis import Jarvis
with Jarvis(config_path="config/lite.toml") as jarvis:
    print(jarvis.ask("Cerca Petalo", pack="knowledge")["content"])
```

## Sviluppo

```bash
python -m pip install '.[dev]'     # include le dipendenze dei test API
python -m pytest -q -rs
python -m ruff check src tests scripts
python -m build
```

Nomi interni lasciati invariati di proposito (non fanno parte dell'identità
pubblica): package `openjarvis`, classi `Jarvis`/`JarvisSystem`/`JarvisConfig`,
variabili `OPENJARVIS_CONFIG`, `OPENJARVIS_HOME` (default `~/.openjarvis-lite`,
non usato sul CT dove si passa `--config`), `OPENJARVIS_SSRF_FAIL_OPEN`,
`JARVIS_NUM_CTX`, e le variabili dei test `JARVIS_BROWSER_SMOKE`/`JARVIS_CDP_URL`.

Documenti: [VALIDATION](docs/VALIDATION.md) (risultati reali),
[API](docs/API.md), [WEB](docs/WEB.md), [BROWSER](docs/BROWSER.md), [SERVER_ACCEPTANCE](docs/SERVER_ACCEPTANCE.md),
[LITE_PLAN](docs/LITE_PLAN.md), [REDUCTION_MANIFEST](docs/REDUCTION_MANIFEST.md).
Licenza Apache 2.0 upstream conservata (LICENSE, NOTICE).
