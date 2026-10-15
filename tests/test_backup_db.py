"""scripts/backup_db.py: a consistent copy, and only the newest few kept."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import backup_db  # noqa: E402


def test_copies_and_keeps_the_newest(tmp_path):
    db = tmp_path / "jejak.db"
    c = sqlite3.connect(db)
    c.execute("CREATE TABLE t (x)")
    c.execute("INSERT INTO t VALUES (1)")
    c.commit()
    c.close()
    folder = tmp_path / "backups"
    folder.mkdir()
    for day in range(1, 5):
        (folder / f"jejak-2026-01-0{day}-0500.db").write_bytes(b"old")

    target, removed = backup_db.backup(db, folder, keep=3)

    assert sqlite3.connect(target).execute("SELECT x FROM t").fetchone() == (1,)
    assert [p.name for p in removed] == ["jejak-2026-01-01-0500.db", "jejak-2026-01-02-0500.db"]
    assert len(list(folder.glob("jejak-*.db"))) == 3
