"""Carry every decision made in /kurasi into the pipeline's working copy.

The curation pages write to Neon, because that is what the web app can reach;
the pipeline reads SQLite. This closes the loop for each kind of decision and
stamps `applied_at` in Neon so none is carried out twice:

  figure_candidates      promote / reject a discovered name
                         (delegates to apply_candidate_verdicts.py)
  figure_edits           a tracked figure's name, office and aliases — the
                         aliases are what attribution matches on, so this is
                         how a curator's correction reaches the next crawl
  figure_merges          a duplicate figure folded into another: its
                         records move and it is retired
  record_link_verdicts   confirmed / rejected record → peristiwa links;
                         link.py never re-proposes a rejected pair
  event_figure_rejections a related figure struck from a peristiwa;
                         promote_peristiwa stops re-adding them
  curation_reasons       why each event was kept or taken down; mirrored
                         whole into curation_labels every run, since it is
                         what jejak/curation_suggest.py learns from

    python scripts/apply_curation.py            # show what would happen
    python scripts/apply_curation.py --apply

publish_local runs this with --apply ahead of the stages, on the runs that
also push. Requires DATABASE_URL, which is never printed.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import apply_candidate_verdicts as candidates  # noqa: E402
from jejak import db as jejak_db  # noqa: E402
from jejak.roster import merge_figure  # noqa: E402


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def figure_edits(pg, conn: sqlite3.Connection) -> list[tuple[str, str]]:
    """Overwrite the roster rows a curator corrected. Returns (key, line)."""
    with pg.cursor() as cur:
        cur.execute(
            "SELECT figure_id, name, role, aliases, active, positions, "
            "bio, facts, education, sources FROM figure_edits "
            "WHERE applied_at IS NULL ORDER BY edited_at"
        )
        pending = cur.fetchall()
    done = []
    for figure_id, name, role, aliases, active, positions, bio, facts, education, sources in pending:
        row = conn.execute(
            "SELECT name, role, aliases, active, origin, positions FROM figures WHERE id = ?",
            (figure_id,),
        ).fetchone()
        if row is None:
            done.append((figure_id, f"no such figure locally: {figure_id} (skipped)"))
            continue
        cv = (positions, bio, facts, education, sources)
        conn.execute(
            "UPDATE figures SET name = ?, role = ?, aliases = ?, active = ?, "
            "positions = COALESCE(?, positions), bio = COALESCE(?, bio), "
            "facts = COALESCE(?, facts), education = COALESCE(?, education), "
            "sources = COALESCE(?, sources) WHERE id = ?",
            (name, role, aliases, 1 if active else 0, *cv, figure_id),
        )
        # A curator's CV is not overwritten by the next import_cv.py.
        if any(v is not None for v in cv):
            conn.execute("UPDATE figures SET cv_curated = 1 WHERE id = ?", (figure_id,))
        before = set(json.loads(row["aliases"] or "[]"))
        after = set(json.loads(aliases or "[]"))
        change = []
        if row["name"] != name:
            change.append(f"name {row['name']!r} -> {name!r}")
        if (row["role"] or "") != (role or ""):
            change.append(f"role {row['role']!r} -> {role!r}")
        if after - before:
            change.append("+aliases " + ", ".join(sorted(after - before)))
        if before - after:
            change.append("-aliases " + ", ".join(sorted(before - after)))
        if positions is not None and positions != row["positions"]:
            n = len(json.loads(positions or "[]"))
            change.append(f"positions -> {n} entr{'y' if n == 1 else 'ies'}")
        if any(v is not None for v in (bio, facts, education, sources)):
            change.append("CV edited")
        if bool(row["active"]) != bool(active):
            change.append("activated" if active else "deactivated")
        line = f"figure {figure_id}: " + ("; ".join(change) or "unchanged")
        # figures.toml re-seeds a rebuilt database and would undo this.
        if row["origin"] == "config":
            line += "\n    note: figure comes from figures.toml — mirror the edit there"
        done.append((figure_id, line))
    return done


def figure_merges(pg, conn: sqlite3.Connection) -> list[tuple[str, str]]:
    with pg.cursor() as cur:
        cur.execute(
            "SELECT from_id, into_id FROM figure_merges "
            "WHERE applied_at IS NULL ORDER BY decided_at"
        )
        pending = cur.fetchall()
    done = []
    for from_id, into_id in pending:
        lines = merge_figure(conn, from_id, into_id)
        head = f"merge {from_id} -> {into_id}"
        done.append((from_id, head + "".join(f"\n    {line}" for line in lines)
                     if lines else head + ": nothing to move"))
    return done


def link_verdicts(pg, conn: sqlite3.Connection) -> list[tuple[tuple[int, int], str]]:
    with pg.cursor() as cur:
        cur.execute(
            "SELECT record_id, peristiwa_id, verdict FROM record_link_verdicts "
            "WHERE applied_at IS NULL ORDER BY decided_at"
        )
        pending = cur.fetchall()
    done = []
    for record_id, peristiwa_id, verdict in pending:
        known = conn.execute(
            "SELECT count(*) FROM events WHERE id IN (?, ?)", (record_id, peristiwa_id)
        ).fetchone()[0]
        if known < 2:
            done.append(((record_id, peristiwa_id),
                         f"link {record_id}->{peristiwa_id}: event missing locally (skipped)"))
            continue
        if verdict is None:
            # Withdrawn: back to a plain proposal, or gone if it never was one.
            conn.execute(
                "UPDATE record_links SET verdict = NULL "
                "WHERE record_id = ? AND peristiwa_id = ?",
                (record_id, peristiwa_id),
            )
            conn.execute(
                "DELETE FROM record_links "
                "WHERE record_id = ? AND peristiwa_id = ? AND origin = 'curator'",
                (record_id, peristiwa_id),
            )
            verdict = "withdrawn"
        else:
            # A confirmed pair the pipeline never proposed is the curator's own.
            conn.execute(
                """INSERT INTO record_links
                       (record_id, peristiwa_id, origin, verdict, created_at)
                   VALUES (?, ?, 'curator', ?, ?)
                   ON CONFLICT (record_id, peristiwa_id) DO UPDATE SET
                       verdict = excluded.verdict""",
                (record_id, peristiwa_id, verdict, _now()),
            )
        done.append(((record_id, peristiwa_id),
                     f"link {record_id}->{peristiwa_id}: {verdict}"))
    return done


def figure_rejections(pg, conn: sqlite3.Connection) -> list[tuple[tuple[int, str, bool], str]]:
    with pg.cursor() as cur:
        cur.execute(
            "SELECT event_id, figure_id, struck, decided_at FROM event_figure_rejections "
            "WHERE applied_at IS NULL"
        )
        pending = cur.fetchall()
    done = []
    for event_id, figure_id, struck, decided_at in pending:
        if struck:
            conn.execute(
                "INSERT OR IGNORE INTO event_figure_rejections "
                "(event_id, figure_id, decided_at) VALUES (?, ?, ?)",
                (event_id, figure_id, decided_at),
            )
            conn.execute(
                "DELETE FROM event_figures WHERE event_id = ? AND figure_id = ?",
                (event_id, figure_id),
            )
            line = f"peristiwa {event_id}: struck {figure_id}"
        else:
            # promote_peristiwa adds them back on its next pass if the
            # coverage still names them.
            conn.execute(
                "DELETE FROM event_figure_rejections WHERE event_id = ? AND figure_id = ?",
                (event_id, figure_id),
            )
            line = f"peristiwa {event_id}: restored {figure_id}"
        done.append(((event_id, figure_id, bool(struck)), line))
    return done


LABEL_COLS = ("event_id", "verdict", "reasons", "note", "kind", "figure_id",
              "title", "summary", "outlets", "suggested", "decided_at")


def curation_labels(pg, conn: sqlite3.Connection) -> int:
    """Replace the local copy of the curator's labels with Neon's. Returns the count.

    The whole table every time rather than unapplied rows: jejak.db is a
    disposable working copy, and a rebuilt one has to get every label back.
    """
    import psycopg2.errors

    try:
        with pg.cursor() as cur:
            cur.execute(f"SELECT {', '.join(LABEL_COLS)} FROM curation_reasons")
            rows = cur.fetchall()
    except psycopg2.errors.UndefinedTable:
        # Neon predates the table; the next push's apply_schema creates it.
        pg.rollback()
        return 0
    conn.execute("DELETE FROM curation_labels")
    conn.executemany(
        f"INSERT INTO curation_labels ({', '.join(LABEL_COLS)}) "
        f"VALUES ({', '.join('?' * len(LABEL_COLS))})",
        rows,
    )
    return len(rows)


def main(argv: list[str] | None = None) -> int:
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--apply", action="store_true",
                    help="write the decisions; without it this only reports")
    args = ap.parse_args(argv)

    print("== discovered names")
    candidates.main(["--apply"] if args.apply else [])

    pg = candidates._connect_pg(candidates._load_database_url())
    jejak_db.init_db()
    conn = jejak_db.connect()
    try:
        edits = figure_edits(pg, conn)
        merges = figure_merges(pg, conn)
        links = link_verdicts(pg, conn)
        struck = figure_rejections(pg, conn)
        labels = curation_labels(pg, conn)
        print("\n== figures, links and related figures")
        for _, line in [*edits, *merges, *links, *struck]:
            print(("apply " if args.apply else "would ") + line)
        if not (edits or merges or links or struck):
            print("nothing waiting to be applied")
        print(f"\n== curation labels\n{'copied' if args.apply else 'would copy'} {labels}")
        if not args.apply:
            conn.rollback()
            return 0
        conn.commit()

        now = _now()
        with pg.cursor() as cur:
            cur.executemany(
                "UPDATE figure_edits SET applied_at = %s WHERE figure_id = %s",
                [(now, key) for key, _ in edits],
            )
            cur.executemany(
                "UPDATE figure_merges SET applied_at = %s WHERE from_id = %s",
                [(now, key) for key, _ in merges],
            )
            cur.executemany(
                "UPDATE record_link_verdicts SET applied_at = %s "
                "WHERE record_id = %s AND peristiwa_id = %s",
                [(now, *key) for key, _ in links],
            )
            # A withdrawal has nothing left to say once SQLite has it. A hand-made
            # link the push already copied up (score NULL: link.py never scored
            # it) goes with it, since push upserts and never deletes.
            cur.execute(
                """DELETE FROM record_links l USING record_link_verdicts v
                    WHERE v.record_id = l.record_id AND v.peristiwa_id = l.peristiwa_id
                      AND v.verdict IS NULL AND v.applied_at IS NOT NULL
                      AND l.score IS NULL"""
            )
            cur.execute(
                "DELETE FROM record_link_verdicts "
                "WHERE verdict IS NULL AND applied_at IS NOT NULL"
            )
            cur.executemany(
                "UPDATE event_figure_rejections SET applied_at = %s "
                "WHERE event_id = %s AND figure_id = %s",
                [(now, e, f) for (e, f, _), _ in struck],
            )
            cur.execute(
                "DELETE FROM event_figure_rejections "
                "WHERE NOT struck AND applied_at IS NOT NULL"
            )
            # The struck row would otherwise sit in Neon forever: push upserts,
            # it never deletes.
            cur.executemany(
                "DELETE FROM event_figures WHERE event_id = %s AND figure_id = %s",
                [(e, f) for (e, f, is_struck), _ in struck if is_struck],
            )
        pg.commit()
        if edits:
            print("\nAliases changed. New coverage is attributed with them from the")
            print("next run; to re-attribute history as well:")
            print("  python -m jejak.cli mentions --reattribute --gains-only")
    finally:
        conn.close()
        pg.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
