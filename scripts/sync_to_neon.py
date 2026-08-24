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
    # `curated` is deliberately NOT listed. Push overwrites every column named
    # here from the disposable SQLite copy, so listing the curator's verdict
    # would undo it on the next crawl; leaving it out means push and pull both
    # skip it and Postgres stays its only home. The web app writes it directly.
    Table("events", "id", (
        "id", "figure_id", "kind", "title", "event_date", "last_seen",
        "event_type", "scope", "impact", "status", "created_at",
    ), serial=True),
    Table("event_figures", "event_id", ("event_id", "figure_id"),
          conflict=("event_id", "figure_id")),
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
        "collected_at",
    ), serial=True, conflict=("event_id", "comment_id")),
    Table("buzzer_signals", "id", (
        "id", "event_id", "anomaly_score", "anomaly_pct",
        "suspicious_ids_json", "signals_triggered", "analyzed_at",
    ), serial=True, conflict=("event_id",)),
    Table("corrections", "id", (
        "id", "event_id", "submitted_by", "body", "status", "created_at",
    ), serial=True),
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
    "CREATE INDEX IF NOT EXISTS idx_events_curated ON events(curated)",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS comment_id TEXT",
    "ALTER TABLE comments ADD COLUMN IF NOT EXISTS channel TEXT",
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


def reset(pg) -> list[tuple[int, str]]:
    """Drop all synced rows so a clean push can rebuild them.

    Destructive, and only correct because SQLite is the authoritative copy:
    the pipeline writes there and Neon is a read replica for the web app.

    The one exception is `events.curated`, which has no SQLite counterpart to
    rebuild from — a truncate would erase the curator's decisions for good. It
    is read out here and handed back so `restore_curation` can reapply it once
    the push has recreated the rows.
    """
    with pg.cursor() as cur:
        cur.execute("SELECT id, curated FROM events WHERE curated IS NOT NULL")
        saved = [(r[0], r[1]) for r in cur.fetchall()]
    names = ", ".join(t.name for t in TABLES)
    with pg.cursor() as cur:
        cur.execute(f"TRUNCATE {names} RESTART IDENTITY CASCADE")
    pg.commit()
    return saved


def restore_curation(pg, saved: list[tuple[int, str]]) -> int:
    """Reapply curator verdicts saved across a --reset.

    Row identity survives the rebuild because push carries `events.id`
    explicitly, so the pre-truncate ids still address the same events.
    """
    if not saved:
        return 0
    with pg.cursor() as cur:
        cur.executemany(
            "UPDATE events SET curated = %s WHERE id = %s",
            [(verdict, event_id) for event_id, verdict in saved],
        )
    pg.commit()
    return len(saved)


def sync_figures(pg) -> int:
    """Mirror the tracked roster into Postgres so the web app has real names.

    Reads the roster from SQLite, not from figures.toml: the TOML only seeds it,
    and most figures arrive from the mentions stage, which promotes anyone named
    by enough distinct outlets.
    """
    figures = load_figures()
    rows = [
        (f.id, f.name, f.role, json.dumps(f.aliases, ensure_ascii=False), True)
        for f in figures
    ]
    if not rows:
        return 0
    with pg.cursor() as cur:
        cur.executemany(
            """INSERT INTO figures (id, name, role, aliases, active)
               VALUES (%s, %s, %s, %s, %s)
               ON CONFLICT (id) DO UPDATE SET
                 name = EXCLUDED.name,
                 role = EXCLUDED.role,
                 aliases = EXCLUDED.aliases,
                 active = EXCLUDED.active""",
            rows,
        )
    pg.commit()
    return len(rows)


# Candidates corroborated by this many outlets are worth a human's time. Kept
# in step with mentions.PROMOTE_MIN_OUTLETS, which is the same bar the
# automatic promoter uses before its own name-shape checks.
CANDIDATE_EVIDENCE_SQL = """
    SELECT c.slug,
           c.name,
           count(DISTINCT m.source) AS outlets,
           count(*)                 AS mentions
      FROM figure_candidates c
      JOIN figure_mentions m ON m.slug = c.slug
     WHERE c.slug NOT IN (SELECT id FROM figures)
       AND c.status != 'tracked'
     GROUP BY c.slug
    HAVING outlets >= ?
"""


def sync_candidates(pg, sqlite: sqlite3.Connection, min_outlets: int = 3) -> int:
    """Publish the review queue, evidence only.

    The curator's verdict columns are absent from the INSERT and from the
    ON CONFLICT update, so a re-sync refreshes the counts behind a decision
    without touching the decision itself.
    """
    rows = []
    for c in sqlite.execute(CANDIDATE_EVIDENCE_SQL, (min_outlets,)).fetchall():
        role_row = sqlite.execute(
            """SELECT role FROM figure_mentions
                WHERE slug = ? AND role IS NOT NULL AND role != ''
                GROUP BY role ORDER BY count(*) DESC LIMIT 1""",
            (c["slug"],),
        ).fetchone()
        titles = [
            r["title"] for r in sqlite.execute(
                """SELECT DISTINCT a.title
                     FROM figure_mentions m JOIN articles a ON a.id = m.article_id
                    WHERE m.slug = ? AND a.title IS NOT NULL
                    ORDER BY a.published_at DESC LIMIT 4""",
                (c["slug"],),
            )
        ]
        rows.append((
            c["slug"], c["name"], c["outlets"], c["mentions"],
            role_row["role"] if role_row else None,
            json.dumps(titles, ensure_ascii=False),
            _now_iso(),
        ))
    if not rows:
        return 0
    with pg.cursor() as cur:
        cur.executemany(
            """INSERT INTO figure_candidates
                   (slug, name, outlets, mentions, role, headlines, synced_at)
               VALUES (%s, %s, %s, %s, %s, %s, %s)
               ON CONFLICT (slug) DO UPDATE SET
                 name = EXCLUDED.name,
                 outlets = EXCLUDED.outlets,
                 mentions = EXCLUDED.mentions,
                 role = EXCLUDED.role,
                 headlines = EXCLUDED.headlines,
                 synced_at = EXCLUDED.synced_at""",
            rows,
        )
    # A candidate that has since been promoted or folded stops being a
    # question. Undecided rows are dropped; a decided one is kept so the
    # decision stays visible until the pipeline has applied it.
    with pg.cursor() as cur:
        cur.execute(
            "DELETE FROM figure_candidates WHERE verdict IS NULL AND slug <> ALL(%s)",
            ([r[0] for r in rows],),
        )
    pg.commit()
    return len(rows)


def _now_iso() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


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


def push(pg, sqlite: sqlite3.Connection) -> dict[str, int]:
    """Upsert the local working copy into Neon, preserving row identity."""
    counts: dict[str, int] = {}
    for t in TABLES:
        names = ", ".join(t.insert_cols)
        rows = sqlite.execute(f"SELECT {names} FROM {t.name}").fetchall()
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
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="sync_to_neon")
    parser.add_argument("--pull", action="store_true",
                        help="hydrate SQLite from Neon and stop")
    parser.add_argument("--push", action="store_true",
                        help="publish SQLite to Neon and stop")
    parser.add_argument("--candidates", action="store_true",
                        help="refresh only the figure-discovery review queue "
                             "(/kurasi/kandidat) and stop — cheap enough to "
                             "run whenever new names have been mined")
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
    if args.candidates and (args.pull or args.push or args.reset or args.schema):
        parser.error("--candidates refreshes the review queue only; "
                     "combine it with nothing")

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

    if args.candidates:
        try:
            n = sync_candidates(pg, sqlite)
            print(f"figure_candidates: {n} rows awaiting review")
        finally:
            sqlite.close()
            pg.close()
        return 0

    try:
        n = sync_figures(pg)
        print(f"figures: {n} rows")
        n = sync_candidates(pg, sqlite)
        print(f"figure_candidates: {n} rows awaiting review")

        saved_curation: list[tuple[int, str]] = []
        if args.reset:
            print("reset: truncating all synced tables in Neon")
            saved_curation = reset(pg)
            print(f"  held {len(saved_curation)} curator verdicts for restore")

        if do_pull:
            print("pull (Neon -> SQLite)")
            for table, count in pull(pg, sqlite).items():
                print(f"  {table}: {count} rows")

        if do_push:
            print("push (SQLite -> Neon)")
            for table, count in push(pg, sqlite).items():
                print(f"  {table}: {count} rows")

        if saved_curation:
            n = restore_curation(pg, saved_curation)
            print(f"restored {n} curator verdicts")
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
