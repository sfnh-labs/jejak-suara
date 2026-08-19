"""Apply the collection-time relevance gate to comments already stored.

`jejak/relevance.py` rejects a comment thread that is not about the event, but
it only runs at collection. Everything gathered before it existed went in
unchecked: 342 of 4061 stored comments fail it, including all 100 on event 6,
which are an argument about the free-meal programme filed as reaction to a
denial of share ownership.

    python scripts/purge_offtopic_comments.py           # dry run - reports only
    python scripts/purge_offtopic_comments.py --apply   # delete, after a backup

The event's sentiment and buzzer rows go with the comments, in both stores.
Leaving them would publish a score citing a sample that no longer exists —
event 913 reads -0.68 over 41 comments, 40 of which fail the gate. Deleting the
sentiment row is also what makes the event pending again, so the next scheduled
run re-collects it with the gate active; `sentiment_pending` picks up any
approved event that has no sentiment row.

Comments are matched across stores on `comment_id`, never on row id: `comments`
syncs with serial=True against a conflict target of (event_id, comment_id), so
Postgres mints its own ids and the two id spaces do not correspond.
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
from jejak import relevance  # noqa: E402


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"'))


def survey(conn):
    """Per event: the comment ids that fail the gate, and what they cost.

    Returns [{event_id, title, doomed, held, threads, sentiment}], worst first.
    """
    out = []
    ids = [r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM comments ORDER BY event_id")]
    for eid in ids:
        rows = [dict(r) for r in conn.execute(
            "SELECT comment_id, video_id, text FROM comments "
            " WHERE event_id = ?", (eid,))]
        kept, dropped = relevance.filter_comments(conn, eid, rows)
        if not dropped:
            continue
        bad_videos = {d["video_id"] for d in dropped}
        ids_to_go = [r["comment_id"] for r in rows
                     if (r["video_id"] or "") in bad_videos]
        sent = conn.execute(
            "SELECT score, sample_size FROM sentiment WHERE event_id = ?",
            (eid,)).fetchone()
        out.append({
            "event_id": eid,
            "title": conn.execute("SELECT title FROM events WHERE id = ?",
                                  (eid,)).fetchone()[0],
            "doomed": ids_to_go,
            "held": len(rows),
            "kept": len(kept),
            "threads": [(d["video_id"], d["score"]) for d in dropped],
            "sentiment": (sent["score"], sent["sample_size"]) if sent else None,
        })
    out.sort(key=lambda e: -len(e["doomed"]))
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="purge_offtopic_comments")
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
    total = sqlite.execute("SELECT count(*) FROM comments").fetchone()[0]
    hits = survey(sqlite)
    doomed = sum(len(e["doomed"]) for e in hits)

    print(f"gate threshold {relevance.THRESHOLD}; {doomed} of {total} stored "
          f"comments fail it, across {len(hits)} events\n")
    for e in hits:
        score = (f"sentiment {e['sentiment'][0]:+.2f} n={e['sentiment'][1]}"
                 if e["sentiment"] else "no sentiment")
        print(f"  event {e['event_id']:<6} drop {len(e['doomed']):>3} of "
              f"{e['held']:<4} {score:<24} {e['title'][:38]}")
        print(f"{'':<16}{[f'{v} {s:.3f}' for v, s in e['threads']]}")
    emptied = [e["event_id"] for e in hits if e["kept"] == 0]
    if emptied:
        print(f"\nleft with no comments at all: {emptied} — these show no "
              f"public reaction until something on topic is found")

    if not args.apply:
        print("\nDry run. Re-run with --apply.")
        sqlite.close()
        return 0
    if not hits:
        sqlite.close()
        return 0

    pg = sync_to_neon._connect_pg(db_url)
    cur = pg.cursor()
    backup = ROOT / f"jejak.db.bak.{datetime.now():%Y%m%d%H%M%S}"
    shutil.copy2(jejak_db.DEFAULT_DB, backup)
    print(f"\nbackup: {backup.name}")

    try:
        for e in hits:
            eid, ids = e["event_id"], e["doomed"]
            sqlite.executemany(
                "DELETE FROM comments WHERE event_id = ? AND comment_id = ?",
                [(eid, cid) for cid in ids])
            cur.execute("DELETE FROM comments WHERE event_id = %s "
                        "AND comment_id = ANY(%s)", (eid, ids))
            # The aggregate cited a sample that is now gone. Dropping the row
            # is what puts the event back in sentiment_pending.
            for table in ("sentiment", "buzzer_signals"):
                sqlite.execute(f"DELETE FROM {table} WHERE event_id = ?",
                               (eid,))
                cur.execute(f"DELETE FROM {table} WHERE event_id = %s", (eid,))
        pg.commit()
        sqlite.commit()

        left = sqlite.execute("SELECT count(*) FROM comments").fetchone()[0]
        cur.execute("SELECT count(*) FROM comments")
        print(f"deleted {doomed} comments and {len(hits)} sentiment rows; "
              f"comments now SQLite {left}, Neon {cur.fetchone()[0]}")
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
