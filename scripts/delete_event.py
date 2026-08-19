"""Delete a named event and everything collected against it, in both stores.

`prune_orphan_events.py` refuses any event carrying child rows, and that guard
is right: child rows normally mean the diagnosis is wrong and real data is at
stake. This is the deliberate exception, for the case where the collected data
is itself the problem.

Event 8 was the first: minted by the CI pipeline with `figure_id`
budiman-sudjatmiko and a June date, while the two articles it held were Prabowo
stories from August. The sentiment stage searched YouTube on that mismatched
title and date, found a video about a Jokowi/Rocky Gerung argument, and stored
its 30 comments as the event's public reaction — 15 of them naming Jokowi, none
of them mentioning ojol. Re-pointing that at the ojol event the articles moved
to would publish a stranger's argument as reaction to a policy. There is
nothing to salvage. `jejak/relevance.py` now rejects this class of thread at
collection time.

    python scripts/delete_event.py 8            # dry run - reports only
    python scripts/delete_event.py 8 --apply    # delete, after a backup

Refuses an event that still owns articles: this is for husks, and losing
coverage is never the intent. Both stores go together, or `--pull` hydrates the
row back on the next run.
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

# Deleted in this order, parents last. SQLite foreign keys are not enforced by
# default and Postgres has no cascade here, so an orphaned child row would
# simply survive and be counted by everything downstream.
CHILD_TABLES = ("event_summaries", "event_figures", "sentiment",
                "comments", "buzzer_signals")


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"'))


def _report(label: str, run, event_id: int, mark: str) -> tuple[bool, int]:
    """Print what is there. Returns (exists, article count)."""
    row = run(f"SELECT title, event_date, figure_id FROM events "
              f"WHERE id = {mark}", (event_id,))
    if row is None:
        print(f"{label:<7}: no event {event_id}")
        return False, 0
    title, when, figure = row
    print(f"{label:<7}: {title[:56]}")
    print(f"{'':<7}  {figure or '(peristiwa)'}  {str(when)[:10]}")
    articles = run(f"SELECT count(*) FROM articles WHERE event_id = {mark}",
                   (event_id,))[0]
    counts = {t: run(f"SELECT count(*) FROM {t} WHERE event_id = {mark}",
                     (event_id,))[0] for t in CHILD_TABLES}
    print(f"{'':<7}  articles {articles}, "
          + ", ".join(f"{t} {n}" for t, n in counts.items() if n))
    return True, articles


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="delete_event")
    parser.add_argument("event_id", type=int)
    parser.add_argument("--apply", action="store_true",
                        help="actually delete (default is a dry run)")
    args = parser.parse_args(argv)

    _load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    if (ROOT / "scripts" / ".publish_local.lock").exists():
        print("A pipeline run is in progress (lock held). Refusing.",
              file=sys.stderr)
        return 1

    import sync_to_neon  # noqa: E402

    sqlite = jejak_db.connect()
    pg = sync_to_neon._connect_pg(db_url)
    cur = pg.cursor()
    eid = args.event_id

    try:
        def sq(sql, params=()):
            return sqlite.execute(sql, params).fetchone()

        def pgq(sql, params=()):
            cur.execute(sql, list(params))
            return cur.fetchone()

        sq_here, sq_articles = _report("SQLite", sq, eid, "?")
        pg_here, pg_articles = _report("Neon", pgq, eid, "%s")

        if not (sq_here or pg_here):
            print("nothing to do")
            return 0
        if sq_articles or pg_articles:
            print(f"\nABORT: event {eid} still owns articles "
                  f"({sq_articles} in SQLite, {pg_articles} in Neon). Detach "
                  f"them first — this deletes husks, not coverage.",
                  file=sys.stderr)
            return 2

        if not args.apply:
            print(f"\nDry run. Re-run with --apply to delete event {eid} and "
                  f"every row above.")
            return 0

        backup = ROOT / f"jejak.db.bak.{datetime.now():%Y%m%d%H%M%S}"
        shutil.copy2(jejak_db.DEFAULT_DB, backup)
        print(f"\nbackup: {backup.name}")

        for table in CHILD_TABLES:
            n = sqlite.execute(f"DELETE FROM {table} WHERE event_id = ?",
                               (eid,)).rowcount
            cur.execute(f"DELETE FROM {table} WHERE event_id = %s", (eid,))
            if n or cur.rowcount:
                print(f"  {table:<16} SQLite {n:>4}   Neon {cur.rowcount:>4}")
        n = sqlite.execute("DELETE FROM events WHERE id = ?", (eid,)).rowcount
        cur.execute("DELETE FROM events WHERE id = %s", (eid,))
        print(f"  {'events':<16} SQLite {n:>4}   Neon {cur.rowcount:>4}")

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
