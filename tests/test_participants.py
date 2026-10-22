"""jejak/participants.py: a record's participants beyond the figure it is filed under."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db, participants  # noqa: E402

NOW = "2026-10-21T10:00:00+00:00"


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    for fid, name in [("prabowo", "Prabowo Subianto"), ("dadan", "Dadan Hindayana"),
                      ("cak-imin", "Muhaimin Iskandar")]:
        c.execute("INSERT INTO figures (id, name, role) VALUES (?, ?, '')", (fid, name))
    yield c
    c.close()


def _record(conn, eid, owner, title, framing=None):
    conn.execute("INSERT INTO events (id, figure_id, kind, title, event_date, status, framing, "
                 "created_at) "
                 "VALUES (?, ?, 'record', ?, ?, 'approved', ?, ?)",
                 (eid, owner, title, NOW, framing, NOW))


def _quote(conn, eid, figure, text):
    conn.execute("INSERT INTO event_quotes (event_id, quote, figure_id, assigned_by, found_at) "
                 "VALUES (?, ?, ?, 'auto', ?)", (eid, text, figure, NOW))


def _roles(conn, eid):
    return {r["figure_id"]: r["role"] for r in conn.execute(
        "SELECT figure_id, role FROM record_figures WHERE event_id = ?", (eid,))}


def test_quoted_figures_join_the_owner(conn):
    _record(conn, 1, "prabowo", "Menegaskan MBG tetap jalan")
    _quote(conn, 1, "prabowo", "MBG jalan terus")
    _quote(conn, 1, "dadan", "Dapur kami siap")
    participants.backfill(conn)
    assert _roles(conn, 1) == {"prabowo": "actor", "dadan": "quoted"}
    assert conn.execute("SELECT count(*) FROM actor_reviews").fetchone()[0] == 0


def test_silent_owner_of_a_statement_is_flagged(conn):
    _record(conn, 1, "prabowo", "Menyatakan Penerimaan MBG Diterima Lebih dari Target")
    _quote(conn, 1, "dadan", "Sudah 30 juta penerima")
    _quote(conn, 1, "dadan", "Melebihi target")
    participants.backfill(conn)
    row = conn.execute("SELECT owner_id, suggested_id, quotes FROM actor_reviews").fetchone()
    assert tuple(row) == ("prabowo", "dadan", 2)


@pytest.mark.parametrize("title,framing,quoters", [
    ("Bertolak ke Jepang, bertemu Kaisar", None, ["dadan"]),      # an act, not a statement
    ("Menyatakan dukungan", "about", ["dadan"]),                    # about him, not his act
    ("Menyatakan dukungan", None, ["dadan", "cak-imin"]),          # no single other voice
])
def test_not_flagged(conn, title, framing, quoters):
    _record(conn, 1, "prabowo", title, framing)
    for i, f in enumerate(quoters):
        _quote(conn, 1, f, f"kutipan {i}")
    participants.backfill(conn)
    assert conn.execute("SELECT count(*) FROM actor_reviews").fetchone()[0] == 0


def test_framing_about_makes_the_owner_the_subject(conn):
    _record(conn, 1, "prabowo", "Dikritik soal MBG", "about")
    participants.backfill(conn)
    assert _roles(conn, 1) == {"prabowo": "subject"}


def test_rerun_keeps_curator_rows_and_decisions(conn):
    _record(conn, 1, "prabowo", "Menyatakan Penerimaan MBG Diterima")
    _quote(conn, 1, "dadan", "Sudah 30 juta")
    participants.backfill(conn)
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source, assigned_by) "
                 "VALUES (1, 'cak-imin', 'target', 'curator', 'curator')")
    conn.execute("UPDATE actor_reviews SET decision = 'keep', decided_at = ?", (NOW,))
    conn.commit()
    participants.backfill(conn)
    assert _roles(conn, 1) == {"prabowo": "actor", "dadan": "quoted", "cak-imin": "target"}
    assert conn.execute("SELECT decision FROM actor_reviews").fetchone()[0] == "keep"


def test_derived_statement_counts_on_the_source_record(conn):
    _record(conn, 1, "prabowo", "Meninjau dapur MBG")
    _record(conn, 2, "dadan", "Menegaskan dapur siap")
    conn.execute("INSERT INTO articles (id, figure_id, source, url, title, fetched_at, event_id) "
                 "VALUES ('a', 'prabowo', 'Kompas', 'https://x/a', 't', ?, 1)", (NOW,))
    conn.execute("INSERT INTO articles (id, figure_id, source, url, title, fetched_at, event_id, "
                 "derived_from, derived_mode) VALUES ('a~dadan', 'dadan', 'Kompas', 'https://x/a', "
                 "'t', ?, 2, 'a', 'record')", (NOW,))
    participants.backfill(conn)
    assert _roles(conn, 1) == {"prabowo": "actor", "dadan": "quoted"}
    assert _roles(conn, 2) == {"dadan": "actor"}
