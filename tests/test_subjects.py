"""jejak/subjects.py: whom each quote is about."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db, subjects  # noqa: E402

NOW = "2026-11-10T10:00:00+00:00"


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    for fid, name, aliases in [
        ("surya", "Surya Paloh", ["NasDem Surya Paloh"]),
        ("sugeng", "Sugeng Teguh Santoso", []),
        ("prabowo", "Prabowo Subianto", ["Prabowo"]),
        ("agus-a", "Agus Gumiwang Kartasasmita", []),
        ("agus-b", "Agus Harimurti Yudhoyono", ["AHY"]),
    ]:
        c.execute("INSERT INTO figures (id, name, aliases) VALUES (?, ?, ?)", (fid, name, json.dumps(aliases)))
    c.execute("INSERT INTO events (id, figure_id, kind, title, event_date, status, created_at) "
              "VALUES (1, 'sugeng', 'record', 't', ?, 'new', ?)", (NOW, NOW))
    yield c
    c.close()


def _quote(conn, text, speaker=None):
    return conn.execute("INSERT INTO event_quotes (event_id, quote, figure_id, found_at) VALUES (1, ?, ?, ?)",
                        (text, speaker, NOW)).lastrowid


def _subjects(conn):
    return {(r[0], r[1]): (r[2], r[3]) for r in conn.execute(
        "SELECT quote_id, figure_id, status, band FROM quote_subjects")}


def test_bands(conn):
    a = _quote(conn, "Pak Surya telepon saya, Pak Surya pun syok", "sugeng")
    b = _quote(conn, "Kami mendukung Presiden Prabowo Subianto", "sugeng")
    c = _quote(conn, "Prabowo sudah tahu", "sugeng")
    subjects.backfill(conn)
    assert _subjects(conn) == {(a, "surya"): ("auto", "sapaan"), (b, "prabowo"): ("auto", "nama lengkap"),
                               (c, "prabowo"): ("auto", "alias")}


def test_a_quote_is_not_about_its_speaker_and_may_be_about_several(conn):
    q = _quote(conn, "Saya, Prabowo, dan Surya Paloh sepakat", "prabowo")
    subjects.backfill(conn)
    assert set(_subjects(conn)) == {(q, "surya")}
    q2 = _quote(conn, "Prabowo dan Surya Paloh sepakat", "sugeng")
    subjects.backfill(conn)
    assert {f for (qid, f) in _subjects(conn) if qid == q2} == {"prabowo", "surya"}


def test_an_honorific_shared_by_several_needs_the_record(conn):
    q = _quote(conn, "Saya dengar dari Pak Agus", "sugeng")
    subjects.backfill(conn)
    assert _subjects(conn) == {}
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source, assigned_by) "
                 "VALUES (1, 'agus-b', 'related', 'owner', 'auto')")
    subjects.backfill(conn)
    assert _subjects(conn) == {(q, "agus-b"): ("auto", "sapaan")}


def test_rerun_keeps_a_curators_rulings(conn):
    q = _quote(conn, "Pak Surya pun syok", "sugeng")
    subjects.backfill(conn)
    conn.execute("UPDATE quote_subjects SET status = 'rejected', assigned_by = 'curator'")
    subjects.backfill(conn)
    assert _subjects(conn) == {(q, "surya"): ("rejected", "sapaan")}
