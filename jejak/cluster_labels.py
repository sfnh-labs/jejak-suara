"""Learn peristiwa clustering from the curator's article labels.

In the Telegram 📋 view of a peristiwa the curator marks articles that are
not part of its story (🚫, 'out') and then confirms the rest as one story
(✅, 'in'). Those labels become three things:

  apply_out   an 'out' article leaves the event at the next cluster run, into
              a candidate of its own, and the event is summarized again.
  Labels      constraints recluster_peristiwa keeps: articles confirmed
              together stay together, and an 'out' article never rejoins the
              articles it was judged against.
  evaluate    the clustering replayed over a window with the labels hidden,
              scored against them: how many confirmed pairs it keeps
              together, how many 'out' pairs it keeps apart. Constants can be
              overridden, so a rule change is measured against the curator's
              judgement before it ships, not against Claude's reading.

    python -m jejak.cli cluster-eval 2026-10-01 [--set PERISTIWA_LEX_QUORUM=0.34]
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from itertools import combinations


@dataclass
class Labels:
    # Article -> the articles the curator confirmed it with.
    together: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    # Article -> the articles it must not be grouped with.
    apart: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))
    # A confirmed article -> the event it was confirmed on.
    home: dict[str, int] = field(default_factory=dict)

    def pairs(self) -> tuple[set[frozenset[str]], set[frozenset[str]]]:
        must = {frozenset((a, b)) for a, bs in self.together.items() for b in bs}
        cannot = {frozenset((a, b)) for a, bs in self.apart.items() for b in bs}
        return must, cannot

    def __bool__(self) -> bool:
        return bool(self.together or self.apart)


def load(conn: sqlite3.Connection) -> Labels:
    """The curator's labels as pairs, for articles that still exist."""
    labels = Labels()
    rows = conn.execute(
        """SELECT l.article_id, l.event_id, l.verdict, l.anchor_id FROM cluster_labels l
             JOIN articles a ON a.id = l.article_id
            ORDER BY l.decided_at""").fetchall()
    confirmed: dict[int, set[str]] = defaultdict(set)
    for r in rows:
        if r["verdict"] == "in":
            confirmed[r["event_id"]].add(r["article_id"])
            labels.home[r["article_id"]] = r["event_id"]
    for group in confirmed.values():
        for a, b in combinations(sorted(group), 2):
            labels.together[a].add(b)
            labels.together[b].add(a)
    exists = {r["id"] for r in conn.execute("SELECT id FROM articles")} if rows else set()
    for r in rows:
        if r["verdict"] != "out":
            continue
        against = set(confirmed.get(r["event_id"], ()))
        if r["anchor_id"] and r["anchor_id"] in exists:
            against.add(r["anchor_id"])
        against.discard(r["article_id"])
        for b in against:
            labels.apart[r["article_id"]].add(b)
            labels.apart[b].add(r["article_id"])
    return labels


def apply_out(conn: sqlite3.Connection) -> int:
    """Move every 'out' article still on the event it was judged on into a
    candidate of its own; the event it left is summarized again, and drops
    back to candidate if it no longer has the outlets to be published."""
    from jejak.cluster import PERISTIWA_MIN_OUTLETS, _move_quotes, _reopen_if_summarized

    rows = conn.execute(
        """SELECT l.article_id, l.event_id, a.title, a.published_at FROM cluster_labels l
             JOIN articles a ON a.id = l.article_id AND a.event_id = l.event_id
            WHERE l.verdict = 'out'""").fetchall()
    now = datetime.now(timezone.utc).isoformat()
    left: set[int] = set()
    for r in rows:
        when = r["published_at"] or now
        eid = conn.execute(
            "INSERT INTO events (figure_id, kind, title, event_date, last_seen, event_type, "
            "status, created_at) VALUES (NULL, 'peristiwa', ?, ?, ?, 'other', 'candidate', ?)",
            (r["title"], when, when, now)).lastrowid
        conn.execute("UPDATE articles SET event_id = ? WHERE id = ?", (eid, r["article_id"]))
        _move_quotes(conn, r["article_id"], eid)
        conn.execute("UPDATE cluster_labels SET applied_at = ? WHERE article_id = ? AND event_id = ?",
                     (now, r["article_id"], r["event_id"]))
        left.add(r["event_id"])
    for eid in left:
        _reopen_if_summarized(conn, eid)
        outlets = conn.execute(
            "SELECT count(DISTINCT source) FROM articles WHERE event_id = ?", (eid,)).fetchone()[0]
        if outlets < PERISTIWA_MIN_OUTLETS:
            conn.execute(
                "UPDATE events SET status = 'candidate', impact = NULL "
                "WHERE id = ? AND status IN ('new', 'summarized', 'approved')", (eid,))
        # Related figures and unruled link proposals came from the old mix:
        # promote_peristiwa and link find them again.
        conn.execute("DELETE FROM event_figures WHERE event_id = ?", (eid,))
        conn.execute("DELETE FROM record_links WHERE peristiwa_id = ? AND verdict IS NULL", (eid,))
    conn.commit()
    return len(rows)


def score(members: list[list[str]], labels: Labels) -> dict:
    """How a grouping agrees with the labels, over the pairs it covers."""
    where = {a: i for i, m in enumerate(members) for a in m}
    must, cannot = labels.pairs()
    must = [p for p in must if all(a in where for a in p)]
    cannot = [p for p in cannot if all(a in where for a in p)]
    kept = sum(1 for p in must if len({where[a] for a in p}) == 1)
    apart = sum(1 for p in cannot if len({where[a] for a in p}) == 2)
    return {
        "together_pairs": len(must), "kept_together": kept,
        "apart_pairs": len(cannot), "kept_apart": apart,
        "together_rate": round(kept / len(must), 3) if must else None,
        "apart_rate": round(apart / len(cannot), 3) if cannot else None,
    }


def evaluate(conn: sqlite3.Connection, since: str, overrides: dict[str, float] | None = None) -> dict:
    """Replay recluster_peristiwa's grouping from `since` with the labels
    hidden, under `overrides` of jejak.cluster's constants, and score it.
    Writes nothing but the embedding cache."""
    from jejak import cluster as C

    saved = {k: getattr(C, k) for k in (overrides or {})}
    try:
        for k, v in (overrides or {}).items():
            setattr(C, k, type(saved[k])(v))
        arts = C._peristiwa_articles(conn, since)[1]
        clusters, members = C._regroup(conn, arts, timedelta(days=C.WINDOW_DAYS))
    finally:
        for k, v in saved.items():
            setattr(C, k, v)
    outlets = [len({a["source"] for a in m}) for m in members]
    out = {
        "articles": len(arts), "clusters": len(clusters),
        "published": sum(1 for n in outlets if n >= C.PERISTIWA_MIN_OUTLETS),
        "published_15plus": sum(1 for n, m in zip(outlets, members)
                                if n >= C.PERISTIWA_MIN_OUTLETS and len(m) >= 15),
    }
    labels = load(conn)
    out.update(score([[a["id"] for a in m] for m in members], labels))
    return out
