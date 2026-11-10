"""jejak/participants.py: one Terkait list per record, beyond the figure it is filed under."""
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
                      ("cak-imin", "Muhaimin Iskandar"), ("surya", "Surya Paloh")]:
        c.execute("INSERT INTO figures (id, name, role) VALUES (?, ?, '')", (fid, name))
    yield c
    c.close()


def _record(conn, eid, owner, title="judul"):
    conn.execute("INSERT INTO events (id, figure_id, kind, title, event_date, status, created_at) "
                 "VALUES (?, ?, 'record', ?, ?, 'approved', ?)", (eid, owner, title, NOW, NOW))


def _quote(conn, eid, figure, text):
    return conn.execute("INSERT INTO event_quotes (event_id, quote, figure_id, assigned_by, found_at) "
                        "VALUES (?, ?, ?, 'auto', ?)", (eid, text, figure, NOW)).lastrowid


def _related(conn, eid):
    return {r["figure_id"]: (r["role"], r["source"], r["quotes"]) for r in conn.execute(
        "SELECT figure_id, role, source, quotes FROM record_figures WHERE event_id = ?", (eid,))}


def test_owner_and_speakers_make_one_list(conn):
    _record(conn, 1, "prabowo")
    _quote(conn, 1, "prabowo", "MBG jalan terus")
    _quote(conn, 1, "dadan", "Dapur kami siap")
    _quote(conn, 1, "dadan", "Sudah 30 juta penerima")
    participants.backfill(conn)
    assert _related(conn, 1) == {"prabowo": ("related", "quote", 1), "dadan": ("related", "quote", 2)}


def test_a_silent_owner_is_still_related(conn):
    _record(conn, 1, "prabowo")
    _quote(conn, 1, "dadan", "Sudah 30 juta penerima")
    participants.backfill(conn)
    assert _related(conn, 1)["prabowo"] == ("related", "owner", 0)


def test_a_record_filed_under_no_one_still_gets_its_speakers(conn):
    _record(conn, 1, None)
    _quote(conn, 1, "dadan", "Dapur kami siap")
    participants.backfill(conn)
    assert _related(conn, 1) == {"dadan": ("related", "quote", 1)}


def test_whom_a_quote_is_about_is_related_unless_rejected(conn):
    _record(conn, 1, "cak-imin")
    q = _quote(conn, 1, "cak-imin", "Pak Surya pun syok")
    q2 = _quote(conn, 1, "cak-imin", "Pak Dadan juga")
    conn.execute("INSERT INTO quote_subjects (quote_id, figure_id, status, created_at) "
                 "VALUES (?, 'surya', 'auto', ?), (?, 'dadan', 'rejected', ?)", (q, NOW, q2, NOW))
    participants.backfill(conn)
    assert set(_related(conn, 1)) == {"cak-imin", "surya"}
    assert _related(conn, 1)["surya"] == ("related", "about", 0)


def test_rerun_keeps_a_curators_rows_including_removals(conn):
    _record(conn, 1, "prabowo")
    _quote(conn, 1, "dadan", "Sudah 30 juta")
    participants.backfill(conn)
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source, assigned_by) "
                 "VALUES (1, 'cak-imin', 'related', 'curator', 'curator')")
    conn.execute("UPDATE record_figures SET role = 'removed', assigned_by = 'curator' "
                 "WHERE figure_id = 'prabowo'")
    conn.commit()
    participants.backfill(conn)
    assert {f: r[0] for f, r in _related(conn, 1).items()} == \
        {"prabowo": "removed", "dadan": "related", "cak-imin": "related"}


def test_derived_statement_counts_on_the_source_record(conn):
    _record(conn, 1, "prabowo")
    _record(conn, 2, "dadan")
    conn.execute("INSERT INTO articles (id, figure_id, source, url, title, fetched_at, event_id) "
                 "VALUES ('a', 'prabowo', 'Kompas', 'https://x/a', 't', ?, 1)", (NOW,))
    conn.execute("INSERT INTO articles (id, figure_id, source, url, title, fetched_at, event_id, "
                 "derived_from, derived_mode) VALUES ('a~dadan', 'dadan', 'Kompas', 'https://x/a', "
                 "'t', ?, 2, 'a', 'record')", (NOW,))
    participants.backfill(conn)
    assert _related(conn, 1) == {"prabowo": ("related", "owner", 0), "dadan": ("related", "derived", 0)}
    assert set(_related(conn, 2)) == {"dadan"}


def test_old_roles_become_one_list_on_migrate(conn):
    _record(conn, 1, "prabowo")
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source, assigned_by) VALUES "
                 "(1, 'prabowo', 'actor', 'owner', 'auto'), (1, 'dadan', 'quoted', 'curator', 'curator')")
    db.migrate(conn)
    assert {r[0] for r in conn.execute("SELECT role FROM record_figures")} == {"related"}
