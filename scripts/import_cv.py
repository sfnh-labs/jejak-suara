"""Load the generated CVs in cv/<figure-id>.json into the pipeline's roster.

A figure's CV is not a separate entity: it is columns on its `figures` row
(bio, facts, positions, education, sources, cv_checked_at). `positions` is both
the CV's career list and where the one-line title under a name comes from —
`role` is the first position — so an office is recorded once, here.

The JSON files are the seed. Once a curator edits the figure's offices or CV
in /kurasi, apply_curation.py sets `cv_curated` and this script leaves that
figure alone, so regenerating a CV never undoes a human correction. Pass
--force to overwrite anyway.

    python scripts/import_cv.py            # show what would change
    python scripts/import_cv.py --apply
    python scripts/import_cv.py --apply --force

File format (every key optional except positions, which may be empty):

    {
      "bio": "...",
      "facts": [{"label": "Lahir", "value": "Kudus, 12 Oktober 1973"}],
      "positions": [{"role": "Menteri ATR/Kepala BPN", "org": "", "period": "2024 – kini"}],
      "education": [{"year": "1997", "detail": "..."}],
      "sources": [{"label": "Wikipedia bahasa Indonesia", "url": "https://..."}],
      "checkedAt": "2026-10-14"
    }

The first position is the main, current one. "Jabatan kini" is not a fact:
the page derives it from that first position.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db  # noqa: E402

CV_DIR = ROOT / "cv"


def _title(position: dict) -> str:
    return " ".join(p for p in (position.get("role", "").strip(),
                                position.get("org", "").strip()) if p)


def load(path: Path) -> dict:
    data = json.loads(path.read_text(encoding="utf-8"))
    positions = [
        {"role": str(p.get("role", "")).strip(), "org": str(p.get("org", "")).strip(),
         "period": str(p.get("period", "")).strip()}
        for p in data.get("positions", [])
        if str(p.get("role", "")).strip() or str(p.get("org", "")).strip()
    ]
    facts = [f for f in data.get("facts", []) if f.get("label") != "Jabatan kini"]
    return {
        "bio": (data.get("bio") or "").strip() or None,
        "facts": facts,
        "positions": positions,
        "education": data.get("education", []),
        "sources": data.get("sources", []),
        "checkedAt": data.get("checkedAt"),
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--apply", action="store_true", help="write; without it only report")
    ap.add_argument("--force", action="store_true",
                    help="also overwrite figures a curator has edited")
    args = ap.parse_args(argv)

    db.init_db()
    conn = db.connect()
    try:
        for path in sorted(CV_DIR.glob("*.json")):
            figure_id = path.stem
            row = conn.execute(
                "SELECT cv_curated, positions, bio FROM figures WHERE id = ?", (figure_id,)
            ).fetchone()
            if row is None:
                print(f"skip {figure_id}: no such figure")
                continue
            if row["cv_curated"] and not args.force:
                print(f"skip {figure_id}: edited by a curator (use --force to overwrite)")
                continue
            cv = load(path)
            dumps = lambda v: json.dumps(v, ensure_ascii=False)  # noqa: E731
            new = (cv["bio"], dumps(cv["facts"]), dumps(cv["positions"]),
                   dumps(cv["education"]), dumps(cv["sources"]), cv["checkedAt"])
            current = conn.execute(
                "SELECT bio, facts, positions, education, sources, cv_checked_at "
                "FROM figures WHERE id = ?", (figure_id,)).fetchone()
            if tuple(current) == new:
                continue
            conn.execute(
                "UPDATE figures SET bio = ?, facts = ?, positions = ?, education = ?, "
                "sources = ?, cv_checked_at = ? WHERE id = ?", (*new, figure_id))
            # The title under the name follows the main position.
            if cv["positions"]:
                conn.execute("UPDATE figures SET role = ? WHERE id = ?",
                             (_title(cv["positions"][0]), figure_id))
            print(f"{'import' if args.apply else 'would import'} {figure_id}: "
                  f"{len(cv['positions'])} positions, {len(cv['facts'])} facts, "
                  f"{len(cv['education'])} education")
        if args.apply:
            conn.commit()
        else:
            conn.rollback()
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
