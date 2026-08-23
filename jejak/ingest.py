"""Stage 1 — Ingest.

Pull articles from configured RSS feeds, attribute each to a tracked figure by
alias match, and store (deduped by URL hash). No AI here; this is plumbing.
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
from datetime import datetime, timezone
from time import mktime

import feedparser

from . import mentions
from .config import Figure, Source, load_figures, load_sources


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hash_url(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _published_iso(entry) -> str | None:
    tm = getattr(entry, "published_parsed", None) or getattr(entry, "updated_parsed", None)
    if tm:
        return datetime.fromtimestamp(mktime(tm), tz=timezone.utc).isoformat()
    return None


# A headline opening "Nama Orang:" attributes the quote that follows to them.
_SPEAKER_RE = re.compile(r"^([A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*){0,2})\s*:")


def _first_alias_at(text: str, figures: list[Figure]) -> tuple[int, Figure | None]:
    """Earliest position at which any tracked figure is named, and who."""
    low = text.lower()
    best, who = len(low) + 1, None
    for fig in figures:
        for term in fig.match_terms():
            pos = low.find(term)
            if 0 <= pos < best:
                best, who = pos, fig
    return best, who


def _attribute(text: str, figures: list[Figure]) -> Figure | None:
    """The figure an article is *about* — the one acting, not merely named.

    A record on someone's page has to be their own conduct or words. Matching
    any mention anywhere put half of Prabowo's timeline on other people's
    doings: "Pimpinan MPR Temui Prabowo" is the MPR's action, and
    "Ketua DPN Tani Merdeka Tantang Para Pembenci Prabowo" is that chairman's.

    Indonesian headlines lead with the actor, so the subject is whoever is named
    first. If a titled office-holder appears ahead of the tracked figure, the
    article belongs to them — they become a candidate figure in their own right
    and the tracked figure is only referenced.
    """
    # Only the headline decides authorship. A name appearing further down is
    # context, not a claim that the article is about that person.
    headline = text.split("\n", 1)[0]
    alias_at, figure = _first_alias_at(headline, figures)
    if figure is None:
        return None

    actor_at = mentions.first_title_position(headline)
    if actor_at is not None and actor_at < alias_at:
        return None

    # "Cak Imin: Prabowo sedang..." — a headline that opens by attributing a
    # quote belongs to the speaker, even when they carry no office title.
    speaker = _SPEAKER_RE.match(headline)
    if speaker and speaker.end(1) <= alias_at:
        said_by = speaker.group(1).lower()
        if not any(term in said_by for term in figure.match_terms()):
            return None
    return figure


def reattribute(conn: sqlite3.Connection,
                figures: list[Figure] | None = None,
                only_unclustered: bool = False,
                gains_only: bool = False) -> dict[str, int]:
    """Re-apply subject attribution to articles already stored.

    Needed whenever the attribution rule or the tracked roster changes. An
    article that changes hands is unclustered so the next cluster run rebuilds
    the affected events from the corrected ownership.

    `only_unclustered` restricts the pass to articles that have not been
    clustered yet. That is the safe form, and the one the pipeline runs after
    promoting newly discovered figures: a freshly promoted figure should own
    the articles about to be clustered, but rebuilding events that already
    exist would delete the summaries written for them.

    `gains_only` keeps the articles that would lose their owner where they are.
    The two things a full pass does are not symmetric: giving history to newly
    discovered figures adds records, while dropping articles the attribution
    rule no longer claims takes apart timelines that are already published —
    on this database, 463 detachments against 105 gains. This mode does the
    first without the second, so the roster can be applied to history and the
    consequences of a rule change stay a separate decision.
    """
    figures = figures or load_figures(conn)
    stats = {"checked": 0, "changed": 0, "kept": 0, "events_removed": 0}

    query = "SELECT id, figure_id, title FROM articles"
    if only_unclustered:
        query += " WHERE event_id IS NULL"
    for art in conn.execute(query).fetchall():
        stats["checked"] += 1
        subject = _attribute(art["title"] or "", figures)
        want = subject.id if subject else None
        if want is None and art["figure_id"] is not None and gains_only:
            stats["kept"] += 1
            continue
        if want != art["figure_id"]:
            conn.execute(
                "UPDATE articles SET figure_id = ?, event_id = NULL WHERE id = ?",
                (want, art["id"]),
            )
            stats["changed"] += 1

    # Nothing can be orphaned by the unclustered-only pass: those articles hold
    # no event to empty. Skipping the sweep keeps that mode purely additive.
    if only_unclustered:
        conn.commit()
        return stats

    orphans = [r["id"] for r in conn.execute(
        """SELECT id FROM events
            WHERE id NOT IN (SELECT event_id FROM articles WHERE event_id IS NOT NULL)"""
    ).fetchall()]
    if orphans:
        marks = ",".join("?" * len(orphans))
        for table in ("event_summaries", "event_figures", "sentiment",
                      "comments", "buzzer_signals"):
            conn.execute(f"DELETE FROM {table} WHERE event_id IN ({marks})", orphans)
        conn.execute(f"DELETE FROM events WHERE id IN ({marks})", orphans)
        stats["events_removed"] = len(orphans)

    conn.commit()
    return stats


def ingest(conn: sqlite3.Connection,
           sources: list[Source] | None = None,
           figures: list[Figure] | None = None) -> dict[str, int]:
    """Fetch all feeds and store every newly-seen article.

    Articles matching a tracked figure carry that figure_id; the rest are stored
    with figure_id NULL as candidate material for peristiwa.

    Returns counts: {fetched, matched, general, inserted, skipped_existing}.
    """
    sources = sources or load_sources()
    figures = figures or load_figures()
    stats = {"fetched": 0, "matched": 0, "general": 0,
             "inserted": 0, "skipped_existing": 0}

    for src in sources:
        feed = feedparser.parse(src.rss)
        for entry in feed.entries:
            stats["fetched"] += 1
            title = getattr(entry, "title", "") or ""
            summary = getattr(entry, "summary", "") or ""
            url = getattr(entry, "link", "") or ""
            if not url:
                continue

            # Unattributed articles are kept, not dropped: they are the raw
            # material for peristiwa (national events, which belong to no
            # figure). Clustering discards the ones that never corroborate.
            figure = _attribute(f"{title}\n{summary}", figures)
            if figure is not None:
                stats["matched"] += 1
            else:
                stats["general"] += 1

            art_id = _hash_url(url)
            exists = conn.execute(
                "SELECT 1 FROM articles WHERE id = ?", (art_id,)
            ).fetchone()
            if exists:
                stats["skipped_existing"] += 1
                continue

            conn.execute(
                """INSERT INTO articles
                   (id, figure_id, source, url, title, summary, published_at, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (art_id, figure.id if figure else None, src.name, url, title,
                 summary, _published_iso(entry), _now()),
            )
            stats["inserted"] += 1

    conn.commit()
    return stats
