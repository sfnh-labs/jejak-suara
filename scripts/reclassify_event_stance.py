"""Relabel stored comments with the event-only stance question.

jejak/sentiment.py used to ask for each comment's stance "toward the figure or
the event" at once, without telling the model what the event was. It now asks
for the stance toward the event alone, given the event (figure_stance.py asks
about the figure). This relabels the comments stored under the old question
and rewrites each event's sentiment rows from the new labels, keeping their
collected_at so refreshes still come due.

Runs event by event and commits each, so it can be stopped and resumed: the
last finished event id is kept in pipeline_state. It refuses to start while a
scheduled run holds the lock, and stops between events if one starts, since
both would be waiting on the same Ollama.

    python scripts/reclassify_event_stance.py              # all, resuming
    python scripts/reclassify_event_stance.py --limit 20   # a sample
    python scripts/reclassify_event_stance.py --restart    # from the first event
"""
from __future__ import annotations

import argparse
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db, sentiment  # noqa: E402

# Beside the real jejak.db: in a worktree, jejak.db is a link to the main
# checkout's, which is where the scheduled run keeps its lock.
LOCK = Path(db.DEFAULT_DB).resolve().parent / "scripts" / ".publish_local.lock"
CURSOR = "event_stance_relabelled_upto"


def _set_cursor(conn, event_id: int) -> None:
    conn.execute(
        "INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (CURSOR, str(event_id), datetime.now(timezone.utc).isoformat()))


def relabel_event(conn, event_id: int) -> dict:
    """Relabel one event's comments and rewrite its sentiment rows."""
    event, figure = sentiment.event_context(conn, event_id)
    rows = conn.execute(
        "SELECT id, video_id, text FROM comments WHERE event_id = ? ORDER BY id",
        (event_id,)).fetchall()
    labels = sentiment.classify_comments([r["text"] for r in rows], event, figure)
    changed = 0
    by_channel: dict[str, tuple[list[str], list[str]]] = {}
    for r, label in zip(rows, labels):
        # A comment the model could not label gets no stance rather than its
        # old one, which answered the other question.
        changed += conn.execute(
            "UPDATE comments SET stance = ? WHERE id = ? AND stance IS NOT ?",
            (label, r["id"], label)).rowcount
        if label:
            channel = "reddit" if (r["video_id"] or "").startswith("t3_") else "youtube"
            texts, ls = by_channel.setdefault(channel, ([], []))
            texts.append(r["text"])
            ls.append(label)
    for channel, (texts, ls) in by_channel.items():
        old = conn.execute("SELECT collected_at FROM sentiment WHERE event_id = ? AND channel = ?",
                           (event_id, channel)).fetchone()
        sentiment.store_aggregate(conn, event_id, channel, texts, ls,
                                  collected_at=old[0] if old else None)
    return {"comments": len(rows), "changed": changed,
            "unlabelled": sum(1 for l in labels if l is None)}


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--limit", type=int, help="stop after this many events")
    ap.add_argument("--restart", action="store_true", help="start from the first event")
    args = ap.parse_args(argv)
    if LOCK.exists():
        print("A pipeline run is in progress (lock held). Refusing.", file=sys.stderr)
        return 1

    conn = db.connect()
    db.migrate(conn)
    row = conn.execute("SELECT value FROM pipeline_state WHERE key = ?", (CURSOR,)).fetchone()
    after = 0 if args.restart or not row else int(row[0])
    ids = [r[0] for r in conn.execute(
        "SELECT DISTINCT event_id FROM comments WHERE event_id > ? ORDER BY event_id", (after,))]
    if args.limit:
        ids = ids[:args.limit]
    print(f"{len(ids)} events to relabel, after event {after}")
    totals = {"comments": 0, "changed": 0, "unlabelled": 0}
    started = time.time()
    for n, eid in enumerate(ids, 1):
        if LOCK.exists():
            print(f"a scheduled run started - stopping after event {after}; re-run to resume")
            break
        stats = relabel_event(conn, eid)
        _set_cursor(conn, eid)
        conn.commit()
        after = eid
        for k in totals:
            totals[k] += stats[k]
        if n % 10 == 0 or n == len(ids):
            per = (time.time() - started) / n
            print(f"  {n}/{len(ids)} events, {totals['changed']} of {totals['comments']} "
                  f"comments changed, ~{per * (len(ids) - n) / 60:.0f} min left", flush=True)
    print(f"done: {totals}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
