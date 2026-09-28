# Lyra Voice — fase 2 (conversazione vocale)

Niente wake word. Si tocca il microfono (Home o Chat), si parla, Lyra risponde a
voce **sullo stesso dispositivo** e torna ad ascoltare, finché non si spegne il
microfono, si passa a Brain/Activity o l'app va in background.

## Architettura

```
DISPOSITIVO (PWA)                                   CT (headless, dietro Caddy)
 microfono ─ AnalyserNode ─ VAD locale
                 │ enunciato (MediaRecorder, in RAM)
                 ├──► POST /api/voice/transcribe ──► STT (faster-whisper)  → testo
                 │ testo
                 ├──► POST /api/chat  (lo stesso della Chat) ──► Lyra Core → risposta
                 │ risposta, divisa in frasi
                 ├──► POST /api/voice/speak (frase 1, 2, …) ──► TTS (Piper) → WAV
 altoparlante ◄──┘ (solo se sessione e turno sono ancora quelli correnti)
```

- **Lyra Core non cambia.** Il testo parlato passa da `POST /api/chat` come quello
  scritto: stessa history in RAM, stessi tool, stesso lock «busy». Aprendo la Chat
  si vedono la frase detta e la risposta come turni normali.
- **Lyra Voice sul server** (`src/openjarvis/voice/`) fa solo STT e TTS:
  `SpeechToTextProvider` / `TextToSpeechProvider` (`providers.py`), un provider
  ciascuno (`faster_whisper_stt.py`, `piper_tts.py`), `VoiceService` e le due route.
  Non conosce Core, conversazioni né altri client.
- **Orchestrazione sul client** (`web/src/voice/`): `conversation.ts` è la
  macchina a stati (senza React), `useVoiceSession.ts` la collega a microfono,
  level meter e UI. Home e Chat sono due controlli sulla stessa sessione.

## Stati

`off` → tocco → `listening` → (VAD: fine frase) → `thinking` (trascrizione + chat)
→ `speaking` (TTS) → `listening`. Un errore di turno (STT, Core, TTS, rete) mostra
`error` per 2,5 s e torna a `listening` con il microfono ancora aperto. Un errore del
microfono (permesso negato, audio sospeso dal sistema, registrazione non supportata)
chiude la sessione in `error`; un tocco riprova.

L'orb mostra lo stato voce quando il runtime è idle; `thinking`/`using_tool` del
runtime hanno la precedenza.

## VAD locale (`web/src/voice/vad/`)

Interfaccia `VoiceActivityDetector` (eventi `candidate`, `cancel`, `start`, `end`),
sostituibile con Silero VAD senza toccare UI o trasporto. Implementazione attuale:
energia (RMS dell'`AnalyserNode` già usato dal level meter), con soglie in un solo
posto (`DEFAULT_VAD_CONFIG` in `energyVad.ts`):

| Parametro | Valore | Effetto |
|---|---|---|
| rumore di fondo | adattivo, parte da −60 dBFS, sale ≤ 3 dB/s | la stanza si impara da sola |
| soglia di inizio | fondo + 14 dB (min −48 dBFS) | apre un candidato |
| soglia di continuazione | fondo + 8 dB | isteresi |
| parlato minimo | 200 ms | un colpo o un rumore breve non conta |
| silenzio di fine | 800 ms | le pause tra le parole non chiudono la frase |
| durata massima | 15 s | chiude comunque l'enunciato |

La registrazione parte già al `candidate` (così la prima sillaba non si perde) e
viene scartata se il candidato è un rumore. Il silenzio non viene mai inviato: si
manda solo l'enunciato finito. Mentre Lyra parla (e per 400 ms dopo) il VAD è
sordo, in aggiunta all'`echoCancellation` del microfono.

## Registrazione

Un `MediaRecorder` per enunciato sullo stream già aperto; il formato è scelto per
feature detection (`audio/webm;codecs=opus`, poi `audio/mp4` per Safari/iOS, …).
Nulla in `localStorage`/IndexedDB: il Blob vive solo fino alla risposta della
richiesta. Sul server l'audio è decodificato in memoria (PyAV) e non tocca il disco.

## Identità e instradamento

| id | cosa | dove nasce |
|---|---|---|
| `client_id` | un'installazione PWA/browser | UUID casuale in `localStorage` (`lyra.clientId`); niente fingerprint |
| `voice_session_id` | una conversazione col microfono | nuovo a ogni tocco che accende il microfono |
| `voice_turn_id` | un enunciato | nuovo a ogni fine frase |

Ogni richiesta voce porta i tre id (header `X-Lyra-Client-Id`,
`X-Lyra-Voice-Session-Id`, `X-Lyra-Voice-Turn-Id` per `transcribe`, campi JSON
per `speak`); il server li valida e li rimanda indietro. L'audio di risposta
viaggia **solo nella risposta HTTP alla richiesta di quel dispositivo**: niente
broadcast sul WebSocket, nessuno stato di routing sul server. Il client riproduce
un audio solo se `client_id` è il suo, `voice_session_id` è la sessione corrente
ancora attiva e `voice_turn_id` è il turno corrente: una risposta arrivata dopo uno
stop, un background o un nuovo tocco viene scartata. Se iPhone e PC parlano insieme,
ognuno riceve solo le proprie risposte; la chat testuale resta quella condivisa del
server (una richiesta alla volta: l'altra riceve «Lyra sta già lavorando»).

## API

- `POST /api/voice/transcribe` — body = audio (`Content-Type: audio/*`, max 4 MB),
  header id → `{client_id, voice_session_id, voice_turn_id, text, language, duration}`.
- `POST /api/voice/speak` — `{client_id, voice_session_id, voice_turn_id, text}`
  (max 600 caratteri: il client manda una frase alla volta e prepara la successiva
  mentre suona la precedente) → `audio/wav`, `Cache-Control: no-store`, header id.
- `GET /api/status` → `voice: {enabled, ready, stt, tts, error}`.

Stessa protezione delle altre route (token, same-origin, content-type non «simple»,
quindi niente POST cross-site senza preflight). Nei log solo id abbreviati, durate
e numero di caratteri: mai audio o testo. Caddy resta senza access log.

## Provider

**STT: faster-whisper, modello `small`, CPU int8.** Whisper è il riferimento per
l'italiano tra i modelli locali; `small` è la taglia più piccola con un italiano
buono (`base` è più rapido ma sbaglia molto di più); CTranslate2 int8 è il modo più
leggero di farlo girare su CPU. Decodifica webm/opus e mp4/aac in memoria con PyAV
(incluso nel pacchetto, nessun ffmpeg di sistema). `vad_filter` e un filtro sulle
classiche allucinazioni su silenzio («Sottotitoli a cura di…»).

**TTS: Piper, voce `it_IT-paola-medium`.** ONNX su CPU, molto più veloce del tempo
reale, voce italiana naturale, WAV in memoria. Con la risposta divisa in frasi il
primo audio arriva dopo la sola prima frase.

Stime (da verificare sul CT, dipendono dalla CPU):

| | disco | RAM | latenza tipica (4 core x86 moderni) |
|---|---|---|---|
| pacchetti `.[voice]` (faster-whisper, ctranslate2, av, onnxruntime, piper-tts, numpy, tokenizers) | ~300 MB | — | — |
| Whisper `small` (CTranslate2) | ~480 MB | ~0,6–1 GB | ~1–2,5 s per una frase di 3–5 s |
| (alternativa) Whisper `base` | ~145 MB | ~0,3 GB | ~0,4–0,8 s |
| Piper `it_IT-paola-medium` | ~63 MB | ~0,15 GB | ~0,1–0,3 s per frase |

## Installazione sul CT (da fare a mano, non automatica)

Prima, solo lettura, per decidere:

```bash
nproc; free -h; df -h /opt /srv; grep -o -m1 'avx2' /proc/cpuinfo; /opt/lyra/.venv/bin/python --version
```

Poi (utente `lyra`, stesso venv del servizio):

```bash
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[dev,browser,api,voice]'
sudo -u lyra mkdir -p /srv/lyra-state/voice/piper
sudo -u lyra /opt/lyra/.venv/bin/python -c "from huggingface_hub import snapshot_download; snapshot_download('Systran/faster-whisper-small', local_dir='/srv/lyra-state/voice/whisper-small')"
cd /srv/lyra-state/voice/piper && sudo -u lyra curl -fLO https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium.onnx && sudo -u lyra curl -fLO https://huggingface.co/rhasspy/piper-voices/resolve/main/it/it_IT/paola/medium/it_IT-paola-medium.onnx.json
```

Config (`/opt/lyra/config/lite-chromium.toml`):

```toml
[voice]
enabled = true
stt_model = "/srv/lyra-state/voice/whisper-small"
tts_voice = "/srv/lyra-state/voice/piper/it_IT-paola-medium.onnx"
```

`systemctl restart lyra-api`, poi `curl -s http://127.0.0.1:8787/api/status` →
`"voice": {"enabled": true, "ready": true, ...}` (i modelli si caricano in
background qualche secondo dopo l'avvio). Senza l'extra o senza modelli l'API parte
comunque e `voice.error` dice perché. `/srv/lyra-state` è già tra i
`ReadWritePaths` del servizio; nessuna nuova route Caddy (è già `/api/*`).

**Caddy e microfono:** il `Caddyfile` manda `Permissions-Policy: microphone=(self)`
(solo la PWA stessa può chiedere il microfono; `camera` e `geolocation` restano
negati). Con il vecchio `microphone=()` Chrome/Edge sul PC bloccavano il microfono.

**Parametri STT** (da misurare sul CT, non ancora ottimizzati): `stt_language`
(default `"it"`, passato sempre esplicitamente a Whisper: niente riconoscimento
automatico della lingua), `stt_beam_size` (default 1), `stt_vad_filter` (default
true), `stt_compute_type` (default `"int8"`), `stt_threads` (0 = default libreria).

## Rinviato alla fase 3

- Barge-in: `VoiceConversation.interrupt()` esiste già (ferma l'audio, stato
  `interrupted` → `listening`) ma il VAD è sordo mentre Lyra parla; la fase 3
  lo terrà acceso con soglia più alta e chiamerà `interrupt()`.
- Silero VAD al posto del VAD a energia (stessa interfaccia).
- TTS in streaming vero (oggi: una frase per richiesta, con prefetch).
- Annullare lato server una richiesta Core già partita (oggi uno stop non la
  interrompe: la risposta arriva in Chat, ma non viene detta).
