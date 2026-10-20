"""One-time move of /kurasi's home from Neon to jejak.db.

Until now the curator wrote to Neon and apply_curation.py copied each decision
down. From here /kurasi reads and writes jejak.db and Neon only receives what
the push sends. This brings down what existed only in Neon:

  1. every decision not yet applied (runs apply_curation.py --apply)
  2. events.curated — the verdicts themselves, which had no SQLite copy
  3. the names queue's decisions and notes (figure_candidates → candidate_review)

and then builds the names queue's evidence locally. Reads Neon; writes only
jejak.db. Safe to run twice: each step overwrites with Neon's values.

    python scripts/migrate_kurasi_local.py           # report only
    python scripts/migrate_kurasi_local.py --apply

Run it before the first push of the new sync, which sends events.curated up
from SQLite and would otherwise clear Neon's verdicts.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import apply_candidate_verdicts as candidates  # noqa: E402
import apply_curation  # noqa: E402
from jejak import candidate_queue, db  # noqa: E402

REVIEW_COLS = ("slug", "name", "verdict", "full_name", "aliases", "curated_role",
               "curated_slug", "curated_positions", "notes", "decided_at", "applied_at")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--apply", action="store_true", help="write; without it only report")
    args = ap.parse_args(argv)

    print("== 1. decisions still waiting in Neon")
    apply_curation.main(["--apply"] if args.apply else [])

    pg = candidates._connect_pg(candidates._load_database_url())
    db.init_db()
    conn = db.connect()
    try:
        with pg.cursor() as cur:
            cur.execute("SELECT id, curated FROM events WHERE curated IS NOT NULL")
            verdicts = cur.fetchall()
            cur.execute(f"SELECT {', '.join(REVIEW_COLS)} FROM figure_candidates "
                        "WHERE verdict IS NOT NULL OR notes IS NOT NULL")
            reviews = cur.fetchall()

        known = {r[0] for r in conn.execute("SELECT id FROM events")}
        missing = [v for v in verdicts if v[0] not in known]
        print(f"\n== 2. event verdicts: {len(verdicts)} in Neon, "
              f"{len(missing)} for events jejak.db does not have (dropped)")
        conn.executemany("UPDATE events SET curated = ? WHERE id = ?",
                         [(c, i) for i, c in verdicts if i in known])

        print(f"\n== 3. names-queue decisions and notes: {len(reviews)}")
        conn.executemany(
            f"""INSERT INTO candidate_review ({', '.join(REVIEW_COLS)})
                VALUES ({', '.join('?' * len(REVIEW_COLS))})
                ON CONFLICT (slug) DO UPDATE SET
                {', '.join(f'{c} = excluded.{c}' for c in REVIEW_COLS[2:])}""",
            reviews,
        )

        n = candidate_queue.refresh(conn)
        print(f"\n== 4. names queue rebuilt locally: {n} names")

        # What sync_to_neon.py checks before it will push verdicts up.
        conn.execute(
            """INSERT INTO pipeline_state (key, value, updated_at)
               VALUES ('kurasi_home', 'local', datetime('now'))
               ON CONFLICT (key) DO UPDATE SET value = 'local',
                 updated_at = excluded.updated_at""")

        if args.apply:
            conn.commit()
            print("\nDone. /kurasi can now run against jejak.db (JEJAK_DB in web/.env.local).")
        else:
            conn.rollback()
            print("\n(report only; nothing written — pass --apply)")
    finally:
        conn.close()
        pg.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
