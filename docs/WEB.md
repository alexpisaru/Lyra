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
  public/               favicon.svg, icone PNG (generate da scripts/make-icons.mjs)
  src/
    App.tsx             hero incorniciato, viste, framing dell'orb, colonna stati
    components/         LyraOrb, StatusPill (card di stato), StateGallery («Stati
                        principali»), Backdrop (onde nebulose), BottomNav, ChatView,
                        ChatComposer, BrainView, NoteMarkdown, ActivityView, icons
    hooks/              useLyraState (status + /ws + activity), useLyraWebSocket,
                        useChat (conversazione a livello app), useViewport (tastiera iOS),
                        useElementSize (dimensioni hero, media query)
    lib/                api.ts (unico client HTTP), websocket.ts (unico client /ws),
                        orbState.ts (state machine), orbScene.ts + orbShaders.ts (WebGL),
                        activity.ts (reducer timeline), notes.ts (Markdown Obsidian), frames.ts
    types/api.ts        contratto tipizzato di Lyra API
    test/               Vitest + Testing Library (fetch e WebSocket simulati)
```

## Comportamento

L'immagine di riferimento (hero + «Stati principali» + Home/Chat) è la fonte visiva
canonica. Layout: un **hero** scuro incorniciato (bordo cyan sottile, angoli
arrotondati, onde nebulose blu sfocate) contiene orb, card di stato, viste e
navigazione; da 1200×620 px in su compare a destra la colonna **Stati principali**.
Sotto quella soglia l'hero occupa tutto lo schermo (su telefono senza cornice).

- **Home**: orb grande, protagonista, leggermente sopra il centro; card di stato in
  alto a destra; navigazione in basso. Nessun input, nessun titolo. Sotto l'orb
  compare una parola discreta solo se Lyra non è in attesa («Elabora», «Usa uno
  strumento», «Lyra non raggiungibile»).
- **Chat**: il composer appare solo qui, placeholder «Come posso aiutarti?».
  `POST /api/chat` con `pack: "auto"`; `+` apre il selettore pack, libro e globo
  sono scorciatoie Knowledge/Browser. La graffetta del riferimento è omessa: l'API
  non supporta upload. Orb medio in alto, composer grande a vetro con invio blu. Risposta di
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
  compatta («● Lyra») e si apre al tap; tap fuori o Esc chiude. Offline: punto
  grigio e «Lyra non raggiungibile». Nessuna pagina Status.
- **Stati principali** (solo schermi larghi): griglia 2×3 IDLE / THINKING / USING
  TOOL / RESPONSE / SPEAKING / INTERRUPTED con anteprima viva dell'orb, titolo e
  sottotitolo italiano; la card dello stato live è evidenziata. È una legenda: le
  anteprime di speaking/interrupted non significano che Lyra parli (Voice non c'è).

## Orb (Three.js/WebGL2)

Un solo canvas che riempie l'hero per tutta la sessione; cambiando vista cambia solo
il framing (grande in Home, medio in alto in Chat, piccolo segno vivo in alto a
sinistra in Brain/Activity), con easing nel render loop. Le anteprime della colonna
«Stati principali» sono disegnate da **un solo** renderer WebGL aggiuntivo (scissor
per card, ~30 fps, qualità "mini").

Obiettivo dal riferimento: una **massa di energia luminosa** leggibile, non una
matassa di linee. Luce additiva su canvas trasparente; strati, tutti deformati dallo
stesso campo (respiro, rigonfiamenti, ritmo, impulsi, onda):

1. **guscio**: sfera densa con bordo cyan-bianco intenso e alone del bordo;
2. **vene luminose**: rete di scariche cyan sulla superficie (tratti brevi con
   svolte nette), luce che scorre lungo le vene;
3. **strato viola/indaco**: zone e vene viola strutturali sul bordo e in superficie;
4. **volume interno**: tante particelle-stella, core che pulsa;
5. **polvere**: particelle che si staccano dalla superficie;
6. **archi esterni**: pochi archi sottili ed eleganti (cyan, uno o due viola);
7. **alone** morbido attorno al bordo, flash di risposta, stelle lontane.

Ogni stato ha obiettivi propri, interpolati in ~450 ms (nessuna geometria ricreata):
speed, deform, flow, core, purple, veins, alternate, arcs, arcSpread, orbit,
compression, dispersion, glow, brightness, warm, saturation, jitter, rhythm, flare
(`web/src/lib/orbState.ts`).

| Stato | Resa |
|---|---|
| idle | respiro lento e calmo, rete di vene tranquilla, viola visibile |
| thinking | turbolenza interna, micro-flussi più veloci, viola più leggibile, alternanza cyan/viola, anelli stretti attorno alla sfera |
| using_tool | energia verso l'esterno: archi ampi e più luminosi, polvere che si allontana, bordo attivo |
| response | starburst dal centro, alone più intenso, onda di luce dal centro al bordo |
| error | coesione persa, jitter, tinta verso magenta |
| offline (`/ws` chiuso) | quasi immobile, desaturato, viola quasi spento |
| speaking / interrupted / listening | **solo anteprime** (colonna stati e pannello DEV); il runtime live non li produce |

Speaking = pulsazione ritmica organica; interrupted = più aspro, coesione persa,
rosso/magenta/viola.

Eventi one-shot reali: `tool_started` → impulso verso l'esterno; `tool_finished` →
impulso più morbido verso l'interno (distanziato di ≥450 ms dal primo); `response`
→ onda. Uno strumento veloce (calculator ≈ 50 ms) resta visibile come `using_tool`
fino a 1,2 s dopo `tool_finished`.

In sviluppo (`npm run dev`) un pannello in alto a sinistra forza ogni stato (anche
le anteprime voice) e lancia gli impulsi, per il confronto visivo; non è incluso
nella build di produzione (verificato: né JS né CSS in `dist`).

Prestazioni: qualità adattiva (desktop ≈ 24k guscio + 4,5k volume + 3,5k polvere,
56 vene, 14 tratti viola, 10 archi; mobile e dispositivi deboli ridotti),
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
