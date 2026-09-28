# Lyra Web 0.4.0 (PWA)

Interfaccia web/PWA di Lyra, in `web/`, separata da `src/openjarvis/`. Build
statica (React 19 + Vite 8 + TypeScript + Three.js), servita da Caddy sul CT.
Usa solo gli endpoint di Lyra API 0.3.1 (0.3.0 + `GET /api/knowledge/notes`); nessuna logica
agentica nel frontend.

```
Browser / iPhone (LAN o Tailscale)
   │  http(s)://<ct>/          static PWA  (/var/www/lyra)
   │  /api/*  /ws              Caddy reverse proxy
   v
Lyra API 127.0.0.1:8787  ──>  Lyra Core (Ollama/MiniCPM, memory, vault, Chromium)
```

## Struttura

```
web/
  index.html            meta iOS/PWA, viewport-fit=cover
  vite.config.ts        PWA (manifest + service worker), proxy dev /api e /ws
  brand/lyra-logo.png   logo ufficiale (sorgente, trasparente)
  public/               favicon, icone PWA/iOS e lyra-logo.png, generate dal logo
                        con `npm run icons` (scripts/make-icons.mjs, richiede ffmpeg)
  src/
    App.tsx             hero incorniciato, viste, framing dell'orb
    components/         LyraOrb, StatusPill (card di stato), Backdrop (onde nebulose),
                        BottomNav, ChatView, ChatComposer, BrainView, NoteMarkdown,
                        ActivityView, icons
    hooks/              useLyraState (status + /ws + activity), useLyraWebSocket,
                        useChat (conversazione a livello app), useViewport (tastiera iOS),
                        useElementSize (dimensioni dell'hero)
    lib/                api.ts (unico client HTTP), websocket.ts (unico client /ws),
                        orbState.ts (state machine), orbScene.ts + orbShaders.ts (WebGL),
                        activity.ts (reducer timeline), notes.ts (Markdown Obsidian), frames.ts
    types/api.ts        contratto tipizzato di Lyra API
    test/               Vitest + Testing Library (fetch e WebSocket simulati)
```

## Comportamento

L'immagine di riferimento è la fonte visiva canonica per hero, orb, card di stato,
Home e Chat. La sua tavola «Stati principali» è **solo un riferimento visivo** per
gli stati dell'orb e non fa parte della UI. Layout: un **hero** scuro incorniciato
(bordo cyan sottile, angoli arrotondati, onde nebulose blu sfocate) che contiene
orb, card di stato, viste e navigazione. L'orb fluttua in uno spazio quasi nero,
senza cornice; le onde blu restano solo come velatura in basso.

- **Sotto l'orb**: una riga dice cosa sta facendo Lyra, dagli eventi reali di `/ws`:
  «Sto pensando…», «Uso la calcolatrice…» (nome del tool reso in italiano:
  calcolatrice, note, memoria, file, browser; altrimenti il nome del tool),
  «Qualcosa non è andato»; nulla quando è in attesa. Quando l'orb diventa anello la
  riga scende sotto l'anello. In Chat la stessa frase sostituisce «Lyra sta
  elaborando» nell'attesa della risposta.
- **Navigazione**: pillola compatta con sole icone; l'etichetta compare solo sulla
  voce attiva (i nomi restano accessibili agli screen reader).

- **Home**: orb grande, protagonista, leggermente sopra il centro; card di stato in
  alto a destra; navigazione in basso. Nessun input, nessun titolo. Sotto l'orb
  compare una parola discreta solo se Lyra non è in attesa («Elabora», «Usa uno
  strumento», «Lyra non raggiungibile»).
- **Chat**: il composer appare solo qui, placeholder «Come posso aiutarti?».
  `POST /api/chat` con `pack: "auto"`; `+` apre il selettore pack, libro e globo
  sono scorciatoie Knowledge/Browser. La graffetta del riferimento è omessa: l'API
  non supporta upload. Orb medio in alto, composer grande a vetro con invio blu.
  La conversazione sale nello spazio sotto l'orb e si dissolve verso di esso; la
  risposta di Lyra compare blocco per blocco (disattivato con reduced motion).
  Mentre leggi una conversazione conclusa l'orb si attenua; torna pieno appena
  Lyra lavora, e mentre lavora in Chat è inquadrato un po' più piccolo perché
  l'anello è più largo della sfera. Risposta di
  Lyra in primo piano (Markdown sicuro), domanda dell'utente discreta, strumenti
  usati in una riga minima (`calculator ✓`). La conversazione vive a livello app:
  passando a Home/Brain non si perde; «Nuova conversazione» chiama `/api/chat/reset`.
  409 → «Lyra sta già lavorando a una richiesta»; il testo digitato resta.
- **Brain**: all'apertura elenca subito tutte le note (`/api/knowledge/notes`); la
  ricerca filtra all'istante per titolo/percorso e aggiunge i risultati full-text
  (`/api/knowledge/search`, debounce 280 ms). Lettura con `/api/knowledge/note`. Desktop: split view; mobile: lista → nota a schermo
  intero → indietro. Frontmatter nascosto, `[[wikilink]]` diventano ricerche,
  HTML grezzo mai eseguito, immagini del vault non caricate. Solo lettura.
- **Activity**: timeline di `/ws` (Thinking, Using tool, Tool completed/failed,
  Response, Errore, connessione) con orario; niente payload o JSON; max 200 righe.
- **Status**: card in alto a destra nell'hero, come nel riferimento: «● Lyra attiva ›»,
  «MiniCPM 2B (Ollama)» (nome breve dal tag del modello; quello completo, la
  versione e lo stato della connessione nel tooltip), «Browser: Chromium»,
  «Memoria: attiva», «Knowledge: attivo», con icone lineari. Aperta di default su
  schermi larghi (il chevron la chiude); su telefono e in Brain/Activity parte
  chiusa: **solo il pallino colorato** in un piccolo cerchio (verde attiva, giallo
  parziale/connessione, grigio non raggiungibile), si apre al tap; tap fuori o Esc
  chiude. Nessuna pagina Status.
- **App installata su iPhone**: iOS può impaginare la pagina più corta dello
  schermo di circa l'altezza della barra di stato, lasciando una fascia vuota in
  fondo. `src/lib/standalone.ts` misura la differenza (solo in modalità app
  installata, massimo 120 px) e l'app si estende fino al bordo.
## Lyra Voice (microfono e conversazione vocale)

Niente wake word né ascolto in background: il microfono si accende solo da un tocco.
Architettura completa, API, provider e installazione: [VOICE.md](VOICE.md).

- **Superfici voce** (`src/voice/surfaces.ts`): Home (primaria, pulsante sotto
  l'orb) e Chat (nel composer). Due controlli sulla **stessa** sessione, posseduta
  da `App`: tra Home e Chat restano microfono, `MediaStream`, `AudioContext`, VAD e
  turno in corso. Brain, Activity o qualunque altra vista chiamano `stopListening()`
  (tracce ferme, `AudioContext` chiuso, VAD e turno annullati, stato off); tornando
  in Home o Chat non si riaccende da solo. Background/`pagehide`: stesso rilascio.
- **Conversazione** (`src/voice/conversation.ts`): listening → (VAD locale) →
  thinking (`/api/voice/transcribe`, poi `chat.converse`, lo stesso invio della Chat)
  → speaking (`/api/voice/speak`, una frase alla volta) → listening. I turni parlati
  compaiono in Chat come turni normali. Un audio suona solo se `client_id`,
  `voice_session_id` e `voice_turn_id` sono quelli correnti.
- `src/voice/useVoiceSession.ts`: `voiceState`, `micPermission`, `hasLiveTrack`,
  `inputLevel`, `error`, `startListening()`, `stopListening()`; la UI non tocca mai
  `MediaStream`. `getUserMedia` e l'`AudioContext` partono dal tocco (iOS); lo stesso
  `AudioContext` misura il livello e riproduce la voce di Lyra.
- `src/voice/levelMeter.ts` (livello per la UI + frame RMS per il VAD, mai collegato
  alle casse), `vad/` (VAD sostituibile), `recorder.ts` (un `MediaRecorder` per
  enunciato, formato per feature detection), `player.ts`, `identity.ts`,
  `speechText.ts` (Markdown → frasi da dire).
- Il pulsante: tocco = accendi; con la conversazione attiva (anche durante thinking,
  speaking o un errore di turno) tocco = spegni. L'anello di livello solo in ascolto.
- Il microfono richiede un'origine sicura (HTTPS, es. Tailscale/Caddy).
- **Orb e didascalia**: `orbStateWithVoice` dà priorità al runtime (thinking,
  using_tool, offline…); con runtime idle l'orb segue la voce. La didascalia in Home
  fa lo stesso (`voiceCaption`).

## Orb (Three.js/WebGL2)

Un solo canvas che riempie l'hero per tutta la sessione; cambiando vista cambia solo
il framing (grande in Home, medio in alto in Chat, piccolo segno vivo in alto a
sinistra in Brain/Activity), con easing nel render loop.

Riferimento: una sfera di energia blu-cyan che si legge come sfera perché il bordo
è molto più luminoso del centro. Luce additiva su canvas trasparente; strati,
deformati dallo stesso campo (respiro, rigonfiamenti, ritmo, impulsi, onda):

1. **globo**: il riempimento cyan traslucido del corpo è **disattivato**
   (`BODY_FILL = 0` in `web/src/lib/orbScene.ts`; `1` lo rimette): la sfera è una
   rete trasparente di energia con le sue particelle;
2. **bordo**: nessun anello cyan pieno; il contorno è disegnato dalla rete stessa,
   più fitta e luminosa verso la silhouette, con un alone largo e tenue
   (`RIM_RING = 0` in `web/src/lib/orbScene.ts`; `1` rimette l'anello);
3. **rete di energia** finissima su tutta la sfera, fatta come una rete e non
   come un gomitolo: ~1.900 nodi minuscoli, ognuno collegato ai 2-3 vicini da un
   tratto breve e leggermente irregolare, così i collegamenti chiudono tante celle
   piccole; più luminosa verso il bordo, visibile sulla faccia, più tenue
   sull'emisfero dietro; zone che si accendono e si spengono, scintille lungo i
   collegamenti; verso il centro della faccia la rete (e le stelle interne) si
   dirada in modo irregolare, lasciando un centro più vuoto dai contorni casuali;
   sopra, pochi **filamenti principali** più luminosi (una rete a
   maglie larghe, ~70 nodi) che attraversano la sfera con curve ampie;
4. **viola/indaco** solo nei **filamenti** della rete: ogni collegamento è viola
   o no (scelta casuale per filamento, con una lieve preferenza per alcune zone che
   migrano lentamente); più filamenti viola in thinking e dopo una risposta. Niente
   macchie viola nel corpo, sulla superficie o nell'alone. Palette cyan saturo e
   blu; la rete non schiarisce mai verso il bianco (le parti dense vicino al
   bordo vanno verso un blu più profondo, così le sovrapposizioni restano blu);
5. **particelle**: tante stelle interne di dimensioni diverse e una nuvola esterna
   raccolta attorno alla sfera su tutti i lati, che si dirada;
6. **scie di energia**: implementate (nastri morbidi che nascono dal bordo, con
   un ciclo di vita proprio) ma **disattivate** per scelta visiva
   (`SHOW_TRAILS = false` in `web/src/lib/orbScene.ts`);
7. **alone** stretto attorno al bordo, poca foschia (contrasto alto).

Ogni stato ha obiettivi propri, interpolati in ~450 ms (nessuna geometria ricreata):
speed, deform, flow, core, purple, plasma, discharge, alternate, flux, fluxReach, orbit,
compression, dispersion, glow, brightness, warm, saturation, jitter, rhythm
(`web/src/lib/orbState.ts`).

| Stato | Resa |
|---|---|
| idle | respiro lento, rete tranquilla, viola discreto, archi lenti |
| thinking | la sfera si scompone e si ricompone in un **anello obliquo e irregolare** che ruota (grumi luminosi, tratti sottili, ogni ~9 s si schiaccia in un'ellisse), con l'energia di thinking; resta finché il modello ragiona, poi si scompone e torna sfera (`web/src/lib/ringMorph.ts`) |
| using_tool | stesso anello di thinking (parte a `tool_started` se non c'è già, continua durante il ragionamento successivo); impulso verso l'esterno a `tool_started`, verso l'interno a `tool_finished` |
| response | **nessun bagliore bianco**: onda cyan dal centro al bordo, scariche più attive, accensione viola sul bordo, particelle che si espandono, poi ritorno a idle |
| error | perdita di coesione, energia che si degrada, tinta verso magenta |
| offline (`/ws` chiuso) | desaturato, quasi fermo, campo minimo, alone basso |
| speaking / interrupted / listening | **predisposti** per la parte voce; il runtime live non li produce |
| speaking (predisposto) | vivo: più turbolenza e flusso, pulsazioni irregolari "a sillabe" diverse sulla superficie, più viola |

Eventi one-shot reali: `tool_started` → impulso verso l'esterno; `tool_finished` →
impulso più morbido verso l'interno (distanziato di ≥450 ms dal primo); `response`
→ onda. Uno strumento veloce (calculator ≈ 50 ms) resta visibile come `using_tool`
fino a 1,2 s dopo `tool_finished`.

Il pannello DEV per forzare gli stati è stato rimosso dopo aver confermato gli
stati; per rivederli si usa una chat reale (`/ws`).

**Anello di lavoro**: quando lo stato è `thinking` o `using_tool` l'orb esegue la
sequenza ad anello (si restringe, si scompone, si ricompone in un anello obliquo e
irregolare che ruota); quando il lavoro finisce si scompone di nuovo e si richiude
in sfera (~2,4 s). Se il lavoro riparte mentre si sta richiudendo, riprende
dall'anello invece di ricominciare. Con `prefers-reduced-motion` resta sfera.
È una deformazione di `place()` (`uMorph`, `uScatter`, `uFlatten`, `uShrink`),
quindi tutta la rete di filamenti la segue; la temporizzazione è in
`web/src/lib/ringMorph.ts` (testata).

Prestazioni: qualità adattiva (desktop ≈ 20k bordo + 8k interno + 14k particelle
esterne, rete di ~1.900 nodi, 14 scie di energia; mobile e dispositivi deboli ridotti),
devicePixelRatio ≤ 2, riduzione dinamica della risoluzione se i frame sono lenti,
pausa quando la pagina è nascosta, `prefers-reduced-motion` (orb presente,
movimento ridotto), Three.js in un chunk separato caricato dopo la UI.
Cleanup completo (rAF, geometrie, materiali, renderer, `forceContextLoss`, listener).
Senza WebGL2 compare un orb CSS statico, incorniciato nell'hero.
Gli shader evitano `pow()` con base negativa e `atan()` (comportamento non definito
o impreciso su alcune GPU/SwiftShader: producevano bande rettangolari nell'alone).

## PWA

Manifest (`display: standalone`, theme/background `#02040a`, icone 192/512/maskable),
apple-touch-icon, `apple-mobile-web-app-*`, `viewport-fit=cover`, safe area su
tutti i bordi, tastiera iOS gestita con `visualViewport`. Service worker (Workbox)
in precache solo shell e asset statici; `/api` e `/ws` mai in cache. Offline la
UI si apre ma dice «Lyra non raggiungibile».

**HTTPS**: i browser registrano service worker solo in contesto sicuro (HTTPS o
localhost). Su `http://<ip-lan>` l'app funziona e su iPhone «Aggiungi a Home»
la apre a schermo intero, ma senza cache offline. Per la PWA completa usare il
blocco HTTPS Tailscale del Caddyfile.

## Sviluppo

```bash
cd web
npm install
npm run dev        # http://127.0.0.1:5173, proxy /api e /ws verso 127.0.0.1:8787
npm run lint       # ESLint + tsc
npm run test       # Vitest (nessun modello reale)
npm run build      # -> web/dist
```

`LYRA_API=http://host:porta npm run dev` punta a un'altra istanza dell'API.

## Deploy sul CT (build sul PC, Caddy sul CT)

Scelta: `/var/www/lyra` (convenzione Debian per contenuti statici serviti da un web
server; resta separata da `/opt/lyra`, che contiene codice Python e venv).

Sul PC:

```bash
cd web && npm ci && npm run lint && npm run test && npm run build
rsync -a --delete web/dist/ root@IP-CT-LYRA:/var/www/lyra/
scp config/Caddyfile root@IP-CT-LYRA:/tmp/Caddyfile.lyra
```

Sul CT, come root (Lyra API resta su 127.0.0.1:8787, `[api] host` invariato):

```bash
apt update && apt install -y caddy
install -d -m 0755 /var/www/lyra && chown -R root:root /var/www/lyra
cp /tmp/Caddyfile.lyra /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
curl -s http://127.0.0.1/api/status
```

Poi dal PC o dall'iPhone: `http://<ip-lan-o-tailscale-del-ct>/`. Per HTTPS su
Tailscale: abilitare MagicDNS e HTTPS nel pannello Tailscale, impostare il nome
nel Caddyfile, `TS_PERMIT_CERT_UID=caddy` in `/etc/default/tailscaled`,
`systemctl restart tailscaled && systemctl reload caddy`. Nessun port forwarding
sul router, nessuna esposizione Internet. Se si imposta `api_key`, la UI non ha
ancora una schermata per inserirla (il client è predisposto: `localStorage`
`lyra.apiToken`, header Bearer e subprotocol WebSocket).

## Limiti

- Caddyfile non eseguito in questo ambiente (Caddy non installato qui): la stessa
  topologia (statico + proxy `/api` e `/ws` con Host preservato) è stata provata
  con il proxy di Vite verso la Lyra API reale.
- La replica del riferimento è stata confrontata con screenshot Chromium con
  rendering software (SwiftShader); su GPU reale luminosità e bloom possono
  risultare leggermente diversi. Il riferimento è un'illustrazione: l'orb è
  un'approssimazione in tempo reale, non una copia pixel per pixel.
- Nessuna conferma click/type del browser via UI (l'API le rifiuta), nessuna
  scrittura note, nessuno streaming token, nessuna schermata per l'API key.
- iPhone reale non provato: verificati viewport iPhone emulati (portrait e
  landscape) in Chromium. Safari/WebKit su dispositivo resta da provare.
