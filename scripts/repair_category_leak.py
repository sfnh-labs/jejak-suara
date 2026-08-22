"""Clean up the KATEGORI leak left in already-stored rows.

The summarize prompt asks the model for a `JUDUL`/`KATEGORI` header above a
`---` line, and `_split_title` cuts the body at that line. The model often drops
the divider, or writes it glued to the category ("KATEGORI: Penyelidikan---"),
and then the cut misses. Two things went wrong downstream:

  * `events.event_type` kept the trailing dashes, so the chip on the card read
    "Penyelidikan---" — and, worse, that string went back into the category menu
    offered to the model on the next run, teaching it the malformed shape.
  * `event_summaries.summary_text` kept the header line, which rendered as the
    first bullet of the summary, repeating a category the card already shows.

Both are fixed at the source now (jejak/summarize.py). This repairs the rows
written before that. Idempotent: re-running it changes nothing.

    python scripts/repair_category_leak.py            # SQLite only, dry run
    python scripts/repair_category_leak.py --apply    # SQLite
    python scripts/repair_category_leak.py --apply --neon
"""
from __future__ import annotations

import argparse
import os
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

DB_PATH = ROOT / "jejak.db"

# A header line the divider failed to cut off, and any separator left behind.
HEADER_RE = re.compile(r"^[ \t]*(?:\*\*)?(?:JUDUL|KATEGORI)(?:\*\*)?[ \t]*:.*$",
                       re.M | re.I)
RULE_RE = re.compile(r"^[ \t]*-{3,}[ \t]*$", re.M)


def clean_summary(text: str) -> str:
    out = RULE_RE.sub("", HEADER_RE.sub("", text))
    # Collapse the blank lines the removals leave behind, without touching the
    # single newlines that separate the bullets.
    return re.sub(r"\n{3,}", "\n\n", out).strip()


def clean_category(value: str) -> str:
    return value.rstrip("-–— \t")


def _load_database_url() -> str:
    """DATABASE_URL from the environment, falling back to the gitignored .env."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL not set and not found in .env")


def repair_sqlite(apply: bool) -> dict[str, int]:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    stats = {"event_type": 0, "summary_text": 0}

    for row in conn.execute(
        "SELECT id, event_type FROM events WHERE event_type IS NOT NULL"
    ).fetchall():
        fixed = clean_category(row["event_type"])
        if fixed != row["event_type"]:
            stats["event_type"] += 1
            if apply:
                conn.execute("UPDATE events SET event_type = ? WHERE id = ?",
                             (fixed or None, row["id"]))

    for row in conn.execute(
        "SELECT event_id, summary_text FROM event_summaries"
    ).fetchall():
        fixed = clean_summary(row["summary_text"])
        if fixed != row["summary_text"]:
            stats["summary_text"] += 1
            if apply:
                conn.execute(
                    "UPDATE event_summaries SET summary_text = ? WHERE event_id = ?",
                    (fixed, row["event_id"]),
                )

    if apply:
        conn.commit()
    conn.close()
    return stats


def repair_neon(apply: bool) -> dict[str, int]:
    try:
        import psycopg2
    except ImportError:
        sys.exit("psycopg2 not installed. Run: pip install -r requirements.txt")

    conn = psycopg2.connect(_load_database_url())
    conn.autocommit = False
    stats = {"event_type": 0, "summary_text": 0}
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, event_type FROM events "
                        "WHERE event_type IS NOT NULL")
            for eid, value in cur.fetchall():
                fixed = clean_category(value)
                if fixed != value:
                    stats["event_type"] += 1
                    if apply:
                        with conn.cursor() as up:
                            up.execute(
                                "UPDATE events SET event_type = %s WHERE id = %s",
                                (fixed or None, eid))

            cur.execute("SELECT event_id, summary_text FROM event_summaries")
            for eid, value in cur.fetchall():
                fixed = clean_summary(value)
                if fixed != value:
                    stats["summary_text"] += 1
                    if apply:
                        with conn.cursor() as up:
                            up.execute(
                                "UPDATE event_summaries SET summary_text = %s "
                                "WHERE event_id = %s", (fixed, eid))
        if apply:
            conn.commit()
        else:
            conn.rollback()
    finally:
        conn.close()
    return stats


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="write the changes (default is a dry run)")
    ap.add_argument("--neon", action="store_true",
                    help="also repair the Postgres copy")
    args = ap.parse_args()

    verb = "fixing" if args.apply else "would fix"
    print("sqlite:", verb, repair_sqlite(args.apply))
    if args.neon:
        print("neon:  ", verb, repair_neon(args.apply))
    if not args.apply:
        print("\ndry run — re-run with --apply to write")
    return 0


if __name__ == "__main__":
    sys.exit(main())
