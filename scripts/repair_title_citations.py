"""Strip the [Sumber N] markers left in already-stored event titles.

The model sometimes copies a bullet's citation marker into the heading
("Menyatakan senjata nuklir [Sumber 1]"). jejak/summarize.py strips it now;
this repairs the titles written before that. Only jejak.db changes: the next
Neon push sends the edited rows, since it ships every row whose contents
changed. A title that is nothing but markers and dividers once they are gone
is listed, not changed. Idempotent.

    python scripts/repair_title_citations.py            # dry run
    python scripts/repair_title_citations.py --apply
"""
from __future__ import annotations

import argparse
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak.summarize import clean_title  # noqa: E402

DB_PATH = ROOT / "jejak.db"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--apply", action="store_true", help="write the fixes (default: dry run)")
    args = ap.parse_args()

    conn = sqlite3.connect(DB_PATH)
    fixed = left = 0
    for eid, title in conn.execute(
            "SELECT id, title FROM events WHERE title LIKE '%[Sumber%'").fetchall():
        new = clean_title(title)
        if len(new.split()) < 3 or "---" in new:
            left += 1
            print(f"  left alone {eid}: {title!r}")
            continue
        fixed += 1
        print(f"  {eid}: {title!r} -> {new!r}")
        if args.apply:
            conn.execute("UPDATE events SET title = ? WHERE id = ?", (new, eid))
    if args.apply:
        conn.commit()
    print(f"{'fixed' if args.apply else 'would fix'} {fixed}, left alone {left}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
