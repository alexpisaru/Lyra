"""The OpenJarvis CLI reduced to local ask, chat, and diagnostics."""

from __future__ import annotations
import json
from dataclasses import asdict
import click
from openjarvis.core.config import load_config
from openjarvis.core.types import Message, Role
from openjarvis.system.builder import SystemBuilder
from openjarvis.tools.packs import PACKS


@click.group(help="OpenJarvis Lite — assistente locale per Ollama")
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


@cli.command()
@click.pass_obj
def check(config):
    """Controlla endpoint e modello senza scaricare né generare nulla."""
    from openjarvis.engine.ollama import OllamaEngine

    engine = OllamaEngine(config.engine.host, timeout=10)
    try:
        if not engine.health():
            raise click.ClickException(f"Ollama non raggiungibile: {config.engine.host}")
        if config.intelligence.model not in engine.list_models():
            raise click.ClickException(f"Modello non presente: {config.intelligence.model}")
        click.echo(f"Ollama OK; modello presente: {config.intelligence.model}")
        click.echo("Compatibilità tool da verificare con una richiesta reale (README).")
    finally:
        engine.close()


def main():
    cli()


if __name__ == "__main__":
    main()
