"""jejak/link.py link_followups: proposing that one event follows up another."""
from __future__ import annotations

import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import cluster, db, link  # noqa: E402

DAY0 = datetime(2026, 9, 1, 10, tzinfo=timezone.utc)


@pytest.fixture
def conn(tmp_path, monkeypatch):
    monkeypatch.setattr(cluster, "_figure_terms", lambda: set())
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    yield c
    c.close()


def _event(conn: sqlite3.Connection, eid: int, kind: str, title: str, body: str,
           vec: list[float], day: int, figure: str | None = None) -> None:
    when = (DAY0 + timedelta(days=day)).isoformat()
    conn.execute(
        "INSERT INTO events (id, figure_id, kind, title, event_date, last_seen, "
        "status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
        (eid, figure, kind, title, when, when, when),
    )
    aid = f"a{eid}"
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, summary, fetched_at, "
        "published_at, event_id) VALUES (?, ?, 'x', ?, ?, ?, ?, ?, ?)",
        (aid, figure, f"https://x/{eid}", title, body, when, when, eid),
    )
    conn.execute(
        "INSERT INTO article_embeddings (article_id, text_hash, vec) VALUES (?, '', ?)",
        (aid, np.asarray(vec, dtype=np.float32).tobytes()),
    )


BILL = "Panitia kerja membahas pasal reforma agraria bersama kementerian pertanahan"
FIRE = "Petugas gulkarmat memadamkan api yang melalap permukiman padat penduduk"


@pytest.fixture
def stories(conn):
    # A bill proposed, then passed: a follow-up.
    _event(conn, 1, "peristiwa", "RUU Reforma Agraria diusulkan DPR", BILL, [1, 0, 0, 0, 0], 0)
    _event(conn, 2, "peristiwa", "DPR sahkan RUU Reforma Agraria", BILL, [0.95, 0.05, 0, 0, 0], 8)
    # Same day as the proposal: clustering's business, not a follow-up.
    _event(conn, 3, "peristiwa", "Fraksi tanggapi RUU Reforma Agraria", BILL, [0.97, 0.03, 0, 0, 0], 0)
    # Three months on: too late to be the same story.
    _event(conn, 4, "peristiwa", "Gugatan UU Reforma Agraria", BILL, [0.96, 0.04, 0, 0, 0], 100)
    # Two different fires: similar, but no rare term in both titles.
    _event(conn, 10, "peristiwa", "Kebakaran rumah di Kebayoran", FIRE, [0, 1, 0, 0, 0], 0)
    _event(conn, 11, "peristiwa", "Kebakaran rumah di Cakung", FIRE, [0, 0.95, 0.05, 0, 0], 5)
    # Make "kebakaran" and "rumah" common title words, as they are in the corpus.
    for i in range(12):
        _event(conn, 100 + i, "peristiwa", f"Kebakaran rumah warga nomor{i}", "lain",
               [0, 0, 0, 1, 0], 200 + i)
    # A figure's promise, then its delivery; and another figure on the same topic.
    _event(conn, 20, "record", "Menjanjikan layar interaktif sekolah", "Bantuan layar interaktif untuk sekolah negeri",
           [0, 0, 1, 0, 0], 0, figure="prabowo")
    _event(conn, 21, "record", "Menyerahkan layar interaktif sekolah", "Bantuan layar interaktif untuk sekolah negeri",
           [0, 0.05, 0.95, 0, 0], 6, figure="prabowo")
    _event(conn, 22, "record", "Mengkritik layar interaktif sekolah", "Bantuan layar interaktif untuk sekolah negeri",
           [0, 0.04, 0.96, 0, 0], 6, figure="anies")
    conn.commit()
    return conn


def _pairs(conn):
    return {(r[0], r[1]) for r in conn.execute(
        "SELECT earlier_id, later_id FROM followup_links ORDER BY 1, 2")}


def test_proposes_true_followups_only(stories):
    stats = link.link_followups(stories)
    pairs = _pairs(stories)
    assert (1, 2) in pairs and (3, 2) in pairs
    assert (20, 21) in pairs
    assert (1, 3) not in pairs and (3, 1) not in pairs   # same day
    assert not {p for p in pairs if 4 in p}              # too far apart
    assert (10, 11) not in pairs                         # different fires
    assert not {p for p in pairs if 22 in p}             # another figure's record
    assert stats["proposed"] == len(pairs)
    evidence = stories.execute(
        "SELECT evidence FROM followup_links WHERE earlier_id = 1 AND later_id = 2"
    ).fetchone()[0]
    assert "agraria" in evidence and "reforma" in evidence


def test_rerun_changes_nothing(stories):
    link.link_followups(stories)
    assert link.link_followups(stories) == {"proposed": 0, "updated": 0}


def test_ruled_pair_is_left_alone(stories):
    link.link_followups(stories)
    stories.execute("UPDATE followup_links SET verdict = 'rejected', score = -1 "
                    "WHERE earlier_id = 1 AND later_id = 2")
    link.link_followups(stories)
    row = stories.execute(
        "SELECT verdict, score FROM followup_links WHERE earlier_id = 1 AND later_id = 2"
    ).fetchone()
    assert (row[0], row[1]) == ("rejected", -1)
