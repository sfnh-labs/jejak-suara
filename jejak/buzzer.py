"""Stage 7 — Buzzer / coordinated-engagement detection.

Analyses individual comments stored by the sentiment stage for patterns
consistent with coordinated inauthentic behaviour (buzzers, brigading).

Output: per-event `anomaly_score` (0–1) and `anomaly_pct` (0–100) stored in
`buzzer_signals`. This is always framed as *pattern detection*, never as
labelling individual accounts as buzzers.

Methodology:
  1. Cross-event authorship — same author_id appears across ≥3 events.
  2. Copypasta — near-identical text from different authors across events.
  3. Stance extremity — comment stance diverges sharply from event majority.
  4. Velocity — same author posts across ≥2 events within 1 hour.
  5. Volume dominance — single author contributes >20 % of an event's comments.

Signals are weighted and combined into a single anomaly_score per event.
"""
from __future__ import annotations

import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

# Thresholds — tunable per deployment
_CROSS_EVENT_MIN = 3          # distinct events before flagged
_COPYPASTA_SIMILARITY = 85    # rapidfuzz token_sort_ratio threshold
_VELOCITY_HOURS = 1           # max hours between comments from same author
_VOLUME_PCT = 20              # max % of event comments from one author

# Weights for each signal in the composite score (must sum to ≤1)
_W = {
    "cross_event": 0.30,
    "copypasta": 0.25,
    "extremity": 0.20,
    "velocity": 0.15,
    "volume": 0.10,
}


def _get_comments(conn: sqlite3.Connection) -> list[dict]:
    """Fetch all comments with their event_id, stance, and metadata."""
    rows = conn.execute(
        """SELECT c.id, c.event_id, c.author_id, c.author_name, c.text,
                  c.stance, c.published_at, c.like_count
           FROM comments c
           JOIN events e ON e.id = c.event_id
           WHERE e.status = 'approved'
           ORDER BY c.event_id"""
    ).fetchall()
    return [dict(r) for r in rows]


def _cross_event_signal(comments: list[dict]) -> dict[int, set[str]]:
    """Find author_ids that appear across multiple events.

    Returns {event_id: {author_id, ...}} for suspicious authors.
    """
    author_events: dict[str, set[int]] = defaultdict(set)
    for c in comments:
        aid = c.get("author_id", "")
        if aid:
            author_events[aid].add(c["event_id"])

    flagged_authors = {a for a, evs in author_events.items()
                       if len(evs) >= _CROSS_EVENT_MIN}

    result: dict[int, set[str]] = defaultdict(set)
    for c in comments:
        if c.get("author_id", "") in flagged_authors:
            result[c["event_id"]].add(c["author_id"])
    return dict(result)


def _copypasta_signal(comments: list[dict]) -> dict[int, set[int]]:
    """Find near-identical comments from different authors across events.

    Uses rapidfuzz token_sort_ratio for fuzzy matching.
    Returns {event_id: {comment_id, ...}} of suspicious comments.
    """
    try:
        from rapidfuzz import fuzz
    except ImportError:
        return {}

    suspicious: dict[int, set[int]] = defaultdict(set)
    texts_seen: list[tuple[str, str, int, int]] = []  # (author_id, text, comment_id, event_id)

    for c in comments:
        txt = " ".join(c.get("text", "").split()).lower()
        if not txt or len(txt) < 15:
            continue
        aid = c.get("author_id", "")
        for prev_aid, prev_txt, prev_cid, prev_eid in texts_seen:
            if prev_aid == aid:
                continue  # same author repeating themselves — less suspicious
            ratio = fuzz.token_sort_ratio(txt, prev_txt)
            if ratio >= _COPYPASTA_SIMILARITY:
                suspicious[prev_eid].add(prev_cid)
                suspicious[c["event_id"]].add(c["id"])
        texts_seen.append((aid, txt, c["id"], c["event_id"]))

    return dict(suspicious)


def _extremity_signal(comments: list[dict]) -> dict[int, set[int]]:
    """Flag comments whose stance opposes the event majority.

    Returns {event_id: {comment_id, ...}}.
    """
    event_majority: dict[int, str] = {}
    event_counts: dict[int, dict[str, int]] = defaultdict(lambda:
                                                          defaultdict(int))
    for c in comments:
        event_counts[c["event_id"]][c.get("stance", "neutral")] += 1

    for eid, counts in event_counts.items():
        event_majority[eid] = max(counts, key=counts.get)

    result: dict[int, set[int]] = defaultdict(set)
    for c in comments:
        majority = event_majority.get(c["event_id"], "neutral")
        stance = c.get("stance", "neutral")
        if stance != majority and stance != "neutral":
            result[c["event_id"]].add(c["id"])
    return dict(result)


def _velocity_signal(comments: list[dict]) -> dict[int, set[str]]:
    """Find authors who comment across ≥2 events within a short window.

    Returns {event_id: {author_id, ...}}.
    """
    author_times: dict[str, list[tuple[str, int]]] = defaultdict(list)
    for c in comments:
        aid = c.get("author_id", "")
        ts = c.get("published_at", "")
        if aid and ts:
            author_times[aid].append((ts, c["event_id"]))

    try:
        from dateutil import parser as dateparser
        parse = dateparser.parse
    except ImportError:
        def parse(s: str) -> datetime:
            return datetime.fromisoformat(s.replace("Z", "+00:00"))

    fast_authors: set[str] = set()
    for aid, entries in author_times.items():
        events_seen = set()
        times_by_event: dict[int, list[datetime]] = defaultdict(list)
        for ts_str, eid in entries:
            try:
                ts = parse(ts_str)
            except (ValueError, TypeError):
                continue
            times_by_event[eid].append(ts)
            events_seen.add(eid)

        if len(events_seen) < 2:
            continue

        # Check if any two events have comments within VELOCITY_HOURS
        eids = list(events_seen)
        for i in range(len(eids)):
            for j in range(i + 1, len(eids)):
                t1 = min(times_by_event[eids[i]])
                t2 = min(times_by_event[eids[j]])
                if abs((t1 - t2).total_seconds()) / 3600 <= _VELOCITY_HOURS:
                    fast_authors.add(aid)
                    break
            else:
                continue
            break

    result: dict[int, set[str]] = defaultdict(set)
    for c in comments:
        if c.get("author_id", "") in fast_authors:
            result[c["event_id"]].add(c["author_id"])
    return dict(result)


def _volume_signal(comments: list[dict]) -> dict[int, set[str]]:
    """Flag authors who dominate an event's comment volume.

    Returns {event_id: {author_id, ...}}.
    """
    event_total: dict[int, int] = defaultdict(int)
    author_event: dict[int, dict[str, int]] = defaultdict(lambda:
                                                          defaultdict(int))
    for c in comments:
        eid = c["event_id"]
        event_total[eid] += 1
        aid = c.get("author_id", "")
        if aid:
            author_event[eid][aid] += 1

    result: dict[int, set[str]] = defaultdict(set)
    for eid, total in event_total.items():
        if total == 0:
            continue
        for aid, count in author_event[eid].items():
            pct = count / total * 100
            if pct > _VOLUME_PCT:
                result[eid].add(aid)
    return dict(result)


def analyze_event(conn: sqlite3.Connection, event_id: int,
                  comments: list[dict]) -> dict:
    """Run all signals for a single event and return the buzzer analysis."""
    event_comments = [c for c in comments if c["event_id"] == event_id]
    if not event_comments:
        return {"event_id": event_id, "anomaly_score": 0.0, "anomaly_pct": 0.0,
                "suspicious_ids": [], "signals_triggered": []}

    cross = _cross_event_signal(comments)
    pasta = _copypasta_signal(comments)
    ext = _extremity_signal(comments)
    vel = _velocity_signal(comments)
    vol = _volume_signal(comments)

    triggers: list[str] = []
    suspicious_ids: set[int] = set()
    signal_scores: list[float] = []

    if cross.get(event_id):
        triggers.append("cross_event")
        signal_scores.append(_W["cross_event"])
        for aid in cross[event_id]:
            for c in event_comments:
                if c.get("author_id") == aid:
                    suspicious_ids.add(c["id"])

    if pasta.get(event_id):
        triggers.append("copypasta")
        signal_scores.append(_W["copypasta"])
        suspicious_ids |= pasta[event_id]

    if ext.get(event_id):
        triggers.append("extremity")
        signal_scores.append(_W["extremity"])
        suspicious_ids |= ext[event_id]

    if vel.get(event_id):
        triggers.append("velocity")
        signal_scores.append(_W["velocity"])
        for aid in vel[event_id]:
            for c in event_comments:
                if c.get("author_id") == aid:
                    suspicious_ids.add(c["id"])

    if vol.get(event_id):
        triggers.append("volume")
        signal_scores.append(_W["volume"])
        for aid in vol[event_id]:
            for c in event_comments:
                if c.get("author_id") == aid:
                    suspicious_ids.add(c["id"])

    anomaly_score = sum(signal_scores) if signal_scores else 0.0
    anomaly_pct = round(len(suspicious_ids) / len(event_comments) * 100, 1) if event_comments else 0.0

    return {
        "event_id": event_id,
        "anomaly_score": round(anomaly_score, 3),
        "anomaly_pct": anomaly_pct,
        "suspicious_ids": sorted(suspicious_ids),
        "signals_triggered": triggers,
    }


def analyze_all(conn: sqlite3.Connection) -> list[dict]:
    """Run buzzer detection for all events that have comments and no existing analysis."""
    comments = _get_comments(conn)
    if not comments:
        return []

    analyzed_ids = {r["event_id"] for r in
                    conn.execute("SELECT event_id FROM buzzer_signals").fetchall()}
    event_ids = {c["event_id"] for c in comments if c["event_id"] not in analyzed_ids}

    results: list[dict] = []
    now = datetime.now(timezone.utc).isoformat()

    for eid in sorted(event_ids):
        result = analyze_event(conn, eid, comments)
        conn.execute(
            """INSERT OR REPLACE INTO buzzer_signals
               (event_id, anomaly_score, anomaly_pct, suspicious_ids_json,
                signals_triggered, analyzed_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (eid, result["anomaly_score"], result["anomaly_pct"],
             json.dumps(result["suspicious_ids"]),
             ",".join(result["signals_triggered"]),
             now),
        )
        results.append(result)

    conn.commit()
    return results
