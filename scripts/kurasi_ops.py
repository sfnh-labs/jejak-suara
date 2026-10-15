"""The /kurasi decisions whose logic lives in the pipeline, run against jejak.db.

/kurasi writes most decisions to jejak.db itself. These few reuse the
pipeline's own code rather than a second copy of it in TypeScript, and the
page calls this script the moment the curator decides:

    python scripts/kurasi_ops.py candidate <slug>        # apply the queued verdict
    python scripts/kurasi_ops.py merge <from-id> <into-id>
    python scripts/kurasi_ops.py refresh                 # rebuild the names queue

Prints one line saying what happened. Exits 1, with the reason on stderr,
when the decision cannot be carried out (a page address already taken, an
unknown figure), so the page can say so.
"""
from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import apply_candidate_verdicts as verdicts  # noqa: E402
from jejak import candidate_queue, db  # noqa: E402
from jejak.roster import merge_figure  # noqa: E402


class Refused(Exception):
    """A decision that cannot be carried out as given."""


def apply_candidate(conn, slug: str) -> str:
    row = conn.execute(
        """SELECT slug, name, verdict, full_name, aliases, curated_role, curated_slug,
                  curated_positions FROM candidate_review WHERE slug = ?""",
        (slug,),
    ).fetchone()
    if row is None:
        raise Refused(f"no such name in the queue: {slug}")
    now = datetime.now(timezone.utc).isoformat()
    if row["verdict"] == "promote":
        line = verdicts._promote(conn, slug, row["name"], row["full_name"], row["aliases"],
                                 row["curated_role"], row["curated_slug"],
                                 row["curated_positions"])
        if line.startswith("already a figure"):
            raise Refused(line)
    elif row["verdict"] == "reject":
        line = verdicts._reject(conn, slug)
    else:
        # A reject withdrawn: discovery may offer the name again. A promote
        # cannot be withdrawn this way — the figure exists; retire it instead.
        conn.execute(
            "UPDATE figure_candidates SET status = 'candidate' "
            "WHERE slug = ? AND status = 'rejected'", (slug,))
        line = f"cleared {slug}"
        now = None
    conn.execute("UPDATE candidate_review SET applied_at = ? WHERE slug = ?", (now, slug))
    return line


def merge(conn, from_id: str, into_id: str) -> str:
    if from_id == into_id:
        raise Refused("cannot merge a figure into itself")
    known = {r["id"]: r for r in conn.execute(
        "SELECT id, active FROM figures WHERE id IN (?, ?)", (from_id, into_id))}
    if from_id not in known or into_id not in known:
        raise Refused("unknown figure")
    if not known[into_id]["active"]:
        raise Refused(f"{into_id} is retired; merge into an active figure")
    lines = merge_figure(conn, from_id, into_id)
    return f"merge {from_id} -> {into_id}: " + ("; ".join(lines) or "nothing to move")


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--db", default=str(db.DEFAULT_DB),
                    help="the database /kurasi uses (JEJAK_DB); default jejak.db")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("candidate").add_argument("slug")
    m = sub.add_parser("merge")
    m.add_argument("from_id")
    m.add_argument("into_id")
    sub.add_parser("refresh")
    args = ap.parse_args(argv)

    db.init_db(args.db)
    conn = db.connect(args.db)
    try:
        if args.cmd == "candidate":
            line = apply_candidate(conn, args.slug)
        elif args.cmd == "merge":
            line = merge(conn, args.from_id, args.into_id)
        else:
            line = f"{candidate_queue.refresh(conn)} names in the queue"
        conn.commit()
    except Refused as e:
        conn.rollback()
        print(str(e), file=sys.stderr)
        return 1
    finally:
        conn.close()
    print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
