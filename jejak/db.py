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
    -- Latest article date in the cluster. event_date says when the thing
    -- happened and must not move, but coverage keeps arriving for days: a
    -- record whose summary was rewritten this morning was still sorted by a
    -- date from last week, so nothing new ever appeared at the top of the
    -- timeline. This is what the feed orders by.
    last_seen   TEXT,
    event_type  TEXT DEFAULT 'other',       -- Pidato, Debat, Demonstrasi, Kebijakan, dll.
    scope       TEXT,                       -- Nasional, Parlemen, a province...
    impact      TEXT,                       -- tinggi|sedang|rendah
    -- 'candidate' is peristiwa-only: clustered but not yet corroborated by
    -- enough distinct outlets to publish. Everything from 'new' onward is
    -- public; 'approved' only means the summary has been written.
    -- 'expired' is a stale candidate kept only because its articles are
    -- evidence in figure_mentions (see cluster.prune_candidates).
    status      TEXT NOT NULL DEFAULT 'new', -- candidate|new|summarized|approved|rejected|expired
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

-- A record that is part of a peristiwa: the figure's own action inside a
-- national story ("Presiden menyerahkan trofi" inside "Indonesia juara Piala
-- AFF"). Clustering cannot produce this — every article lands in exactly one
-- event, attributed ones in a record and the rest in a peristiwa — so
-- jejak/link.py proposes pairs afterwards and a curator rules on them.
--   origin  'pipeline' — proposed by link.py; 'curator' — added by hand
--   verdict NULL = proposed only, 'confirmed', 'rejected'. Owned by the
--           curator in Postgres and copied here by scripts/apply_curation.py,
--           so link.py never re-proposes a rejected pair and the public site
--           shows only confirmed ones.
CREATE TABLE IF NOT EXISTS record_links (
    record_id    INTEGER NOT NULL,
    peristiwa_id INTEGER NOT NULL,
    score        REAL,
    evidence     TEXT,                      -- JSON array of the shared terms
    origin       TEXT NOT NULL DEFAULT 'pipeline',
    verdict      TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (record_id, peristiwa_id),
    FOREIGN KEY (record_id) REFERENCES events(id),
    FOREIGN KEY (peristiwa_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_record_links_peristiwa ON record_links(peristiwa_id);

-- One event following up an earlier one: a bill proposed, then passed; a
-- search launched, then called off. Same kind on both sides — peristiwa to
-- peristiwa, or a figure's record to an earlier record of the same figure.
-- Proposed by jejak/link.py (link_followups), ruled on in /kurasi; the
-- columns mean what they do in record_links.
CREATE TABLE IF NOT EXISTS followup_links (
    earlier_id   INTEGER NOT NULL,
    later_id     INTEGER NOT NULL,
    score        REAL,
    evidence     TEXT,                      -- JSON array of the shared terms
    origin       TEXT NOT NULL DEFAULT 'pipeline',
    verdict      TEXT,
    created_at   TEXT NOT NULL,
    PRIMARY KEY (earlier_id, later_id),
    FOREIGN KEY (earlier_id) REFERENCES events(id),
    FOREIGN KEY (later_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_followup_links_later ON followup_links(later_id);

-- Related figures a curator struck from a peristiwa. promote_peristiwa
-- re-derives event_figures from the coverage every run, and an alias that
-- also names someone else would put the wrong person straight back; this is
-- what it checks first.
CREATE TABLE IF NOT EXISTS event_figure_rejections (
    event_id   INTEGER NOT NULL,
    figure_id  TEXT NOT NULL,
    decided_at TEXT,
    PRIMARY KEY (event_id, figure_id)
);

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
    mentions_figure INTEGER,               -- 1 if the text names the event's figure; NULL = not checked
    figure_stance TEXT,                    -- stance toward the figure, only where mentions_figure = 1
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
    created_at TEXT,
    -- The figure's CV. One entity with the roster row: `positions` is both the
    -- CV's career list and the source of `role` (the first entry), so an
    -- office is never recorded twice. Seeded from cv/<id>.json by
    -- scripts/import_cv.py; edited in /kurasi, after which cv_curated = 1 and
    -- the seed no longer overwrites it.
    positions  TEXT,                       -- JSON [{role, org, period}]; role = the first
    bio        TEXT,
    facts      TEXT,                       -- JSON [{label, value}]
    education  TEXT,                       -- JSON [{year?, detail}]
    sources    TEXT,                       -- JSON [{label, url}]
    cv_checked_at TEXT,                    -- when the sources were read (ISO date)
    cv_curated INTEGER NOT NULL DEFAULT 0
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

-- Clustering's embedding cache (jejak/cluster.py). Local only, never synced:
-- it is derived from the article text and rebuilt on demand, so a working copy
-- pulled fresh from Neon just pays one slow cluster run to refill it.
CREATE TABLE IF NOT EXISTS article_embeddings (
    article_id TEXT PRIMARY KEY,
    text_hash  TEXT NOT NULL,
    vec        BLOB NOT NULL
);

-- Why the curator kept or took down each event, written by /kurasi along with
-- events.curated. What jejak/curation_suggest.py learns from. Local only: the
-- site needs the verdict, which travels on events, not the reasoning.
CREATE TABLE IF NOT EXISTS curation_labels (
    event_id   INTEGER PRIMARY KEY,
    verdict    TEXT NOT NULL,      -- 'rejected' | 'kept'
    reasons    TEXT NOT NULL,      -- JSON array of reason codes
    note       TEXT,
    kind       TEXT,
    figure_id  TEXT,
    title      TEXT,
    summary    TEXT,
    outlets    INTEGER,
    suggested  TEXT,
    decided_at TEXT NOT NULL
);

-- The names awaiting a curator in /kurasi/kandidat: evidence refreshed by
-- jejak/candidate_queue.py from figure_mentions, decisions written by the
-- curator. A promote or reject is applied the moment it is made
-- (scripts/kurasi_ops.py); `applied_at` records that it was.
CREATE TABLE IF NOT EXISTS candidate_review (
    slug              TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    outlets           INTEGER NOT NULL DEFAULT 0,
    mentions          INTEGER NOT NULL DEFAULT 0,
    role              TEXT,            -- what the coverage called them most
    headlines         TEXT,            -- JSON [{title, url, source, context}]
    records           TEXT,            -- JSON [{id, title, figure_id}]
    refreshed_at      TEXT,
    verdict           TEXT,            -- 'promote' | 'reject' | NULL
    full_name         TEXT,
    aliases           TEXT,            -- pipe-separated
    curated_role      TEXT,
    curated_slug      TEXT,            -- the page address chosen, figures.id
    curated_positions TEXT,            -- JSON [{role, org, period}]
    notes             TEXT,
    decided_at        TEXT,
    applied_at        TEXT
);

-- Every attributed quote in an event's articles, verbatim, and whose words
-- they are (jejak/quotes.py). `figure_id` is matched from the attribution
-- ("…," ujar Said) when the stage finds it, or set by a curator in /kurasi
-- (`assigned_by`), whose choice the stage never overwrites. The one shown
-- on a record is copied to events.quote.
CREATE TABLE IF NOT EXISTS event_quotes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    article_id  TEXT,
    url         TEXT,
    quote       TEXT NOT NULL,
    speaker     TEXT,              -- as the article names them: "Said", "Ketua Banggar DPR Said Abdullah"
    figure_id   TEXT,              -- whose words, or NULL when unclear
    assigned_by TEXT,              -- 'auto' | 'curator'
    found_at    TEXT NOT NULL,
    UNIQUE (event_id, quote)
);
CREATE INDEX IF NOT EXISTS idx_event_quotes_event ON event_quotes(event_id);
CREATE INDEX IF NOT EXISTS idx_event_quotes_figure ON event_quotes(figure_id);

-- Which article bodies the quotes stage (jejak/quotes.py) has read, and for
-- which event: an article moved to another event is read again. Local only.
-- Without it every run reread the whole archive (35k articles, the stage's
-- cost growing with it). `jejak quotes --full` ignores it.
CREATE TABLE IF NOT EXISTS quote_scans (
    article_id TEXT NOT NULL,
    event_id   INTEGER NOT NULL,
    scanned_at TEXT NOT NULL,
    PRIMARY KEY (article_id, event_id)
);

-- Everyone taking part in a record, not just the figure it is filed under
-- (jejak/participants.py). events.figure_id stays the record's main actor
-- for display; this says who else is in it and how:
--   'actor'    does or says the act ("Menolak Menu MBG")
--   'subject'  the record is about them but they did not do it (framing 'about')
--   'target'   the act is aimed at them; set by a curator only
--   'quoted'   speaks in the coverage without being the actor
-- One row per figure per record, the strongest role winning. Rows with
-- assigned_by 'curator' are never touched by the stage.
CREATE TABLE IF NOT EXISTS record_figures (
    event_id    INTEGER NOT NULL,
    figure_id   TEXT NOT NULL,
    role        TEXT NOT NULL,      -- actor | subject | target | quoted
    source      TEXT NOT NULL,      -- owner | quote | derived | curator
    quotes      INTEGER NOT NULL DEFAULT 0,  -- their quotes in the record's coverage
    assigned_by TEXT NOT NULL DEFAULT 'auto',
    PRIMARY KEY (event_id, figure_id),
    FOREIGN KEY (event_id) REFERENCES events(id)
);
CREATE INDEX IF NOT EXISTS idx_record_figures_figure ON record_figures(figure_id);

-- Records whose filed actor is probably wrong: they are never quoted in the
-- coverage and exactly one other figure is, as when an article about the
-- President's programme carries only the BGN head's words. A curator moves
-- the record ('move'), keeps it ('keep') or marks it as about the owner
-- ('about') in /kurasi; the stage only adds and withdraws undecided rows.
CREATE TABLE IF NOT EXISTS actor_reviews (
    event_id     INTEGER PRIMARY KEY,
    owner_id     TEXT NOT NULL,
    suggested_id TEXT NOT NULL,
    quotes       INTEGER NOT NULL,  -- the suggested figure's quotes in it
    found_at     TEXT NOT NULL,
    decision     TEXT,              -- move | keep | about, NULL = waiting
    decided_at   TEXT,
    FOREIGN KEY (event_id) REFERENCES events(id)
);

-- Organisations by their long and short names ("Komisi Pemberantasan
-- Korupsi" / "KPK"), kept by the curator in /kurasi/organisasi. The figure
-- editor offers both when filling in an office's organisation.
CREATE TABLE IF NOT EXISTS organizations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,  -- "Komisi Pemberantasan Korupsi"
    short_name  TEXT UNIQUE COLLATE NOCASE,           -- "KPK", or NULL when it has none
    updated_at  TEXT NOT NULL
);

-- "Jadikan info CV" in /kurasi: what an article says about someone's
-- offices, background and education, drafted by the local model
-- (jejak/cv_extract.py) for the curator to check, edit and accept onto that
-- figure's CV — the record itself then comes down as cv_material.
CREATE TABLE IF NOT EXISTS cv_proposals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id    INTEGER NOT NULL,
    figure_id   TEXT NOT NULL,     -- whose CV
    note        TEXT,              -- what the curator wants taken from it
    status      TEXT NOT NULL DEFAULT 'queued',
                -- queued | running | ready | accepted | discarded | failed
    proposal    TEXT,              -- JSON {positions, facts, education}
    error       TEXT,
    created_at  TEXT NOT NULL,
    finished_at TEXT,
    decided_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_cv_proposals_event ON cv_proposals(event_id);

-- What the local model learns from the curator (jejak/kurasi.py): each
-- accepted rework or CV draft becomes a worked example — the draft that was
-- wrong, the curator's note, the version they accepted — shown to the model
-- the next time it writes something similar. `active` = 0 when the curator
-- switches a lesson off in /kurasi/pelajaran.
CREATE TABLE IF NOT EXISTS curation_lessons (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,     -- 'summary' | 'cv'
    source      TEXT NOT NULL,     -- 'rework:<id>' | 'cv:<id>'
    event_id    INTEGER,
    figure_id   TEXT,
    words       TEXT,              -- distinctive words of the event, for finding similar ones
    wrong       TEXT,              -- what the model produced
    note        TEXT,              -- what the curator said
    right       TEXT,              -- what the curator accepted
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    UNIQUE (source)
);

-- One row per run of the `kurasi` stage: what it caught up on and learned.
CREATE TABLE IF NOT EXISTS kurasi_reports (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_at  TEXT NOT NULL,
    stats   TEXT NOT NULL          -- JSON
);

-- A curator asking for an event to be redone (/kurasi → scripts/kurasi_ops.py
-- rework): written again with their note, framed as about the figure rather
-- than by them, given to another figure, or made a peristiwa. The result is a
-- draft kept here until the curator accepts it; nothing reaches the event
-- before that. `before` and `after` are JSON snapshots {kind, figure_id,
-- framing, title, event_type, summary_text}, kept for the record.
CREATE TABLE IF NOT EXISTS rework_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      INTEGER NOT NULL,
    note          TEXT,
    framing       TEXT,             -- 'own' | 'about' | NULL = unchanged
    new_figure_id TEXT,             -- give the record to this figure
    to_peristiwa  INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'queued',
                  -- queued | running | ready | accepted | discarded | failed
    error         TEXT,
    before        TEXT,
    after         TEXT,
    draft         TEXT,             -- the generated entry, JSON, until accepted
    created_at    TEXT NOT NULL,
    finished_at   TEXT,
    decided_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_rework_event ON rework_requests(event_id);

-- What the suggester expects the curator to do with each unruled event.
-- Pushed to Neon, where /kurasi shows it and, for auto_hide = 1, the public
-- site leaves the event out until a curator rules on it.
CREATE TABLE IF NOT EXISTS curation_suggestions (
    event_id   INTEGER PRIMARY KEY,
    reason     TEXT,
    confidence REAL,
    support    INTEGER,
    examples   TEXT,               -- JSON array of labelled event ids
    auto_hide  INTEGER NOT NULL DEFAULT 0,
    model      TEXT,
    scored_at  TEXT NOT NULL
);

-- Events a model stage gave up on after repeated failures (jejak/failures.py).
-- Local only. Deleting a row lets the stage try that event again.
CREATE TABLE IF NOT EXISTS stage_failures (
    stage      TEXT NOT NULL,     -- summarize | auto_cv
    event_id   INTEGER NOT NULL,
    failures   INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (stage, event_id)
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
    # Several stages can share the file at once (a long fetch backfill beside
    # a publish run), so wait for a lock rather than fail after sqlite's 5s.
    conn = sqlite3.connect(path, timeout=60)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    # WAL lets readers and one writer work side by side. Switching needs a
    # moment with no other connection open; until then it simply stays as is.
    try:
        conn.execute("PRAGMA journal_mode = WAL")
    except sqlite3.OperationalError:
        pass
    return conn


_MIGRATIONS = {
    "figures": [
        ("positions", "TEXT"),
        ("bio", "TEXT"),
        ("facts", "TEXT"),
        ("education", "TEXT"),
        ("sources", "TEXT"),
        ("cv_checked_at", "TEXT"),
        ("cv_curated", "INTEGER NOT NULL DEFAULT 0"),
    ],
    "articles": [
        ("body", "TEXT"),
        ("fetch_status", "TEXT"),
        ("body_original", "TEXT"),
        ("body_lang", "TEXT"),
        # jejak/actors.py: another tracked figure's own statement inside an
        # article is copied out as an article of theirs. derived_from is the
        # article it was read from; derived_mode 'join' (the passage recalls
        # something earlier) may only join a record they already have.
        ("derived_from", "TEXT"),
        ("derived_mode", "TEXT"),
        ("actors_scanned_at", "TEXT"),
    ],
    "events": [
        ("event_type", "TEXT DEFAULT 'other'"),
        ("kind", "TEXT NOT NULL DEFAULT 'record'"),
        ("scope", "TEXT"),
        ("impact", "TEXT"),
        ("last_seen", "TEXT"),
        ("quote", "TEXT"),
        ("quote_url", "TEXT"),
        # The curator's verdict ('rejected' | 'kept' | NULL), set in /kurasi.
        # Pushed with the event; the site hides 'rejected'.
        ("curated", "TEXT"),
        # How a record is written (jejak/summarize.py): NULL = the figure's
        # own act, 'about' = coverage concerning them that they did not do.
        # Set by a curator's rework in /kurasi.
        ("framing", "TEXT"),
    ],
    "sentiment": [
        ("samples_json", "TEXT"),
    ],
    # The nightly `kurasi` stage retries a failed draft at most twice, and
    # learns from each decision once (jejak/kurasi.py).
    "rework_requests": [
        ("attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("learned_at", "TEXT"),
    ],
    "cv_proposals": [
        ("attempts", "INTEGER NOT NULL DEFAULT 0"),
        ("learned_at", "TEXT"),
        ("accepted", "TEXT"),          # JSON: what the curator kept
        # 'auto' = found, drafted and applied by the kurasi stage on its own
        # (kurasi.auto_cv); 'curator' = asked for in /kurasi.
        ("origin", "TEXT NOT NULL DEFAULT 'curator'"),
    ],
    "comments": [
        ("comment_id", "TEXT"),
        ("channel", "TEXT"),
        ("mentions_figure", "INTEGER"),
        ("figure_stance", "TEXT"),
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
    # The feed's sort key.
    "CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen)",
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
    _backfill_last_seen(conn)
    conn.commit()


def _backfill_last_seen(conn: sqlite3.Connection) -> None:
    """Fill last_seen for events that predate the column.

    Only ever fills NULLs: after this runs once, clustering owns the value.
    An event whose articles all lack a published_at falls back to event_date so
    the feed's sort key is never NULL.
    """
    conn.execute(
        """UPDATE events SET last_seen = COALESCE(
               (SELECT max(published_at) FROM articles WHERE event_id = events.id),
               event_date)
           WHERE last_seen IS NULL"""
    )


def init_db(path: Path | str = DEFAULT_DB) -> None:
    conn = connect(path)
    try:
        conn.executescript(SCHEMA)
        migrate(conn)
        conn.commit()
    finally:
        conn.close()
