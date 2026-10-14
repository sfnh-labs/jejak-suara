"""Apply the decisions made in /kurasi/kandidat to the local roster.

The review page writes to Neon, because that is what the web app can reach.
The pipeline reads SQLite. This closes the loop: it pulls every verdict that
has not been applied yet, acts on it locally, and stamps `applied_at` in Neon
so the same decision is never carried out twice.

    python scripts/apply_candidate_verdicts.py            # show what would happen
    python scripts/apply_candidate_verdicts.py --apply

A 'promote' becomes a tracked figure exactly as the curator filled the form:
their full name, office, aliases and page address, and nothing else. The form
pre-fills the mined spelling and the office the coverage stated, where the
curator can see and change them; nothing is added behind their back. (It used
to be: the mined spelling always became an alias and the page address, so
accepting "Hafidz" as Habib Umar made /tokoh/hafidz match every Hafidz.) A 'reject' marks the
candidate so discovery stops offering it.

Promoting only adds figures; it does not hand them any history. To do that,
run afterwards:

    python -m jejak.cli mentions --reattribute --gains-only

Requires DATABASE_URL, which is never printed.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak.mentions import slugify  # noqa: E402

DB_PATH = ROOT / "jejak.db"


def _load_database_url() -> str:
    """Environment first, then .env — and never echoed anywhere."""
    url = os.environ.get("DATABASE_URL")
    if url:
        return url
    env = ROOT / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    sys.exit("DATABASE_URL not set (env or .env)")


def _connect_pg(url: str):
    try:
        import psycopg2
    except ImportError:
        sys.exit("psycopg2 not installed. Run: pip install -r requirements.txt")
    return psycopg2.connect(url)


def _promote(conn: sqlite3.Connection, slug: str, name: str,
             full_name: str | None, aliases_raw: str | None,
             curated_role: str | None = None,
             curated_slug: str | None = None,
             curated_positions: str | None = None) -> str:
    """Create the tracked figure a 'promote' verdict asked for."""
    display = (full_name or "").strip() or name
    figure_id = (curated_slug or "").strip() or slugify(display)
    if conn.execute("SELECT 1 FROM figures WHERE id = ?", (figure_id,)).fetchone():
        return f"already a figure: {figure_id} (pick another page address for {display})"

    extra = [a.strip() for a in (aliases_raw or "").split("|") if a.strip()]
    alias_list = sorted({display, *extra})
    role = (curated_role or "").strip()
    # The offices as the curator entered them; the title under the name is
    # the first one, as everywhere else.
    try:
        positions = [p for p in json.loads(curated_positions or "[]")
                     if isinstance(p, dict) and (p.get("role") or p.get("org"))]
    except ValueError:
        positions = []
    if positions:
        role = " ".join(x for x in (str(positions[0].get("role", "")).strip(),
                                    str(positions[0].get("org", "")).strip()) if x)

    now = datetime.now(timezone.utc).isoformat()
    conn.execute(
        """INSERT INTO figures (id, name, role, aliases, positions, active, origin, created_at)
           VALUES (?, ?, ?, ?, ?, 1, 'discovered', ?)""",
        (figure_id, display, role, json.dumps(alias_list, ensure_ascii=False),
         json.dumps(positions, ensure_ascii=False) if positions else None, now),
    )
    # Every other candidate carrying one of these names is the same person and
    # would otherwise queue again on the next sync.
    folded = 0
    for alias in alias_list:
        folded += conn.execute(
            "UPDATE figure_candidates SET status = 'tracked', promoted_at = ? "
            "WHERE lower(name) = lower(?) AND slug != ? AND status != 'tracked'",
            (now, alias, slug),
        ).rowcount
    conn.execute(
        "UPDATE figure_candidates SET status = 'tracked', promoted_at = ? WHERE slug = ?",
        (now, slug),
    )
    note = f" ({role})" if role else ""
    fold = f", {folded} duplicate/s folded" if folded else ""
    return f"promoted {slug} -> {figure_id}: {display}{note}{fold}"


def _reject(conn: sqlite3.Connection, slug: str) -> str:
    cur = conn.execute(
        "UPDATE figure_candidates SET status = 'rejected' WHERE slug = ?", (slug,)
    )
    return f"rejected {slug}" if cur.rowcount else f"no such candidate: {slug}"


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="write the decisions; without it this only reports")
    args = ap.parse_args(argv)

    pg = _connect_pg(_load_database_url())
    with pg.cursor() as cur:
        cur.execute(
            """SELECT slug, name, verdict, full_name, aliases, curated_role, curated_slug,
                      curated_positions, notes
                 FROM figure_candidates
                WHERE verdict IS NOT NULL AND applied_at IS NULL
                ORDER BY verdict, outlets DESC"""
        )
        pending = cur.fetchall()

    if not pending:
        print("no decisions waiting to be applied")
        pg.close()
        return 0

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    done: list[str] = []
    try:
        for (slug, name, verdict, full_name, aliases, curated_role, curated_slug,
             curated_positions, notes) in pending:
            if verdict == "promote":
                line = _promote(conn, slug, name, full_name, aliases, curated_role,
                                curated_slug, curated_positions)
            else:
                line = _reject(conn, slug)
            print(("apply " if args.apply else "would ") + line)
            # The curator's reasoning is the useful half of a reject: it says
            # what the extractor mistook, which is what gets tuned next.
            if notes:
                print(f"    note: {notes}")
            done.append(slug)
        if args.apply:
            conn.commit()
        else:
            conn.rollback()
    finally:
        conn.close()

    if args.apply and done:
        now = datetime.now(timezone.utc).isoformat()
        with pg.cursor() as cur:
            cur.executemany(
                "UPDATE figure_candidates SET applied_at = %s WHERE slug = %s",
                [(now, slug) for slug in done],
            )
        pg.commit()
        print(f"\n{len(done)} decision/s applied and marked in Neon.")
        print("Hand history to the new figures with:")
        print("  python -m jejak.cli mentions --reattribute --gains-only")
    else:
        print(f"\n{len(pending)} decision/s pending. Re-run with --apply.")
    pg.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
