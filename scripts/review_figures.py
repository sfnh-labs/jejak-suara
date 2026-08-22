"""List and curate the figures the mentions stage discovered.

Discovery is pattern-based, so it is right most of the time and wrong in a
recognisable way: what it gets wrong is almost never a person. "Federal Bureau",
"Nahdlatul Ulama" and "Metro Jaya Brigjen" are an agency, an organisation and a
police rank. The gazetteers in jejak/mentions.py keep shrinking that tail, but a
pattern will not close it, and this site names real people — so the roster needs
a way to be looked at.

Deactivating sets `active = 0`. That is what every other stage reads, so the
figure stops being attributed, stops appearing on the site, and keeps the
evidence behind it: nothing is deleted, and reactivating is one command.

    python scripts/review_figures.py                    # list, most-cited first
    python scripts/review_figures.py --suspects         # only the likely junk
    python scripts/review_figures.py --off slug [slug]  # deactivate
    python scripts/review_figures.py --on  slug [slug]  # reactivate
"""
from __future__ import annotations

import argparse
import re
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import mentions  # noqa: E402

DB_PATH = ROOT / "jejak.db"

# Words that mark a row as an organisation, a rank or an office fragment rather
# than a person. Same spirit as the extractor's gazetteers, but used here to
# *rank* rows for review rather than to reject them outright.
_SUSPECT_WORDS = {
    "bureau", "federal", "manager", "public", "relations", "corporate",
    "satlantas", "gakkum", "polri", "polda", "polres", "metro", "jaya",
    "brigjen", "irjen", "komjen", "kombes", "akbp", "kompol", "letjen",
    "mayjen", "laksamana", "marsekal", "kolonel", "letkol", "haji",
    "nahdlatul", "ulama", "muhammadiyah", "pertamina", "bulog", "danantara",
    "bangsa", "masyarakat", "rakyat", "wali", "kota", "kabupaten", "deputi",
    "ombudsman", "sekretariat", "direktorat", "kementerian", "badan",
}


def _looks_like_junk(name: str, role: str | None) -> str | None:
    """A short reason this row is worth a look, or None if it looks fine."""
    words = name.split()
    lowered = {w.lower() for w in words}
    hit = lowered & _SUSPECT_WORDS
    if hit:
        return f"contains {', '.join(sorted(hit))}"
    if not role:
        return "no office ever stated"
    if any(mentions._NOMINALISATION_RE.match(w) for w in words):
        return "office noun, not a name"
    if len(words) > 3:
        return "longer than a name"
    return None


def _rows(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    return conn.execute(
        """SELECT f.id, f.name, f.role, f.active,
                  (SELECT count(DISTINCT m.source) FROM figure_mentions m
                    WHERE m.slug = f.id) AS outlets,
                  (SELECT count(*) FROM figure_mentions m
                    WHERE m.slug = f.id) AS mentions,
                  (SELECT count(*) FROM articles a
                    WHERE a.figure_id = f.id) AS articles
             FROM figures f
            WHERE f.origin = 'discovered'
            ORDER BY outlets DESC, mentions DESC"""
    ).fetchall()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--suspects", action="store_true",
                    help="list only the rows that do not look like a person")
    ap.add_argument("--off", nargs="+", metavar="SLUG",
                    help="deactivate these figures")
    ap.add_argument("--on", nargs="+", metavar="SLUG",
                    help="reactivate these figures")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        if args.off or args.on:
            for slugs, active in ((args.off or [], 0), (args.on or [], 1)):
                for slug in slugs:
                    cur = conn.execute(
                        "UPDATE figures SET active = ? WHERE id = ?",
                        (active, slug))
                    verb = "deactivated" if active == 0 else "reactivated"
                    print(f"{verb if cur.rowcount else 'no such figure'}: {slug}")
            conn.commit()
            return 0

        rows = _rows(conn)
        shown = 0
        for r in rows:
            reason = _looks_like_junk(r["name"], r["role"])
            if args.suspects and reason is None:
                continue
            shown += 1
            flag = "" if r["active"] else "  [off]"
            note = f"   <- {reason}" if reason else ""
            print(f"{r['outlets']:3} outlets  {r['articles']:4} art  "
                  f"{r['name'][:32]:32} {(r['role'] or '-')[:28]:28}"
                  f"{flag}{note}")
        print(f"\n{shown} of {len(rows)} discovered figures listed")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
