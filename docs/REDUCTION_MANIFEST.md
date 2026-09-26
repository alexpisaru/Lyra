# File mantenuti dalla base upstream

I file non elencati sono rimossi, salvo nuovi documenti/config/test Lite.

- `.gitignore`
- `LICENSE`
- `README.md`
- `pyproject.toml`
- `src/openjarvis/__init__.py`
- `src/openjarvis/_rust_bridge.py`
- `src/openjarvis/agents/__init__.py`
- `src/openjarvis/agents/_stubs.py`
- `src/openjarvis/agents/loop_guard.py`
- `src/openjarvis/agents/orchestrator.py`
- `src/openjarvis/cli/__init__.py`
- `src/openjarvis/cli/__main__.py`
- `src/openjarvis/core/__init__.py`
- `src/openjarvis/core/config.py`
- `src/openjarvis/core/events.py`
- `src/openjarvis/core/registry.py`
- `src/openjarvis/core/types.py`
- `src/openjarvis/engine/__init__.py`
- `src/openjarvis/engine/_base.py`
- `src/openjarvis/engine/_http_async.py`
- `src/openjarvis/engine/_stubs.py`
- `src/openjarvis/engine/ollama.py`
- `src/openjarvis/sdk.py`
- `src/openjarvis/security/__init__.py`
- `src/openjarvis/security/capabilities.py`
- `src/openjarvis/security/file_policy.py`
- `src/openjarvis/security/injection_scanner.py`
- `src/openjarvis/security/ssrf.py`
- `src/openjarvis/security/taint.py`
- `src/openjarvis/security/types.py`
- `src/openjarvis/system/__init__.py`
- `src/openjarvis/system/builder.py`
- `src/openjarvis/system/core.py`
- `src/openjarvis/tools/__init__.py`
- `src/openjarvis/tools/_stubs.py`
- `src/openjarvis/tools/browser.py`
- `src/openjarvis/tools/calculator.py`
- `src/openjarvis/tools/file_read.py`
- `src/openjarvis/tools/packs.py`
- `src/openjarvis/tools/storage/__init__.py`
- `src/openjarvis/tools/storage/_stubs.py`
- `src/openjarvis/tools/storage/sqlite.py`
- `src/openjarvis/tools/storage_tools.py`
- `tests/agents/test_loop_guard.py`
- `tests/agents/test_loop_guard_warn.py`
- `tests/engine/test_ollama_runtime_options.py`
- `tests/security/test_ssrf.py`
- `tests/security/test_ssrf_disguised.py`
- `tests/tools/test_calculator.py`
- `tests/tools/test_file_read.py`

Base: 2151 file tracciati. Rimozioni finali: 2101.
`tests/conftest.py` è stato rimosso nella riduzione iniziale e poi riscritto
come fixture minima per isolare la configurazione dei test.

## Incremento 0.2 rispetto al Lite preparato

Nuovo runtime: `src/openjarvis/tools/knowledge.py` (Markdown + FTS in RAM).
Modificati sul posto: `core/config.py`, `tools/packs.py`, `tools/browser.py`,
`system/builder.py`, `system/core.py`, `cli/__init__.py`.

Nuovi test: `tests/test_knowledge.py`, `tests/test_browser_backends.py`,
`tests/test_browser_smoke.py` (opt-in). `tests/test_lite.py` aggiornato per il
nuovo pack e il routing; nessuna eliminazione di prove preesistenti.

Configurazioni: aggiornato `config/lite.toml`, aggiunti `config/lite-obscura.toml`
e `config/obscura.service`. Documentazione: README, LITE_PLAN, VALIDATION,
SERVER_ACCEPTANCE aggiornati; aggiunto `docs/BROWSER.md`.

`pyproject.toml`: versione 0.2.0, stesso trio click/httpx/jsonschema; il minimo
Playwright dell'extra sale da 1.40 a 1.48. Obscura è un binario esterno opzionale,
non vendorizzato né scaricato dall'installazione base. Nessun pacchetto Obsidian.
I 39 moduli Python Lite diventano 40. Le rimozioni upstream non vengono annullate.

## Incremento 0.2.1

Modificati sul posto: `security/ssrf.py`, `tools/browser.py`, `tools/knowledge.py`,
`tools/packs.py`, `core/config.py`, `system/builder.py`, `cli/__init__.py`.
Nessun nuovo modulo runtime (restano 40).

Test: aggiornati `tests/test_browser_backends.py`, `tests/test_browser_smoke.py`,
`tests/test_knowledge.py`, `tests/test_lite.py`, `tests/security/test_ssrf_disguised.py`.
Nessuna prova esistente rimossa; alcune asserzioni adattate al nuovo contratto
(redirect principale seguito solo dopo validazione, output notes etichettato,
`knowledge.enabled` obbligatorio per i tool notes).

Nuovi file: `scripts/ct-acceptance.sh`, `scripts/live_acceptance.py`, `config/lite-chromium.toml`,
`docs/live-0.2.1.json`. Aggiornati: `config/lite.toml`, `config/lite-obscura.toml`,
README e tutti i documenti in `docs/`. `pyproject.toml`: versione 0.2.1, `scripts`
nel sorgente distribuito. `.gitignore`: output di collaudo. Nessuna dipendenza nuova.
