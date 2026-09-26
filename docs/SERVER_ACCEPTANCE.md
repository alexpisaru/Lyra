# Collaudo sul CT — da eseguire dopo la preparazione

Questa sessione ha preparato il progetto sul PC; nessuna installazione sul CT.
Seguire i comandi del README per Debian 12/13 x86_64 e usare l'utente `jarvis`.

1. Verificare Python 3.11–3.13, FTS5 e installazione senza dipendenze browser.
2. `jarvis --config config/lite.toml check`: deve trovare il modello esatto
   `openbmb/minicpm5-2b:q8_0` su `http://192.168.1.252:11434`.
3. Calcolo `17*23`, pack general: risultato 391 e tool riuscito.
4. Scrivere `collaudo.md` nel pack knowledge con `ORCHIDEA-742`; leggere e
   aggiungere una seconda riga. Verificare fisicamente `/srv/jarvis-vault/collaudo.md`.
5. Riavviare Jarvis: search/read devono recuperare il file; modificare il Markdown
   fuori da Jarvis, ripetere search e verificare il nuovo testo. Poi rinominarlo
   ed eliminarlo per verificare l'aggiornamento dell'indice in RAM.
6. I test unitari di confinement devono passare su Linux, inclusi symlink/hardlink
   e file speciali. `../`, percorsi assoluti e directory `.obsidian` devono fallire.
7. Salvare una memoria con `--pack memory`: il database separato conserva il dato,
   il vault non cambia. Per note preesistenti 0.1 usare questo pack.
8. Installare browser solo se necessario. Eseguire lo smoke di BROWSER.md.
   Obscura resta sperimentale fino a esito positivo sul CT: non disattivare il probe.
9. Per click/type usare chat oppure `ask --confirm`. I redirect HTTP vengono
   rifiutati intenzionalmente; fornire URL finali. LAN e metadata restano vietati.
10. Verificare backup separato vault/memoria, directory scrivibili da `jarvis`,
    egress CT e assenza di una porta CDP esposta sulla LAN.

Annotare versione Debian, Python, Playwright, Obscura, tempi, esiti e consumo RAM.
Non dedurre affidabilità del modello dai soli test mocked; conservare anche i
fallimenti e controllare `tool_results`, non soltanto la risposta in linguaggio naturale.
