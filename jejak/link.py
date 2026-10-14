"""Stage 2b — Propose which records belong to which peristiwa.

Clustering puts every article in exactly one event: an article attributed to a
tracked figure goes into that figure's record, everything else into a
peristiwa. So the President handing over a trophy and the final the trophy was
for end up in two events that nothing connects. This stage proposes the
connection; a curator confirms or rejects it in /kurasi, and only confirmed
links reach the public site.

Proposals, not decisions, because the signal is weak. Measured over the live
data (2026-10), plain cosine between cluster centroids scored unrelated pairs
above 0.85: every centroid drifts toward the same "Indonesian government news"
direction. Two corrections make the ranking usable:

  * vectors are centred on the corpus mean before comparison, which removes
    that shared direction, and
  * a pair must share at least MIN_SPECIFIC rare words — terms found in no
    more than SPECIFIC_MAX_EVENTS events ("summarecon", "wantimpres",
    "velodrome") — which is what actually distinguishes one story from the
    next. Those words are stored as the link's evidence, so the curator can
    see why it was proposed.

Even so, about half the top proposals are wrong, mostly because a large
record or peristiwa cluster has absorbed more than one story. Confirmed and
rejected pairs are kept as labels for tuning these constants.
"""
from __future__ import annotations

import json
import sqlite3
from collections import Counter
from datetime import datetime, timedelta, timezone

from .cluster import _parse, _tokens

PUBLIC = ("new", "summarized", "approved")
# A record can start a little before the national story is corroborated, or
# trail it by a day or two of follow-up statements.
WINDOW_DAYS = 2
MIN_SCORE = 0.35
MIN_SPECIFIC = 2
SPECIFIC_MAX_EVENTS = 12
PER_RECORD = 3


def _load(conn: sqlite3.Connection, kind: str) -> dict[int, dict]:
    import numpy as np

    events: dict[int, dict] = {}
    rows = conn.execute(
        f"""SELECT e.id, e.figure_id, e.event_date, e.last_seen,
                   a.title, a.summary, ae.vec
              FROM events e
              JOIN articles a ON a.event_id = e.id
              JOIN article_embeddings ae ON ae.article_id = a.id
             WHERE e.kind = ? AND e.status IN ({",".join("?" * len(PUBLIC))})""",
        (kind, *PUBLIC),
    )
    for r in rows:
        ev = events.setdefault(r["id"], {
            "figure": r["figure_id"],
            "start": _parse(r["event_date"]),
            "end": _parse(r["last_seen"] or r["event_date"]),
            "vecs": [],
            "tokens": set(),
        })
        ev["vecs"].append(np.frombuffer(r["vec"], dtype=np.float32))
        ev["tokens"] |= _tokens(f"{r['title']} {r['summary'] or ''}")
    return events


def link_records(conn: sqlite3.Connection) -> dict[str, int]:
    """Refresh proposed record → peristiwa links. Never deletes a row.

    A pair the curator has ruled on is left exactly as it is: a rejected one is
    not re-proposed, and a confirmed one keeps its verdict even if a later run
    would score it below the bar.
    """
    import numpy as np

    stats = {"proposed": 0, "updated": 0}
    peristiwa = _load(conn, "peristiwa")
    if not peristiwa:
        return stats
    records = _load(conn, "record")

    every = list(peristiwa.values()) + list(records.values())
    centre = np.vstack([v for ev in every for v in ev["vecs"]]).mean(axis=0)
    for ev in every:
        m = np.vstack(ev["vecs"]).mean(axis=0) - centre
        ev["mean"] = m / (np.linalg.norm(m) or 1.0)
    df = Counter(t for ev in every for t in ev["tokens"])

    ruled = {
        (r["record_id"], r["peristiwa_id"])
        for r in conn.execute(
            "SELECT record_id, peristiwa_id FROM record_links WHERE verdict IS NOT NULL"
        )
    }
    earliest = min(p["start"] for p in peristiwa.values()) - timedelta(days=WINDOW_DAYS)
    window = timedelta(days=WINDOW_DAYS)
    now = datetime.now(timezone.utc).isoformat()

    for rid, rec in records.items():
        if rec["end"] < earliest:
            continue
        found = []
        for pid, per in peristiwa.items():
            if rec["start"] > per["end"] + window or rec["end"] < per["start"] - window:
                continue
            score = float(rec["mean"] @ per["mean"])
            if score < MIN_SCORE:
                continue
            specific = sorted(
                (t for t in rec["tokens"] & per["tokens"] if df[t] <= SPECIFIC_MAX_EVENTS),
                key=lambda t: (df[t], t),
            )
            if len(specific) < MIN_SPECIFIC:
                continue
            found.append((score, pid, specific[:8]))

        for score, pid, specific in sorted(found, reverse=True)[:PER_RECORD]:
            if (rid, pid) in ruled:
                continue
            evidence = json.dumps(specific, ensure_ascii=False)
            score = round(score, 4)
            existing = conn.execute(
                "SELECT score, evidence FROM record_links "
                "WHERE record_id = ? AND peristiwa_id = ?",
                (rid, pid),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO record_links
                           (record_id, peristiwa_id, score, evidence, origin, created_at)
                       VALUES (?, ?, ?, ?, 'pipeline', ?)""",
                    (rid, pid, score, evidence, now),
                )
                stats["proposed"] += 1
            elif (existing["score"], existing["evidence"]) != (score, evidence):
                conn.execute(
                    "UPDATE record_links SET score = ?, evidence = ? "
                    "WHERE record_id = ? AND peristiwa_id = ?",
                    (score, evidence, rid, pid),
                )
                stats["updated"] += 1

    # A confirmed link says the record's figure is part of the peristiwa,
    # whether or not the coverage happened to spell out their name.
    stats["related_figures"] = conn.execute(
        """INSERT OR IGNORE INTO event_figures (event_id, figure_id)
           SELECT l.peristiwa_id, e.figure_id
             FROM record_links l JOIN events e ON e.id = l.record_id
            WHERE l.verdict = 'confirmed' AND e.figure_id IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM event_figure_rejections x
                               WHERE x.event_id = l.peristiwa_id
                                 AND x.figure_id = e.figure_id)"""
    ).rowcount
    conn.commit()
    return stats

