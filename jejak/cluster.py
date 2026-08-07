"""Stage 2 — Cluster articles into events using hybrid semantic + lexical matching.

Uses sentence-embedding cosine similarity (semantic) plus a content-word overlap
guard (lexical) to prevent false merges. The lexical guard ensures two articles
share concrete entities/topics beyond the tracked figure's name.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import datetime, timedelta, timezone
from functools import lru_cache
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

# A peristiwa (national event, belonging to no tracked figure) has to be
# corroborated by this many distinct outlets before it is published. This is the
# significance filter: general news is ingested in bulk, and independent
# coverage by several outlets is what separates a national event from routine
# filler — without asking a model to judge importance.
PERISTIWA_MIN_OUTLETS = 3
# Peristiwa clustering has no figure to anchor it — a record only ever merges
# articles about the same person — so it is guarded by the seed check in
# cluster() instead. Measured over a live ingest, raising the threshold alone
# made results *worse*: it produced fewer, broader clusters that mixed unrelated
# court cases together, while the seed check is what actually keeps a cluster
# from drifting. Hence a threshold close to the record one, plus that check.
PERISTIWA_THRESHOLD = 0.60
PERISTIWA_MIN_SHARED = 4
# Unpromoted candidates older than this are deleted along with their articles,
# which is what keeps bulk ingestion from growing the database without bound.
CANDIDATE_TTL_DAYS = 14

# Keyword-based event type inference from article text.
_EVENT_TYPE_KEYWORDS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(pidato|berpidato|orasi|pida(to|h))\b", re.I), "Pidato"),
    (re.compile(r"\b(debat|berdebat|debat(us|er)?)\b", re.I), "Debat"),
    (re.compile(r"\b(demonstrasi|demo|unjuk rasa|protes|demo(besaran)?)\b", re.I), "Demonstrasi"),
    (re.compile(r"\b(kebijakan|kebijakan baru|peraturan|regulasi|beleid)\b", re.I), "Kebijakan"),
    (re.compile(r"\b(kunjungan|berkunjung|melawat|lawatan)\b", re.I), "Kunjungan"),
    (re.compile(r"\b(pertemuan|bertemu|rapat|sidang|audiensi)\b", re.I), "Pertemuan"),
    (re.compile(r"\b(wawancara|interviu|interview)\b", re.I), "Wawancara"),
    (re.compile(r"\b(konferensi pers|jumpa pers|press conference)\b", re.I), "Konferensi Pers"),
    (re.compile(r"\b(pernyataan|pernyataan resmi|siaran pers)\b", re.I), "Pernyataan"),
    (re.compile(r"\b(pelantikan|dilantik|pengukuhan|inaugurasi)\b", re.I), "Pelantikan"),
    (re.compile(r"\b(keputusan|putusan|vonis|dakwa|tuntutan)\b", re.I), "Keputusan"),
    (re.compile(r"\b(pemilu|pemilihan|pilkada|pileg|pilpres)\b", re.I), "Pemilu"),
    (re.compile(r"\b(pencalonan|calon|mencalonkan|kandidat)\b", re.I), "Pencalonan"),
    (re.compile(r"\b(pengunduran|mundur|resign|mengundurkan diri)\b", re.I), "Pengunduran Diri"),
]


def _infer_event_type(texts: list[str]) -> str:
    """Infer event type from article texts using keyword matching."""
    combined = " ".join(texts).lower()
    for pattern, etype in _EVENT_TYPE_KEYWORDS:
        if pattern.search(combined):
            return etype
    return "other"


def _figures_mentioned(text: str) -> list[str]:
    """Ids of tracked figures whose name or alias appears in `text`.

    Used to attach *related* figures to a peristiwa. Unlike ingest attribution
    this is not first-match-wins: an event can involve several people, and none
    of them owns it.
    """
    low = text.lower()
    return [
        f.id for f in load_figures()
        if any(term in low for term in f.match_terms())
    ]


@lru_cache(maxsize=1)
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


def _tokens(text: str) -> set[str]:
    # Resolved per call rather than at import: the roster now grows during a
    # run as figures are discovered, and editing figures.toml previously needed
    # a restart to take effect.
    figure_terms = _figure_terms()
    return {
        w for w in (m.group().lower() for m in _TOKEN_RE.finditer(text))
        if len(w) > 2 and w not in _STOP and w not in figure_terms
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
    stats = {"clustered": 0, "new_events": 0, "promoted": 0, "pruned": 0}
    now_iso = datetime.now(timezone.utc).isoformat()
    window = timedelta(days=WINDOW_DAYS)

    rows = conn.execute(
        """SELECT id, figure_id, title, summary, body, published_at
           FROM articles WHERE event_id IS NULL
           ORDER BY published_at"""
    ).fetchall()

    if not rows:
        return stats

    # Cache: (event_id, figure_id, when, mean-embedding, seed-embedding, tokens)
    open_events: list[tuple[int, str, datetime, np.ndarray, np.ndarray, set[str]]] = []
    for ev in conn.execute(
        """SELECT e.id, e.figure_id, e.event_date
           FROM events e
           WHERE e.status IN ('new','summarized','candidate')
           ORDER BY e.event_date"""
    ).fetchall():
        arts = conn.execute(
            "SELECT title, summary, body FROM articles WHERE event_id = ? "
            "ORDER BY published_at",
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
            (ev["id"], ev["figure_id"], _parse(ev["event_date"]), mean_vec,
             vecs[0], all_toks)
        )

    for art in rows:
        txt = _text(art)
        vec = embed(txt)
        toks = _tokens(txt)
        when = _parse(art["published_at"])

        is_general = art["figure_id"] is None
        threshold = PERISTIWA_THRESHOLD if is_general else THRESHOLD
        min_shared = PERISTIWA_MIN_SHARED if is_general else MIN_SHARED

        match_id = None
        best = threshold
        for eid, fig, ewhen, ev_vec, seed_vec, ev_toks in open_events:
            if fig != art["figure_id"]:
                continue
            if abs((when - ewhen).total_seconds()) > window.total_seconds():
                continue
            sim = cosine_similarity(vec, ev_vec)
            shared = len(toks & ev_toks)
            if sim < best or shared < min_shared:
                continue
            # Also require similarity to the cluster's first article. The mean
            # widens with every merge, so matching on it alone lets a cluster
            # drift: each loosely-related article pulls the centroid further out
            # and admits the next one. The seed does not move.
            if is_general and cosine_similarity(vec, seed_vec) < threshold:
                continue
            best, match_id = sim, eid

        if match_id is None:
            art_texts = [txt]
            etype = _infer_event_type(art_texts)
            # A figure-less cluster starts as a peristiwa *candidate*: it stays
            # unpublished until enough distinct outlets corroborate it.
            is_peristiwa = art["figure_id"] is None
            cur = conn.execute(
                "INSERT INTO events "
                "(figure_id, kind, title, event_date, event_type, status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (art["figure_id"],
                 "peristiwa" if is_peristiwa else "record",
                 art["title"], art["published_at"] or now_iso, etype,
                 "candidate" if is_peristiwa else "new",
                 now_iso),
            )
            match_id = cur.lastrowid
            open_events.append((match_id, art["figure_id"], when, vec, vec, toks))
            stats["new_events"] += 1
        else:
            for i, (eid, fig, ewhen, ev_vec, seed_vec, ev_toks) in enumerate(open_events):
                if eid == match_id:
                    n = conn.execute(
                        "SELECT count(*) FROM articles WHERE event_id = ?",
                        (eid,),
                    ).fetchone()[0]
                    updated = (ev_vec * n + vec) / (n + 1)
                    norm = float((updated @ updated) ** 0.5)
                    if norm > 0:
                        updated = updated / norm
                    open_events[i] = (eid, fig, ewhen, updated, seed_vec,
                                      ev_toks | toks)
                    # Re-infer event_type from all article texts in the event
                    art_texts = [a["body"] or a["title"] for a in conn.execute(
                        "SELECT title, body FROM articles WHERE event_id = ?", (eid,)
                    ).fetchall()] + [txt]
                    etype = _infer_event_type(art_texts)
                    conn.execute("UPDATE events SET event_type = ? WHERE id = ?", (etype, eid))
                    break

        conn.execute("UPDATE articles SET event_id = ? WHERE id = ?", (match_id, art["id"]))
        stats["clustered"] += 1

    conn.commit()
    stats["retitled"] = retitle_events(conn)
    stats.update(promote_peristiwa(conn))
    stats["pruned"] = prune_candidates(conn)
    return stats


def retitle_events(conn: sqlite3.Connection) -> int:
    """Re-derive each event's working title from the articles it now holds.

    The title is taken at creation from the first article, and stays frozen
    even after that article leaves — re-attribution moved "Pimpinan MPR Temui
    Prabowo" off Prabowo, yet his event went on displaying that headline. An
    event should never be named by an article it no longer contains.

    Events that have been summarized are skipped: their title is generated in
    the figure's own voice, and copying a source headline back over it would
    undo exactly that.
    """
    changed = 0
    rows = conn.execute(
        """SELECT e.id, e.title,
                  (SELECT a.title FROM articles a
                    WHERE a.event_id = e.id
                    ORDER BY a.published_at LIMIT 1) AS current_title
             FROM events e
            WHERE NOT EXISTS (SELECT 1 FROM event_summaries s
                               WHERE s.event_id = e.id)"""
    ).fetchall()
    for row in rows:
        if row["current_title"] and row["current_title"] != row["title"]:
            conn.execute(
                "UPDATE events SET title = ? WHERE id = ?",
                (row["current_title"], row["id"]),
            )
            changed += 1
    conn.commit()
    return changed


def _impact_for(outlets: int) -> str:
    """Impact tier from breadth of coverage — a proxy, not an editorial call."""
    if outlets >= PERISTIWA_MIN_OUTLETS + 3:
        return "tinggi"
    if outlets >= PERISTIWA_MIN_OUTLETS + 1:
        return "sedang"
    return "rendah"


def promote_peristiwa(conn: sqlite3.Connection) -> dict[str, int]:
    """Publish peristiwa candidates that enough distinct outlets now report.

    Also refreshes impact and related figures, because both change as more
    coverage lands on an already-promoted event.
    """
    stats = {"promoted": 0}
    rows = conn.execute(
        """SELECT e.id, count(DISTINCT a.source) AS outlets
             FROM events e
             JOIN articles a ON a.event_id = e.id
            WHERE e.kind = 'peristiwa' AND e.status IN ('candidate','new','summarized','approved')
            GROUP BY e.id"""
    ).fetchall()

    for row in rows:
        eid, outlets = row["id"], row["outlets"]
        if outlets < PERISTIWA_MIN_OUTLETS:
            continue

        status = conn.execute(
            "SELECT status FROM events WHERE id = ?", (eid,)
        ).fetchone()["status"]
        if status == "candidate":
            conn.execute("UPDATE events SET status = 'new' WHERE id = ?", (eid,))
            stats["promoted"] += 1

        arts = conn.execute(
            "SELECT title, summary, body FROM articles WHERE event_id = ?", (eid,)
        ).fetchall()
        combined = "\n".join(_text(a) for a in arts)
        # Scope is left NULL rather than assumed: "Nasional" only makes sense
        # for national politics, and the model has to fit any public figure —
        # a university seminar is not a national event.
        conn.execute(
            "UPDATE events SET impact = ? WHERE id = ?", (_impact_for(outlets), eid)
        )
        for fid in _figures_mentioned(combined):
            conn.execute(
                "INSERT OR IGNORE INTO event_figures (event_id, figure_id) VALUES (?, ?)",
                (eid, fid),
            )

    conn.commit()
    return stats


def prune_candidates(conn: sqlite3.Connection) -> int:
    """Delete stale peristiwa candidates and the general articles under them.

    Bulk ingestion means most figure-less articles never corroborate into
    anything. Once a candidate is older than the clustering window it will never
    gain more coverage, so it is dropped rather than kept forever.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CANDIDATE_TTL_DAYS)).isoformat()
    stale = [r["id"] for r in conn.execute(
        "SELECT id FROM events WHERE kind = 'peristiwa' AND status = 'candidate' "
        "AND created_at < ?",
        (cutoff,),
    ).fetchall()]
    if not stale:
        return 0
    marks = ",".join("?" * len(stale))
    conn.execute(f"DELETE FROM articles WHERE event_id IN ({marks})", stale)
    conn.execute(f"DELETE FROM event_figures WHERE event_id IN ({marks})", stale)
    conn.execute(f"DELETE FROM events WHERE id IN ({marks})", stale)
    conn.commit()
    return len(stale)


def _parse(ts: str | None) -> datetime:
    """Parse a stored timestamp, always returning an aware UTC datetime.

    Article dates come from RSS (aware) but event_date can be a bare date, and
    subtracting a naive from an aware datetime raises — which would abort a
    whole cluster run on one malformed feed entry.
    """
    if not ts:
        return datetime.now(timezone.utc)
    try:
        parsed = datetime.fromisoformat(ts)
    except ValueError:
        return datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)
