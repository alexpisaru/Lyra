"""OpenJarvis MemoryBackend backed by stdlib SQLite/FTS5, without Rust."""

from __future__ import annotations
import json
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from openjarvis.core.registry import MemoryRegistry
from openjarvis.tools.storage._stubs import MemoryBackend, RetrievalResult


@MemoryRegistry.register("sqlite")
class SQLiteMemory(MemoryBackend):
    """Explicit notes only; no embeddings, learning, or automatic prompt injection."""

    backend_id = "sqlite"

    def __init__(self, db_path=""):
        if not db_path:
            from openjarvis.core.config import DEFAULT_CONFIG_DIR

            db_path = DEFAULT_CONFIG_DIR / "memory.db"
        self._db_path = str(db_path)
        if self._db_path != ":memory:":
            Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False, timeout=10)
        try:
            self._conn.execute("PRAGMA journal_mode=WAL")
            self._create_tables()
        except BaseException:
            self._conn.close()
            raise

    def _create_tables(self):
        # Dedicated Lite tables: no implicit migration of an old Rust DB.
        self._conn.executescript("""
            CREATE TABLE IF NOT EXISTS lite_notes (
                id TEXT PRIMARY KEY, content TEXT NOT NULL,
                source TEXT NOT NULL, metadata TEXT NOT NULL, created_at REAL NOT NULL
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS lite_notes_fts
                USING fts5(content, source, content='lite_notes', content_rowid='rowid');
            CREATE TRIGGER IF NOT EXISTS lite_notes_ai AFTER INSERT ON lite_notes BEGIN
                INSERT INTO lite_notes_fts(rowid, content, source)
                    VALUES (new.rowid, new.content, new.source);
            END;
            CREATE TRIGGER IF NOT EXISTS lite_notes_ad AFTER DELETE ON lite_notes BEGIN
                INSERT INTO lite_notes_fts(lite_notes_fts, rowid, content, source)
                    VALUES ('delete', old.rowid, old.content, old.source);
            END;
        """)

    def _insert(self, content, source, metadata):
        if not isinstance(content, str) or not content.strip():
            raise ValueError("Cannot store an empty note")
        doc_id = uuid.uuid4().hex
        self._conn.execute(
            "INSERT INTO lite_notes VALUES (?, ?, ?, ?, ?)",
            (doc_id, content, source, json.dumps(metadata or {}), time.time()),
        )
        return doc_id

    def store(self, content, *, source="", metadata=None):
        with self._lock, self._conn:
            return self._insert(content, source, metadata)

    def replace_source(self, source, documents):
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM lite_notes WHERE source=?", (source,))
            return [self._insert(content, source, metadata) for content, metadata in documents]

    def retrieve(self, query, *, top_k=3, **kwargs):
        if not 1 <= top_k <= 20:
            raise ValueError("top_k must be between 1 and 20")
        words = re.findall(r"\w+", query, flags=re.UNICODE)[:30]
        if not words:
            return []
        match = " OR ".join('"' + word + '"' for word in words)
        with self._lock:
            rows = self._conn.execute(
                """
                SELECT n.content, n.source, n.metadata, bm25(lite_notes_fts)
                FROM lite_notes_fts JOIN lite_notes n ON n.rowid=lite_notes_fts.rowid
                WHERE lite_notes_fts MATCH ? ORDER BY bm25(lite_notes_fts) LIMIT ?
            """,
                (match, top_k),
            ).fetchall()
        return [
            RetrievalResult(
                content=row[0], source=row[1], metadata=json.loads(row[2]), score=-row[3]
            )
            for row in rows
        ]

    def delete(self, doc_id):
        with self._lock, self._conn:
            return self._conn.execute("DELETE FROM lite_notes WHERE id=?", (doc_id,)).rowcount > 0

    def clear(self):
        with self._lock, self._conn:
            self._conn.execute("DELETE FROM lite_notes")

    def count(self):
        with self._lock:
            return self._conn.execute("SELECT count(*) FROM lite_notes").fetchone()[0]

    def close(self):
        with self._lock:
            self._conn.close()
