"""Re-cluster articles that were never clustered in the first place.

`cluster()` will only merge an article into an event whose date is within
WINDOW_DAYS of the article's publication. So an article sitting on an event
further away than that did not get there by clustering — it got there from the
GitHub Actions pipeline that ran until 2026-08-18. That job checked out the
repo, where `jejak.db` is gitignored, so it started from an empty database and
numbered its events from 1. The sync it ran then pushed events *without* their
id, letting Postgres mint fresh ones, while articles carried the CI-local
`event_id` verbatim — so the coverage landed on whatever real event happened to
hold that low id. Event 1 collected 578 articles this way. `--pull` then
copied the mapping back into the local database, which is why both stores show
it.

    python scripts/repair_misassigned_articles.py           # dry run
    python scripts/repair_misassigned_articles.py --apply   # detach + recluster

Detaching rather than rebuilding. Nulling `event_id` and re-running `cluster()`
re-homes the coverage while every event keeps its row — and with it the
comments and sentiment already collected against it, and `events.curated`,
which lives only in Postgres and is a human verdict that nothing can
regenerate. Dropping the events and clustering from scratch would take all of
that with it.

An event that loses articles has a summary that cites coverage it no longer
holds, and a corroboration count taken from it — the number the single-source
badge is derived from. Those summaries are deleted in both stores and the
event goes back to 'new' for the next run to write again. This is the mirror
of `cluster._reopen_if_summarized`, which handles an event *gaining* an
article; nothing handled one losing an article, because until now nothing
could.

Afterwards, run in this order:

    python scripts/prune_orphan_events.py --apply   # events left with nothing
    python scripts/sync_to_neon.py --push           # carry it all to Neon
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from jejak import cluster as jejak_cluster  # noqa: E402
from jejak import db as jejak_db  # noqa: E402


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"'))


def misassigned(conn) -> list[tuple[str, int]]:
    """(article_id, event_id) pairs that clustering could not have produced.

    The window is read from the clusterer rather than restated here, so the
    two cannot drift apart and start disagreeing about what is wrong.
    """
    window = timedelta(days=jejak_cluster.WINDOW_DAYS).total_seconds()
    out = []
    for row in conn.execute(
        """SELECT a.id, a.event_id, a.published_at, e.event_date
             FROM articles a JOIN events e ON e.id = a.event_id"""
    ):
        when = jejak_cluster._parse(row["published_at"])
        ewhen = jejak_cluster._parse(row["event_date"])
        if abs((when - ewhen).total_seconds()) > window:
            out.append((row["id"], row["event_id"]))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="repair_misassigned_articles")
    parser.add_argument("--apply", action="store_true",
                        help="actually detach and recluster (default: dry run)")
    args = parser.parse_args(argv)

    if (ROOT / "scripts" / ".publish_local.lock").exists():
        print("A pipeline run is in progress (lock held). Refusing.",
              file=sys.stderr)
        return 1

    _load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    conn = jejak_db.connect()
    bad = misassigned(conn)
    total = conn.execute("SELECT count(*) FROM articles").fetchone()[0]
    per_event = Counter(eid for _, eid in bad)

    print(f"{len(bad)} of {total} articles sit outside their event's "
          f"{jejak_cluster.WINDOW_DAYS}-day window, "
          f"across {len(per_event)} events")
    for eid, n in per_event.most_common(8):
        row = conn.execute(
            "SELECT title, (SELECT count(*) FROM articles a "
            " WHERE a.event_id = events.id) AS held "
            "FROM events WHERE id = ?", (eid,)).fetchone()
        print(f"  event {eid:<5} loses {n:>4} of {row['held']:>4}  "
              f"{row['title'][:52]}")

    stale = [eid for eid in per_event if conn.execute(
        "SELECT 1 FROM event_summaries WHERE event_id = ?", (eid,)).fetchone()]
    print(f"\n{len(stale)} of those events carry a summary that will be "
          f"rewritten")

    if not args.apply:
        print("\nDry run. Re-run with --apply.")
        conn.close()
        return 0
    if not bad:
        print("nothing to do")
        conn.close()
        return 0

    import sync_to_neon  # noqa: E402
    pg = sync_to_neon._connect_pg(db_url)

    backup = ROOT / f"jejak.db.bak.{datetime.now():%Y%m%d%H%M%S}"
    shutil.copy2(jejak_db.DEFAULT_DB, backup)
    print(f"\nbackup: {backup.name}")

    try:
        conn.executemany("UPDATE articles SET event_id = NULL WHERE id = ?",
                         [(aid,) for aid, _ in bad])
        # Both stores, because push only ever inserts and updates summaries —
        # a row deleted here would otherwise survive in Postgres and go on
        # being served.
        conn.executemany("DELETE FROM event_summaries WHERE event_id = ?",
                         [(eid,) for eid in stale])
        conn.executemany("UPDATE events SET status = 'new' WHERE id = ? "
                         "AND status IN ('summarized', 'approved')",
                         [(eid,) for eid in stale])
        conn.commit()
        with pg.cursor() as cur:
            cur.executemany("DELETE FROM event_summaries WHERE event_id = %s",
                            [(eid,) for eid in stale])
        pg.commit()
        print(f"detached {len(bad)} articles, dropped {len(stale)} summaries")

        stats = jejak_cluster.cluster(conn)
        print(f"recluster: {stats}")

        left = len(misassigned(conn))
        print(f"still outside the window: {left}")
        sizes = conn.execute(
            "SELECT count(*) c FROM articles WHERE event_id IS NOT NULL "
            "GROUP BY event_id ORDER BY c DESC LIMIT 5").fetchall()
        print(f"largest events now: {[r['c'] for r in sizes]}")
        empty = conn.execute(
            "SELECT count(*) FROM events e WHERE NOT EXISTS "
            "(SELECT 1 FROM articles a WHERE a.event_id = e.id)").fetchone()[0]
        print(f"events now holding no articles: {empty} "
              f"(run prune_orphan_events.py --apply)")
    except Exception:
        pg.rollback()
        raise
    finally:
        pg.close()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
