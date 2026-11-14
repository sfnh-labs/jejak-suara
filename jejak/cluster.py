"""Stage 2 — Cluster articles into events using hybrid semantic + lexical matching.

Uses sentence-embedding cosine similarity (semantic) plus a content-word overlap
guard (lexical) to prevent false merges. The lexical guard ensures two articles
share concrete entities/topics beyond the tracked figure's name.
"""
from __future__ import annotations

import hashlib
import math
import re
import sqlite3
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from functools import lru_cache
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np

from .embed import MODEL_NAME, cosine_similarity, embed
from .config import load_figures

_STOP = {
    "yang", "dan", "di", "ke", "dari", "untuk", "dengan", "pada", "ini", "itu",
    "akan", "ada", "atau", "juga", "tidak", "dalam", "sebagai", "oleh", "para",
    "the", "a", "an", "of", "to", "in", "on", "for", "and", "is", "are",
}
_TOKEN_RE = re.compile(r"[a-zA-ZÀ-ɏ]+")

WINDOW_DAYS = 7
# Records get a tighter window than peristiwa. A tracked figure acts most days,
# and over seven days their coverage is similar enough — same person, same
# office, same beat vocabulary — that a fresh action kept landing in a week-old
# cluster instead of starting its own: for four straight days every attributed
# article merged and not one new record was created. A national event's coverage
# genuinely runs for a week; one person's Tuesday is not their Saturday.
RECORD_WINDOW_DAYS = 3
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
# The seed check was not enough either. This model scores any two pieces of
# Indonesian political news around 0.6, so a short, generic seed ("Dirut KAI
# Menghadap Prabowo ke Istana") cleared it for half a week's politics, and the
# shared-word check compared against every word the cluster had collected,
# which a 30-article cluster passes for anything. One peristiwa held a KAI
# meeting, hero awards, a wiretap hearing and Gibran's volunteers.
#
# So a peristiwa article also has to sit with the cluster's articles: its
# median similarity to them at least PERISTIWA_MEDIAN_SIM, its words shared
# with the article it is closest to, and enough rare words in common with
# some member (PERISTIWA_MIN_LEX, cosine over IDF-weighted word sets).
# Replayed over six weeks of general news (Oct–Nov 2026), loose clusters fell
# from 105 of 365 published with 15+ articles to clusters that each read as
# one story; 0.06 still let a 48-article Jakarta grab-bag form, 0.15 split
# real stories apart.
PERISTIWA_MEDIAN_SIM = 0.58
PERISTIWA_MIN_LEX = 0.09
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
    return [f.id for f in load_figures() if f.first_named_at(text) is not None]


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


class _Idf:
    """Word rarity over the articles at hand, for comparing word sets."""

    def __init__(self, token_sets) -> None:
        self.df: Counter[str] = Counter()
        self.n = 0
        for toks in token_sets:
            self.df.update(toks)
            self.n += 1

    def weight(self, w: str) -> float:
        return math.log((self.n + 1) / (self.df.get(w, 0) + 1))

    def norm(self, toks: set[str]) -> float:
        return math.sqrt(sum(self.weight(w) ** 2 for w in toks)) or 1.0

    def cosine(self, a: set[str], b: set[str]) -> float:
        shared = sum(self.weight(w) ** 2 for w in a & b)
        return shared / (self.norm(a) * self.norm(b)) if shared else 0.0


@dataclass
class _Open:
    """An event open for matching, as cluster() holds it."""
    event_id: int
    figure_id: str | None
    when: datetime
    mean: "np.ndarray"
    seed: "np.ndarray"
    toks: set[str]
    # Each article's unit vector and words, for the peristiwa checks.
    members: list[tuple["np.ndarray", set[str]]] = field(default_factory=list)

    def add(self, vec, toks: set[str]) -> None:
        import numpy as np

        n = len(self.members)
        updated = (self.mean * n + vec) / (n + 1) if n else vec
        norm = float(np.linalg.norm(updated))
        self.mean = updated / norm if norm > 0 else updated
        self.toks |= toks
        self.members.append((_unit(vec), toks))


def _unit(vec):
    import numpy as np

    v = np.asarray(vec, dtype=np.float32)
    norm = float(np.linalg.norm(v))
    return v / norm if norm > 0 else v


def _sits_with(ev: _Open, vec, toks: set[str], idf: _Idf) -> bool:
    """A peristiwa article fits with the cluster's articles, not only its average."""
    import numpy as np

    sims = np.stack([m for m, _ in ev.members]) @ _unit(vec)
    if float(np.median(sims)) < PERISTIWA_MEDIAN_SIM:
        return False
    nearest = ev.members[int(np.argmax(sims))][1]
    if len(toks & nearest) < PERISTIWA_MIN_SHARED:
        return False
    return max(idf.cosine(toks, t) for _, t in ev.members) >= PERISTIWA_MIN_LEX


def _best_event(open_events: list[_Open], vec, toks: set[str], when: datetime,
                figure_id: str | None, window: timedelta, idf: _Idf) -> _Open | None:
    """The open event an article belongs to, or None for a new one."""
    is_general = figure_id is None
    threshold = PERISTIWA_THRESHOLD if is_general else THRESHOLD
    min_shared = PERISTIWA_MIN_SHARED if is_general else MIN_SHARED
    match, best = None, threshold
    for ev in open_events:
        if ev.figure_id != figure_id:
            continue
        if abs((when - ev.when).total_seconds()) > window.total_seconds():
            continue
        sim = cosine_similarity(vec, ev.mean)
        if sim < best or len(toks & ev.toks) < min_shared:
            continue
        # Also require similarity to the cluster's first article. The mean
        # widens with every merge, so matching on it alone lets a cluster
        # drift: each loosely-related article pulls the centroid further out
        # and admits the next one. The seed does not move.
        #
        # This was once applied to peristiwa only, on the reasoning that a
        # record is already anchored by its figure. It is not: the figure
        # only decides *whose* event it is, not which one, and a tracked
        # figure appears in everything an outlet writes about the
        # government. Left unguarded, one record grew to 131 articles
        # spanning every story of the week the figure was named in.
        if cosine_similarity(vec, ev.seed) < threshold:
            continue
        if is_general and not _sits_with(ev, vec, toks, idf):
            continue
        best, match = sim, ev
    return match


def _embed_article(conn: sqlite3.Connection, article_id: str, txt: str):
    """An article's embedding, from the local cache when its text is unchanged.

    Matching needs a vector for every article of every open event, which is
    nearly the whole database; encoding them all afresh made this stage take
    most of an hour each run. The hash covers the model and the text, so a
    fetched body, a translation or a model change re-encodes just that article.
    """
    import numpy as np

    key = hashlib.sha1(f"{MODEL_NAME}\n{txt}".encode("utf-8")).hexdigest()
    row = conn.execute(
        "SELECT text_hash, vec FROM article_embeddings WHERE article_id = ?",
        (article_id,),
    ).fetchone()
    if row and row["text_hash"] == key:
        return np.frombuffer(row["vec"], dtype=np.float32)
    vec = np.asarray(embed(txt), dtype=np.float32)
    conn.execute(
        "INSERT OR REPLACE INTO article_embeddings (article_id, text_hash, vec) "
        "VALUES (?, ?, ?)",
        (article_id, key, vec.tobytes()),
    )
    return vec


def cluster(conn: sqlite3.Connection) -> dict[str, int]:
    """Assign every unclustered article to a new or existing event.

    Uses hybrid matching: cosine similarity on sentence embeddings + a guard of
    MIN_SHARED content words (excluding figure names) to avoid false merges.
    """
    stats = {"clustered": 0, "new_events": 0, "promoted": 0, "pruned": 0,
             "derived_dropped": 0}
    now_iso = datetime.now(timezone.utc).isoformat()
    peristiwa_window = timedelta(days=WINDOW_DAYS)
    record_window = timedelta(days=RECORD_WINDOW_DAYS)

    rows = conn.execute(
        """SELECT id, figure_id, title, summary, body, published_at, derived_mode
           FROM articles WHERE event_id IS NULL
           ORDER BY published_at"""
    ).fetchall()

    if not rows:
        return stats

    open_events: list[_Open] = []
    # 'approved' events are open for matching too. Coverage no longer arrives
    # in order: the archive backfill walks history backwards, so an article
    # about an event that was summarized last week can land today. Excluding
    # summarized events made every late arrival mint a duplicate of an event
    # already on the timeline.
    for ev in conn.execute(
        """SELECT e.id, e.figure_id, e.event_date
           FROM events e
           WHERE e.status IN ('new','summarized','candidate','approved')
           ORDER BY e.event_date"""
    ).fetchall():
        arts = conn.execute(
            "SELECT id, title, summary, body FROM articles WHERE event_id = ? "
            "ORDER BY published_at",
            (ev["id"],),
        ).fetchall()
        if not arts:
            continue
        first = None
        for a in arts:
            txt = _text(a)
            vec = _embed_article(conn, a["id"], txt)
            if first is None:
                first = _Open(ev["id"], ev["figure_id"], _parse(ev["event_date"]),
                              _unit(vec), vec, set())
            first.add(vec, _tokens(txt))
        open_events.append(first)

    texts = {art["id"]: _text(art) for art in rows}
    # Rarity among general news, which is what peristiwa are matched in: a
    # figure's beat words are common in their records and rare elsewhere.
    idf = _Idf([t for ev in open_events if ev.figure_id is None for _, t in ev.members]
               + [_tokens(texts[a["id"]]) for a in rows if a["figure_id"] is None])
    for art in rows:
        txt = texts[art["id"]]
        vec = _embed_article(conn, art["id"], txt)
        toks = _tokens(txt)
        when = _parse(art["published_at"])

        is_general = art["figure_id"] is None
        window = peristiwa_window if is_general else record_window
        # A recalled statement (jejak/actors.py) is dated by the article that
        # recalls it, so the record it belongs to can be a few days older.
        join_only = art["derived_mode"] == "join"
        if join_only:
            window = peristiwa_window

        hit = _best_event(open_events, vec, toks, when, art["figure_id"], window, idf)
        match_id = hit.event_id if hit else None

        if match_id is None and join_only:
            # Nothing of theirs to join: a new record would carry the wrong date.
            conn.execute("DELETE FROM article_embeddings WHERE article_id = ?", (art["id"],))
            conn.execute("DELETE FROM article_scans WHERE article_id = ?", (art["id"],))
            conn.execute("DELETE FROM articles WHERE id = ?", (art["id"],))
            stats["derived_dropped"] += 1
            continue

        if match_id is None:
            art_texts = [txt]
            etype = _infer_event_type(art_texts)
            # A figure-less cluster starts as a peristiwa *candidate*: it stays
            # unpublished until enough distinct outlets corroborate it.
            is_peristiwa = art["figure_id"] is None
            cur = conn.execute(
                "INSERT INTO events "
                "(figure_id, kind, title, event_date, last_seen, event_type, "
                " status, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (art["figure_id"],
                 "peristiwa" if is_peristiwa else "record",
                 art["title"], art["published_at"] or now_iso,
                 art["published_at"] or now_iso, etype,
                 "candidate" if is_peristiwa else "new",
                 now_iso),
            )
            match_id = cur.lastrowid
            fresh = _Open(match_id, art["figure_id"], when, _unit(vec), vec, set())
            fresh.add(vec, toks)
            open_events.append(fresh)
            stats["new_events"] += 1
        else:
            hit.add(vec, toks)
            # Re-infer event_type from all article texts in the event
            art_texts = [a["body"] or a["title"] for a in conn.execute(
                "SELECT title, body FROM articles WHERE event_id = ?", (match_id,)
            ).fetchall()] + [txt]
            etype = _infer_event_type(art_texts)
            # event_date stays put — it is when the thing happened —
            # while last_seen follows the coverage, so an event that is
            # still being written about resurfaces on the timeline.
            conn.execute(
                "UPDATE events SET event_type = ?, "
                "last_seen = max(coalesce(last_seen, ''), ?) WHERE id = ?",
                (etype, art["published_at"] or now_iso, match_id),
            )
            _reopen_if_summarized(conn, match_id)

        conn.execute("UPDATE articles SET event_id = ? WHERE id = ?", (match_id, art["id"]))
        stats["clustered"] += 1

    conn.commit()
    stats["retitled"] = retitle_events(conn)
    stats.update(promote_peristiwa(conn))
    stats["pruned"] = prune_candidates(conn)
    return stats


def _reopen_if_summarized(conn: sqlite3.Connection, event_id: int) -> None:
    """Send an event back through summarize after it gains a new article.

    A summary is grounded in the articles the event held when it was written,
    and its corroboration count is taken from them. Once backfill adds an
    outlet that was missing, both are stale — and the corroboration count is
    what the single-source badge is derived from, so leaving it is worse than
    the extra model call.

    Candidates are left alone: they have no summary to invalidate, and the
    corroboration gate in promote_peristiwa decides when they get one.
    """
    row = conn.execute(
        "SELECT status FROM events WHERE id = ?", (event_id,)
    ).fetchone()
    if row is None or row["status"] not in ("summarized", "approved"):
        return
    conn.execute("DELETE FROM event_summaries WHERE event_id = ?", (event_id,))
    conn.execute("UPDATE events SET status = 'new' WHERE id = ?", (event_id,))


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
        # A figure a curator struck from this event stays struck: the alias
        # that matched is still in the coverage and would match again.
        struck = {r["figure_id"] for r in conn.execute(
            "SELECT figure_id FROM event_figure_rejections WHERE event_id = ?",
            (eid,),
        )}
        for fid in _figures_mentioned(combined):
            if fid in struck:
                continue
            conn.execute(
                "INSERT OR IGNORE INTO event_figures (event_id, figure_id) VALUES (?, ?)",
                (eid, fid),
            )

    conn.commit()
    return stats


# What can point at an event besides its articles: (table, column).
_EVENT_REFS = (
    ("event_quotes", "event_id"), ("event_summaries", "event_id"), ("sentiment", "event_id"),
    ("buzzer_signals", "event_id"), ("corrections", "event_id"), ("record_figures", "event_id"),
    ("record_links", "peristiwa_id"), ("followup_links", "earlier_id"), ("followup_links", "later_id"),
    ("curation_points", "event_id"), ("curation_labels", "event_id"),
)


def prune_candidates(conn: sqlite3.Connection) -> int:
    """Delete stale peristiwa candidates and the general articles under them.

    Bulk ingestion means most figure-less articles never corroborate into
    anything. Once a candidate is older than the clustering window it will never
    gain more coverage, so it is dropped rather than kept forever.

    An article someone was named in is kept: figure_mentions points at it as
    the evidence for promoting that person, and promotion counts outlets with
    no time limit. Its candidate becomes 'expired' rather than deleted, since
    the article still needs an event_id that exists, and an orphaned NULL one
    would be re-clustered into a fresh candidate every cycle.
    """
    cutoff = (datetime.now(timezone.utc) - timedelta(days=CANDIDATE_TTL_DAYS)).isoformat()
    stale = [r["id"] for r in conn.execute(
        "SELECT id FROM events WHERE kind = 'peristiwa' AND status = 'candidate' "
        "AND created_at < ?",
        (cutoff,),
    ).fetchall()]
    if not stale:
        return 0
    # One that was published once (recluster_peristiwa puts those back to
    # candidate) has quotes, points, links or a verdict pointing at it: it
    # expires whole, articles and all, rather than being deleted from under them.
    marks = ",".join("?" * len(stale))
    used = " OR ".join(f"EXISTS (SELECT 1 FROM {t} x WHERE x.{c} = e.id)" for t, c in _EVENT_REFS)
    kept = [r["id"] for r in conn.execute(
        f"SELECT id FROM events e WHERE id IN ({marks}) AND (curated IS NOT NULL OR {used})", stale)]
    conn.executemany("UPDATE events SET status = 'expired' WHERE id = ?", [(i,) for i in kept])
    stale = [i for i in stale if i not in set(kept)]
    if not stale:
        conn.commit()
        return len(kept)
    marks = ",".join("?" * len(stale))
    doomed = (f"SELECT id FROM articles WHERE event_id IN ({marks}) AND id NOT IN "
              "(SELECT article_id FROM figure_mentions)")
    conn.execute(f"DELETE FROM article_scans WHERE article_id IN ({doomed})", stale)
    conn.execute(f"DELETE FROM articles WHERE id IN ({doomed})", stale)
    conn.execute(
        f"UPDATE events SET status = 'expired' WHERE id IN ({marks}) "
        "AND id IN (SELECT event_id FROM articles)", stale)
    empty = f"SELECT id FROM events WHERE id IN ({marks}) AND status = 'candidate'"
    conn.execute(f"DELETE FROM event_figures WHERE event_id IN ({empty})", stale)
    conn.execute(f"DELETE FROM events WHERE id IN ({empty})", stale)
    conn.commit()
    return len(stale) + len(kept)


def _move_quotes(conn: sqlite3.Connection, article_id: str, event_id: int) -> None:
    """An article's quotes follow it to `event_id`. Where the event already
    holds the same words from another outlet, the two become one quote: the
    curator's speaker and their rulings on whom it is about are kept, and the
    duplicate goes (its open points are settled at the next points run)."""
    for q in conn.execute(
        "SELECT id, quote, speaker, figure_id, assigned_by FROM event_quotes "
        "WHERE article_id = ? AND event_id <> ?", (article_id, event_id)).fetchall():
        keep = conn.execute(
            "SELECT id, assigned_by FROM event_quotes WHERE event_id = ? AND quote = ?",
            (event_id, q["quote"])).fetchone()
        if keep is None:
            conn.execute("UPDATE event_quotes SET event_id = ? WHERE id = ?", (event_id, q["id"]))
            continue
        if q["assigned_by"] == "curator" and keep["assigned_by"] != "curator":
            conn.execute(
                "UPDATE event_quotes SET speaker = ?, figure_id = ?, assigned_by = 'curator' WHERE id = ?",
                (q["speaker"], q["figure_id"], keep["id"]))
        conn.execute(
            """INSERT INTO quote_subjects (quote_id, figure_id, status, band, assigned_by, created_at)
               SELECT ?, figure_id, status, band, assigned_by, created_at
                 FROM quote_subjects WHERE quote_id = ? AND status <> 'auto'
               ON CONFLICT (quote_id, figure_id) DO UPDATE
                  SET status = excluded.status, assigned_by = excluded.assigned_by
                WHERE quote_subjects.status = 'auto'""", (keep["id"], q["id"]))
        conn.execute("DELETE FROM event_quotes WHERE id = ?", (q["id"],))


def recluster_peristiwa(conn: sqlite3.Connection, since: str, apply: bool = False) -> dict:
    """Cluster again, under the current rules, the general articles of the
    peristiwa dated `since` or later: the repair for peristiwa that drifted
    before _sits_with existed.

    An event keeps its id where most of its articles stay together, so a
    curator's verdict, its record links and its illustration stay with the
    story they were about. A cluster that took no event's majority becomes a
    new candidate; an event left with no articles is 'dissolved' — kept for
    whatever still points at it, never published or matched again. Every
    event whose articles changed is sent back through summarize, loses its
    automatic related figures (promote_peristiwa finds them again) and its
    unruled record-link proposals (link proposes again); fewer than
    PERISTIWA_MIN_OUTLETS outlets puts it back to candidate.

    Without `apply` nothing is written: the counts say what it would do.
    """
    statuses = ("candidate", "new", "summarized", "approved")
    marks = ",".join("?" * len(statuses))
    old_events = {r["id"]: r for r in conn.execute(
        f"""SELECT id, status, curated FROM events
             WHERE kind = 'peristiwa' AND event_date >= ? AND status IN ({marks})""",
        (since, *statuses))}
    if not old_events:
        return {"events": 0}
    ids = ",".join(str(i) for i in old_events)
    arts = conn.execute(
        f"""SELECT id, source, title, summary, body, published_at, event_id FROM articles
             WHERE event_id IN ({ids}) AND figure_id IS NULL
             ORDER BY published_at, id""").fetchall()
    texts = {a["id"]: _text(a) for a in arts}
    toks = {a["id"]: _tokens(texts[a["id"]]) for a in arts}
    idf = _Idf(toks.values())
    window = timedelta(days=WINDOW_DAYS)

    clusters: list[_Open] = []
    members: list[list[sqlite3.Row]] = []
    for a in arts:
        vec = _embed_article(conn, a["id"], texts[a["id"]])
        when = _parse(a["published_at"])
        hit = _best_event(clusters, vec, toks[a["id"]], when, None, window, idf)
        if hit is None:
            hit = _Open(len(clusters), None, when, _unit(vec), vec, set())
            clusters.append(hit)
            members.append([])
        hit.add(vec, toks[a["id"]])
        members[hit.event_id].append(a)

    # Ids go to the biggest clusters first, each to the event most of its
    # articles came from.
    taken: dict[int, int] = {}
    order = sorted(range(len(clusters)), key=lambda i: -len(members[i]))
    for i in order:
        for eid, _ in Counter(a["event_id"] for a in members[i]).most_common():
            if eid not in taken.values():
                taken[i] = eid
                break
    outlets = [len({a["source"] for a in m}) for m in members]
    stats = {
        "events": len(old_events),
        "published_before": sum(1 for e in old_events.values() if e["status"] != "candidate"),
        "clusters": len(clusters),
        "published_after": sum(1 for n in outlets if n >= PERISTIWA_MIN_OUTLETS),
        "kept": len(taken),
        "new": len(clusters) - len(taken),
        "dissolved": len(set(old_events) - set(taken.values())),
        "articles": len(arts),
        "moved": sum(1 for i, m in enumerate(members) for a in m if a["event_id"] != taken.get(i)),
    }
    # Changed: any article came from elsewhere, or any of the event's left.
    held = Counter(a["event_id"] for a in arts)
    changed = {i for i, m in enumerate(members)
               if i not in taken or any(a["event_id"] != taken[i] for a in m)
               or len(m) != held[taken[i]]}
    stats["changed"] = len(changed)
    gone = set(old_events) - set(taken.values())
    stats["dissolved_curated"] = sum(1 for e in gone if old_events[e]["curated"])
    stats["dissolved_confirmed_links"] = conn.execute(
        f"SELECT count(*) FROM record_links WHERE verdict IS NOT NULL AND peristiwa_id IN ({','.join(map(str, gone)) or 'NULL'})"
    ).fetchone()[0]
    if not apply:
        return stats

    now = datetime.now(timezone.utc).isoformat()
    for i in changed:
        m = members[i]
        if i in taken:
            eid = taken[i]
        else:
            eid = conn.execute(
                "INSERT INTO events (figure_id, kind, title, event_date, last_seen, event_type, "
                "status, created_at) VALUES (NULL, 'peristiwa', ?, ?, ?, 'other', 'candidate', ?)",
                (m[0]["title"], m[0]["published_at"] or now, m[-1]["published_at"] or now, now),
            ).lastrowid
        conn.executemany("UPDATE articles SET event_id = ? WHERE id = ?", [(eid, a["id"]) for a in m])
        for a in m:
            _move_quotes(conn, a["id"], eid)
        _reopen_if_summarized(conn, eid)
        conn.execute(
            "UPDATE events SET event_date = ?, last_seen = ?, event_type = ? WHERE id = ?",
            (m[0]["published_at"] or now, m[-1]["published_at"] or now,
             _infer_event_type([a["body"] or a["title"] for a in m]), eid))
        if outlets[i] < PERISTIWA_MIN_OUTLETS:
            # Past the matching window it can gain no more outlets: expired,
            # as prune_candidates would leave it, rather than a candidate.
            ended = _parse(m[-1]["published_at"]) < datetime.now(timezone.utc) - window
            conn.execute("UPDATE events SET status = ?, impact = NULL WHERE id = ?",
                         ("expired" if ended else "candidate", eid))
        conn.execute("DELETE FROM event_figures WHERE event_id = ?", (eid,))
        conn.execute("DELETE FROM record_links WHERE peristiwa_id = ? AND verdict IS NULL", (eid,))
    for eid in gone:
        conn.execute("UPDATE events SET status = 'dissolved' WHERE id = ?", (eid,))
        conn.execute("DELETE FROM event_summaries WHERE event_id = ?", (eid,))
        conn.execute("DELETE FROM event_figures WHERE event_id = ?", (eid,))
        conn.execute("DELETE FROM record_links WHERE peristiwa_id = ? AND verdict IS NULL", (eid,))
    conn.commit()
    stats.update(promote_peristiwa(conn))
    stats["retitled"] = retitle_events(conn)
    return stats


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
