"""scripts/apply_candidate_verdicts.py: a promote creates what the curator typed."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import apply_candidate_verdicts as acv  # noqa: E402
from jejak import db  # noqa: E402


def _conn(tmp_path):
    path = tmp_path / "t.db"
    db.init_db(path)
    c = db.connect(path)
    c.execute("INSERT INTO figure_candidates (slug, name, status) VALUES ('hafidz', 'Hafidz', 'candidate')")
    return c


def test_positions_become_the_figures_offices(tmp_path):
    c = _conn(tmp_path)
    positions = [{"role": "Pengasuh", "org": "Darul Mustafa", "period": "1994 – kini"},
                 {"role": "Ulama", "org": "", "period": ""}]
    line = acv._promote(c, "hafidz", "Hafidz", "Habib Umar", "Hafidz", "ignored",
                        "habib-umar", json.dumps(positions))
    assert line.startswith("promoted hafidz -> habib-umar")
    row = c.execute("SELECT name, role, positions, aliases FROM figures WHERE id = 'habib-umar'").fetchone()
    assert row["role"] == "Pengasuh Darul Mustafa"
    assert json.loads(row["positions"]) == positions
    assert json.loads(row["aliases"]) == ["Habib Umar", "Hafidz"]


def test_role_alone_still_works(tmp_path):
    c = _conn(tmp_path)
    acv._promote(c, "hafidz", "Hafidz", "Habib Umar", None, "Ulama")
    row = c.execute("SELECT role, positions FROM figures WHERE id = 'habib-umar'").fetchone()
    assert (row["role"], row["positions"]) == ("Ulama", None)
