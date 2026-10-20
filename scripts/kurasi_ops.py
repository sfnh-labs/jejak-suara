"""The /kurasi decisions whose logic lives in the pipeline, run against jejak.db.

/kurasi writes most decisions to jejak.db itself. These few reuse the
pipeline's own code rather than a second copy of it in TypeScript, and the
page calls this script the moment the curator decides:

    python scripts/kurasi_ops.py candidate <slug>        # apply the queued verdict
    python scripts/kurasi_ops.py merge <from-id> <into-id>
    python scripts/kurasi_ops.py not-a-person <figure-id>
    python scripts/kurasi_ops.py refresh                 # rebuild the names queue
    python scripts/kurasi_ops.py rework <request-id>     # draft a rework (Ollama)
    python scripts/kurasi_ops.py rework-accept <request-id>
    python scripts/kurasi_ops.py cv-draft <proposal-id>    # draft CV entries (Ollama)

Prints one line saying what happened. Exits 1, with the reason on stderr,
when the decision cannot be carried out (a page address already taken, an
unknown figure), so the page can say so.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import apply_candidate_verdicts as verdicts  # noqa: E402
from jejak import candidate_queue, db, summarize  # noqa: E402,F401  (summarize: tests patch it)
from jejak.kurasi import (  # noqa: E402
    Refused, _now, accept_rework, draft_cv, run_rework,
)
from jejak.roster import merge_figure  # noqa: E402


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
    elif row["verdict"] == "alias":
        line = add_alias(conn, slug, row["name"], row["curated_slug"])
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


def add_alias(conn, slug: str, name: str, figure_id: str | None) -> str:
    """A discovered name that is a tracked figure written another way.

    The spelling joins that figure's aliases, so attribution matches it from
    now on, and discovery stops offering it as someone new.
    """
    fig = conn.execute("SELECT name, aliases, active FROM figures WHERE id = ?",
                       (figure_id or "",)).fetchone()
    if fig is None:
        raise Refused(f"unknown figure: {figure_id}")
    if not fig["active"]:
        raise Refused(f"{figure_id} is retired; choose the figure it was merged into")
    aliases = json.loads(fig["aliases"] or "[]")
    if name.lower() not in {a.lower() for a in [fig["name"], *aliases]}:
        aliases.append(name)
        conn.execute("UPDATE figures SET aliases = ? WHERE id = ?",
                     (json.dumps(aliases, ensure_ascii=False), figure_id))
    conn.execute(
        "UPDATE figure_candidates SET status = 'tracked', promoted_at = ? WHERE slug = ?",
        (datetime.now(timezone.utc).isoformat(), slug))
    return f"alias {slug} -> {figure_id}: {name!r} added"


def not_a_person(conn, figure_id: str) -> str:
    """A tracked "figure" that is no one — a place, an office, a headline
    fragment ("Istana Merdeka"). Retired, so attribution stops matching it and
    discovery never offers the name again (its id stays taken); taken off every
    peristiwa it was related to; its articles left unattributed for the next
    reattribution to place; and any record it owned taken down, since a record
    is one person's act and this was nobody's.
    """
    fig = conn.execute("SELECT name FROM figures WHERE id = ?", (figure_id,)).fetchone()
    if fig is None:
        raise Refused(f"unknown figure: {figure_id}")
    now = _now()
    conn.execute("UPDATE figures SET active = 0 WHERE id = ?", (figure_id,))
    conn.execute("UPDATE figure_candidates SET status = 'rejected' WHERE slug = ?", (figure_id,))
    related = conn.execute("DELETE FROM event_figures WHERE figure_id = ?", (figure_id,)).rowcount
    articles = conn.execute("UPDATE articles SET figure_id = NULL WHERE figure_id = ?",
                            (figure_id,)).rowcount
    records = [r[0] for r in conn.execute(
        "SELECT id FROM events WHERE figure_id = ? AND kind = 'record' AND curated IS NOT 'rejected'",
        (figure_id,))]
    for event_id in records:
        conn.execute("UPDATE events SET curated = 'rejected' WHERE id = ?", (event_id,))
        conn.execute(
            """INSERT INTO curation_labels (event_id, verdict, reasons, note, kind, figure_id,
                                            title, decided_at)
               SELECT id, 'rejected', '["wrong_person"]', ?, kind, figure_id, title, ?
                 FROM events WHERE id = ?
               ON CONFLICT (event_id) DO UPDATE SET verdict = 'rejected',
                 reasons = excluded.reasons, note = excluded.note, decided_at = excluded.decided_at""",
            (f"{fig['name']} bukan orang", now, event_id))
    return (f"not a person: {figure_id} retired; off {related} peristiwa, "
            f"{articles} articles unattributed, {len(records)} records taken down")


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
    sub.add_parser("not-a-person").add_argument("figure_id")
    sub.add_parser("refresh")
    sub.add_parser("rework").add_argument("request_id", type=int)
    sub.add_parser("rework-accept").add_argument("request_id", type=int)
    sub.add_parser("cv-draft").add_argument("proposal_id", type=int)
    args = ap.parse_args(argv)

    db.init_db(args.db)
    conn = db.connect(args.db)
    try:
        if args.cmd == "candidate":
            line = apply_candidate(conn, args.slug)
        elif args.cmd == "merge":
            line = merge(conn, args.from_id, args.into_id)
        elif args.cmd == "not-a-person":
            line = not_a_person(conn, args.figure_id)
        elif args.cmd == "rework":
            line = run_rework(conn, args.request_id)
        elif args.cmd == "rework-accept":
            line = accept_rework(conn, args.request_id)
        elif args.cmd == "cv-draft":
            line = draft_cv(conn, args.proposal_id)
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
