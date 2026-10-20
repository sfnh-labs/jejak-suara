"""Sync the local SQLite working copy with Neon Postgres.

Neon is the durable store; `jejak.db` is a working copy that CI recreates from
scratch on every run. So the sync is two-directional:

    pull   Neon -> SQLite   hydrate history, so dedupe/clustering are incremental
    push   SQLite -> Neon   upsert everything the pipeline just produced

Row identity is preserved in both directions — `events.id` is carried explicitly
instead of letting Postgres' SERIAL mint a new one, which is what previously
duplicated the whole events table on every run and left child rows pointing at
unrelated events.

    python scripts/sync_to_neon.py            # pull, then push
    python scripts/sync_to_neon.py --pull     # hydrate SQLite only
    python scripts/sync_to_neon.py --push     # publish to Neon only
    python scripts/sync_to_neon.py --schema   # apply DDL only, touch no rows
    python scripts/sync_to_neon.py --reset    # rebuild Neon from SQLite

Requires DATABASE_URL. Run pull BEFORE the pipeline and push after; pulling
mid-run is a no-op for rows that already exist locally (local writes win).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db as jejak_db  # noqa: E402
from jejak.config import load_figures  # noqa: E402

SCHEMA = (ROOT / "web" / "src" / "lib" / "schema.sql").read_text(encoding="utf-8")


@dataclass(frozen=True)
class Table:
    name: str
    pk: str
    cols: tuple[str, ...]
    serial: bool = False  # Postgres id is SERIAL -> sequence needs resetting
    conflict: tuple[str, ...] = ()  # upsert target; defaults to the pk

    @property
    def target(self) -> tuple[str, ...]:
        return self.conflict or (self.pk,)

    @property
    def insert_cols(self) -> tuple[str, ...]:
        """Columns to send to Postgres.

        When the upsert target is a natural key, a SERIAL surrogate id is
        omitted so Postgres assigns it. Carrying the local id there could
        collide with an unrelated row's primary key, and ON CONFLICT only
        catches conflicts on the one target it names — any other constraint
        violation just errors. Tables without a surrogate id (pure join tables)
        keep every column.
        """
        if self.conflict and self.serial:
            return tuple(c for c in self.cols if c != self.pk)
        return self.cols

    @property
    def updatable(self) -> tuple[str, ...]:
        """Columns to overwrite on conflict.

        The surrogate `id` is never overwritten: when the conflict target is a
        natural key (e.g. buzzer_signals.event_id) the existing row keeps its
        own id, so child references and the sequence stay coherent.
        """
        skip = {self.pk, *self.target}
        return tuple(c for c in self.cols if c not in skip)


# Foreign-key safe order: parents first.
TABLES: tuple[Table, ...] = (
    # Pipeline bookkeeping, not published data. It syncs because the local
    # working copy is disposable: without it the backfill cursor would reset to
    # today every time jejak.db is rebuilt, and the walk would never progress.
    Table("pipeline_state", "key", ("key", "value", "updated_at")),
    # `curated` is the curator's verdict. /kurasi writes it in jejak.db, so it
    # goes up with the rest of the row; the site hides 'rejected'.
    Table("events", "id", (
        "id", "figure_id", "kind", "title", "event_date", "last_seen",
        "event_type", "scope", "impact", "status", "created_at", "curated",
        "quote", "quote_url",
    ), serial=True),
    Table("event_figures", "event_id", ("event_id", "figure_id"),
          conflict=("event_id", "figure_id")),
    # Proposals and the curator's ruling on them, both from jejak.db. The
    # site shows only verdict = 'confirmed'.
    Table("record_links", "record_id",
          ("record_id", "peristiwa_id", "score", "evidence", "origin", "verdict",
           "created_at"),
          conflict=("record_id", "peristiwa_id")),
    Table("followup_links", "earlier_id",
          ("earlier_id", "later_id", "score", "evidence", "origin", "verdict",
           "created_at"),
          conflict=("earlier_id", "later_id")),
    Table("articles", "id", (
        "id", "figure_id", "source", "url", "title", "summary", "body",
        "body_original", "body_lang", "fetch_status", "published_at",
        "fetched_at", "event_id",
    )),
    Table("event_summaries", "event_id", (
        "event_id", "summary_text", "citations_json", "corroboration_count",
        "single_source_flag", "model", "generated_at",
    )),
    # One aggregate per event per channel — upsert on that, not on the
    # surrogate id, which is reassigned whenever sentiment is recollected.
    Table("sentiment", "id", (
        "id", "event_id", "channel", "score", "label", "sample_size",
        "samples_json", "collected_at",
    ), serial=True, conflict=("event_id", "channel")),
    Table("comments", "id", (
        "id", "event_id", "comment_id", "video_id", "channel", "author_id",
        "author_name", "text", "like_count", "published_at", "stance",
        "mentions_figure", "figure_stance", "collected_at",
    ), serial=True, conflict=("event_id", "comment_id")),
    Table("buzzer_signals", "id", (
        "id", "event_id", "anomaly_score", "anomaly_pct",
        "suspicious_ids_json", "signals_triggered", "analyzed_at",
    ), serial=True, conflict=("event_id",)),
    Table("corrections", "id", (
        "id", "event_id", "submitted_by", "body", "status", "created_at",
    ), serial=True),
    # The suggester's output (jejak/curation_suggest.py). Its labels go the
    # other way: curation_reasons is curator-owned and never pushed.
    Table("curation_suggestions", "event_id", (
        "event_id", "reason", "confidence", "support", "examples",
        "auto_hide", "model", "scored_at",
    )),
)


def _connect_pg(db_url: str):
    try:
        import psycopg2
    except ImportError:
        sys.exit(
            "psycopg2 not installed. Run: pip install -r requirements.txt"
        )
    conn = psycopg2.connect(db_url)
    conn.autocommit = False
    return conn


# Idempotent repairs applied after the declarative schema. `CREATE TABLE IF NOT
# EXISTS` cannot add a constraint to a table that already exists, so the unique
# index backing the sentiment upsert is created here — after clearing any
# duplicate rows the previous (id-losing) sync left behind.
MIGRATIONS = (
    # Columns and constraints that CREATE TABLE IF NOT EXISTS cannot apply to a
    # table that already exists. Postgres makes all of these idempotent.
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'record'",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS scope TEXT",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type TEXT DEFAULT 'other'",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS impact TEXT",
    # Newest article in the cluster — what the feed sorts by, so that an event
    # still gathering coverage resurfaces instead of staying frozen at the date
    # it happened. Backfilled from articles for rows synced before it existed.
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS last_seen TEXT",
    """UPDATE events SET last_seen = COALESCE(
           (SELECT max(published_at) FROM articles WHERE event_id = events.id),
           event_date)
       WHERE last_seen IS NULL""",
    "CREATE INDEX IF NOT EXISTS idx_events_last_seen ON events(last_seen)",
    # Curator verdict. Postgres-only on purpose — see the events Table entry.
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS curated TEXT",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS quote TEXT",
    "ALTER TABLE events ADD COLUMN IF NOT EXISTS quote_url TEXT",
    "CREATE INDEX IF NOT EXISTS idx_events_curated ON events(curated)",
    "ALTER TABLE figure_candidates ADD COLUMN IF NOT EXISTS notes TEXT",
    "ALTER TABLE figure_candidates ADD COLUMN IF NOT EXISTS records TEXT",
    "ALTER TABLE figure_candidates ADD COLUMN IF NOT EXISTS curated_role TEXT",
    "ALTER TABLE figure_candidates ADD COLUMN IF NOT EXISTS curated_slug TEXT",
    "ALTER TABLE figure_candidates ADD COLUMN IF NOT EXISTS curated_positions TEXT",
    # The rulings now travel on the link rows themselves, from jejak.db.
    "ALTER TABLE record_links ADD COLUMN IF NOT EXISTS origin TEXT",
    "ALTER TABLE record_links ADD COLUMN IF NOT EXISTS verdict TEXT",
    "ALTER TABLE followup_links ADD COLUMN IF NOT EXISTS origin TEXT",
    "ALTER TABLE followup_links ADD COLUMN IF NOT EXISTS verdict TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS positions TEXT",
    "ALTER TABLE figure_edits ADD COLUMN IF NOT EXISTS positions TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS bio TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS facts TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS education TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS sources TEXT",
    "ALTER TABLE figures ADD COLUMN IF NOT EXISTS cv_checked_at TEXT",
    "ALTER TABLE figure_edits ADD COLUMN IF NOT EXISTS bio TEXT",
    "ALTER TABLE figure_edits ADD COLUMN IF NOT EXISTS facts TEXT",
    "ALTER TABLE figure_edits ADD COLUMN IF NOT EXISTS education TEXT",
    "ALTER TABLE figure_edits ADD COLUMN IF NOT EXISTS sources TEXT",
    "ALTER TABLE figure_edits ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS comment_id TEXT",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS channel TEXT",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS mentions_figure INTEGER",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS figure_stance TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS body_original TEXT",
    "ALTER TABLE articles ADD COLUMN IF NOT EXISTS body_lang TEXT DEFAULT 'id'",
    # figure_id became nullable when peristiwa were introduced: an event that
    # belongs to no tracked figure has none.
    "ALTER TABLE events ALTER COLUMN figure_id DROP NOT NULL",
    "ALTER TABLE articles ALTER COLUMN figure_id DROP NOT NULL",
    "CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind)",
    """DELETE FROM sentiment s USING sentiment older
       WHERE s.event_id = older.event_id
         AND s.channel = older.channel
         AND s.id < older.id""",
    """CREATE UNIQUE INDEX IF NOT EXISTS uq_sentiment_event_channel
       ON sentiment (event_id, channel)""",
    """DELETE FROM comments c USING comments older
       WHERE c.event_id = older.event_id
         AND c.comment_id = older.comment_id
         AND c.id < older.id""",
    """CREATE UNIQUE INDEX IF NOT EXISTS uq_comments_event_comment
       ON comments (event_id, comment_id)""",
)


def apply_schema(pg) -> None:
    """Create any missing tables/indexes. Every statement is idempotent."""
    with pg.cursor() as cur:
        cur.execute(SCHEMA)
        for stmt in MIGRATIONS:
            cur.execute(stmt)
    pg.commit()


def reset(pg) -> None:
    """Drop all synced rows so a clean push can rebuild them.

    Destructive, and correct because jejak.db is the authoritative copy of
    everything here, the curator's verdicts included.
    """
    names = ", ".join(t.name for t in TABLES)
    with pg.cursor() as cur:
        cur.execute(f"TRUNCATE {names} RESTART IDENTITY CASCADE")
    pg.commit()


# Small tables whose rows the curator removes locally (a struck figure, a
# withdrawn link). Push only upserts, so these are also pruned to the local
# set after it. (table, key columns, Postgres types of the key)
PRUNED = (
    ("event_figures", ("event_id", "figure_id"), ("int", "text")),
    ("record_links", ("record_id", "peristiwa_id"), ("int", "int")),
    ("followup_links", ("earlier_id", "later_id"), ("int", "int")),
)


def prune(pg, sqlite: sqlite3.Connection) -> dict[str, int]:
    """Delete rows from Neon that jejak.db no longer has. Returns per-table counts."""
    counts = {}
    with pg.cursor() as cur:
        for table, keys, types in PRUNED:
            local = sqlite.execute(f"SELECT {', '.join(keys)} FROM {table}").fetchall()
            columns = [list(col) for col in zip(*local)] if local else [[] for _ in keys]
            unnest = ", ".join(f"%s::{t}[]" for t in types)
            match = " AND ".join(f"k.{c} = {table}.{c}" for c in keys)
            cur.execute(
                f"""DELETE FROM {table} WHERE NOT EXISTS (
                      SELECT 1 FROM unnest({unnest}) AS k({', '.join(keys)})
                       WHERE {match})""",
                columns,
            )
            counts[table] = cur.rowcount
    pg.commit()
    return counts


def sync_figures(pg, sqlite: sqlite3.Connection) -> int:
    """Mirror the tracked roster into Postgres so the web app has real names.

    Reads the roster from SQLite, not from figures.toml: the TOML only seeds it,
    and most figures arrive from the mentions stage, which promotes anyone named
    by enough distinct outlets.
    """
    load_figures(sqlite)  # seeds the roster from figures.toml on a fresh db
    # Retired figures go too, flagged inactive. Sending only the active ones
    # left a figure switched off in the pipeline still live on the site.
    rows = [
        (r["id"], r["name"], r["role"] or "", r["aliases"] or "[]", bool(r["active"]),
         r["positions"], r["bio"], r["facts"], r["education"], r["sources"],
         r["cv_checked_at"])
        for r in sqlite.execute(
            "SELECT id, name, role, aliases, active, positions, bio, facts, "
            "education, sources, cv_checked_at FROM figures")
    ]
    if not rows:
        return 0
    with pg.cursor() as cur:
        cur.executemany(
            """INSERT INTO figures (id, name, role, aliases, active, positions,
                                  bio, facts, education, sources, cv_checked_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name,
                 role = EXCLUDED.role,
                 aliases = EXCLUDED.aliases,
                 active = EXCLUDED.active,
                 positions = EXCLUDED.positions,
                 bio = EXCLUDED.bio,
                 facts = EXCLUDED.facts,
                 education = EXCLUDED.education,
                 sources = EXCLUDED.sources,
                 cv_checked_at = EXCLUDED.cv_checked_at""",
            rows,
        )
    pg.commit()
    return len(rows)


def pull(pg, sqlite: sqlite3.Connection) -> dict[str, int]:
    """Copy Neon history into the local working copy.

    Uses INSERT OR IGNORE: Neon supplies rows the local copy has never seen,
    but anything already local (i.e. just produced by the pipeline) wins.
    """
    counts: dict[str, int] = {}
    for t in TABLES:
        names = ", ".join(t.cols)
        with pg.cursor() as cur:
            cur.execute(f"SELECT {names} FROM {t.name}")
            rows = cur.fetchall()
        if not rows:
            counts[t.name] = 0
            continue
        placeholders = ", ".join("?" * len(t.cols))
        sqlite.executemany(
            f"INSERT OR IGNORE INTO {t.name} ({names}) VALUES ({placeholders})",
            rows,
        )
        counts[t.name] = len(rows)
    sqlite.commit()
    return counts


def _row_hash(row) -> str:
    return hashlib.sha1(repr(tuple(row)).encode("utf-8")).hexdigest()


def push(pg, sqlite: sqlite3.Connection) -> dict[str, int]:
    """Upsert rows changed since the last push, preserving row identity.

    `_pushed` in SQLite remembers each row's hash as last sent, so a cycle ships
    its few hundred new or edited rows instead of the whole database. Rows
    edited directly in Neon are not re-sent; --reset clears the ledger.
    """
    sqlite.execute(
        "CREATE TABLE IF NOT EXISTS _pushed "
        "(tbl TEXT, key TEXT, hash TEXT, PRIMARY KEY (tbl, key))"
    )
    counts: dict[str, int] = {}
    sent: list[tuple[str, str, str]] = []
    for t in TABLES:
        names = ", ".join(t.insert_cols)
        seen = dict(sqlite.execute(
            "SELECT key, hash FROM _pushed WHERE tbl = ?", (t.name,)
        ).fetchall())
        key_idx = [t.insert_cols.index(c) for c in t.target]
        rows = []
        for r in sqlite.execute(f"SELECT {names} FROM {t.name}"):
            key = repr(tuple(r[i] for i in key_idx))
            h = _row_hash(r)
            if seen.get(key) != h:
                rows.append(r)
                sent.append((t.name, key, h))
        if not rows:
            counts[t.name] = 0
            continue

        placeholders = ", ".join(["%s"] * len(t.insert_cols))
        target = ", ".join(t.target)
        if t.updatable:
            action = "DO UPDATE SET " + ", ".join(
                f"{c} = EXCLUDED.{c}" for c in t.updatable
            )
        else:
            action = "DO NOTHING"
        stmt = (
            f"INSERT INTO {t.name} ({names}) VALUES ({placeholders}) "
            f"ON CONFLICT ({target}) {action}"
        )
        with pg.cursor() as cur:
            cur.executemany(stmt, [tuple(r) for r in rows])
        counts[t.name] = len(rows)

    # Explicit ids were inserted, so every SERIAL sequence is now behind the
    # data. Park it at max(id)+1 (is_called=false -> that value is next).
    with pg.cursor() as cur:
        for t in TABLES:
            if not t.serial:
                continue
            cur.execute(
                f"SELECT setval(pg_get_serial_sequence('{t.name}', '{t.pk}'), "
                f"COALESCE((SELECT MAX({t.pk}) FROM {t.name}), 0) + 1, false)"
            )
    pg.commit()
    # Recorded only after Neon committed, so a failed push is retried in full.
    sqlite.executemany("INSERT OR REPLACE INTO _pushed VALUES (?, ?, ?)", sent)
    sqlite.commit()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sync_to_neon")
    parser.add_argument("--pull", action="store_true",
                        help="hydrate SQLite from Neon and stop")
    parser.add_argument("--push", action="store_true",
                        help="publish SQLite to Neon and stop")
    parser.add_argument("--schema", action="store_true",
                        help="apply the schema + migrations to Neon and stop "
                             "(run this before deploying a web change that "
                             "reads a newly added column)")
    parser.add_argument("--reset", action="store_true",
                        help="TRUNCATE every synced table in Neon, then push "
                             "the local copy over it (repairs a Neon database "
                             "corrupted by the pre-2026-08 sync)")
    args = parser.parse_args(argv)

    if args.reset and args.pull:
        parser.error("--reset rebuilds Neon from SQLite; --pull is meaningless with it")
    if args.schema and (args.pull or args.push or args.reset):
        parser.error("--schema applies DDL only; combine it with nothing")

    do_pull = not args.reset and (args.pull or not args.push)
    do_push = args.reset or args.push or not args.pull

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    pg = _connect_pg(db_url)
    apply_schema(pg)

    if args.schema:
        print("schema + migrations applied")
        pg.close()
        return 0

    jejak_db.init_db()
    sqlite = jejak_db.connect()

    # The verdicts used to live only in Neon. Until migrate_kurasi_local.py
    # has brought them down, a push would send jejak.db's empty ones up over
    # them.
    if do_push and not sqlite.execute(
            "SELECT 1 FROM pipeline_state WHERE key = 'kurasi_home' AND value = 'local'"
    ).fetchone():
        sqlite.close()
        pg.close()
        print("refusing to push: run scripts/migrate_kurasi_local.py --apply first "
              "(the curator's verdicts are still only in Neon)", file=sys.stderr)
        return 1

    try:
        n = sync_figures(pg, sqlite)
        print(f"figures: {n} rows")

        if args.reset:
            print("reset: truncating all synced tables in Neon")
            reset(pg)
            sqlite.execute("DROP TABLE IF EXISTS _pushed")

        if do_pull:
            print("pull (Neon -> SQLite)")
            for table, count in pull(pg, sqlite).items():
                print(f"  {table}: {count} rows")

        if do_push:
            print("push (SQLite -> Neon)")
            for table, count in push(pg, sqlite).items():
                print(f"  {table}: {count} rows")

        if do_push:
            for table, count in prune(pg, sqlite).items():
                if count:
                    print(f"  pruned {table}: {count} rows no longer in jejak.db")
    except Exception:
        pg.rollback()
        raise
    finally:
        sqlite.close()
        pg.close()

    print("sync complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
