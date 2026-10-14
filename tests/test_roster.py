"""jejak/roster.py: folding a duplicate figure into the real one."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db  # noqa: E402
from jejak.roster import merge_figure  # noqa: E402


def test_merge_moves_records_and_retires_the_duplicate(tmp_path):
    db.init_db(tmp_path / "t.db")
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO figures (id, name, aliases) VALUES "
              "('cak-imin', 'Cak Imin', '[\"Cak Imin\"]'), "
              "('muhaimin-iskandar', 'Muhaimin Iskandar', '[\"Muhaimin Iskandar\"]')")
    c.execute("INSERT INTO events (id, figure_id, kind, status, created_at) "
              "VALUES (1, 'cak-imin', 'record', 'new', 'x'), (2, NULL, 'peristiwa', 'new', 'x')")
    c.execute("INSERT INTO event_figures (event_id, figure_id) VALUES (2, 'cak-imin')")

    assert merge_figure(c, "cak-imin", "muhaimin-iskandar")
    assert merge_figure(c, "cak-imin", "muhaimin-iskandar") == []  # idempotent

    assert c.execute("SELECT figure_id FROM events WHERE id = 1").fetchone()[0] == "muhaimin-iskandar"
    assert [r[0] for r in c.execute("SELECT figure_id FROM event_figures")] == ["muhaimin-iskandar"]
    aliases = json.loads(c.execute(
        "SELECT aliases FROM figures WHERE id = 'muhaimin-iskandar'").fetchone()[0])
    assert aliases == ["Muhaimin Iskandar", "Cak Imin"]
    assert c.execute("SELECT active FROM figures WHERE id = 'cak-imin'").fetchone()[0] == 0
