"""Stage 2b — Propose which records belong to which peristiwa, and which
events follow up which (link_followups, below).

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
from collections import Counter, defaultdict
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



# ---------------------------------------------------------------------------
# Follow-ups
#
# Clustering merges coverage only within a window of days, so a story that
# runs for weeks — a bill proposed then passed, a search launched then called
# off — leaves a chain of unconnected events. This proposes the chain.
#
# Similarity alone is not enough: same-genre stories about different incidents
# (two house fires, two weather forecasts, two unrelated KPK cases) score as
# high as a true follow-up. What a follow-up has that they do not is a rare
# term in both events' *titles* — the ship's name, the bill, the suspect.
# Measured on the live data (2026-10): requiring one cut 1,127 candidate pairs
# to ~300, most of them genuine; without it, about half were genre matches.

FOLLOWUP_MIN_SCORE = 0.45
FOLLOWUP_MIN_GAP_DAYS = 1      # the later one starts at least this much later
FOLLOWUP_MAX_GAP_DAYS = 60     # ... and no longer than this after the first ends
FOLLOWUP_TITLE_MAX_EVENTS = 10 # a shared title term found in at most this many titles
FOLLOWUP_TITLE_MAX_DF = 60     # ... and in at most this many events' text
PER_FOLLOWUP = 2               # predecessors proposed per event


def _title_tokens(conn: sqlite3.Connection) -> dict[int, set[str]]:
    return {r[0]: _tokens(r[1] or "") for r in conn.execute("SELECT id, title FROM events")}


def link_followups(conn: sqlite3.Connection) -> dict[str, int]:
    """Refresh proposed follow-up links. Never deletes a row; ruled pairs are left alone.

    Peristiwa are paired with peristiwa; a record only with earlier records of
    the same figure, since a figure's own story is what their page tells.
    """
    import numpy as np

    stats = {"proposed": 0, "updated": 0}
    groups: list[dict[int, dict]] = []
    peristiwa = _load(conn, "peristiwa")
    records = _load(conn, "record")
    every = list(peristiwa.values()) + list(records.values())
    if len(every) < 2:
        return stats
    centre = np.vstack([v for ev in every for v in ev["vecs"]]).mean(axis=0)
    for ev in every:
        m = np.vstack(ev["vecs"]).mean(axis=0) - centre
        ev["mean"] = m / (np.linalg.norm(m) or 1.0)
    df = Counter(t for ev in every for t in ev["tokens"])
    titles = _title_tokens(conn)
    title_df = Counter(t for toks in titles.values() for t in toks)

    groups.append(peristiwa)
    by_figure: dict[str, dict[int, dict]] = defaultdict(dict)
    for rid, rec in records.items():
        by_figure[rec["figure"]][rid] = rec
    groups.extend(by_figure.values())

    ruled = {
        (r[0], r[1]) for r in conn.execute(
            "SELECT earlier_id, later_id FROM followup_links WHERE verdict IS NOT NULL"
        )
    }
    day = 86400.0
    found: dict[int, list[tuple[float, int, list[str]]]] = defaultdict(list)
    for group in groups:
        ids = list(group)
        if len(ids) < 2:
            continue
        mat = np.stack([group[i]["mean"] for i in ids])
        sims = mat @ mat.T
        start = np.array([group[i]["start"].timestamp() for i in ids])
        end = np.array([group[i]["end"].timestamp() for i in ids])
        # Row = earlier, column = later.
        ok = (
            (sims >= FOLLOWUP_MIN_SCORE)
            & (start[None, :] >= start[:, None] + FOLLOWUP_MIN_GAP_DAYS * day)
            & (start[None, :] <= end[:, None] + FOLLOWUP_MAX_GAP_DAYS * day)
        )
        for a, b in zip(*np.nonzero(ok)):
            early, late = ids[a], ids[b]
            in_titles = {
                t for t in titles.get(early, set()) & titles.get(late, set())
                if title_df[t] <= FOLLOWUP_TITLE_MAX_EVENTS and df[t] <= FOLLOWUP_TITLE_MAX_DF
            }
            if not in_titles:
                continue
            shared = group[early]["tokens"] & group[late]["tokens"]
            specific = sorted((t for t in shared if df[t] <= SPECIFIC_MAX_EVENTS),
                              key=lambda t: (df[t], t))
            evidence = sorted(in_titles) + [t for t in specific if t not in in_titles]
            if len(evidence) < MIN_SPECIFIC:
                continue
            found[late].append((float(sims[a, b]), early, evidence[:8]))

    now = datetime.now(timezone.utc).isoformat()
    for late, cands in found.items():
        for score, early, evidence in sorted(cands, reverse=True)[:PER_FOLLOWUP]:
            if (early, late) in ruled:
                continue
            ev_json = json.dumps(evidence, ensure_ascii=False)
            score = round(score, 4)
            existing = conn.execute(
                "SELECT score, evidence FROM followup_links WHERE earlier_id = ? AND later_id = ?",
                (early, late),
            ).fetchone()
            if existing is None:
                conn.execute(
                    """INSERT INTO followup_links
                           (earlier_id, later_id, score, evidence, origin, created_at)
                       VALUES (?, ?, ?, ?, 'pipeline', ?)""",
                    (early, late, score, ev_json, now),
                )
                stats["proposed"] += 1
            elif (existing[0], existing[1]) != (score, ev_json):
                conn.execute(
                    "UPDATE followup_links SET score = ?, evidence = ? "
                    "WHERE earlier_id = ? AND later_id = ?",
                    (score, ev_json, early, late),
                )
                stats["updated"] += 1
    conn.commit()
    return stats
