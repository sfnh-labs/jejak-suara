"""jejak/failures.py: a stage stops retrying an event the model keeps failing on."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db, failures, summarize  # noqa: E402

NOW = "2026-10-15T10:00:00+00:00"


def test_summarize_gives_up_on_an_event_that_keeps_timing_out(tmp_path, monkeypatch):
    path = tmp_path / "test.db"
    db.init_db(path)
    conn = db.connect(path)
    conn.execute("INSERT INTO figures (id, name) VALUES ('ferry', 'Ferry Juliantono')")
    for eid in (1, 2):
        conn.execute(
            "INSERT INTO events (id, figure_id, kind, title, event_date, status, created_at) "
            "VALUES (?, 'ferry', 'record', 't', ?, 'new', ?)", (eid, NOW, NOW))
    conn.commit()
    tried = []

    def summarize_event(conn, eid):
        tried.append(eid)
        if eid == 1:
            raise TimeoutError
        return {"event_id": eid}

    monkeypatch.setattr(summarize, "summarize_event", summarize_event)
    for _ in range(failures.MAX_FAILURES):
        summarize.summarize_pending(conn)
    assert tried.count(1) == failures.MAX_FAILURES

    tried.clear()
    summarize.summarize_pending(conn)
    assert tried == [2]

    conn.execute("DELETE FROM stage_failures WHERE stage = 'summarize' AND event_id = 1")
    tried.clear()
    summarize.summarize_pending(conn)
    assert tried == [1, 2]
