"""Remove duplicate event rows left behind by the pre-2026-08 sync.

The old `sync_to_neon` pushed events to Postgres without their `id`, so SERIAL
minted a fresh one for every event on every run while the articles kept
pointing at the original SQLite ids. The result is a population of event rows
that own no articles: each is a copy of a real, lower-numbered event whose
coverage stayed where it was. They cannot be summarized (`summarize_event`
raises "has no articles" on each one, which is the wall of `skip event N` lines
in every run's log) and they cannot be shown, but they still fill the curation
queue and the site's counters.

    python scripts/prune_orphan_events.py           # dry run - reports only
    python scripts/prune_orphan_events.py --apply   # delete, after a backup

Deliberately NOT `sync_to_neon.py --reset`. That repairs the same damage by
truncating and rebuilding, but `events.curated` is a Postgres-only column the
sync never carries, so a truncate would destroy every curator verdict on the
way past. This deletes named ids instead and every surviving row keeps its
verdict.

Both stores are cleaned in one pass. Cleaning only one is pointless: `--pull`
would hydrate the rows straight back from Neon on the next scheduled run.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from jejak import db as jejak_db  # noqa: E402

# Anything referencing events(id). An orphan is expected to carry none of it -
# the run refuses to delete rows that do, because that would mean the diagnosis
# is wrong and real collected data is at stake.
CHILD_TABLES = ("event_summaries", "event_figures", "sentiment",
                "comments", "buzzer_signals")

ORPHAN_SQL = """
    SELECT e.id FROM events e
     WHERE NOT EXISTS (SELECT 1 FROM articles a WHERE a.event_id = e.id)
     ORDER BY e.id
"""


def _load_env() -> None:
    """Read the gitignored .env the same way publish_local.ps1 does."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"'))


def _child_counts(execute, ids: list[int], placeholder: str) -> dict[str, int]:
    """How many child rows hang off the candidate ids, per table."""
    if not ids:
        return {t: 0 for t in CHILD_TABLES}
    marks = ", ".join([placeholder] * len(ids))
    out = {}
    for table in CHILD_TABLES:
        out[table] = execute(
            f"SELECT count(*) FROM {table} WHERE event_id IN ({marks})", ids
        )
    return out


def _sqlite_scalar(conn):
    def run(sql, params=()):
        return conn.execute(sql, params).fetchone()[0]
    return run


def _pg_scalar(cur):
    def run(sql, params=()):
        cur.execute(sql, list(params))
        return cur.fetchone()[0]
    return run


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="prune_orphan_events")
    parser.add_argument("--apply", action="store_true",
                        help="actually delete (default is a dry run)")
    args = parser.parse_args(argv)

    _load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    lock = ROOT / "scripts" / ".publish_local.lock"
    if lock.exists():
        print("A pipeline run is in progress (lock held). Refusing - it would "
              "race the same SQLite file.", file=sys.stderr)
        return 1

    import sync_to_neon  # noqa: E402  (needs DATABASE_URL loaded first)

    sqlite = jejak_db.connect()
    pg = sync_to_neon._connect_pg(db_url)
    cur = pg.cursor()

    try:
        sq_ids = [r[0] for r in sqlite.execute(ORPHAN_SQL).fetchall()]
        cur.execute(ORPHAN_SQL)
        pg_ids = [r[0] for r in cur.fetchall()]

        sq_total = sqlite.execute("SELECT count(*) FROM events").fetchone()[0]
        cur.execute("SELECT count(*) FROM events")
        pg_total = cur.fetchone()[0]

        print(f"SQLite : {len(sq_ids)} orphan events of {sq_total}")
        print(f"Neon   : {len(pg_ids)} orphan events of {pg_total}")

        only_sq = sorted(set(sq_ids) - set(pg_ids))
        only_pg = sorted(set(pg_ids) - set(sq_ids))
        if only_sq or only_pg:
            print(f"  differ: {len(only_sq)} only in SQLite, "
                  f"{len(only_pg)} only in Neon (each store is cleaned "
                  f"against its own list)")

        # The whole diagnosis rests on these rows carrying nothing. Verify it
        # rather than trust it: a non-zero count means real collected data
        # would be destroyed, so stop instead.
        blocked = False
        for label, counts in (
            ("SQLite", _child_counts(_sqlite_scalar(sqlite), sq_ids, "?")),
            ("Neon", _child_counts(_pg_scalar(cur), pg_ids, "%s")),
        ):
            attached = {t: n for t, n in counts.items() if n}
            if attached:
                blocked = True
                print(f"  ABORT: {label} orphans carry child rows: {attached}")
        if blocked:
            print("\nThese events are not the inert duplicates this script "
                  "assumes. Nothing deleted.", file=sys.stderr)
            return 2

        print("  child rows attached: none in either store (verified)")

        cur.execute(
            "SELECT curated, count(*) FROM events WHERE id = ANY(%s) "
            "AND curated IS NOT NULL GROUP BY curated", (pg_ids,)
        )
        verdicts = cur.fetchall()
        if verdicts:
            print("  note: some carry a curator verdict that will go with "
                  f"them: {dict(verdicts)}")

        if not args.apply:
            preview = ", ".join(str(i) for i in sq_ids[:12])
            print(f"\nDry run. Would delete ids: {preview}"
                  f"{' ...' if len(sq_ids) > 12 else ''}")
            print("Re-run with --apply to delete.")
            return 0

        backup = ROOT / f"jejak.db.bak.{datetime.now():%Y%m%d%H%M%S}"
        shutil.copy2(jejak_db.DEFAULT_DB, backup)
        print(f"\nbackup: {backup.name}")

        if pg_ids:
            cur.execute("DELETE FROM events WHERE id = ANY(%s)", (pg_ids,))
            print(f"Neon   : deleted {cur.rowcount}")
        if sq_ids:
            marks = ", ".join("?" * len(sq_ids))
            deleted = sqlite.execute(
                f"DELETE FROM events WHERE id IN ({marks})", sq_ids
            ).rowcount
            print(f"SQLite : deleted {deleted}")

        pg.commit()
        sqlite.commit()
        print("done")
    except Exception:
        pg.rollback()
        raise
    finally:
        cur.close()
        pg.close()
        sqlite.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
