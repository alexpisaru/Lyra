"""The OpenJarvis CLI reduced to local ask, chat, and diagnostics."""

from __future__ import annotations
import json
from dataclasses import asdict
import click
from openjarvis.core.config import load_config
from openjarvis.core.types import Message, Role
from openjarvis.system.builder import SystemBuilder
from openjarvis.tools.packs import PACKS


@click.group(help="Lyra — assistente locale per Ollama (Lyra Core, fork ridotto di OpenJarvis)")
@click.option("--config", type=click.Path(exists=True, dir_okay=False), default=None)
@click.pass_context
def cli(ctx, config):
    try:
        ctx.obj = load_config(config)
    except (ValueError, OSError) as exc:
        raise click.ClickException(str(exc)) from exc


def _confirm(prompt):
    return click.confirm(prompt, default=False)


def _output(result, as_json):
    if as_json:
        click.echo(
            json.dumps(
                {**result, "tool_results": [asdict(t) for t in result["tool_results"]]},
                ensure_ascii=False,
                default=str,
            )
        )
    else:
        click.echo(result["content"])
        if result["metadata"].get("truncated"):
            click.echo("[Risposta troncata al limite di generazione]", err=True)


@cli.command()
@click.argument("query")
@click.option("--pack", type=click.Choice(list(PACKS)), default=None)
@click.option("--json", "as_json", is_flag=True)
@click.option("--confirm", is_flag=True, help="Chiedi conferma per i tool sensibili.")
@click.pass_obj
def ask(config, query, pack, as_json, confirm):
    """Esegui una richiesta con un solo gruppo di tool."""
    try:
        with SystemBuilder(config).build() as system:
            result = system.ask(query, pack=pack, confirm_callback=_confirm if confirm else None)
            _output(result, as_json)
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc
    incomplete = (
        "missing_tool_use",
        "context_limit",
        "tool_call_limit",
        "tool_timeout",
        "invalid_tool_calls",
        "max_turns_exceeded",
        "truncated",
    )
    if any(result["metadata"].get(key) for key in incomplete):
        raise click.exceptions.Exit(2)


@cli.command()
@click.option("--pack", type=click.Choice(list(PACKS)), default=None)
@click.pass_obj
def chat(config, pack):
    """Chat locale. /pack nome cambia gruppo; /auto riattiva routing; /exit termina."""
    try:
        with SystemBuilder(config).build() as system:
            history = []
            click.echo("/pack " + "|".join(PACKS) + ", /auto, /exit")
            while True:
                try:
                    query = click.prompt("Tu", prompt_suffix=": ")
                except (EOFError, click.Abort):
                    break
                if query == "/exit":
                    break
                if query == "/auto":
                    pack = None
                    continue
                if query.startswith("/pack "):
                    candidate = query.split(maxsplit=1)[1]
                    if candidate in PACKS:
                        pack = candidate
                    else:
                        click.echo("Pack sconosciuto.")
                    continue
                try:
                    result = system.ask(
                        query, pack=pack, prior_messages=history, confirm_callback=_confirm
                    )
                    _output(result, False)
                    history.extend(
                        [
                            Message(role=Role.USER, content=query),
                            Message(role=Role.ASSISTANT, content=result["content"]),
                        ]
                    )
                    history = system._history(history, config.agent.history_chars)
                except Exception as exc:
                    click.echo(f"Errore: {exc}", err=True)
    except Exception as exc:
        raise click.ClickException(str(exc)) from exc


def _writable_dir(path):
    import os
    from pathlib import Path

    path = Path(path).expanduser()
    if not path.is_dir():
        return f"directory assente: {path}"
    if not os.access(path, os.W_OK | os.X_OK):
        return f"directory non scrivibile: {path}"
    return None


@cli.command()
@click.option(
    "--browser",
    "probe_browser",
    is_flag=True,
    help="Avvia davvero il backend browser ed esegue il probe di intercettazione.",
)
@click.pass_obj
def check(config, probe_browser):
    """Controlla Ollama, modello, vault, memoria e browser senza generare nulla."""
    from pathlib import Path
    from openjarvis.engine.ollama import OllamaEngine

    problems = []

    def report(label, error, ok):
        click.echo(f"[{'ERRORE' if error else 'OK'}] {label}: {error or ok}")
        if error:
            problems.append(label)

    engine = OllamaEngine(config.engine.host, timeout=10)
    try:
        if not engine.health():
            report("ollama", f"non raggiungibile: {config.engine.host}", "")
        else:
            model = config.intelligence.model
            missing = None if model in engine.list_models() else f"modello assente: {model}"
            report("ollama", missing, f"{config.engine.host}, modello {model}")
    finally:
        engine.close()

    if config.memory.enabled:
        db = Path(config.memory.db_path).expanduser()
        report("memory", _writable_dir(db.parent), str(db))
    else:
        click.echo("[--] memory: disattivata")
    if config.knowledge.enabled:
        report("knowledge", _writable_dir(config.knowledge.vault_path), config.knowledge.vault_path)
    else:
        click.echo("[--] knowledge: disattivato")

    if not config.tools.browser:
        click.echo("[--] browser: disattivato")
    else:
        backend = config.browser.backend
        label = "EXPERIMENTAL" if backend == "obscura" else "stabile"
        click.echo(f"[..] browser: backend {backend} ({label}), fallback {config.browser.fallback}")
        if probe_browser:
            from openjarvis.tools.browser import _BrowserSession

            session = _BrowserSession(config.browser)
            try:
                future = session.runner.submit(session._ensure_browser)
                error = None
                try:
                    future.result(timeout=60)
                except Exception as exc:
                    error = f"avvio/probe falliti: {exc}"
                ok = f"{session.active_backend} attivo, intercettazione verificata"
                if session.fallback_reason:
                    ok += f" (FALLBACK da obscura: {session.fallback_reason})"
                report("browser", error, ok)
            finally:
                session.close()
        else:
            click.echo("     usare 'check --browser' per il probe reale del backend")

    click.echo("Compatibilità tool del modello da verificare con richieste reali (README).")
    if problems:
        raise click.ClickException("controlli falliti: " + ", ".join(problems))


def main():
    cli()


if __name__ == "__main__":
    main()
