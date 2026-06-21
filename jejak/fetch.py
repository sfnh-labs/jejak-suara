"""Stage 1.5 — Fetch full article text.

RSS gives us only a title + lead. For trustworthy grounded summaries we want the
actual article body, so the summarizer cites real reporting rather than a teaser.

This stage backfills `articles.body` for articles not yet fetched. It is separate
from ingest (network-heavy, rate-limited, fail-soft): a fetch failure leaves the
article usable — summarize falls back to the RSS lead.

Extraction uses `trafilatura` when available (best quality) and degrades to a
dependency-free stdlib extractor otherwise.
"""
from __future__ import annotations

import re
import sqlite3
import time
import urllib.request
from html.parser import HTMLParser

try:  # primary, high-quality extractor
    import trafilatura  # type: ignore
    _HAVE_TRAFILATURA = True
except Exception:  # pragma: no cover - fallback path
    _HAVE_TRAFILATURA = False

USER_AGENT = "jejak-suara/0.1 (+research; contact: set-me@example.com)"
TIMEOUT = 20          # seconds per request
POLITE_DELAY = 1.0    # seconds between requests to the same run
MIN_BODY_CHARS = 200  # shorter than this = treat as extraction failure


class _ParagraphExtractor(HTMLParser):
    """Stdlib fallback: collect text inside <p> tags, skip script/style/nav."""

    _SKIP = {"script", "style", "nav", "header", "footer", "aside", "form"}

    def __init__(self) -> None:
        super().__init__()
        self._depth_skip = 0
        self._in_p = 0
        self._buf: list[str] = []
        self.paragraphs: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self._SKIP:
            self._depth_skip += 1
        elif tag == "p" and self._depth_skip == 0:
            self._in_p += 1

    def handle_endtag(self, tag):
        if tag in self._SKIP and self._depth_skip:
            self._depth_skip -= 1
        elif tag == "p" and self._in_p:
            self._in_p -= 1
            text = re.sub(r"\s+", " ", "".join(self._buf)).strip()
            if len(text) > 40:  # drop short boilerplate lines
                self.paragraphs.append(text)
            self._buf = []

    def handle_data(self, data):
        if self._in_p and self._depth_skip == 0:
            self._buf.append(data)


def _download(url: str) -> str | None:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        charset = resp.headers.get_content_charset() or "utf-8"
        return resp.read().decode(charset, errors="replace")


def _extract(html: str, url: str) -> str | None:
    if _HAVE_TRAFILATURA:
        text = trafilatura.extract(html, url=url, favor_recall=True)
        if text and len(text) >= MIN_BODY_CHARS:
            return text.strip()
    parser = _ParagraphExtractor()
    parser.feed(html)
    text = "\n\n".join(parser.paragraphs)
    return text.strip() if len(text) >= MIN_BODY_CHARS else None


def fetch_article(url: str) -> tuple[str | None, str]:
    """Fetch + extract one article. Returns (body_or_None, status)."""
    try:
        html = _download(url)
    except Exception as e:  # network / HTTP errors
        return None, f"error:download:{type(e).__name__}"
    if not html:
        return None, "error:empty"
    body = _extract(html, url)
    if not body:
        return None, "error:extract"
    return body, "ok"


def fetch_bodies(conn: sqlite3.Connection, limit: int = 50,
                 retry_failed: bool = False) -> dict[str, int]:
    """Backfill bodies for articles not yet successfully fetched.

    By default only attempts articles never tried (fetch_status IS NULL). Pass
    retry_failed=True to also retry prior failures.
    Returns counts: {attempted, ok, failed}.
    """
    where = "fetch_status IS NULL" if not retry_failed \
        else "fetch_status IS NULL OR fetch_status LIKE 'error:%'"
    rows = conn.execute(
        f"SELECT id, url FROM articles WHERE {where} ORDER BY fetched_at LIMIT ?",
        (limit,),
    ).fetchall()

    stats = {"attempted": 0, "ok": 0, "failed": 0}
    for i, art in enumerate(rows):
        if i:
            time.sleep(POLITE_DELAY)
        stats["attempted"] += 1
        body, status = fetch_article(art["url"])
        conn.execute(
            "UPDATE articles SET body = ?, fetch_status = ? WHERE id = ?",
            (body, status, art["id"]),
        )
        stats["ok" if status == "ok" else "failed"] += 1
    conn.commit()
    return stats
