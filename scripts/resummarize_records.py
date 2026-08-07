"""Regenerate every summarized event with the current prompt.

An event is summarized once and never revisited, so a change to how an entry
is framed — or, now, to the event_type taxonomy — only reaches new events.
This re-runs the existing ones so the backlog catches up too.

Both kinds are included: peristiwa keep their news-framed titles (the prompt
doesn't touch that), but they still need retagging under the open-vocabulary
event_type scheme, same as records.

    python scripts/resummarize_records.py [--limit N] [--kind record|peristiwa]
"""
from __future__ import annotations

import argparse
import sys

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))

from jejak import db, summarize  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--skip", type=int, nargs="*", default=[])
    ap.add_argument("--kind", choices=["record", "peristiwa"], default=None)
    args = ap.parse_args()

    conn = db.connect()
    try:
        # Only events that have ALREADY been summarized. Anything else is
        # either still corroborating (a peristiwa 'candidate', gated at
        # PERISTIWA_MIN_OUTLETS) or hasn't been queued yet — summarize_event
        # force-sets status='approved' unconditionally, so running it on a
        # candidate publishes it without the outlet corroboration that gate
        # exists to require.
        sql = """SELECT e.id FROM events e
                   WHERE EXISTS (SELECT 1 FROM event_summaries s WHERE s.event_id = e.id)"""
        params: tuple = ()
        if args.kind:
            sql += " AND e.kind = ?"
            params = (args.kind,)
        rows = conn.execute(sql + " ORDER BY e.event_date DESC", params).fetchall()
        ids = [r["id"] for r in rows if r["id"] not in set(args.skip)]
        if args.limit:
            ids = ids[: args.limit]

        print(f"regenerating {len(ids)} entries", flush=True)
        for n, eid in enumerate(ids, 1):
            before = conn.execute(
                "SELECT title, event_type FROM events WHERE id = ?", (eid,)
            ).fetchone()
            try:
                summarize.summarize_event(conn, eid)
            except Exception as exc:  # keep going; one bad cluster is not fatal
                print(f"[{n}/{len(ids)}] {eid} FAILED: {exc}", flush=True)
                continue
            after = conn.execute(
                "SELECT title, event_type FROM events WHERE id = ?", (eid,)
            ).fetchone()
            mark = "=" if after["title"] == before["title"] else ">"
            tag = (
                f"{before['event_type']} -> {after['event_type']}"
                if before["event_type"] != after["event_type"]
                else after["event_type"]
            )
            print(f"[{n}/{len(ids)}] {eid} {mark} {after['title']}  [{tag}]", flush=True)
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
