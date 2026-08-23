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

The other half is the queue the promoter refuses on its own. A candidate named
by one word never gets promoted automatically: sentence case capitalises the
first word of every sentence, so "Dasar", "Lalu" and "Ke" reach three outlets
as readily as "Dasco" does, and a pattern cannot tell them apart. They are
listed with their evidence so a person can:

    python scripts/review_figures.py --candidates                # the queue
    python scripts/review_figures.py --promote dasco yusril      # accept
    python scripts/review_figures.py --promote "dasco=Sufmi Dasco Ahmad"
    python scripts/review_figures.py --promote "jokowi=Joko Widodo|Jokowi|Mulyono"
    python scripts/review_figures.py --reject ke dasar lalu      # never ask again

Promoting keeps the one-word form as an alias, so headline attribution still
matches it, while the site shows the full name when one is given. Names after
the first, separated by `|`, are extra aliases — the several ways outlets
write one person. Any other candidate carrying one of those names is folded
in at the same time, so the same person stops queueing twice.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from datetime import datetime, timezone
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


def _candidates(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    """Corroborated candidates the promoter will never take on its own.

    `rejected` rows stay out: a decision already made is not asked again.
    """
    return conn.execute(
        """SELECT c.slug, c.name, c.status,
                  count(DISTINCT m.source) AS outlets,
                  count(*)                 AS mentions
             FROM figure_candidates c
             JOIN figure_mentions m ON m.slug = c.slug
            WHERE c.slug NOT IN (SELECT id FROM figures)
              AND c.status != 'rejected'
            GROUP BY c.slug
           HAVING outlets >= ?
            ORDER BY outlets DESC, mentions DESC""",
        (mentions.PROMOTE_MIN_OUTLETS,),
    ).fetchall()


def _evidence(conn: sqlite3.Connection, slug: str) -> tuple[str, list[str]]:
    """The office most often attached to a candidate, and headlines naming them.

    The headline is what the reader would see the person leading, and it is
    also what attribution reads — so it is the right thing to judge on.
    """
    role_row = conn.execute(
        """SELECT role, count(*) n FROM figure_mentions
            WHERE slug = ? AND role IS NOT NULL AND role != ''
            GROUP BY role ORDER BY n DESC LIMIT 1""",
        (slug,),
    ).fetchone()
    titles = [
        r["title"] for r in conn.execute(
            """SELECT DISTINCT a.title
                 FROM figure_mentions m JOIN articles a ON a.id = m.article_id
                WHERE m.slug = ? AND a.title IS NOT NULL
                ORDER BY a.published_at DESC LIMIT 2""",
            (slug,),
        )
    ]
    return (role_row["role"] if role_row else ""), titles


def _promote(conn: sqlite3.Connection, spec: str) -> str:
    """Accept one candidate: `slug`, `slug=Full Name`, or with extra aliases
    after it, `slug=Full Name|Nickname|Other name`.

    Aliases are the whole point of the manual pass. A person is written several
    ways across outlets and the discovery pattern sees each as its own
    candidate: Joko Widodo is "Jokowi" in most headlines and "Mulyono" in some.
    Every name listed here becomes a match term, so the record lands on one
    page instead of three — and the site still shows the full name.

    The candidate's own form is always kept as an alias, whether or not a
    fuller name is given: it is how the headlines write them.
    """
    slug, _, rest = spec.partition("=")
    slug = slug.strip()
    row = conn.execute(
        "SELECT name FROM figure_candidates WHERE slug = ?", (slug,)
    ).fetchone()
    if row is None:
        return f"no such candidate: {slug}"
    if conn.execute("SELECT 1 FROM figures WHERE id = ?", (slug,)).fetchone():
        return f"already a figure: {slug}"

    parts = [p.strip() for p in rest.split("|") if p.strip()]
    name = parts[0] if parts else row["name"]
    role, _ = _evidence(conn, slug)
    aliases = sorted({row["name"], name, *parts})
    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO figures (id, name, role, aliases, active, origin, created_at)
           VALUES (?, ?, ?, ?, 1, 'discovered', ?)""",
        (slug, name, role, json.dumps(aliases, ensure_ascii=False), now),
    )
    conn.execute(
        "UPDATE figure_candidates SET status = 'tracked', promoted_at = ? WHERE slug = ?",
        (now, slug),
    )
    # Any other candidate that is one of these names is the same person, and
    # would otherwise sit in the queue as a separate row forever.
    folded = 0
    for alias in aliases:
        cur = conn.execute(
            "UPDATE figure_candidates SET status = 'tracked', promoted_at = ? "
            "WHERE lower(name) = lower(?) AND slug != ? AND status != 'tracked'",
            (now, alias, slug),
        )
        folded += cur.rowcount
    note = f"  ({role})" if role else ""
    extra = f"  aliases: {', '.join(aliases)}" if len(aliases) > 1 else ""
    fold = f"  [{folded} duplicate candidate/s folded]" if folded else ""
    return f"promoted: {slug} -> {name}{note}{extra}{fold}"


def main() -> int:
    # Indonesian names and the box-drawing glyph below both leave the Windows
    # console's default code page; without this the listing dies on its own
    # output.
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--suspects", action="store_true",
                    help="list only the rows that do not look like a person")
    ap.add_argument("--off", nargs="+", metavar="SLUG",
                    help="deactivate these figures")
    ap.add_argument("--on", nargs="+", metavar="SLUG",
                    help="reactivate these figures")
    ap.add_argument("--candidates", action="store_true",
                    help="list corroborated candidates the promoter refuses "
                         "on its own, with the evidence behind each")
    ap.add_argument("--promote", nargs="+", metavar="SLUG[=NAME]",
                    help="accept these candidates as tracked figures")
    ap.add_argument("--reject", nargs="+", metavar="SLUG",
                    help="mark these candidates rejected, so they stop being "
                         "listed and are never promoted")
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

        if args.promote or args.reject:
            for spec in args.promote or []:
                print(_promote(conn, spec))
            for slug in args.reject or []:
                cur = conn.execute(
                    "UPDATE figure_candidates SET status = 'rejected' WHERE slug = ?",
                    (slug,))
                print(f"{'rejected' if cur.rowcount else 'no such candidate'}: {slug}")
            conn.commit()
            print("\nRun `python -m jejak.cli mentions --reattribute "
                  "--gains-only` to hand history to anything promoted.")
            return 0

        if args.candidates:
            rows = _candidates(conn)
            for r in rows:
                role, titles = _evidence(conn, r["slug"])
                print(f"{r['name'][:18]:18} {r['outlets']:2} outlets "
                      f"{r['mentions']:4} mentions   {(role or '-')[:44]}")
                for t in titles[:1]:
                    print(f"{'':18} └ {t[:88]}")
            print(f"\n{len(rows)} candidates awaiting a decision")
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
