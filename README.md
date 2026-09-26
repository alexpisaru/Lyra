# OpenJarvis Lite 0.2.1

Fork ridotto di [OpenJarvis](https://github.com/open-jarvis/OpenJarvis), base
`13eefab4a993809c1a28739eebc32a67500e393f`, per un assistente personale locale su
un CT Linux (Proxmox LXC, Debian/Ubuntu) con Ollama e `openbmb/minicpm5-2b:q8_0`.

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

Stato in breve (dettagli e numeri in [docs/VALIDATION.md](docs/VALIDATION.md)):

| Componente | Stato |
|---|---|
| Runtime, pack, memoria, vault | Suite automatica verde su Windows; **NOT VERIFIED ON TARGET LINUX CT** |
| Vault + MiniCPM reale (runtime su PC, Ollama sul CT) | Tool corretti 7/7; prosa del modello a volte imprecisa |
| Browser Chromium | **Stabile/predefinito**; smoke reale superato su Windows; NOT VERIFIED ON TARGET LINUX CT |
| Browser Obscura v0.2.3 | **EXPERIMENTAL**; probe di intercettazione fallito su Windows; NOT VERIFIED ON TARGET LINUX CT |

## Memory vs Knowledge

Due archivi separati, pack separati, nessuna migrazione automatica tra i due.

| | Memory (runtime) | Knowledge (vault) |
|---|---|---|
| Cosa | Fatti brevi da ricordare («il mio colore preferito…») | Note e documenti Markdown |
| Dove | `memory.db_path`, es. `/srv/jarvis-state/memory.db` | `knowledge.vault_path`, es. `/srv/jarvis-vault` |
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

- **Modifiche esterne**: a ogni `notes_search` Jarvis riscandisce il vault,
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
- Scritture Jarvis serializzate; se Obsidian e Jarvis scrivono lo **stesso** file
  nello stesso momento vince l'ultimo (non c'è merge).

```toml
[knowledge]
enabled = true
vault_path = "/srv/jarvis-vault"   # assoluto; memory.db deve stare fuori

[memory]
enabled = true
db_path = "/srv/jarvis-state/memory.db"
```

## Installazione sul CT Jarvis (Debian 12/13 o Ubuntu 24.04, x86_64)

Nulla di questo è stato eseguito sul CT. Requisiti: Python 3.11–3.13
(Debian 12 = 3.11, Debian 13 = 3.13, Ubuntu 24.04 = 3.12; Ubuntu 22.04 **no**),
SQLite con FTS5 (presente nei pacchetti Debian/Ubuntu). Non servono Git, Rust,
Node o Obsidian. Il modello resta nel CT Ollama: Jarvis non scarica modelli.

1. Copiare questa cartella sul CT (senza `.git`, che contiene tutta la storia
   upstream, e senza cache/venv locali), ad esempio dal PC:

   ```bash
   rsync -a --exclude .git --exclude .venv --exclude '.*cache' --exclude __pycache__ OpenJarvis-Lite/ root@IP-CT-JARVIS:/opt/jarvis-lite/
   ```

   In alternativa `python -m build --sdist` sul PC e `tar -xzf
   openjarvis_lite-0.2.1.tar.gz -C /opt/jarvis-lite --strip-components=1` sul CT.

2. Come root nel CT:

   ```bash
   apt update
   apt install -y python3 python3-venv ca-certificates
   id jarvis >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/jarvis --shell /usr/sbin/nologin jarvis
   install -d -o jarvis -g jarvis -m 0750 /srv/jarvis-vault /srv/jarvis-state /srv/jarvis-workspace
   chown -R jarvis:jarvis /opt/jarvis-lite
   ```

3. Come utente `jarvis`:

   ```bash
   runuser -u jarvis -- bash -c 'cd /opt/jarvis-lite && python3 -m venv .venv && .venv/bin/python -m pip install .'
   runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml check
   ```

   Equivalente interattivo: `cd /opt/jarvis-lite && python3 -m venv .venv &&
   source .venv/bin/activate && python -m pip install . && jarvis --config config/lite.toml check`.

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
il firewall Proxmox deve permettere CT Jarvis → 192.168.1.252:11434. Il modello
deve essere già scaricato lì (`ollama pull openbmb/minicpm5-2b:q8_0` nel CT Ollama).
L'adapter Ollama non passa dal guard SSRF del browser: il pack browser non può
comunque raggiungere 192.168.1.252.

### Primo utilizzo

```bash
J="runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml"
$J ask --json 'Calcola 17 * 23 usando calculator'
$J ask --json 'Usa notes_write per creare prova.md con il testo ORCHIDEA-742'
$J ask --json 'Cerca ORCHIDEA nelle mie note'
$J ask --json 'Memorizza nella memoria: il mio colore preferito è verde'
$J chat          # /pack <nome>, /auto, /exit
```

Controllare `tool_results` nel JSON: una risposta senza tool riuscito non
certifica l'azione. Esiti incompleti escono con codice 2.

### Collaudo sul CT

Script separato, non installa nulla (richiede l'extra dev per i test):

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install '/opt/jarvis-lite[dev]'
runuser -u jarvis -- bash /opt/jarvis-lite/scripts/ct-acceptance.sh
runuser -u jarvis -- env BROWSER=chromium CONFIG=config/lite-chromium.toml bash /opt/jarvis-lite/scripts/ct-acceptance.sh
```

Esegue suite completa (su Linux girano anche i test symlink/hardlink/FIFO),
`check`, smoke browser opzionale e `scripts/live_acceptance.py` con il modello
reale su un vault temporaneo. Procedura completa: [docs/SERVER_ACCEPTANCE.md](docs/SERVER_ACCEPTANCE.md).

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

Chromium, come root per le librerie di sistema e come `jarvis` per il browser:

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install '/opt/jarvis-lite[browser]'
/opt/jarvis-lite/.venv/bin/python -m playwright install-deps chromium
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m playwright install chromium
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite-chromium.toml check --browser
```

Configurazioni pronte, identiche salvo il browser: `config/lite.toml` (browser
spento), `config/lite-chromium.toml` (Chromium), `config/lite-obscura.toml`
(Obscura EXPERIMENTAL, `fallback="none"`).

Obscura (v0.2.3, unica versione considerata dal codice/doc): installazione Linux,
servizio systemd e smoke in [docs/BROWSER.md](docs/BROWSER.md). **Resta
EXPERIMENTAL**: su Windows non ha superato il probe di intercettazione richieste,
quindi Jarvis lo rifiuta. Il probe non va mai disattivato per farlo funzionare.

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
  (es. vietare al CT Jarvis la LAN salvo 192.168.1.252:11434 e DNS).

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

## Limiti runtime

Default: 6 generazioni, 5 chiamate tool sequenziali, output tool 1200 caratteri,
payload 12000 byte, `num_ctx=8192`, `max_tokens=512`, timeout tool 30 s,
timeout modello 120 s. Timeout e risultati incerti non vengono ritentati.
Memoria, vault, file e browser richiedono almeno una chiamata tool; senza, il
risultato è marcato `missing_tool_use`. La cronologia chat resta in RAM.

```python
from openjarvis import Jarvis
with Jarvis(config_path="config/lite.toml") as jarvis:
    print(jarvis.ask("Cerca Petalo", pack="knowledge")["content"])
```

## Sviluppo

```bash
python -m pip install '.[dev]'
python -m pytest -q -rs
python -m ruff check src tests scripts
python -m build
```

Documenti: [VALIDATION](docs/VALIDATION.md) (risultati reali),
[BROWSER](docs/BROWSER.md), [SERVER_ACCEPTANCE](docs/SERVER_ACCEPTANCE.md),
[LITE_PLAN](docs/LITE_PLAN.md), [REDUCTION_MANIFEST](docs/REDUCTION_MANIFEST.md).
Licenza Apache 2.0 upstream conservata (LICENSE, NOTICE).
