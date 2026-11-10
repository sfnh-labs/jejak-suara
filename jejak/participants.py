"""Stage 2c — Everyone each record concerns, beyond the figure it is filed under.

Ingest files an article under one figure, by its headline, and the record
inherits that one owner. On a programme like MBG that hides most of the
people involved: measured 2026-10, the President owned 236 of 278 MBG
records, 94 of them without a word of his in the coverage, while the BGN
head owned none and 75 of his 82 quotes sat in the President's records.

So every record gets one list in record_figures, "Terkait" in /kurasi. A
record has someone saying something, about someone; no one in it is told
apart as the actor. It holds:

  * the figure it is filed under ('owner');
  * every figure quoted in its coverage ('quote');
  * every figure a quote is about (quote_subjects, jejak/subjects.py), unless
    a curator ruled the quote is not about them ('about');
  * every figure whose statement actors.py copied out of the record's
    articles into a record of their own ('derived').

The stage rebuilds only its own rows. A curator's (or an answered point's)
stay, including 'removed': someone a curator took out is not put back.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict

# Which source a row is shown with when several apply: the strongest reason first.
_RANK = {"quote": 0, "about": 1, "owner": 2, "derived": 3}


def backfill(conn: sqlite3.Connection) -> dict:
    """Rebuild the automatic rows. Safe to repeat."""
    records = {
        r["id"]: r["figure_id"] for r in conn.execute(
            "SELECT id, figure_id FROM events WHERE kind = 'record'")
    }
    known = {r[0] for r in conn.execute("SELECT id FROM figures")}

    # event -> figure -> [source, quotes]
    rows: dict[int, dict[str, list]] = defaultdict(dict)

    def add(event_id: int, figure_id: str, source: str, n: int = 0) -> None:
        if event_id not in records or figure_id not in known:
            return
        cur = rows[event_id].setdefault(figure_id, [source, 0])
        cur[1] += n
        if _RANK[source] < _RANK[cur[0]]:
            cur[0] = source

    for eid, owner in records.items():
        if owner:
            add(eid, owner, "owner")

    for q in conn.execute(
            "SELECT event_id, figure_id, count(*) n FROM event_quotes "
            "WHERE figure_id IS NOT NULL GROUP BY event_id, figure_id"):
        add(q["event_id"], q["figure_id"], "quote", q["n"])

    for s in conn.execute(
            "SELECT DISTINCT q.event_id, s.figure_id FROM quote_subjects s "
            "JOIN event_quotes q ON q.id = s.quote_id WHERE s.status <> 'rejected'"):
        add(s["event_id"], s["figure_id"], "about")

    for d in conn.execute(
            "SELECT DISTINCT src.event_id, der.figure_id FROM articles der "
            "JOIN articles src ON src.id = der.derived_from "
            "WHERE der.figure_id IS NOT NULL AND src.event_id IS NOT NULL"):
        add(d["event_id"], d["figure_id"], "derived")

    conn.execute("DELETE FROM record_figures WHERE assigned_by = 'auto'")
    conn.executemany(
        "INSERT OR IGNORE INTO record_figures "
        "(event_id, figure_id, role, source, quotes, assigned_by) "
        "VALUES (?, ?, 'related', ?, ?, 'auto')",
        [(eid, fid, src, n)
         for eid, figs in rows.items() for fid, (src, n) in figs.items()])
    # A curator's row keeps its say but not a stale count.
    conn.execute(
        """UPDATE record_figures SET quotes = (
               SELECT count(*) FROM event_quotes q
                WHERE q.event_id = record_figures.event_id AND q.figure_id = record_figures.figure_id)
            WHERE assigned_by <> 'auto'""")
    conn.commit()

    total = sum(len(f) for f in rows.values())
    multi = sum(1 for f in rows.values() if len(f) > 1)
    return {"records": len(rows), "related": total, "with_several": multi}
