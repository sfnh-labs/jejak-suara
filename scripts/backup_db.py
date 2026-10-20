"""Copy jejak.db to backups/, keeping the newest few.

jejak.db is the only home of the curator's work — verdicts and their reasons,
figure edits, merges, name decisions and notes, link rulings — since /kurasi
writes there and Neon only receives the result. publish_local runs this first
on every run.

Uses SQLite's backup API, so the copy is consistent even while the pipeline
or /kurasi is writing.

    python scripts/backup_db.py            # keep the newest 7
    python scripts/backup_db.py --keep 14
"""
from __future__ import annotations

import argparse
import sqlite3
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB = ROOT / "jejak.db"
BACKUPS = ROOT / "backups"


def backup(db: Path = DB, folder: Path = BACKUPS, keep: int = 7) -> tuple[Path, list[Path]]:
    """Write a dated copy and drop the oldest beyond `keep`. Returns (copy, removed)."""
    folder.mkdir(exist_ok=True)
    target = folder / f"jejak-{datetime.now():%Y-%m-%d-%H%M}.db"
    src = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=60)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    # The names sort by date, so the oldest come first.
    copies = sorted(folder.glob("jejak-*.db"))
    removed = copies[:-keep] if keep > 0 else []
    for old in removed:
        old.unlink()
    return target, removed


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    ap.add_argument("--keep", type=int, default=7, help="copies to keep (default 7)")
    args = ap.parse_args(argv)
    target, removed = backup(keep=args.keep)
    size = target.stat().st_size / 1e6
    print(f"backup: {target.relative_to(ROOT)} ({size:.0f} MB)"
          + (f", removed {len(removed)} older" if removed else ""))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
