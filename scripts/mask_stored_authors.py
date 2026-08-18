"""Bring stored commenter identities into the form the pipeline now writes.

`sentiment._store_comments` redacts at write time, so nothing collected from
now on carries a full display name or a raw channel id. This is the one-off for
rows written before that, and the way to roll out a change to the redaction
format across rows already stored: it recomputes rather than skipping anything
that merely looks done.

    python scripts/mask_stored_authors.py           # dry run - reports only
    python scripts/mask_stored_authors.py --apply   # rewrite, after a backup

    # recover names an earlier format destroyed, then redact those
    python scripts/mask_stored_authors.py --names-from jejak.db.bak.20260818125949

`--names-from` exists because the redaction format changed after rows were
already scrubbed. The first format replaced the whole name with a pseudonym
derived from the id, so the name itself is not in the live database any more
and a partial redaction cannot be computed from what is there. A pre-scrub
SQLite backup still has it. Rows whose name cannot be recovered are reported
and left alone: masking a pseudonym would produce something that reads like a
redacted name but is not one.

Names are matched across stores on `comment_id`, the platform's own id for the
comment, and never on the row id. `comments` syncs with serial=True against a
conflict target of (event_id, comment_id), so its id is omitted from the push
and Postgres mints its own; the two id spaces do not correspond, and updating
one store by the other's ids rewrites the wrong rows.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from jejak import anonymize  # noqa: E402
from jejak import db as jejak_db  # noqa: E402

# The retired format: "Akun" plus a prefix of the id's digest. Nothing of the
# display name survives in it, so a row still wearing one is unrecoverable
# unless --names-from supplies the original.
_RETIRED = re.compile(r"^Akun\s+[0-9a-f]{4,}$", re.I)


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"'))


def recovered_names(path: Path) -> dict[str, str]:
    """comment_id -> the display name as it was stored before any redaction.

    Only names that predate redaction are taken. A backup can hold a mix, and
    a value already in a mask's shape is no better a source than what is live.
    """
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        rows = conn.execute(
            "SELECT comment_id, author_name FROM comments").fetchall()
    finally:
        conn.close()
    return {cid: name for cid, name in rows
            if cid and name and not _RETIRED.match(name)
            and not anonymize.is_masked(name)}


def plan(rows, names: dict[str, str]):
    """Rows whose stored form differs from what it should be.

    Returns (updates, unrecoverable), where updates is ready for executemany as
    (author_name, author_id, row_id).
    """
    updates, stuck = [], 0
    for row_id, comment_id, author_id, name in rows:
        source = names.get(comment_id)
        if source is None:
            if _RETIRED.match(name or ""):
                stuck += 1
                continue
            source = name
        want_id = anonymize.hash_author_id(author_id)
        want_name = anonymize.mask_author(source)
        if (want_id, want_name) != (author_id, name):
            updates.append((want_name, want_id, row_id))
    return updates, stuck


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mask_stored_authors")
    parser.add_argument("--apply", action="store_true",
                        help="actually rewrite (default is a dry run)")
    parser.add_argument("--names-from", type=Path, default=None,
                        help="SQLite file holding the pre-redaction names")
    args = parser.parse_args(argv)

    _load_env()
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        print("DATABASE_URL not set", file=sys.stderr)
        return 1

    if (ROOT / "scripts" / ".publish_local.lock").exists():
        print("A pipeline run is in progress (lock held). Refusing.",
              file=sys.stderr)
        return 1

    names: dict[str, str] = {}
    if args.names_from:
        if not args.names_from.exists():
            print(f"no such file: {args.names_from}", file=sys.stderr)
            return 1
        names = recovered_names(args.names_from)
        print(f"recovered {len(names)} names from {args.names_from.name}")

    import sync_to_neon  # noqa: E402

    sqlite = jejak_db.connect()
    pg = sync_to_neon._connect_pg(db_url)
    cur = pg.cursor()

    try:
        sq_rows = [(r["id"], r["comment_id"], r["author_id"], r["author_name"])
                   for r in sqlite.execute(
                       "SELECT id, comment_id, author_id, author_name "
                       "FROM comments")]
        cur.execute(
            "SELECT id, comment_id, author_id, author_name FROM comments")
        pg_rows = cur.fetchall()

        sq_updates, sq_stuck = plan(sq_rows, names)
        pg_updates, pg_stuck = plan(pg_rows, names)

        for label, rows, updates, stuck in (
                ("SQLite", sq_rows, sq_updates, sq_stuck),
                ("Neon", pg_rows, pg_updates, pg_stuck)):
            print(f"{label:<7}: {len(rows)} comments, {len(updates)} to "
                  f"rewrite, {stuck} unrecoverable")

        if not args.apply:
            for (mask, _, row_id) in sq_updates[:5]:
                before = next(r for r in sq_rows if r[0] == row_id)
                print(f"    {before[3]!r} -> {mask!r}")
            print("\nDry run. Re-run with --apply to rewrite.")
            return 0

        if not (sq_updates or pg_updates):
            print("nothing to do")
            return 0

        backup = ROOT / f"jejak.db.bak.{datetime.now():%Y%m%d%H%M%S}"
        shutil.copy2(jejak_db.DEFAULT_DB, backup)
        print(f"\nbackup: {backup.name}")

        if sq_updates:
            sqlite.executemany(
                "UPDATE comments SET author_name = ?, author_id = ? "
                " WHERE id = ?", sq_updates)
            sqlite.commit()
        if pg_updates:
            cur.executemany(
                "UPDATE comments SET author_name = %s, author_id = %s "
                " WHERE id = %s", pg_updates)
        pg.commit()

        # What is left in the clear afterwards, counted from the rows
        # themselves rather than from what we believed we were writing.
        left = ("SELECT count(*) FROM comments WHERE "
                "(author_name <> 'Anonim' AND author_name NOT LIKE '{p}*{p}') "
                "OR (author_id <> '' AND length(author_id) <> 64)")
        left_sq = sqlite.execute(left.format(p="%")).fetchone()[0]
        cur.execute(left.format(p="%%"))
        print(f"SQLite : rewrote {len(sq_updates)}, {left_sq} still exposed")
        print(f"Neon   : rewrote {len(pg_updates)}, {cur.fetchone()[0]} "
              f"still exposed")
    except Exception:
        pg.rollback()
        raise
    finally:
        cur.close()
        pg.close()
        sqlite.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
