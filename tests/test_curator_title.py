"""A title the curator set (events.title_by = 'curator') is the pipeline's to
leave: no retitling from headlines, no summary's title over it."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import cluster, db, summarize  # noqa: E402


def _conn(tmp_path: Path):
    path = tmp_path / "test.db"
    db.init_db(path)
    conn = db.connect(path)
    conn.execute("PRAGMA foreign_keys = OFF")
    for eid, by in ((1, None), (2, "curator")):
        conn.execute(
            "INSERT INTO events (id, figure_id, kind, title, event_date, status, created_at, title_by) "
            "VALUES (?, NULL, 'peristiwa', 'Judul lama', '2026-11-01', 'candidate', 'now', ?)", (eid, by))
        conn.execute(
            "INSERT INTO articles (id, figure_id, source, url, title, fetched_at, published_at, event_id) "
            "VALUES (?, 'x', 'Kompas', 'http://x', 'Judul dari berita', 'now', '2026-11-01', ?)", (f"a{eid}", eid))
    conn.commit()
    return conn


def _title(conn, eid: int) -> str:
    return conn.execute("SELECT title FROM events WHERE id = ?", (eid,)).fetchone()[0]


def test_retitling_from_headlines_skips_a_curator_title(tmp_path):
    conn = _conn(tmp_path)
    assert cluster.retitle_events(conn) == 1
    assert _title(conn, 1) == "Judul dari berita"
    assert _title(conn, 2) == "Judul lama"


def test_a_summary_keeps_a_curator_title(tmp_path):
    conn = _conn(tmp_path)
    for eid in (1, 2):
        summarize.store_draft(conn, {
            "event_id": eid, "summary_text": "Ringkasan.", "citations": [], "corroboration": 1,
            "single_source": True, "model": "test", "title": "Judul dari model", "category": "lainnya",
        })
    assert _title(conn, 1) == "Judul dari model"
    assert _title(conn, 2) == "Judul lama"
