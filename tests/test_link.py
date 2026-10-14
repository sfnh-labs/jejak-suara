"""jejak/link.py: proposing record → peristiwa links, and honouring rulings."""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import cluster, db, link  # noqa: E402

NOW = "2026-10-05T10:00:00+00:00"


@pytest.fixture
def conn(tmp_path, monkeypatch):
    # _tokens strips tracked figures' names, which reads the real roster.
    monkeypatch.setattr(cluster, "_figure_terms", lambda: set())
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    yield c
    c.close()


def _event(conn: sqlite3.Connection, eid: int, kind: str, title: str,
           vec: list[float], figure: str | None = None) -> None:
    conn.execute(
        "INSERT INTO events (id, figure_id, kind, title, event_date, last_seen, "
        "status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
        (eid, figure, kind, title, NOW, NOW, NOW),
    )
    aid = f"a{eid}"
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, fetched_at, "
        "published_at, event_id) VALUES (?, ?, 'x', ?, ?, ?, ?, ?)",
        (aid, figure, f"https://x/{eid}", title, NOW, NOW, eid),
    )
    conn.execute(
        "INSERT INTO article_embeddings (article_id, text_hash, vec) VALUES (?, '', ?)",
        (aid, np.asarray(vec, dtype=np.float32).tobytes()),
    )


@pytest.fixture
def story(conn):
    _event(conn, 1, "record", "Presiden serahkan trofi piala velodrome summarecon",
           [1, 0, 0, 0], figure="prabowo")
    _event(conn, 2, "peristiwa", "Final piala velodrome summarecon digelar",
           [0.9, 0.1, 0, 0])
    _event(conn, 3, "peristiwa", "Banjir rendam pemukiman warga pesisir",
           [-1, 0, 0, 0])
    conn.commit()
    return conn


def test_proposes_the_shared_story_only(story):
    stats = link.link_records(story)
    rows = story.execute(
        "SELECT record_id, peristiwa_id, origin, verdict, evidence FROM record_links"
    ).fetchall()
    assert stats["proposed"] == 1
    assert [(r["record_id"], r["peristiwa_id"], r["origin"], r["verdict"]) for r in rows] \
        == [(1, 2, "pipeline", None)]
    assert "summarecon" in rows[0]["evidence"]


def test_rerun_changes_nothing(story):
    link.link_records(story)
    assert link.link_records(story)["proposed"] == 0


def test_rejected_pair_is_left_alone(story):
    link.link_records(story)
    story.execute("UPDATE record_links SET verdict = 'rejected', score = -1")
    link.link_records(story)
    row = story.execute("SELECT verdict, score FROM record_links").fetchone()
    assert (row["verdict"], row["score"]) == ("rejected", -1)


def test_confirmed_link_relates_the_figure(story):
    link.link_records(story)
    story.execute("UPDATE record_links SET verdict = 'confirmed'")
    link.link_records(story)
    assert story.execute(
        "SELECT figure_id FROM event_figures WHERE event_id = 2"
    ).fetchall()[0]["figure_id"] == "prabowo"


def test_struck_figure_is_not_related_again(story):
    link.link_records(story)
    story.execute("UPDATE record_links SET verdict = 'confirmed'")
    story.execute(
        "INSERT INTO event_figure_rejections (event_id, figure_id) VALUES (2, 'prabowo')"
    )
    link.link_records(story)
    assert story.execute("SELECT count(*) FROM event_figures").fetchone()[0] == 0
