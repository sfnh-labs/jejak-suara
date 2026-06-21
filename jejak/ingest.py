"""Stage 1 — Ingest.

Pull articles from configured RSS feeds, attribute each to a tracked figure by
alias match, and store (deduped by URL hash). No AI here; this is plumbing.
"""
from __future__ import annotations

import hashlib
import sqlite3
from datetime import datetime, timezone
from time import mktime

import feedparser

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


def _attribute(text: str, figures: list[Figure]) -> Figure | None:
    """Return the figure whose alias appears in `text`, or None.

    First-match wins. Good enough for v1; a disambiguation pass can come later
    (e.g. two figures sharing a surname).
    """
    low = text.lower()
    for fig in figures:
        if any(term in low for term in fig.match_terms()):
            return fig
    return None


def ingest(conn: sqlite3.Connection,
           sources: list[Source] | None = None,
           figures: list[Figure] | None = None) -> dict[str, int]:
    """Fetch all feeds, store newly-seen articles attributed to a tracked figure.

    Returns counts: {fetched, matched, inserted, skipped_existing}.
    """
    sources = sources or load_sources()
    figures = figures or load_figures()
    stats = {"fetched": 0, "matched": 0, "inserted": 0, "skipped_existing": 0}

    for src in sources:
        feed = feedparser.parse(src.rss)
        for entry in feed.entries:
            stats["fetched"] += 1
            title = getattr(entry, "title", "") or ""
            summary = getattr(entry, "summary", "") or ""
            url = getattr(entry, "link", "") or ""
            if not url:
                continue

            figure = _attribute(f"{title}\n{summary}", figures)
            if figure is None:
                continue
            stats["matched"] += 1

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
                (art_id, figure.id, src.name, url, title, summary,
                 _published_iso(entry), _now()),
            )
            stats["inserted"] += 1

    conn.commit()
    return stats
