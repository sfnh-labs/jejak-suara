"""jejak/cv_extract.py: only well-formed entries survive the model's JSON."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from jejak import cv_extract  # noqa: E402


def test_clean_keeps_only_complete_entries():
    out = cv_extract._clean({
        "positions": [{"role": "Gubernur", "org": "Sumatera Utara"}, {"org": "tanpa jabatan"}, "x"],
        "facts": [{"label": "Paman", "value": "Benny"}, {"label": "Kosong", "value": ""}],
        "education": [{"detail": "S1, UGM", "year": 2010}],
        "extra": "ignored",
    })
    assert out == {
        "positions": [{"role": "Gubernur", "org": "Sumatera Utara", "period": ""}],
        "facts": [{"label": "Paman", "value": "Benny"}],
        "education": [{"year": "2010", "detail": "S1, UGM"}],
    }
