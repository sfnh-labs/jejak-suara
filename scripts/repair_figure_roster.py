"""Undo the roster damage the old name-folding rule left behind.

`mentions._same_as_tracked` used to fold any candidate that *contained* a
tracked alias into that figure. A one-word alias made that a surname match, so
"Listyo Sigit Prabowo" (the former Kapolri) and the headline fragment "Prabowo
Didit" were filed as aliases of Prabowo Subianto. The rule is fixed now; this
repairs what it wrote:

  * Prabowo loses those two aliases. With them gone, the next `mentions` run
    promotes Listyo Sigit Prabowo as a figure of his own, and the new rule no
    longer folds him back.
  * "Pol Listyo Sigit" and "Polisi Listyo Sigit" are retired: rank words read
    as first names ("Kapolri Jenderal Pol Listyo Sigit"), with no records.
  * Nicknames ("Gus Ipul", "Cak Imin") join the figure they name, and the
    five records filed under "Saifullah Yusuf" join the established Gus Ipul page.
  * "Ahmad Muzani Tutup", a headline verb read as a surname ("Ahmad Muzani
    Tutup Rakernas Gerindra"), was promoted on the same run as Ahmad Muzani and
    took most of his coverage. Its records, articles and peristiwa links move
    to ahmad-muzani and the duplicate is retired.

SQLite only. The next `sync_to_neon.py --push` carries everything: figures are
upserted with their active flag, and moved events and articles hash
differently, so they are sent again. Idempotent.

    python scripts/repair_figure_roster.py           # dry run
    python scripts/repair_figure_roster.py --apply
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db  # noqa: E402
from jejak.roster import merge_figure  # noqa: E402

DROP_ALIASES = {"prabowo-subianto": ["Listyo Sigit Prabowo", "Prabowo Didit"]}
# Nicknames the press uses as often as the name. The extractor now keeps "Gus"
# and similar honorifics, so without these each would be promoted as a second
# person — "Gus Ipul" already had been.
ADD_ALIASES = {
    "gus-ipul": ["Saifullah Yusuf"],
    "muhaimin-iskandar": ["Cak Imin", "Gus Imin", "Gus Muhaimin", "Abdul Muhaimin Iskandar"],
    "yaqut-cholil-qoumas": ["Gus Yaqut"],
}
RETIRE = ["pol-listyo-sigit", "polisi-listyo-sigit"]
MERGE = {  # duplicate -> the real one
    "ahmad-muzani-tutup": "ahmad-muzani",
    # The other way round: /tokoh/gus-ipul is the page with the history.
    "saifullah-yusuf": "gus-ipul",
}


def repair(conn: sqlite3.Connection) -> list[str]:
    done: list[str] = []

    for fid, drop in DROP_ALIASES.items():
        row = conn.execute("SELECT aliases FROM figures WHERE id = ?", (fid,)).fetchone()
        if row is None:
            continue
        aliases = json.loads(row["aliases"] or "[]")
        unwanted = {a.lower() for a in drop}
        kept = [a for a in aliases if a.lower() not in unwanted]
        if kept != aliases:
            conn.execute("UPDATE figures SET aliases = ? WHERE id = ?",
                         (json.dumps(kept, ensure_ascii=False), fid))
            done.append(f"{fid}: dropped aliases {sorted(set(aliases) - set(kept))}")

    for fid, add in ADD_ALIASES.items():
        row = conn.execute("SELECT aliases FROM figures WHERE id = ?", (fid,)).fetchone()
        if row is None:
            continue
        aliases = json.loads(row["aliases"] or "[]")
        have = {a.lower() for a in aliases}
        new = [a for a in add if a.lower() not in have]
        if new:
            conn.execute("UPDATE figures SET aliases = ? WHERE id = ?",
                         (json.dumps(aliases + new, ensure_ascii=False), fid))
            done.append(f"{fid}: added aliases {new}")

    for dup, real in MERGE.items():
        done += merge_figure(conn, dup, real)

    for fid in RETIRE:
        n = conn.execute("UPDATE figures SET active = 0 WHERE id = ? AND active = 1",
                         (fid,)).rowcount
        if n:
            done.append(f"{fid}: retired")
    return done


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--apply", action="store_true", help="write the changes")
    args = parser.parse_args()

    conn = db.connect()
    try:
        done = repair(conn)
        for line in done or ["nothing to repair"]:
            print(line)
        if args.apply:
            conn.commit()
            print("applied. Push with: python scripts/sync_to_neon.py --push")
        else:
            conn.rollback()
            print("dry run; re-run with --apply to write")
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
