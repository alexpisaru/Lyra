# Lyra Web 0.4.0 (PWA)

Interfaccia web/PWA di Lyra, in `web/`, separata da `src/openjarvis/`. Build
statica (React 19 + Vite 8 + TypeScript + Three.js), servita da Caddy sul CT.
Usa solo gli endpoint di Lyra API 0.3.0; nessun endpoint nuovo, nessuna logica
agentica nel frontend. Lyra Core resta 0.3.0.

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
    App.tsx             viste, framing dell'orb, caption Home
    components/         LyraOrb, StatusPill, BottomNav, ChatView, ChatComposer,
                        BrainView, NoteMarkdown, ActivityView, icons
    hooks/              useLyraState (status + /ws + activity), useLyraWebSocket,
                        useChat (conversazione a livello app), useViewport (tastiera iOS)
    lib/                api.ts (unico client HTTP), websocket.ts (unico client /ws),
                        orbState.ts (state machine), orbScene.ts + orbShaders.ts (WebGL),
                        activity.ts (reducer timeline), notes.ts (Markdown Obsidian), frames.ts
    types/api.ts        contratto tipizzato di Lyra API
    test/               Vitest + Testing Library (fetch e WebSocket simulati)
```

## Comportamento

- **Home**: solo orb, navigazione in basso e pill di stato. Nessun input, nessun
  titolo. Sotto l'orb compare una parola discreta solo se Lyra non è in attesa
  («Elabora», «Usa uno strumento», «Lyra non raggiungibile»).
- **Chat**: il composer appare solo qui, placeholder «Come posso aiutarti?».
  `POST /api/chat` con `pack: "auto"`; `+` apre il selettore pack, libro e globo
  sono scorciatoie Knowledge/Browser (non upload: l'API non ne ha). Risposta di
  Lyra in primo piano (Markdown sicuro), domanda dell'utente discreta, strumenti
  usati in una riga minima (`calculator ✓`). La conversazione vive a livello app:
  passando a Home/Brain non si perde; «Nuova conversazione» chiama `/api/chat/reset`.
  409 → «Lyra sta già lavorando a una richiesta»; il testo digitato resta.
- **Brain**: ricerca sul vault (`/api/knowledge/search`, debounce 280 ms) e lettura
  (`/api/knowledge/note`). Desktop: split view; mobile: lista → nota a schermo
  intero → indietro. Frontmatter nascosto, `[[wikilink]]` diventano ricerche,
  HTML grezzo mai eseguito, immagini del vault non caricate. Solo lettura.
- **Activity**: timeline di `/ws` (Thinking, Using tool, Tool completed/failed,
  Response, Errore, connessione) con orario; niente payload o JSON; max 200 righe.
- **Status**: pill «● Lyra» in alto a destra. Hover (puntatore fine) o tap la
  espande (≈300 ms, trasformazioni, nessun layout shift): stato, modello, provider,
  browser, memoria, knowledge, connessione, versione. Tap fuori o Esc chiude.
  Offline: punto grigio e «Lyra non raggiungibile». Nessuna pagina Status.

## Orb (Three.js/WebGL2)

Un solo canvas a tutto schermo per tutta la sessione; cambiando vista cambia solo
il framing (grande in Home, ridotto in alto in Chat, piccolo segno vivo in alto a
sinistra in Brain/Activity), con easing nel render loop. Strati: guscio di
particelle con vene luminose (ridged noise) e bordo fresnel, polvere interna,
alone esterno, archi orbitali, glow billboard, stelle lontane. Blending
additivo puro sul canvas trasparente (il fondo CSS resta visibile).

| Stato (da `/ws`) | Animazione |
|---|---|
| idle | quasi sferico, respiro lento, poche particelle esterne |
| thinking | più turbolenza e velocità, leggera instabilità |
| using_tool | vortice orbitale e archi più visibili |
| response | breve espansione/pulse (1,4 s), poi ritorno a idle |
| error | perdita parziale di coesione, lieve deriva cromatica |
| offline (`/ws` chiuso) | desaturato, lento, attenuato |
| listening / speaking / interrupted | **predisposti, mai attivati** (Voice futura) |

Prestazioni: qualità adattiva (26k/12k/6k particelle desktop/mobile/deboli),
devicePixelRatio ≤ 2, riduzione dinamica della risoluzione se i frame sono lenti,
pausa quando la pagina è nascosta, `prefers-reduced-motion` (orb presente, ~20 fps,
movimento ridotto al 12%), Three.js in un chunk separato caricato dopo la UI.
Cleanup completo (rAF, geometrie, materiali, renderer, `forceContextLoss`, listener).
Senza WebGL2 compare un orb CSS statico.

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
- Nessun elenco completo delle note: l'API offre solo ricerca (max 3 risultati).
- Nessuna conferma click/type del browser via UI (l'API le rifiuta), nessuna
  scrittura note, nessuno streaming token, nessuna schermata per l'API key.
- iPhone reale non provato: verificati viewport iPhone emulati (portrait e
  landscape) in Chromium. Safari/WebKit su dispositivo resta da provare.
