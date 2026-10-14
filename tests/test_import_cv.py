"""scripts/import_cv.py: generated CVs seed the roster but never undo a curator."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import import_cv  # noqa: E402
from jejak import db  # noqa: E402

CV = {
    "bio": "Menteri.",
    "facts": [{"label": "Lahir", "value": "Kudus"}, {"label": "Jabatan kini", "value": "x"}],
    "positions": [{"role": "Menteri ATR", "org": "Kabinet Merah Putih", "period": "2024 – kini"}],
    "education": [{"detail": "S1"}],
    "sources": [{"label": "Wiki", "url": "https://example.org"}],
    "checkedAt": "2026-10-14",
}


def _setup(tmp_path, monkeypatch, curated: int):
    path = tmp_path / "t.db"
    db.init_db(path)
    monkeypatch.setattr(db, "init_db", lambda p=path: None)
    real_connect = db.connect
    monkeypatch.setattr(db, "connect", lambda p=path: real_connect(path))
    c = real_connect(path)
    c.execute("INSERT INTO figures (id, name, role, aliases, cv_curated) "
              "VALUES ('nusron-wahid', 'Nusron Wahid', 'Menteri', '[]', ?)", (curated,))
    c.commit()
    cv_dir = tmp_path / "cv"
    cv_dir.mkdir()
    (cv_dir / "nusron-wahid.json").write_text(json.dumps(CV))
    monkeypatch.setattr(import_cv, "CV_DIR", cv_dir)
    return c


def test_import_fills_the_cv_and_the_title(tmp_path, monkeypatch):
    c = _setup(tmp_path, monkeypatch, curated=0)
    import_cv.main(["--apply"])
    row = c.execute("SELECT role, positions, facts FROM figures").fetchone()
    assert row["role"] == "Menteri ATR Kabinet Merah Putih"
    assert json.loads(row["positions"])[0]["period"] == "2024 – kini"
    # The current office is derived from the first position, never stored twice.
    assert [f["label"] for f in json.loads(row["facts"])] == ["Lahir"]


def test_curated_figure_is_left_alone(tmp_path, monkeypatch):
    c = _setup(tmp_path, monkeypatch, curated=1)
    import_cv.main(["--apply"])
    row = c.execute("SELECT role, positions FROM figures").fetchone()
    assert (row["role"], row["positions"]) == ("Menteri", None)
