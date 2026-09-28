# Browser Linux/CT — backend espliciti

Il modello vede sempre gli stessi quattro tool (`browser_navigate`,
`browser_click`, `browser_type`, `browser_extract`). `browser.backend` sceglie
soltanto come Playwright ottiene il browser:

| backend | Come | Stato |
|---|---|---|
| `chromium` (default) | `chromium.launch(headless=True)` locale | **Stabile. TARGET LINUX CT: VERIFIED** (Debian 13, Playwright 1.63.0): `check --browser` PASS, smoke PASS, nessun fallback. In precedenza superato anche su Windows (headless shell 153) |
| `obscura` | `chromium.connect_over_cdp(cdp_url)` verso un server Obscura su loopback | **EXPERIMENTAL**. v0.2.3 fallisce il probe di intercettazione su Windows. Non collaudato sul CT Linux |

## Fonti Obscura (ricontrollate il 27 settembre 2026)

- [Release v0.2.3](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.3),
  pubblicata il 20/09/2026, **ultima release disponibile** alla data del controllo.
- [README](https://github.com/h4ckf0r0day/obscura/blob/v0.2.3/README.md),
  [Playwright/CDP](https://github.com/h4ckf0r0day/obscura/blob/v0.2.3/docs/Use-with-Playwright.md),
  [variabili d'ambiente](https://github.com/h4ckf0r0day/obscura/blob/v0.2.3/docs/Environment-variables.md).
- Digest SHA-256 dall'API GitHub della release:
  - `obscura-x86_64-linux.tar.gz`: `1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec`
  - `obscura-x86_64-windows.zip`: `781a1b8bd12b65ec5aba95842e75e6f56b3101d360397506c0e35fe3f78536e8`
    (coincide con l'archivio usato nello smoke Windows).

Binari Linux x86_64 con glibc 2.35+ (Debian 12 = 2.36 ok, Ubuntu 22.04+ ok,
Debian 11 no). Le note v0.2.3 citano autenticazione integrata per CDP/MCP: la
configurazione Lite accetta solo `ws://IP-loopback:porta` senza token; se il
server richiedesse un token la connessione fallisce in modo esplicito.

## Stato reale di Obscura

Smoke del 26/09/2026 (sessione precedente), Obscura v0.2.3 Windows +
Playwright 1.63.0: la connessione CDP riesce, ma il probe di intercettazione
fallisce. All'avvio Lyra naviga verso `https://jarvis-interception.invalid/`
e si aspetta che la route del contesto risponda con un contenuto sintetico;
Obscura invece tenta il fetch di rete (errore; con un hostname pubblico: timeout
di 5 s). Stesso esito con route sulla pagina. Causa interna non diagnosticata.

Conseguenza: con Obscura il guard SSRF non potrebbe vedere le richieste, quindi
**Lyra rifiuta il backend**. Il probe esiste proprio per questo e non va
disattivato. In questa sessione il binario Obscura non è stato rieseguito;
l'esito Windows sopra non è generalizzato a Linux. Promuovere Obscura solo se
`check --browser` e lo smoke qui sotto passano sul CT.

## Installazione Obscura su Linux x86_64 (opzionale, sperimentale)

Questi comandi Obscura non sono ancora stati eseguiti sul CT (Chromium sì). Come root nel CT Lyra:

```bash
uname -m                      # x86_64
getconf GNU_LIBC_VERSION      # >= 2.35
apt install -y curl ca-certificates
install -d /opt/obscura-0.2.3
cd /opt/obscura-0.2.3
curl --fail --location --output obscura-x86_64-linux.tar.gz https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.3/obscura-x86_64-linux.tar.gz
echo '1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec  obscura-x86_64-linux.tar.gz' | sha256sum --check
tar -xzf obscura-x86_64-linux.tar.gz
chmod 755 obscura obscura-worker
./obscura --version
ldd ./obscura | grep 'not found' || echo 'librerie ok'
```

Archivio con rendering, senza stealth; tenere insieme `obscura` e
`obscura-worker`. Non servono Rust, Node o Docker. Il client Playwright:

```bash
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[browser]'
```

Avvio manuale per il collaudo (terminale separato):

```bash
runuser -u lyra -- env OBSCURA_ALLOW_PRIVATE_NETWORK=0 OBSCURA_NAV_TIMEOUT_MS=15000 OBSCURA_CDP_COMMAND_TIMEOUT_MS=20000 OBSCURA_FETCH_TIMEOUT_MS=10000 /opt/obscura-0.2.3/obscura serve --host 127.0.0.1 --port 9222
```

Solo loopback: mai esporre 9222 alla LAN, mai `--allow-private-network`.
Per l'avvio persistente, **dopo** un collaudo positivo:

```bash
cp /opt/lyra/config/obscura.service /etc/systemd/system/obscura.service
systemctl daemon-reload
systemctl enable --now obscura
systemctl status obscura
```

`config/obscura.service` è una ricetta di questo fork (utente `lyra`,
`ProtectSystem=strict`, `NoNewPrivileges`), non un'unità upstream, e non è
stata provata nel CT. Non usarla insieme al comando manuale sulla stessa porta.

## Configurazione e fallback

`config/lite-obscura.toml` è identico a `config/lite.toml` più browser attivo e:

```toml
[browser]
backend = "obscura"
cdp_url = "ws://127.0.0.1:9222"
fallback = "none"
```

- `fallback = "none"`: se CDP non risponde o il probe fallisce, il tool
  restituisce errore e `check --browser` esce con codice 1. Nessun ripiego.
- `fallback = "chromium"` (ammesso solo con `backend="obscura"`, richiede
  Chromium installato): ripiego **solo all'avvio della sessione**, con
  `RuntimeWarning` su stderr, `browser_backend="chromium"` e `fallback_reason`
  nei metadati, e riga `FALLBACK da obscura` in `check --browser`. Mai cambio
  di backend dopo un'azione già tentata.

## Smoke reale separato

```bash
# Probe del backend configurato (avvia davvero il browser):
runuser -u lyra -- /opt/lyra/.venv/bin/lyra --config /opt/lyra/config/lite-obscura.toml check --browser
# Contratto completo (serve l'extra dev; la directory sorgente deve essere dell'utente lyra):
runuser -u lyra -- /opt/lyra/.venv/bin/python -m pip install '/opt/lyra[dev,browser]'
cd /opt/lyra
runuser -u lyra -- env JARVIS_BROWSER_SMOKE=obscura JARVIS_CDP_URL=ws://127.0.0.1:9222 .venv/bin/python -m pytest -q -rs tests/test_browser_smoke.py
runuser -u lyra -- env JARVIS_BROWSER_SMOKE=chromium .venv/bin/python -m pytest -q -rs tests/test_browser_smoke.py
```

Oppure lo script completo, sempre come `lyra` da `/opt/lyra` (vedi SERVER_ACCEPTANCE): `BROWSER=obscura CONFIG=config/lite-obscura.toml bash scripts/ct-acceptance.sh`. Lo smoke non chiama
Ollama e verifica: probe di intercettazione, example.com reale, form
deterministico con type/click/extract, rifiuto di 192.168.1.252, WebRTC assente
(pagina e iframe) senza connessioni TCP verso un listener loopback, e con un
server HTTP locale temporaneo: redirect verso path privato bloccato (il server
riceve solo il primo hop), catena di redirect validata seguita
(`/hop1 → /hop2 → /final`), redirect privato di una sottorisorsa bloccato.
Nel test solo quei path fixture sono trattati come pubblici; il runtime non ha
alcuna eccezione del genere. Richiede accesso a example.com: un errore di rete
non è un successo.

## Confini del browser

- Guard su ogni richiesta: solo HTTP(S) verso IP pubblici (`security/ssrf.py`:
  privati, loopback, link-local, metadata, CGNAT/Tailscale, riservati, forme
  IPv4 mascherate, IPv6 mapped/NAT64/6to4; DNS non risolvibile = blocco).
- `route.fetch(max_redirects=0)`; un 3xx non viene mai consegnato al browser.
  Verificato con Chromium reale: se la route risponde con un 3xx, Chromium segue
  i salti successivi **senza** richiamare la route (i path intermedi arrivano al
  server senza controllo). Invece Refresh header, `<meta refresh>` e navigazioni
  JS generano nuove richieste che ripassano dal guard (verificato).
- Redirect della navigazione principale in `browser_navigate`: `Location`
  risolto, validato e riaperto come nuova navigazione sorvegliata, massimo 5
  salti; metadati `redirects`. Una navigazione principale bloccata riceve una
  pagina locale 403 «Blocked by Lyra» (nessuna richiesta alla destinazione)
  invece di un abort, che in Chromium lascerebbe una pagina d'errore capace di
  interrompere la navigazione successiva.
- Conseguenza del blocco per tipo di richiesta: una **navigazione del frame
  principale** (o un suo redirect) verso un indirizzo vietato fa fallire
  `browser_navigate`. Una **sottorisorsa** (immagine, script, fetch, beacon…) o la
  navigazione di un **iframe** verso un indirizzo vietato viene solo annullata
  (abort, nessuna richiesta inviata) e contata in `metadata.blocked_subresources`;
  la pagina continua. Caso reale: il DNS locale restituisce `0.0.0.0` per i domini
  di telemetria (`unagi.amazon.it`, `fls-eu.amazon.it`, `unagi-eu.amazon.com`,
  `collector.github.com`), e prima questo faceva fallire tutta la pagina.
  Un iframe bloccato non diventa una via alternativa verso la LAN: la sua richiesta
  è annullata prima del fetch, esattamente come le altre.
- Chiusura: il guard viene rimosso (`unroute_all(behavior="ignoreErrors")`) prima
  di chiudere il contesto, e abort/dispose su una pagina già chiusa vengono
  ignorati, così dopo un blocco non compaiono `TargetClosedError`.
- WebRTC: `--force-webrtc-ip-handling-policy=disable_non_proxied_udp` (Chromium)
  e init script che rimuove `RTCPeerConnection` & co. in pagine, iframe e popup
  (entrambi i backend). Verificato: senza queste misure una pagina invia STUN UDP
  e apre TCP TURN verso loopback; il flag da solo blocca solo l'UDP.
- Un contesto effimero, service worker e WebSocket bloccati, download rifiutati,
  popup chiusi, un solo thread. Timeout: connessione 5 s CDP / 10 s Chromium,
  azioni 10 s, navigazione 15 s, fetch 10 s, tool 30 s.
- Non è una sandbox di rete: nessun pinning DNS (DNS rebinding tra controllo e
  fetch), risoluzioni DNS/preconnect non sorvegliate. Per isolamento forte usare
  il firewall Proxmox sul CT Lyra (egress: DNS, Internet pubblico,
  192.168.1.252:11434; niente altra LAN).
