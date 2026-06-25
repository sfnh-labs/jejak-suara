"""SQLite storage layer.

Schema is deliberately legal-aware: we never store a claim as our own assertion.
Every published timeline event is backed by `articles` (what outlets reported) and
an `event_summaries` row that carries grounded citations + a corroboration count.
Nothing reaches the public timeline until `events.status = 'approved'`.

Start on SQLite for dev; the schema ports cleanly to Postgres later.
"""
from __future__ import annotations

import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "jejak.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id           TEXT PRIMARY KEY,         -- sha256(url)
    figure_id    TEXT NOT NULL,
    source       TEXT NOT NULL,            -- outlet name
    url          TEXT NOT NULL,
    title        TEXT NOT NULL,
    summary      TEXT,                     -- lead / RSS description
    body         TEXT,                     -- extracted full article text (fetch stage)
    fetch_status TEXT,                     -- NULL=not tried, 'ok', or 'error:<reason>'
    published_at TEXT,                     -- ISO8601 if known
    fetched_at   TEXT NOT NULL,
    event_id     INTEGER,                  -- set during clustering
    FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_articles_figure ON articles(figure_id);
CREATE INDEX IF NOT EXISTS idx_articles_event  ON articles(event_id);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    figure_id   TEXT NOT NULL,               -- single or comma-separated figure IDs
    title       TEXT,                       -- working title until summarized
    event_date  TEXT,                       -- earliest article date in cluster
    event_type  TEXT DEFAULT 'other',       -- Pidato, Debat, Demonstrasi, Kebijakan, dll.
    status      TEXT NOT NULL DEFAULT 'new', -- new|summarized|approved|rejected
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_figure ON events(figure_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

CREATE TABLE IF NOT EXISTS event_summaries (
    event_id            INTEGER PRIMARY KEY,
    summary_text        TEXT NOT NULL,
    citations_json      TEXT NOT NULL,     -- claim->source spans from Claude citations
    corroboration_count INTEGER NOT NULL,  -- distinct outlets backing the event
    single_source_flag  INTEGER NOT NULL,  -- 1 if only one outlet
    model               TEXT NOT NULL,
    generated_at        TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS sentiment (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL,
    channel      TEXT NOT NULL,            -- 'youtube' or 'reddit'
    score        REAL,                     -- -1.0 .. 1.0
    label        TEXT,                     -- negative|neutral|positive
    sample_size  INTEGER,
    samples_json TEXT,                     -- few example comments + labels (display only)
    collected_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS comments (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id     INTEGER NOT NULL,
    video_id     TEXT,
    author_id    TEXT,
    author_name  TEXT,
    text         TEXT NOT NULL,
    like_count   INTEGER DEFAULT 0,
    published_at TEXT,
    stance       TEXT,                     -- negative|neutral|positive (from classification)
    collected_at TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_comments_event  ON comments(event_id);
CREATE INDEX IF NOT EXISTS idx_comments_author ON comments(author_id);

CREATE TABLE IF NOT EXISTS buzzer_signals (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id             INTEGER NOT NULL UNIQUE,
    anomaly_score        REAL,           -- 0..1
    anomaly_pct          REAL,           -- 0..100
    suspicious_ids_json  TEXT,           -- list of comment IDs
    signals_triggered    TEXT,           -- comma-separated signal names
    analyzed_at          TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Correction / right-of-reply requests (legal safety valve).
CREATE TABLE IF NOT EXISTS corrections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    submitted_by TEXT,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'open', -- open|actioned|dismissed
    created_at  TEXT NOT NULL,
    FOREIGN KEY (event_id) REFERENCES events(id)
);
"""


def connect(path: Path | str = DEFAULT_DB) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


_MIGRATIONS = {
    "articles": [
        ("body", "TEXT"),
        ("fetch_status", "TEXT"),
        ("body_original", "TEXT"),
        ("body_lang", "TEXT"),
    ],
    "events": [
        ("event_type", "TEXT DEFAULT 'other'"),
    ],
    "sentiment": [
        ("samples_json", "TEXT"),
    ],
}


def migrate(conn: sqlite3.Connection) -> None:
    """Idempotently add any columns missing from an older database."""
    for table, cols in _MIGRATIONS.items():
        row = conn.execute(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
            (table,),
        ).fetchone()
        if not row or row[0] == 0:
            continue
        existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        for name, decl in cols:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")
    conn.commit()


def init_db(path: Path | str = DEFAULT_DB) -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        conn.close()
