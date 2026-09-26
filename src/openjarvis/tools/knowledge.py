"""Markdown is authoritative; reuse SQLiteMemory only as a disposable FTS index."""

from __future__ import annotations

import hashlib
import os
import stat
import threading
import uuid
from contextlib import contextmanager
from pathlib import Path, PureWindowsPath

from openjarvis.core.types import ToolResult
from openjarvis.security.file_policy import is_sensitive_file
from openjarvis.tools._stubs import BaseTool, ToolSpec
from openjarvis.tools.storage.sqlite import SQLiteMemory

MAX_NOTE_BYTES = 262_144
MAX_SCAN_BYTES = 16 * 1024 * 1024
MAX_ENTRIES = 5000
MAX_CONTENT_CHARS = 20_000


def _is_link(path):
    info = path.lstat()
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & 0x400)


class MarkdownVault:
    """One personal vault. Serializes Jarvis writes; external editors remain independent.

    Linux uses directory descriptors and O_NOFOLLOW for every component, so a
    symlink swap cannot redirect a read/write outside the opened vault. Windows
    preparation uses resolved paths and rejects reparse points; it is not a
    sandbox against a hostile local process racing filesystem operations.
    """

    def __init__(self, root):
        root = Path(root)
        if not root.is_absolute():
            raise ValueError("knowledge.vault_path must be absolute")
        root.mkdir(parents=True, exist_ok=True)
        self.root = root.resolve(strict=True)
        self._lock = threading.RLock()
        self._closed = False
        self._index = SQLiteMemory(":memory:")
        self._hashes = {}

    def _parts(self, name):
        if not isinstance(name, str) or not name or len(name) > 512:
            raise ValueError("Use a non-empty relative Markdown path (max 512 characters)")
        # Reject Windows drives, UNC, ADS and backslashes on Linux as well.
        if Path(name).is_absolute() or PureWindowsPath(name).drive or "\\" in name:
            raise ValueError("Only relative vault paths with / separators are allowed")
        parts = name.split("/")
        if any(
            p in ("", ".", "..")
            or p.startswith(".")
            or ":" in p
            or p.endswith((" ", "."))
            or any(ord(c) < 32 for c in p)
            or PureWindowsPath(p).is_reserved()
            for p in parts
        ):
            raise ValueError("Invalid or hidden vault path component")
        if Path(parts[-1]).suffix.lower() != ".md":
            raise ValueError("Only .md files are supported")
        if is_sensitive_file(self.root.joinpath(*parts)):
            raise ValueError("Sensitive files are not allowed")
        return parts

    @contextmanager
    def _parent(self, name, *, create=False):
        parts = self._parts(name)
        if os.name == "posix":
            flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
            fd = os.open(self.root, flags)
            try:
                for part in parts[:-1]:
                    if create:
                        try:
                            os.mkdir(part, mode=0o700, dir_fd=fd)
                        except FileExistsError:
                            pass
                    child = os.open(part, flags, dir_fd=fd)
                    os.close(fd)
                    fd = child
                yield fd, parts[-1]
            finally:
                os.close(fd)
        else:
            current = self.root
            for part in parts:
                current = current / part
                if current.exists() or current.is_symlink():
                    if _is_link(current):
                        raise ValueError("Links/reparse points are not allowed in the vault")
            if not current.resolve().is_relative_to(self.root):
                raise ValueError("Path outside vault")
            if create:
                current.parent.mkdir(parents=True, exist_ok=True)
            yield None, str(current)

    @staticmethod
    def _regular(info):
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            raise ValueError("Only regular files without hard links are supported")
        if info.st_size > MAX_NOTE_BYTES:
            raise ValueError(f"Note exceeds {MAX_NOTE_BYTES} bytes")

    def _read(self, name):
        with self._parent(name) as (directory, leaf):
            flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
            fd = os.open(leaf, flags, dir_fd=directory)
            with os.fdopen(fd, "rb") as handle:
                self._regular(os.fstat(handle.fileno()))
                data = handle.read(MAX_NOTE_BYTES + 1)
                if len(data) > MAX_NOTE_BYTES:
                    raise ValueError("Note grew beyond the size limit")
                return data.decode("utf-8")

    def _check_open(self):
        if self._closed:
            raise RuntimeError("Vault is closed")

    def read(self, name):
        with self._lock:
            self._check_open()
            return self._read(name)

    def write(self, name, content, *, append=False):
        if not isinstance(content, str) or len(content) > MAX_CONTENT_CHARS:
            raise ValueError(f"content must be text with <= {MAX_CONTENT_CHARS} characters")
        with self._lock:
            self._check_open()
            # Validate before creating directories. Append requires an existing note.
            self._parts(name)
            text = self._read(name) + content if append else content
            data = text.encode("utf-8")
            if len(data) > MAX_NOTE_BYTES:
                raise ValueError("Resulting note exceeds size limit")
            with self._parent(name, create=not append) as (directory, leaf):
                try:
                    self._regular(os.stat(leaf, dir_fd=directory, follow_symlinks=False))
                except FileNotFoundError:
                    if append:
                        raise
                temporary = ".jarvis-" + uuid.uuid4().hex + ".tmp"
                if directory is None:
                    temporary = str(Path(leaf).parent / temporary)
                fd = os.open(
                    temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=directory
                )
                try:
                    with os.fdopen(fd, "wb") as handle:
                        handle.write(data)
                        handle.flush()
                        os.fsync(handle.fileno())
                    os.replace(temporary, leaf, src_dir_fd=directory, dst_dir_fd=directory)
                    if directory is not None:
                        os.fsync(directory)
                finally:
                    try:
                        os.unlink(temporary, dir_fd=directory)
                    except FileNotFoundError:
                        pass
            return len(data)

    def search(self, query):
        if not isinstance(query, str) or not query.strip() or len(query) > 300:
            raise ValueError("query must contain 1..300 characters")
        with self._lock:
            self._check_open()
            seen, skipped = set(), 0
            entries, total_bytes = 0, 0
            try:

                def walk_error(error):
                    raise error

                for parent, dirs, files in os.walk(
                    self.root, followlinks=False, onerror=walk_error
                ):
                    entries += len(dirs) + len(files)
                    if entries > MAX_ENTRIES:
                        raise ValueError(
                            f"Vault scan exceeds {MAX_ENTRIES} entries; narrow the vault"
                        )
                    dirs[:] = sorted(
                        d
                        for d in dirs
                        if not d.startswith(".") and not _is_link(Path(parent, d))
                    )
                    for leaf in sorted(files):
                        if leaf.startswith(".") or Path(leaf).suffix.lower() != ".md":
                            continue
                        name = Path(parent, leaf).relative_to(self.root).as_posix()
                        try:
                            content = self._read(name)
                        except (ValueError, OSError, UnicodeError):
                            # Invalid/unreadable notes are explicitly counted, never indexed.
                            skipped += 1
                            continue
                        encoded = content.encode("utf-8")
                        total_bytes += len(encoded)
                        if total_bytes > MAX_SCAN_BYTES:
                            raise ValueError("Vault scan exceeds 16 MiB; narrow the vault")
                        seen.add(name)
                        digest = hashlib.sha256(encoded).digest()
                        if self._hashes.get(name) != digest:
                            self._index.replace_source(
                                name, [(content, None)] if content.strip() else []
                            )
                            self._hashes[name] = digest
                for removed in self._hashes.keys() - seen:
                    self._index.replace_source(removed, [])
                    del self._hashes[removed]
            except Exception:
                # A failed scan must never serve an old or partially refreshed index.
                self._index.clear()
                self._hashes.clear()
                raise
            results = self._index.retrieve(query, top_k=3)
            return results, skipped

    def close(self):
        with self._lock:
            if not self._closed:
                self._index.close()
                self._closed = True


_DESCRIPTIONS = {
    "notes_search": "Search Markdown vault by keywords; returns up to 3 paths and excerpts.",
    "notes_read": "Read a UTF-8 Markdown note using its relative vault path ending in .md.",
    "notes_write": "Create or fully replace a Markdown note. Write only when requested.",
    "notes_append": "Append exact text to an existing Markdown note; include needed newlines.",
}


class NotesTool(BaseTool):
    """Four small schemas sharing the same filesystem/index implementation."""

    def __init__(self, vault, name):
        if name not in _DESCRIPTIONS:
            raise ValueError("Unknown notes tool")
        self.vault, self.tool_id = vault, name

    @property
    def spec(self):
        props = {"path": {"type": "string", "minLength": 1, "maxLength": 512}}
        if self.tool_id == "notes_search":
            props = {"query": {"type": "string", "minLength": 1, "maxLength": 300}}
        elif self.tool_id in ("notes_write", "notes_append"):
            props["content"] = {"type": "string", "maxLength": MAX_CONTENT_CHARS}
        return ToolSpec(
            name=self.tool_id,
            description=_DESCRIPTIONS[self.tool_id],
            parameters={"type": "object", "properties": props, "required": list(props)},
            category="knowledge",
        )

    def execute(self, **params):
        try:
            metadata = {}
            if self.tool_id == "notes_search":
                results, skipped = self.vault.search(params.get("query", ""))
                # Explicit labels: a 2B model otherwise mistakes excerpts for file names.
                content = "\n".join(
                    f"- nota: {r.source}\n  estratto: {' '.join(r.content[:240].split())}"
                    for r in results
                )
                content = (
                    f"{len(results)} note trovate:\n{content}"
                    if results
                    else "Nessuna nota Markdown corrisponde alla ricerca."
                )
                if skipped:
                    content += f"\n[{skipped} unreadable/unsupported Markdown files skipped]"
                metadata = {"paths": [r.source for r in results], "skipped": skipped}
            elif self.tool_id == "notes_read":
                path = params.get("path", "")
                text = self.vault.read(path)
                content = f"Nota {path} letta correttamente. Contenuto:\n{text}"
                metadata = {"path": path, "chars": len(text)}
            else:
                size = self.vault.write(
                    params.get("path", ""),
                    params.get("content"),
                    append=self.tool_id == "notes_append",
                )
                content = f"Saved {params['path']} ({size} bytes)."
                metadata = {"path": params["path"], "size_bytes": size}
            return ToolResult(
                tool_name=self.tool_id, content=content, success=True, metadata=metadata
            )
        except (ValueError, OSError, UnicodeError, RuntimeError) as exc:
            return ToolResult(tool_name=self.tool_id, content=f"Vault error: {exc}", success=False)
