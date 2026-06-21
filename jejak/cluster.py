"""Stage 2 — Cluster articles into events using hybrid semantic + lexical matching.

Uses sentence-embedding cosine similarity (semantic) plus a content-word overlap
guard (lexical) to prevent false merges. The lexical guard ensures two articles
share concrete entities/topics beyond the tracked figure's name.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

from .embed import cosine_similarity, embed
from .config import load_figures

_STOP = {
    "yang", "dan", "di", "ke", "dari", "untuk", "dengan", "pada", "ini", "itu",
    "akan", "ada", "atau", "juga", "tidak", "dalam", "sebagai", "oleh", "para",
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "is", "are",
}
_TOKEN_RE = re.compile(r"[a-zA-ZÀ-ɏ]+")

WINDOW_DAYS = 7
THRESHOLD = 0.58
MIN_SHARED = 3


def _figure_terms() -> set[str]:
    """All figure name/alias tokens (lowered) to exclude from overlap checks."""
    terms: set[str] = set()
    for f in load_figures():
        for t in [f.name, *f.aliases]:
            if t.strip():
                for m in _TOKEN_RE.finditer(t.lower()):
                    w = m.group()
                    if len(w) > 2 and w not in _STOP:
                        terms.add(w)
    return terms


_FIGURE_TERMS = _figure_terms()


def _tokens(text: str) -> set[str]:
    return {
        w for w in (m.group().lower() for m in _TOKEN_RE.finditer(text))
        if len(w) > 2 and w not in _STOP and w not in _FIGURE_TERMS
    }


def _text(article: dict | sqlite3.Row) -> str:
    parts = [article["title"]]
    if article["summary"]:
        parts.append(article["summary"])
    if article["body"]:
        parts.append(article["body"])
    return "\n".join(parts)


def cluster(conn: sqlite3.Connection) -> dict[str, int]:
    """Assign every unclustered article to a new or existing event.

    Uses hybrid matching: cosine similarity on sentence embeddings + a guard of
    MIN_SHARED content words (excluding figure names) to avoid false merges.
    """
    stats = {"clustered": 0, "new_events": 0}
    now_iso = datetime.now(timezone.utc).isoformat()
    window = timedelta(days=WINDOW_DAYS)

    rows = conn.execute(
        """SELECT id, figure_id, title, summary, body, published_at
           FROM articles WHERE event_id IS NULL
           ORDER BY published_at"""
    ).fetchall()

    if not rows:
        return stats

    # Cache: (event_id, figure_id, when, mean-embedding, content-tokens)
    open_events: list[tuple[int, str, datetime, np.ndarray, set[str]]] = []
    for ev in conn.execute(
        """SELECT e.id, e.figure_id, e.event_date
           FROM events e
           WHERE e.status IN ('new','summarized')
           ORDER BY e.event_date"""
    ).fetchall():
        arts = conn.execute(
            "SELECT title, summary, body FROM articles WHERE event_id = ?",
            (ev["id"],),
        ).fetchall()
        if not arts:
            continue
        all_toks: set[str] = set()
        vecs = []
        for a in arts:
            txt = _text(a)
            all_toks |= _tokens(txt)
            vecs.append(embed(txt))
        mean_vec = sum(vecs[1:], vecs[0]) / len(vecs)
        norm = float((mean_vec @ mean_vec) ** 0.5)
        if norm > 0:
            mean_vec = mean_vec / norm
        open_events.append(
            (ev["id"], ev["figure_id"], _parse(ev["event_date"]), mean_vec, all_toks)
        )

    for art in rows:
        txt = _text(art)
        vec = embed(txt)
        toks = _tokens(txt)
        when = _parse(art["published_at"])

        match_id = None
        best = THRESHOLD
        for eid, fig, ewhen, ev_vec, ev_toks in open_events:
            if fig != art["figure_id"]:
                continue
            if abs((when - ewhen).total_seconds()) > window.total_seconds():
                continue
            sim = cosine_similarity(vec, ev_vec)
            shared = len(toks & ev_toks)
            if sim >= best and shared >= MIN_SHARED:
                best, match_id = sim, eid

        if match_id is None:
            cur = conn.execute(
                "INSERT INTO events (figure_id, title, event_date, status, created_at) "
                "VALUES (?, ?, ?, 'new', ?)",
                (art["figure_id"], art["title"], art["published_at"] or now_iso, now_iso),
            )
            match_id = cur.lastrowid
            open_events.append((match_id, art["figure_id"], when, vec, toks))
            stats["new_events"] += 1
        else:
            for i, (eid, fig, ewhen, ev_vec, ev_toks) in enumerate(open_events):
                if eid == match_id:
                    n = conn.execute(
                        "SELECT count(*) FROM articles WHERE event_id = ?",
                        (eid,),
                    ).fetchone()[0]
                    updated = (ev_vec * n + vec) / (n + 1)
                    norm = float((updated @ updated) ** 0.5)
                    if norm > 0:
                        updated = updated / norm
                    open_events[i] = (eid, fig, ewhen, updated, ev_toks | toks)
                    break

        conn.execute("UPDATE articles SET event_id = ? WHERE id = ?", (match_id, art["id"]))
        stats["clustered"] += 1

    conn.commit()
    return stats


def _parse(ts: str | None) -> datetime:
    if not ts:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(ts)
    except ValueError:
        return datetime.now(timezone.utc)
