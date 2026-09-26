# Browser Linux/CT — backend espliciti

Verifica documentale del 26 settembre 2026:

- [Obscura v0.2.3](https://github.com/h4ckf0r0day/obscura/releases/tag/v0.2.3)
- [README della versione](https://github.com/h4ckf0r0day/obscura/blob/v0.2.3/README.md)
- [Playwright/CDP](https://github.com/h4ckf0r0day/obscura/blob/v0.2.3/docs/Use-with-Playwright.md)
- [Variabili d'ambiente](https://github.com/h4ckf0r0day/obscura/blob/v0.2.3/docs/Environment-variables.md)
- [Playwright route](https://playwright.dev/python/docs/api/class-route)

La distribuzione ufficiale include binari Linux x86_64. Il README richiede
glibc 2.35+: Debian 12/13 è il target consigliato; Debian 11 non basta.
CDP è il protocollo documentato, via `chromium.connect_over_cdp`, non `connect`.
La documentazione espone anche l'intercettazione delle richieste. La sua
compatibilità effettiva deve però passare il test Jarvis, non basta accettare
un comando CDP senza errore.

**Stato:** v0.2.3 Windows + Playwright 1.63.0 fallisce il probe di intercettazione
su una pagina sintetica `.invalid`, sia con route sul contesto sia sulla pagina.
La connessione CDP riesce ma il browser tenta il fetch invece del fulfill locale.
Jarvis rifiuta la sessione; nessun fallback implicito. Non è una prova Linux,
né una diagnosi della causa interna di Obscura. Anche un probe diagnostico
con hostname pubblico risolvibile è fallito per timeout. Perciò il default resta Chromium.
Promuovere Obscura a scelta preferita solo dopo il medesimo smoke sul CT.

## Installazione opzionale di Obscura

Da eseguire soltanto dopo aver caricato Jarvis. Nessun comando di questa guida
è stato eseguito sul server. Come root nel CT Debian 12/13 x86_64:

```bash
uname -m
getconf GNU_LIBC_VERSION
apt install -y curl ca-certificates
install -d /opt/obscura-0.2.3
cd /opt/obscura-0.2.3
curl --fail --location --output obscura-x86_64-linux.tar.gz https://github.com/h4ckf0r0day/obscura/releases/download/v0.2.3/obscura-x86_64-linux.tar.gz
echo '1534d1e6ddaf3d080ec4091eb41d0a4d8cc042a48b607d3c410fc13b482a9eec  obscura-x86_64-linux.tar.gz' | sha256sum --check
tar -xzf obscura-x86_64-linux.tar.gz
chmod 755 obscura obscura-worker
./obscura --version
ldd ./obscura
```

Controllare che `ldd` non mostri librerie mancanti. Il digest è quello pubblicato
nell'API GitHub per l'asset v0.2.3. Si usa l'archivio con rendering, senza stealth,
e si tengono insieme i due binari ufficiali. Non serve compilare Rust o installare
Chrome/Node. Un'immagine container ufficiale esiste, ma non è necessaria qui:
il binario evita Docker annidato nel CT e dipendenze aggiuntive.

Installare solamente il client Playwright nell'ambiente Jarvis:

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install '/opt/jarvis-lite[browser]'
```

Per un primo test, in un terminale separato avviare il server CDP come utente
dedicato (lo stesso `jarvis` va bene per il collaudo personale):

```bash
runuser -u jarvis -- env OBSCURA_ALLOW_PRIVATE_NETWORK=0 OBSCURA_NAV_TIMEOUT_MS=15000 OBSCURA_CDP_COMMAND_TIMEOUT_MS=20000 OBSCURA_FETCH_TIMEOUT_MS=10000 /opt/obscura-0.2.3/obscura serve --host 127.0.0.1 --port 9222
```

Il collegamento CDP è ammesso solo su IP loopback esplicito. Non esporre 9222
alla LAN. La configurazione Lite non gestisce token CDP remoti, proxy o profili.
Usare un processo dedicato; Jarvis chiude il proprio contesto e collegamento,
non amministra il servizio esterno. Non passare `--allow-private-network`.
L'upstream documenta un controllo di rete nativo aggiuntivo; il guard Jarvis usa
anche il trasporto `route.fetch` di Playwright e non si affida solo a quel controllo.

Per l'avvio persistente, dopo il collaudo copiare
`config/obscura.service` in `/etc/systemd/system/obscura.service` e poi:

```bash
systemctl daemon-reload
systemctl enable --now obscura
systemctl status obscura
```

Questo file è una ricetta fornita dal fork, non un'unità upstream certificata.
Non è stato collaudato nel tuo LXC. Non attivarlo insieme al comando manuale
sulla stessa porta. Non modifica né avvia un servizio Jarvis: Jarvis resta CLI/SDK.

## Configurazione e fallback

`config/lite-obscura.toml` contiene l'allowlist completa e:

```toml
[browser]
backend = "obscura"
cdp_url = "ws://127.0.0.1:9222"
fallback = "none"
```

Se si vuole esplicitamente ripiegare su Chromium all'avvio, installare prima
Chromium come nel README e impostare `fallback="chromium"`. L'avviso compare
su stderr; `metadata.browser_backend` e i metadati di navigate riportano il
backend effettivo e la ragione. Non si cambia backend dopo un'azione fallita.

## Smoke reale separato

Con il servizio in esecuzione e la directory sorgente di Jarvis scrivibile
dall'utente `jarvis`:

```bash
runuser -u jarvis -- /opt/jarvis-lite/.venv/bin/python -m pip install '/opt/jarvis-lite[dev,browser]'
cd /opt/jarvis-lite
runuser -u jarvis -- env JARVIS_BROWSER_SMOKE=obscura JARVIS_CDP_URL=ws://127.0.0.1:9222 /opt/jarvis-lite/.venv/bin/python -m pytest -q -rs tests/test_browser_smoke.py
# Per verificare Chromium già installato:
runuser -u jarvis -- env JARVIS_BROWSER_SMOKE=chromium /opt/jarvis-lite/.venv/bin/python -m pytest -q -rs tests/test_browser_smoke.py
```

Lo smoke non chiama Ollama. Prova probe CDP, pagina pubblica example.com,
form deterministico, type/click/extract e redirect HTTP con un server locale
temporaneo del test. Richiede accesso a example.com; un errore di rete non è un successo.
In CI/unit test resta saltato per default. Non indebolire i controlli per farlo
passare: un errore di intercettazione impedisce di promuovere quel backend.

## Confini del browser

Un solo contesto senza persistenza, service worker e WebSocket bloccati,
download rifiutati, popup chiusi; richieste HTTP(S) verificate con guard SSRF.
Connessione 5 s CDP / 10 s Chromium, azioni 10 s, navigazione 15 s, fetch 10 s,
timeout esterno tool 30 s. Il probe usa solo una risposta sintetica.
Tutti i redirect HTTP con Location vengono rifiutati prima del secondo hop.
Questo limita login e link abbreviati: fornire direttamente l'URL finale.
La policy è identica per entrambi i backend e conserva il blocco LAN/metadata.
I filtri DNS applicativi non sono pinning DNS: per siti ostili usare anche
restrizioni egress di rete a livello CT. Il CDP loopback è un canale di controllo
esplicito, non un'eccezione per la navigazione del modello.
