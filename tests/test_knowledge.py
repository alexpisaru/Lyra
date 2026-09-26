import json
import os
from concurrent.futures import ThreadPoolExecutor
from unittest.mock import MagicMock

import pytest

from openjarvis.core.config import JarvisConfig, load_config
from openjarvis.core.types import ToolCall
from openjarvis.system.builder import SystemBuilder
from openjarvis.tools._stubs import ToolExecutor
from openjarvis.tools.knowledge import MarkdownVault, NotesTool
from openjarvis.tools.packs import PACKS, route_pack


@pytest.fixture
def vault(tmp_path):
    instance = MarkdownVault(tmp_path / "vault")
    yield instance
    instance.close()


def run(vault, name, **args):
    return ToolExecutor([NotesTool(vault, name)]).execute(
        ToolCall(id="test", name=name, arguments=json.dumps(args))
    )


def test_read_write_append_search_and_persistence(vault):
    assert run(vault, "notes_write", path="progetti/Petalo.md", content="# Petalo\nCaffè").success
    assert run(vault, "notes_append", path="progetti/Petalo.md", content="\nOrchidea-742").success
    result = run(vault, "notes_read", path="progetti/Petalo.md")
    text = "# Petalo\nCaffè\nOrchidea-742"
    assert result.content == f"Nota progetti/Petalo.md letta correttamente. Contenuto:\n{text}"
    assert (vault.root / "progetti/Petalo.md").read_text(encoding="utf-8") == text
    result = run(vault, "notes_search", query="Orchidea")
    assert result.success and result.metadata["paths"] == ["progetti/Petalo.md"]
    assert "- nota: progetti/Petalo.md\n  estratto: # Petalo Caffè Orchidea-742" in result.content
    root = vault.root
    vault.close()
    reopened = MarkdownVault(root)
    try:
        assert run(reopened, "notes_search", query="Caffè").metadata["paths"] == [
            "progetti/Petalo.md"
        ]
        assert run(reopened, "notes_read", path="progetti/Petalo.md").success
        assert not list(root.rglob("*.db"))
    finally:
        reopened.close()


def test_external_edits_rename_delete_and_same_stat(vault):
    vault.write("alpha.md", "orchidea")
    assert vault.search("orchidea")[0]
    note = vault.root / "alpha.md"
    before = note.stat()
    note.write_text("magnolia", encoding="utf-8")
    os.utime(note, ns=(before.st_atime_ns, before.st_mtime_ns))
    assert not vault.search("orchidea")[0]
    assert vault.search("magnolia")[0]
    note.rename(vault.root / "beta.md")
    assert vault.search("magnolia")[0][0].source == "beta.md"
    (vault.root / "beta.md").unlink()
    assert not vault.search("magnolia")[0]


@pytest.mark.parametrize(
    "path",
    [
        "../escape.md",
        "a/../../escape.md",
        "/tmp/escape.md",
        "C:/escape.md",
        "C:escape.md",
        "\\\\server\\share\\note.md",
        "a\\..\\escape.md",
        ".obsidian/config.md",
        ".git/config.md",
        "a//x.md",
        "a/./x.md",
        "a.md:secret.md",
        "note.txt",
        "",
        "a/../x.md",
        "NUL.md",
        "dir./x.md",
    ],
)
@pytest.mark.parametrize("name", ["notes_read", "notes_write", "notes_append"])
def test_confinement(vault, path, name):
    args = {"path": path}
    if name != "notes_read":
        args["content"] = "forbidden"
    assert not run(vault, name, **args).success
    assert not list(vault.root.iterdir())


def test_absolute_existing_outside_file_is_not_touched(vault, tmp_path):
    outside = tmp_path / "outside.md"
    outside.write_text("secret", encoding="utf-8")
    assert not run(vault, "notes_write", path=str(outside), content="overwrite").success
    assert not run(vault, "notes_read", path=str(outside)).success
    assert outside.read_text() == "secret"


@pytest.mark.parametrize("directory", [False, True])
def test_symlink_escape(vault, tmp_path, directory):
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "secret.md").write_text("secret")
    link = vault.root / ("link" if directory else "link.md")
    try:
        link.symlink_to(
            outside if directory else outside / "secret.md", target_is_directory=directory
        )
    except OSError:
        pytest.skip("filesystem does not permit creating symlinks")
    path = "link/secret.md" if directory else "link.md"
    for name in ("notes_read", "notes_write", "notes_append"):
        args = {"path": path}
        if name != "notes_read":
            args["content"] = "forbidden"
        assert not run(vault, name, **args).success
    assert not vault.search("secret")[0]
    assert (outside / "secret.md").read_text() == "secret"


def test_hardlink_escape(vault, tmp_path):
    source = tmp_path / "outside.md"
    source.write_text("secret")
    os.link(source, vault.root / "link.md")
    assert not run(vault, "notes_read", path="link.md").success
    assert not run(vault, "notes_write", path="link.md", content="bad").success
    assert not vault.search("secret")[0]
    assert source.read_text() == "secret"


def test_size_format_and_failed_write_preserve_original(vault, monkeypatch):
    vault.write("note.md", "original")
    assert not run(vault, "notes_write", path="note.md", content="x" * 20001).success
    assert not run(vault, "notes_append", path="missing.md", content="x").success
    assert not run(vault, "notes_write", path="note.md", content="x", surprise=True).success

    def fail(*args, **kwargs):
        raise OSError("disk failure")

    monkeypatch.setattr(os, "replace", fail)
    assert not run(vault, "notes_write", path="note.md", content="replacement").success
    assert vault.read("note.md") == "original"
    assert not list(vault.root.glob(".jarvis-*.tmp"))


def test_search_is_bounded_and_ignores_hidden_and_binary(vault, monkeypatch):
    for index in range(5):
        vault.write(f"{index}.md", "Petalo orchidea")
    (vault.root / ".hidden.md").write_text("hiddenword")
    (vault.root / "binary.md").write_bytes(b"\xff\xfe")
    assert len(vault.search('Petalo OR "')[0]) == 3
    result = run(vault, "notes_search", query="hiddenword")
    assert not result.metadata["paths"] and result.metadata["skipped"] == 1
    monkeypatch.setattr("openjarvis.tools.knowledge.MAX_SCAN_BYTES", 1)
    assert not run(vault, "notes_search", query="Petalo").success
    assert vault._index.count() == 0


def test_concurrent_appends_are_serialized(vault):
    vault.write("note.md", "")
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda n: vault.write("note.md", f"{n}\n", append=True), range(20)))
    assert sorted(map(int, vault.read("note.md").splitlines())) == list(range(20))


def test_size_limits_empty_note_and_closed_vault(vault):
    assert run(vault, "notes_write", path="empty.md", content="").success
    assert not vault.search("empty")[0]
    huge = vault.root / "huge.md"
    huge.write_bytes(b"x" * 262145)
    assert not run(vault, "notes_read", path="huge.md").success
    assert not run(vault, "notes_append", path="huge.md", content="more").success
    assert huge.stat().st_size == 262145
    vault.close()
    assert not run(vault, "notes_read", path="empty.md").success


@pytest.mark.skipif(os.name != "posix", reason="POSIX special-file confinement")
def test_fifo_never_blocks_or_gets_overwritten(vault):
    os.mkfifo(vault.root / "pipe.md")
    assert not run(vault, "notes_read", path="pipe.md").success
    assert not run(vault, "notes_write", path="pipe.md", content="no").success
    assert not vault.search("anything")[0]


def test_entry_limit_invalidates_index(vault, monkeypatch):
    vault.write("note.md", "orchidea")
    assert vault.search("orchidea")[0]
    monkeypatch.setattr("openjarvis.tools.knowledge.MAX_ENTRIES", 0)
    assert not run(vault, "notes_search", query="orchidea").success
    assert vault._index.count() == 0


def test_pack_wiring_and_separate_memory(tmp_path):
    cfg = JarvisConfig()
    cfg.knowledge.enabled = True
    cfg.knowledge.vault_path = str(tmp_path / "vault")
    cfg.memory.db_path = str(tmp_path / "memory.db")
    cfg.tools.workspace = str(tmp_path / "workspace")
    cfg.tools.enabled.extend(PACKS["knowledge"])
    with SystemBuilder(cfg).build() as system:
        system.engine.generate = MagicMock(
            side_effect=[
                {
                    "content": "",
                    "tool_calls": [
                        {
                            "name": "notes_write",
                            "arguments": '{"path":"test.md","content":"Petalo"}',
                        }
                    ],
                },
                {"content": "salvato"},
            ]
        )
        result = system.ask("Scrivi una nota Petalo")
        assert result["tool_results"][0].success
        assert result["metadata"]["tools"] == list(PACKS["knowledge"])
        assert system.memory_backend.count() == 0
        assert (tmp_path / "vault/test.md").read_text() == "Petalo"
        system.engine.generate = MagicMock(return_value={"content": "inventato"})
        assert system.ask("Cerca nelle note Petalo")["metadata"]["missing_tool_use"]


@pytest.mark.parametrize(
    "query",
    [
        "Cerca nei miei appunti Petalo",
        "Leggi note.md",
        "Scrivi nel vault",
        "Ricorda questa nota in Obsidian",
        "Append to notes",
        "Leggi file vault.md",
    ],
)
def test_knowledge_routing(query):
    assert route_pack(query) == "knowledge"


def test_mixed_capabilities_and_config(tmp_path):
    for query in ("Copia https://example.com nel vault", "Copia appunti in memoria"):
        with pytest.raises(ValueError, match="capability"):
            route_pack(query)
    path = tmp_path / "config.toml"
    path.write_text('[knowledge]\nvault_path="relative"')
    with pytest.raises(ValueError, match="absolute"):
        load_config(path)
    cfg = JarvisConfig()
    cfg.tools.enabled = ["notes_read"]
    with pytest.raises(ValueError, match="vault_path"):
        cfg.validate()
    cfg.knowledge.vault_path = str(tmp_path / "vault")
    # A path alone does not enable the vault: the switch must be explicit.
    with pytest.raises(ValueError, match="knowledge.enabled"):
        cfg.validate()
    cfg.knowledge.enabled = True
    cfg.memory.db_path = str(tmp_path / "vault/memory.db")
    with pytest.raises(ValueError, match="outside"):
        cfg.validate()
    cfg.knowledge.vault_path = ""
    cfg.tools.enabled = []
    with pytest.raises(ValueError, match="requires knowledge.vault_path"):
        cfg.validate()


@pytest.mark.parametrize(
    ("query", "pack"),
    [
        ("Salva questa nota in memoria", "memory"),
        ("Ricordami che il meeting è alle 10", "memory"),
        ("Cosa ricordi di me?", "memory"),
        ("Prendi nota: comprare il latte", "knowledge"),
        ("Aggiungi agli appunti la lista spesa", "knowledge"),
        ("Cerca nelle note Petalo", "knowledge"),
    ],
)
def test_memory_vs_knowledge_routing(query, pack):
    assert route_pack(query) == pack


def test_vault_specific_words_with_memory_stay_ambiguous():
    for query in ("Copia gli appunti di Obsidian in memoria", "Salva vault.md in memoria"):
        with pytest.raises(ValueError, match="capability"):
            route_pack(query)


@pytest.mark.parametrize(
    ("name", "backend"),
    [("lite.toml", "chromium"), ("lite-chromium.toml", "chromium"), ("lite-obscura.toml", "obscura")],
)
def test_ct_config_files_validate_and_use_separate_state(tmp_path, name, backend):
    import tomllib
    from pathlib import Path

    from openjarvis.core.config import _overlay

    cfg = JarvisConfig()
    with (Path(__file__).resolve().parents[1] / "config" / name).open("rb") as handle:
        _overlay(cfg, tomllib.load(handle))
    assert cfg.engine.host == "http://192.168.1.252:11434"
    assert cfg.knowledge.enabled and cfg.knowledge.vault_path == "/srv/jarvis-vault"
    assert cfg.memory.db_path == "/srv/jarvis-state/memory.db"
    assert set(PACKS["knowledge"]) <= set(cfg.tools.enabled)
    assert cfg.browser.backend == backend and cfg.browser.fallback == "none"
    if os.name != "posix":
        # "/srv/..." is not absolute on Windows; validate the same shape elsewhere.
        cfg.knowledge.vault_path = str(tmp_path / "vault")
        cfg.memory.db_path = str(tmp_path / "state/memory.db")
    cfg.validate()
    assert cfg.intelligence.model == "openbmb/minicpm5-2b:q8_0"


def test_engine_model_alias(tmp_path):
    path = tmp_path / "config.toml"
    path.write_text('[engine]\nmodel = "custom:q8"')
    assert load_config(path).intelligence.model == "custom:q8"
    path.write_text('[engine]\nmodel = "custom:q8"\n[intelligence]\nmodel = "other"')
    with pytest.raises(ValueError, match="disagree"):
        load_config(path)
