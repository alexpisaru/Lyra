# OpenJarvis Lite 0.2

Fork ridotto di [OpenJarvis](https://github.com/open-jarvis/OpenJarvis), base
`13eefab4a993809c1a28739eebc32a67500e393f`. Target invariato: Linux personale,
Ollama e `openbmb/minicpm5-2b:q8_0`. Nessuna installazione sul CT è stata eseguita.

Mantiene `OrchestratorAgent`, `ToolExecutor`, adapter Ollama e tipi upstream.
Un loop sequenziale, un pack per richiesta, massimo 5 schema (i pack attuali
ne usano 0–4). Nessun framework aggiuntivo, router LLM, cloud o MCP.

Il vault è una directory di file Markdown UTF-8. Obsidian può aprirla, ma
l'app non è una dipendenza. Obscura si collega attraverso Playwright/CDP
usando gli stessi quattro tool browser. **Obscura 0.2.3 non ha superato lo
smoke Windows sull'intercettazione richieste: resta sperimentale, non il
backend predefinito.** Il collaudo Linux è separato e ancora da eseguire.

## Installazione sul CT Jarvis — da eseguire in seguito

Consigliato Debian 12/13 x86_64, Python 3.11–3.13, SQLite con FTS5.
Caricare il pacchetto sorgente `openjarvis_lite-0.2.0.tar.gz` sul CT, per
esempio in `/tmp`, poi come root:

```bash
apt update
apt install -y python3 python3-venv ca-certificates
id jarvis >/dev/null 2>&1 || useradd --system --create-home --home-dir /var/lib/jarvis --shell /usr/sbin/nologin jarvis
install -d -o jarvis -g jarvis /opt/jarvis-lite /srv/jarvis-workspace /srv/jarvis-vault /srv/jarvis-state
tar -xzf /tmp/openjarvis_lite-0.2.0.tar.gz -C /opt/jarvis-lite --strip-components=1
chown -R jarvis:jarvis /opt/jarvis-lite
runuser -u jarvis -- python3 -m venv /opt/jarvis-lite/.venv
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install /opt/jarvis-lite
```

Non usare l'installer full di OpenJarvis. Il pacchetto base installa soltanto
`click`, `httpx`, `jsonschema` e relative dipendenze. Nessun browser viene
scaricato se disabilitato. Non sono necessari Git, Rust, Node o Obsidian.

`config/lite.toml` è già predisposto per:

```toml
[engine]
host = "http://192.168.1.252:11434"
timeout = 120.0
[intelligence]
model = "openbmb/minicpm5-2b:q8_0"
[knowledge]
vault_path = "/srv/jarvis-vault"
[memory]
enabled = true
db_path = "/srv/jarvis-state/memory.db"
```

Questi sono estratti del file completo, non un secondo file da concatenare.
Il modello deve essere già presente nel CT Ollama: `check` non lo scarica.

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml check
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml ask --pack general --json 'Calcola 17 * 23 usando calculator'
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml ask --pack knowledge --json 'Usa notes_write per creare test.md con il testo ORCHIDEA-742'
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml ask --pack knowledge --json 'Cerca ORCHIDEA nelle note usando notes_search'
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/jarvis --config /opt/jarvis-lite/config/lite.toml chat
```

I risultati JSON devono contenere `tool_results` riusciti. Una risposta
senza tool non certifica l'azione. La qualità del nuovo pack con MiniCPM va
collaudata sul target; i precedenti test reali del modello riguardano la 0.1.

## Pack e routing

| Pack | Tool |
|---|---|
| `chat` | Nessuno |
| `general` | `calculator` |
| `files` | `file_read` nel workspace |
| `memory` | `memory_store`, `memory_retrieve` nel database personale |
| `knowledge` | `notes_search`, `notes_read`, `notes_write`, `notes_append` nel vault |
| `browser` | `browser_navigate`, `browser_click`, `browser_type`, `browser_extract` |

`tools.enabled` resta l'allowlist globale; al modello arrivano solo gli schema
del pack scelto. `enabled=[]` lascia disponibile soltanto `chat`. Non sono
ammessi tool esterni al pack e gli argomenti JSON sconosciuti sono rifiutati.

Le regole italiano/inglese selezionano `knowledge` per note/appunti/vault/
Obsidian/Markdown e nomi `.md`; `memory` per ricorda/memorizza/memoria senza
riferimenti al vault. **Cambiamento dalla 0.1:** «Cerca nelle note» ora cerca
i Markdown. Per dati già memorizzati in SQLite usare `--pack memory` oppure
«Cerca nella memoria». Non viene eseguita una migrazione automatica.
Richieste miste (es. sito → vault) richiedono passi separati e pack espliciti.
`/pack knowledge`, `/pack browser`, `/auto`, `/exit` sono disponibili in chat.

## Vault e memoria

- `knowledge.vault_path`: percorso assoluto. Contiene soltanto i file dell'utente;
  salvataggi atomici, directory create quando necessario, niente database sul disco.
- I tool accettano path relativi con `/`, estensione `.md`. Vietati traversal,
  path assoluti, drive/UNC, file nascosti, symlink, hard link e file speciali.
  Linux usa descrittori di directory e `O_NOFOLLOW` anche contro scambi di symlink.
- `notes_write` crea o **sostituisce tutto** il file; `notes_append` richiede un
  file esistente e aggiunge esattamente il testo fornito, senza nuove righe implicite.
- `notes_search` riusa `SQLiteMemory`/FTS5 in RAM. A ogni ricerca controlla i
  contenuti e aggiorna solo quelli cambiati; rimozioni e rinomine vengono recepite.
  La ricerca trova parole in testo e path, restituisce al massimo tre estratti.
- Limiti: 20.000 caratteri per write/append, 256 KiB per nota, 5.000 voci e
  16 MiB di testo per scansione. Il superamento della scansione è un errore,
  mai un risultato completo fittizio. File non leggibili/non supportati sono
  saltati con conteggio esplicito. Nessun embedding o indicizzatore in background.
- `memory.db_path`: memoria personale persistente separata, da tenere fuori
  dal vault; store/retrieve e limiti della 0.1 rimangono. La cronologia chat
  rimane in RAM e si perde al riavvio.

Per Obsidian aprire una copia sincronizzata o un mount del vault come cartella.
La sincronizzazione non è inclusa. Fare backup dei `.md` e, se usata, della
memoria SQLite separata. Scritture Jarvis serializzate; modifiche simultanee
da Obsidian e Jarvis possono sovrascriversi: non c'è un protocollo di merge.

## Browser opzionale

Le istruzioni complete con versione, checksum, servizio Debian e smoke sono
in [docs/BROWSER.md](docs/BROWSER.md). Per Chromium:

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install '/opt/jarvis-lite[browser]'
/opt/jarvis-lite/.venv/bin/python -m playwright install-deps chromium
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m playwright install chromium --only-shell
```

Nel file completo impostare `tools.browser=true`, aggiungere i quattro nomi
browser a `tools.enabled` e mantenere `browser.backend="chromium"`.
Per provare Obscura esiste `config/lite-obscura.toml`, esplicito e senza fallback.
Il backend si inizializza solo alla prima chiamata browser; una nuova sessione
isolata per sistema, un solo thread, nessun profilo personale.

Il controllo iniziale prova realmente l'intercettazione; se non funziona,
l'avvio fallisce. Il fallback avviene solo con `browser.fallback="chromium"`,
soltanto all'avvio, con warning e backend effettivo nei metadati. Nessun replay
di un click o di una scrittura dopo un errore. Click/type conservano il gate
di conferma: in chat è disponibile; per `ask` usare `--confirm`.

Privati, metadata, schemi non HTTP(S), WebSocket e service worker sono bloccati.
**I redirect HTTP con Location sono rifiutati anche se pubblici**, perché il
routing Playwright non garantisce una callback per ogni hop. Usare l'URL finale.
Le richieste passano da `route.fetch(max_redirects=0)` prima di essere consegnate
al renderer. Queste protezioni non sono una sandbox di rete: DNS rebinding,
canali non intercettati e limiti del browser richiedono filtri egress sul CT.
Non abilitare override fail-open né accesso alla LAN per il browser. L'endpoint
Ollama resta raggiungibile dall'adapter, separato dal pack browser.

## Limiti runtime e SDK

Default invariati: 6 generazioni, 5 chiamate sequenziali, output tool di 1200
caratteri, payload massimo di 12000 byte, `num_ctx=8192`, `max_tokens=512`.
Il limite byte non è una misura esatta dei token. Memoria, vault, file e browser
richiedono almeno una chiamata tool; un richiamo, poi mancata verifica esplicita.
Gli esiti incompleti CLI escono con codice 2. Timeout fermano il loop senza retry;
Python non può interrompere forzatamente un tool già in esecuzione.

```python
from openjarvis import Jarvis
with Jarvis(config_path="config/lite.toml") as jarvis:
    result = jarvis.ask("Cerca Petalo", pack="knowledge")
    print(result["content"])
```

Laya potrà passare un nome pack alla stessa API. Nessun server HTTP,
scheduler, speech, training, agenti avanzati o discovery in questa distribuzione.
Licenza Apache 2.0 upstream conservata.

## Verifiche

```bash
python -m pip install '.[dev]'
python -m pytest -q -rs
python -m ruff check src tests
python -m build
```

Vedere [VALIDATION](docs/VALIDATION.md) per risultati e limiti osservati,
[LITE_PLAN](docs/LITE_PLAN.md) per architettura e
[REDUCTION_MANIFEST](docs/REDUCTION_MANIFEST.md) per file cambiati.
