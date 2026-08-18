"""SQLite storage layer.

Schema is deliberately legal-aware: we never store a claim as our own assertion.
Every published timeline event is backed by `articles` (what outlets reported) and
an `event_summaries` row that carries grounded citations + a corroboration count.
An event reaches the public timeline once it clusters — status 'new' for a
record, and for a peristiwa once enough distinct outlets corroborate it. The
summary lands afterwards ('approved'); the site renders the sources without it
rather than holding the event back, so the timeline stays ordered by date
instead of by how far each event has moved through the pipeline.

Start on SQLite for dev; the schema ports cleanly to Postgres later.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DB = ROOT / "jejak.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS articles (
    id           TEXT PRIMARY KEY,         -- sha256(url)
    figure_id    TEXT,                     -- NULL = general news, not about a tracked figure
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

-- Two kinds of event share this table because everything downstream —
-- clustering, summarizing, corroboration, sentiment — treats them identically:
--   'record'    one tracked figure's activity; figure_id is set.
--   'peristiwa' a national event; figure_id is NULL and any tracked figures
--               that turn up in its coverage are *related*, not owners
--               (a flood belongs to nobody), recorded in event_figures.
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    figure_id   TEXT,                       -- NULL for peristiwa
    kind        TEXT NOT NULL DEFAULT 'record',  -- record|peristiwa
    title       TEXT,                       -- working title until summarized
    event_date  TEXT,                       -- earliest article date in cluster
    event_type  TEXT DEFAULT 'other',       -- Pidato, Debat, Demonstrasi, Kebijakan, dll.
    scope       TEXT,                       -- Nasional, Parlemen, a province...
    impact      TEXT,                       -- tinggi|sedang|rendah
    -- 'candidate' is peristiwa-only: clustered but not yet corroborated by
    -- enough distinct outlets to publish. Everything from 'new' onward is
    -- public; 'approved' only means the summary has been written.
    status      TEXT NOT NULL DEFAULT 'new', -- candidate|new|summarized|approved|rejected
    created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_figure ON events(figure_id);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);

-- Tracked figures mentioned in a peristiwa's coverage.
CREATE TABLE IF NOT EXISTS event_figures (
    event_id   INTEGER NOT NULL,
    figure_id  TEXT NOT NULL,
    PRIMARY KEY (event_id, figure_id),
    FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_event_figures_figure ON event_figures(figure_id);

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
    comment_id   TEXT,                     -- platform's own id; stable across collections
    video_id     TEXT,
    channel      TEXT,                     -- YouTube channel / subreddit the comment sits under
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

-- Tracked figures. The database is the source of truth, not figures.toml:
-- most figures are discovered from coverage rather than listed by hand. The
-- TOML seeds this table and can override any row.
--   origin 'config'     — came from figures.toml
--   origin 'discovered' — promoted from figure_candidates by corroboration
CREATE TABLE IF NOT EXISTS figures (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    role       TEXT,                       -- may be empty until an article states one
    aliases    TEXT,                       -- JSON array
    active     INTEGER NOT NULL DEFAULT 1,
    origin     TEXT NOT NULL DEFAULT 'config',
    created_at TEXT
);

-- People discovered in the coverage, before any decision to track them.
-- A candidate is evidence that someone keeps being reported on; it is not a
-- published claim about them. Promotion is by corroboration, never a hand list.
CREATE TABLE IF NOT EXISTS figure_candidates (
    slug        TEXT PRIMARY KEY,          -- slugify(name)
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'candidate',  -- candidate|tracked|ignored
    promoted_at TEXT
);

-- One sighting of a person in one article, with the role they were given.
-- This is the provenance behind both promotion and any CV entry derived later:
-- every claim traces back to reporting.
CREATE TABLE IF NOT EXISTS figure_mentions (
    slug       TEXT NOT NULL,
    article_id TEXT NOT NULL,
    role       TEXT,
    org_name   TEXT,
    source     TEXT,                       -- outlet, for counting corroboration
    seen_at    TEXT,
    PRIMARY KEY (slug, article_id, role),
    FOREIGN KEY (article_id) REFERENCES articles(id)
);
CREATE INDEX IF NOT EXISTS idx_figure_mentions_slug ON figure_mentions(slug);

-- Articles already mined for mentions, so scanning stays incremental.
CREATE TABLE IF NOT EXISTS article_scans (
    article_id TEXT PRIMARY KEY,
    FOREIGN KEY (article_id) REFERENCES articles(id)
);

-- Pipeline bookkeeping that has to outlive the working copy. `jejak.db` is
-- rebuilt from Neon on every run, so anything the pipeline needs to remember
-- between runs -- the archive backfill cursor, for one -- has to be a synced
-- row rather than a local file.
CREATE TABLE IF NOT EXISTS pipeline_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
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
        ("kind", "TEXT NOT NULL DEFAULT 'record'"),
        ("scope", "TEXT"),
        ("impact", "TEXT"),
    ],
    "sentiment": [
        ("samples_json", "TEXT"),
    ],
    "comments": [
        ("comment_id", "TEXT"),
        ("channel", "TEXT"),
    ],
}

# Created after _MIGRATIONS, because these index columns that older databases
# only gain during migration.
_INDEXES = (
    # events.kind only exists after migration on pre-peristiwa databases.
    "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)",
    # One aggregate per event per channel — also the upsert key used when
    # syncing to Postgres, so both stores agree on sentiment row identity.
    """CREATE UNIQUE INDEX IF NOT EXISTS uq_sentiment_event_channel
       ON sentiment(event_id, channel)""",
    # Lets re-collection update a comment in place (stance, like count) rather
    # than deleting an event's comment history and refetching it.
    """CREATE UNIQUE INDEX IF NOT EXISTS uq_comments_event_comment
       ON comments(event_id, comment_id)""",
)


def _add_missing_columns(conn: sqlite3.Connection, table: str,
                         key: str | None = None) -> None:
    """Bring one table up to date with _MIGRATIONS. Safe to repeat.

    `key` selects the _MIGRATIONS entry when the table is under a scratch name
    during a rebuild.
    """
    row = conn.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()
    if not row or row[0] == 0:
        return
    existing = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
    for name, decl in _MIGRATIONS.get(key or table, ()):
        if name not in existing:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")


_CREATE_RE = re.compile(r"CREATE TABLE IF NOT EXISTS (\w+) \(.*?\n\);", re.S)


def _table_ddl(table: str) -> str:
    """The CREATE TABLE statement for one table, taken from SCHEMA."""
    for match in _CREATE_RE.finditer(SCHEMA):
        if match.group(1) == table:
            return match.group(0)
    raise KeyError(f"no CREATE TABLE for {table} in SCHEMA")


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    return conn.execute(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?",
        (table,),
    ).fetchone()[0] > 0


def _drop_not_null(conn: sqlite3.Connection, table: str, column: str) -> None:
    """Make `column` nullable on an existing table.

    SQLite has no ALTER COLUMN, so the table must be rebuilt. This follows the
    order given in the SQLite docs — build the replacement under a scratch name,
    copy, drop the original, then rename the replacement *into* place.

    Renaming the original out of the way instead would corrupt the schema:
    ALTER TABLE ... RENAME rewrites foreign-key references in *other* tables to
    follow the new name, so every FK pointing at `events` would end up pointing
    at a scratch table that is about to be dropped.

    The whole rebuild is one explicit transaction; executescript would commit at
    each step and could strand the rows. A no-op once `column` allows NULL.
    """
    info = conn.execute(f"PRAGMA table_info({table})").fetchall()
    if not info:
        return
    target = next((r for r in info if r["name"] == column), None)
    if target is None or not target["notnull"]:
        return

    scratch = f"_rebuild_{table}"
    names = ", ".join(r["name"] for r in info)
    ddl = _table_ddl(table).replace(
        f"CREATE TABLE IF NOT EXISTS {table} (", f"CREATE TABLE {scratch} (", 1
    )

    prior = conn.isolation_level
    conn.isolation_level = None  # take manual control of the transaction
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute("BEGIN IMMEDIATE")
        try:
            conn.execute(f"DROP TABLE IF EXISTS {scratch}")
            conn.execute(ddl)
            # SCHEMA describes a fresh database, so on its own the replacement
            # lacks every column that only exists via _MIGRATIONS.
            _add_missing_columns(conn, scratch, key=table)
            conn.execute(
                f"INSERT INTO {scratch} ({names}) SELECT {names} FROM {table}"
            )
            conn.execute(f"DROP TABLE {table}")
            conn.execute(f"ALTER TABLE {scratch} RENAME TO {table}")
            conn.execute("COMMIT")
        except Exception:
            conn.execute("ROLLBACK")
            raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")
        conn.isolation_level = prior


REBUILT_TABLES = ("articles", "events")


def migrate(conn: sqlite3.Connection) -> None:
    """Idempotently bring an older database up to the current schema."""
    for table in _MIGRATIONS:
        _add_missing_columns(conn, table)
    # After the column additions: the rebuild copies whatever columns the table
    # has at that point, so the two must not be interleaved.
    for table in REBUILT_TABLES:
        _drop_not_null(conn, table, "figure_id")
    # A rebuild drops the old table's indexes with it; every statement here is
    # IF NOT EXISTS, so re-running the schema just restores what went missing.
    conn.executescript(SCHEMA)
    for stmt in _INDEXES:
        conn.execute(stmt)
    conn.commit()


def init_db(path: Path | str = DEFAULT_DB) -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        conn.close()
