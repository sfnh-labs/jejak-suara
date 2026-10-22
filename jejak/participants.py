"""Stage 2c — Who takes part in each record, beyond the figure it is filed under.

Ingest files an article under one figure, by its headline, and the record
inherits that one owner. On a programme like MBG that hides most of the
people involved: measured 2026-10, the President owned 236 of 278 MBG
records, 94 of them without a word of his in the coverage, while the BGN
head owned none and 75 of his 82 quotes sat in the President's records.

So every record gets a participant list in record_figures:

  * the owner, as 'actor' — or 'subject' when the record is framed as about
    them rather than their act;
  * every figure quoted in the record's coverage (event_quotes), as 'quoted';
  * every figure whose statement actors.py copied out of the record's
    articles into a record of their own, as 'quoted' here as well.

The owner is not moved automatically. Where the owner is never quoted and
exactly one other figure is, a record whose title is a statement goes to
actor_reviews for a curator.
"""
from __future__ import annotations

import re
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

from . import actors

# Only a statement needs the owner's voice. An act ("Menandatangani …",
# "Bertolak ke Jepang") is routinely reported through a spokesperson or
# minister, so a silent owner says nothing there.
_STATEMENT = re.compile(rf"^({actors._ACTS})\b", re.I)

_RANK = {"actor": 0, "subject": 1, "target": 2, "quoted": 3}


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def backfill(conn: sqlite3.Connection) -> dict:
    """Rebuild the automatic participant rows and the review queue. Safe to repeat."""
    records = {
        r["id"]: r for r in conn.execute(
            "SELECT id, figure_id, framing, title FROM events "
            "WHERE kind = 'record' AND figure_id IS NOT NULL")
    }
    known = {r[0] for r in conn.execute("SELECT id FROM figures")}

    # event -> figure -> (role, source, quotes)
    rows: dict[int, dict[str, list]] = defaultdict(dict)

    def add(event_id: int, figure_id: str, role: str, source: str, n: int = 0) -> None:
        cur = rows[event_id].get(figure_id)
        if cur is None:
            rows[event_id][figure_id] = [role, source, n]
            return
        cur[2] += n
        if _RANK[role] < _RANK[cur[0]]:
            cur[0], cur[1] = role, source

    for eid, r in records.items():
        add(eid, r["figure_id"], "subject" if r["framing"] == "about" else "actor", "owner")

    for q in conn.execute(
            "SELECT event_id, figure_id, count(*) n FROM event_quotes "
            "WHERE figure_id IS NOT NULL GROUP BY event_id, figure_id"):
        if q["event_id"] in records and q["figure_id"] in known:
            add(q["event_id"], q["figure_id"], "quoted", "quote", q["n"])

    for d in conn.execute(
            "SELECT DISTINCT src.event_id, der.figure_id FROM articles der "
            "JOIN articles src ON src.id = der.derived_from "
            "WHERE der.figure_id IS NOT NULL AND src.event_id IS NOT NULL"):
        if d["event_id"] in records and d["figure_id"] in known:
            add(d["event_id"], d["figure_id"], "quoted", "derived")

    conn.execute("DELETE FROM record_figures WHERE assigned_by = 'auto'")
    conn.executemany(
        "INSERT OR IGNORE INTO record_figures "
        "(event_id, figure_id, role, source, quotes, assigned_by) "
        "VALUES (?, ?, ?, ?, ?, 'auto')",
        [(eid, fid, role, src, n)
         for eid, figs in rows.items() for fid, (role, src, n) in figs.items()])

    # Probable wrong actor: owner silent, one other voice.
    flagged = {}
    for eid, figs in rows.items():
        owner = records[eid]["figure_id"]
        if (records[eid]["framing"] == "about" or figs[owner][2] > 0
                or not _STATEMENT.match(records[eid]["title"] or "")):
            continue
        others = [(fid, v[2]) for fid, v in figs.items() if fid != owner and v[2] > 0]
        if len(others) == 1:
            flagged[eid] = (owner, *others[0])

    conn.execute("DELETE FROM actor_reviews WHERE decision IS NULL")
    now = _now()
    conn.executemany(
        "INSERT OR IGNORE INTO actor_reviews "
        "(event_id, owner_id, suggested_id, quotes, found_at) VALUES (?, ?, ?, ?, ?)",
        [(eid, o, s, n, now) for eid, (o, s, n) in flagged.items()])
    conn.commit()

    total = sum(len(f) for f in rows.values())
    multi = sum(1 for f in rows.values() if len(f) > 1)
    return {"records": len(rows), "participants": total,
            "with_others": multi, "to_review": len(flagged)}
