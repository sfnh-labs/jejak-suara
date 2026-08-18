"""Stage 1b — Backfill.

RSS carries roughly a day of headlines, so `ingest` can only ever learn about
things as they happen. A track record wants the opposite: what a figure did
before we started watching. Outlets publish date-indexed archive pages, and
those are the one public surface that lets history be walked backwards a day at
a time.

A cursor in `pipeline_state` records how far back the walk has got, so each
scheduled run picks up where the last one stopped and the archive fills in
steadily behind the live feed. The cursor lives in the database rather than a
file because `jejak.db` is disposable — it is rebuilt from Neon on every run.

Only headlines that attribute to a tracked figure are stored by default. The
archives carry every section an outlet publishes (sport, entertainment,
regional filler), and keeping all of it would mean tens of thousands of rows a
month for the handful that ever corroborate into a peristiwa. Pass
general=True to take the lot.
"""
from __future__ import annotations

import html as html_lib
import re
import sqlite3
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from .config import Figure, load_figures
from .ingest import _attribute, _hash_url, _now

# Archive pages are read at the same rate as article bodies; see fetch.py.
USER_AGENT = "jejak-suara/0.1 (+research; contact: set-me@example.com)"
TIMEOUT = 25
POLITE_DELAY = 1.0

# Indonesian outlets publish in WIB, and their archive pages are indexed by
# local date. Storing the offset keeps a midnight article on the day the outlet
# filed it rather than the day before.
WIB = timezone(timedelta(hours=7))

# How far back the walk is allowed to go. Overridable per run; the default is
# the start of the current presidential term, which is as far back as the
# tracked roster is meaningful.
DEFAULT_FLOOR = date(2024, 10, 20)

CURSOR_KEY = "backfill_cursor"


@dataclass(frozen=True)
class Archive:
    """One outlet's date-indexed archive.

    `url` takes a date and a 1-based page number. `link_re` matches article
    URLs on that page; `time_re` optionally recovers the publication time from
    the URL itself, since the archive only pins the date.
    """
    name: str
    url_for: callable
    link_re: re.Pattern
    time_re: re.Pattern | None = None


# A day of one outlet's output runs to roughly 300 headlines across 15-20
# archive pages. Walking short would silently skip most of the day, so the cap
# sits above every outlet's real depth and the walk stops early instead: past
# the last page, Detik and Kompas re-serve content already read rather than
# returning nothing.
MAX_PAGES = 25


ARCHIVES: tuple[Archive, ...] = (
    Archive(
        name="Detik",
        url_for=lambda d, p: (
            f"https://news.detik.com/indeks?date={d:%m/%d/%Y}&page={p}"
        ),
        link_re=re.compile(r"https://news\.detik\.com/[a-z-]+/d-\d+/[a-z0-9-]+"),
    ),
    Archive(
        name="Kompas",
        url_for=lambda d, p: (
            f"https://indeks.kompas.com/?site=news&date={d:%Y-%m-%d}&page={p}"
        ),
        link_re=re.compile(
            r"https://[a-z]+\.kompas\.com/read/\d{4}/\d{2}/\d{2}/\d+/[a-z0-9-]+"
        ),
        time_re=re.compile(r"/read/\d{4}/\d{2}/\d{2}/(\d{2})(\d{2})(\d{2})"),
    ),
    Archive(
        name="CNN Indonesia",
        url_for=lambda d, p: (
            f"https://www.cnnindonesia.com/indeks/2?date={d:%Y/%m/%d}&page={p}"
        ),
        link_re=re.compile(
            r"https://www\.cnnindonesia\.com/[a-z-]+/\d{14}-\d+-\d+/[a-z0-9-]+"
        ),
        time_re=re.compile(r"/\d{8}(\d{2})(\d{2})(\d{2})-\d+-\d+/"),
    ),
)

# The headline sits in the thumbnail's alt text on all three outlets, which is
# the only markup they have in common; Detik also emits it in a tracking
# handler. Matching on structure instead would need three separate parsers that
# break independently.
_ALT_RE = re.compile(r'alt="([^"]{12,300})"')
_DETIK_TITLE_RE = re.compile(r'_pt\(this,[^,]+,\s*"([^"]{12,300})"')


def _download(url: str, attempts: int = 3) -> str | None:
    """Read an archive page, retrying transient failures.

    A page that fails ends the walk for that outlet on that day, and the cursor
    moves on regardless — so a single dropped connection would silently cost a
    whole outlet's coverage of that date, with nothing to distinguish it from a
    day the outlet genuinely filed nothing. Retrying is much cheaper than
    noticing the hole later.
    """
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return resp.read().decode("utf-8", "ignore")
        except urllib.error.HTTPError as e:
            # 404 is the archive's way of saying "no such page" — past the last
            # page of the day. Retrying it would just be slow.
            if e.code == 404:
                return None
        except (urllib.error.URLError, OSError, ValueError):
            pass
        if attempt + 1 < attempts:
            time.sleep(POLITE_DELAY * (attempt + 1))
    return None


def _listing(page: str, arc: Archive) -> dict[str, str]:
    """Article url -> headline for one archive page."""
    found: dict[str, str] = {}
    for m in arc.link_re.finditer(page):
        url = m.group(0)
        if url in found:
            continue
        after = page[m.end():m.end() + 1200]
        around = page[max(0, m.start() - 400):m.end() + 400]
        hit = _ALT_RE.search(after) or _DETIK_TITLE_RE.search(around)
        if hit:
            found[url] = html_lib.unescape(hit.group(1)).strip()
    return found


def _published(arc: Archive, url: str, day: date) -> str:
    """Publication timestamp, as precise as the URL allows."""
    if arc.time_re:
        m = arc.time_re.search(url)
        if m:
            h, mi, s = (int(x) for x in m.groups())
            if h < 24 and mi < 60 and s < 60:
                return datetime(day.year, day.month, day.day, h, mi, s,
                                tzinfo=WIB).isoformat()
    return datetime(day.year, day.month, day.day, tzinfo=WIB).isoformat()


def _get_state(conn: sqlite3.Connection, key: str) -> str | None:
    row = conn.execute(
        "SELECT value FROM pipeline_state WHERE key = ?", (key,)
    ).fetchone()
    return row["value"] if row else None


def _set_state(conn: sqlite3.Connection, key: str, value: str) -> None:
    conn.execute(
        "INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, "
        "updated_at = excluded.updated_at",
        (key, value, _now()),
    )


def backfill_day(conn: sqlite3.Connection, day: date,
                 figures: list[Figure] | None = None,
                 general: bool = False) -> dict[str, int]:
    """Read every archive for one date and store the articles worth keeping.

    Rows land in `articles` exactly as `ingest` writes them — same url hash,
    same attribution rule — so clustering, fetching and summarizing treat a
    year-old article no differently from one that arrived this morning.
    """
    figures = figures if figures is not None else load_figures()
    stats = {"seen": 0, "matched": 0, "inserted": 0,
             "skipped_existing": 0, "pages": 0}

    for arc in ARCHIVES:
        seen_urls: set[str] = set()
        for page_no in range(1, MAX_PAGES + 1):
            page = _download(arc.url_for(day, page_no))
            time.sleep(POLITE_DELAY)
            if not page:
                break
            stats["pages"] += 1
            items = {u: t for u, t in _listing(page, arc).items()
                     if u not in seen_urls}
            if not items:
                break
            seen_urls |= set(items)

            for url, title in items.items():
                stats["seen"] += 1
                figure = _attribute(title, figures)
                if figure is not None:
                    stats["matched"] += 1
                elif not general:
                    continue

                art_id = _hash_url(url)
                if conn.execute("SELECT 1 FROM articles WHERE id = ?",
                                (art_id,)).fetchone():
                    stats["skipped_existing"] += 1
                    continue

                conn.execute(
                    """INSERT INTO articles
                       (id, figure_id, source, url, title, summary,
                        published_at, fetched_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (art_id, figure.id if figure else None, arc.name, url,
                     title, None, _published(arc, url, day), _now()),
                )
                stats["inserted"] += 1

    conn.commit()
    return stats


def backfill(conn: sqlite3.Connection, days: int = 1,
             floor: date = DEFAULT_FLOOR,
             general: bool = False) -> dict[str, int]:
    """Walk `days` further back through the archives from where we left off.

    Returns the per-day totals plus the date reached. When the cursor hits the
    floor the walk stops and later runs are no-ops, so this is safe to leave in
    the scheduled pipeline forever.
    """
    figures = load_figures()
    saved = _get_state(conn, CURSOR_KEY)
    cursor = date.fromisoformat(saved) if saved else datetime.now(WIB).date()

    totals = {"seen": 0, "matched": 0, "inserted": 0,
              "skipped_existing": 0, "pages": 0, "days": 0}

    for _ in range(days):
        day = cursor - timedelta(days=1)
        if day < floor:
            totals["done"] = 1
            break
        day_stats = backfill_day(conn, day, figures, general=general)
        for k, v in day_stats.items():
            totals[k] += v
        totals["days"] += 1
        cursor = day
        # Written per day, not at the end: a run killed halfway through a
        # multi-day walk must not repeat the days it already read.
        _set_state(conn, CURSOR_KEY, cursor.isoformat())
        conn.commit()

    totals["reached"] = cursor.isoformat()
    return totals
