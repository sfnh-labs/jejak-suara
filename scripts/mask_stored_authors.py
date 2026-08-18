"""Strip commenters' identities from rows already in storage.

`sentiment._store_comments` does this at write time, so nothing collected from
now on carries either field in the clear. This is the one-off for rows written
before that: their `author_name` is still the display name YouTube handed back,
and their `author_id` is still a channel id that resolves to the person. See
jejak/anonymize.py for why neither should be there.

    python scripts/mask_stored_authors.py           # dry run - reports only
    python scripts/mask_stored_authors.py --apply   # rewrite, after a backup

Both fields derive from `author_id`, and both helpers give the same answer
whether handed the raw id or their own output - so this converges on the same
values the pipeline would have written, and re-running it is a no-op. It is
also the way to roll out a change to the pseudonym format across rows already
stored, since it recomputes rather than skipping anything that merely looks
done.
"""
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

from jejak import anonymize  # noqa: E402
from jejak import db as jejak_db  # noqa: E402


def _load_env() -> None:
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*)", line)
        if m:
            os.environ.setdefault(m.group(1), m.group(2).strip().strip('"'))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mask_stored_authors")
    parser.add_argument("--apply", action="store_true",
                        help="actually rewrite (default is a dry run)")
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

    import sync_to_neon  # noqa: E402

    sqlite = jejak_db.connect()
    pg = sync_to_neon._connect_pg(db_url)
    cur = pg.cursor()

    try:
        # Each store is scrubbed from its own rows. They cannot be matched on
        # comments.id: that table syncs with serial=True against a conflict
        # target of (event_id, comment_id), so its id is omitted from the push
        # and Postgres mints its own. The two id spaces do not correspond, and
        # updating one store by the other's ids rewrites the wrong rows.
        sq_rows = sqlite.execute(
            "SELECT id, author_id, author_name FROM comments").fetchall()
        cur.execute("SELECT id, author_id, author_name FROM comments")
        pg_rows = cur.fetchall()

        def plan(rows):
            """Rows whose stored form differs from what it should be.

            Recomputed rather than skipped-if-it-looks-masked: a row can
            already hold a pseudonym and still be wrong, which is exactly what
            happened when the label widened from four hex digits to six. Both
            helpers are idempotent on their own output, so this converges.
            """
            out = []
            for row_id, author_id, name in rows:
                want_id = anonymize.hash_author_id(author_id)
                want_name = anonymize.mask_author(author_id, name)
                if (want_id, want_name) != (author_id, name):
                    out.append((want_name, want_id, row_id))
            return out

        sq_updates = plan([(r["id"], r["author_id"], r["author_name"])
                           for r in sq_rows])
        pg_updates = plan(pg_rows)

        for label, rows, updates in (("SQLite", sq_rows, sq_updates),
                                     ("Neon", pg_rows, pg_updates)):
            print(f"{label:<7}: {len(rows)} comments, {len(updates)} to rewrite")
        people = len({m for m, _, _ in sq_updates} | {m for m, _, _ in pg_updates})
        print(f"  distinct people behind them: {people}")

        if not args.apply:
            for (mask, hashed, row_id) in sq_updates[:5]:
                before = next(r for r in sq_rows if r["id"] == row_id)
                print(f"    {before['author_name']!r} -> {mask!r}")
                print(f"      id {before['author_id']!r} -> {hashed[:16]!r}...")
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

        remaining = (
            "SELECT count(*) FROM comments WHERE "
            "(author_name NOT LIKE 'Akun {p}' AND author_name <> 'Anonim') "
            "OR (author_id <> '' AND length(author_id) <> 64)"
        )
        left_sq = sqlite.execute(remaining.format(p="%")).fetchone()[0]
        cur.execute(remaining.format(p="%%"))
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
