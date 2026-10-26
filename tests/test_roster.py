"""jejak/roster.py: folding a duplicate figure into the real one."""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db  # noqa: E402
from jejak.roster import merge_figure  # noqa: E402


def test_merge_moves_records_and_retires_the_duplicate(tmp_path):
    db.init_db(tmp_path / "t.db")
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO figures (id, name, aliases) VALUES "
              "('cak-imin', 'Cak Imin', '[\"Cak Imin\"]'), "
              "('muhaimin-iskandar', 'Muhaimin Iskandar', '[\"Muhaimin Iskandar\"]')")
    c.execute("INSERT INTO events (id, figure_id, kind, status, created_at) "
              "VALUES (1, 'cak-imin', 'record', 'new', 'x'), (2, NULL, 'peristiwa', 'new', 'x')")
    c.execute("INSERT INTO event_figures (event_id, figure_id) VALUES (2, 'cak-imin')")

    assert merge_figure(c, "cak-imin", "muhaimin-iskandar")
    assert merge_figure(c, "cak-imin", "muhaimin-iskandar") == []  # idempotent

    assert c.execute("SELECT figure_id FROM events WHERE id = 1").fetchone()[0] == "muhaimin-iskandar"
    assert [r[0] for r in c.execute("SELECT figure_id FROM event_figures")] == ["muhaimin-iskandar"]
    aliases = json.loads(c.execute(
        "SELECT aliases FROM figures WHERE id = 'muhaimin-iskandar'").fetchone()[0])
    assert aliases == ["Muhaimin Iskandar", "Cak Imin"]
    assert c.execute("SELECT active FROM figures WHERE id = 'cak-imin'").fetchone()[0] == 0


def test_merge_moves_quotes_participants_and_lessons(tmp_path):
    db.init_db(tmp_path / "t.db")
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO figures (id, name) VALUES ('bahlil-lahadlia', 'Bahlil Lahadlia'), "
              "('bahlil-lahadalia', 'Bahlil Lahadalia'), ('prabowo', 'Prabowo Subianto')")
    c.execute("INSERT INTO events (id, figure_id, kind, status, created_at) VALUES "
              "(1, 'prabowo', 'record', 'new', 'x'), (2, 'prabowo', 'record', 'new', 'x'), "
              "(3, 'bahlil-lahadalia', 'record', 'new', 'x')")
    c.execute("INSERT INTO event_quotes (event_id, quote, speaker, figure_id, assigned_by, found_at) "
              "VALUES (1, 'kata-kata', 'Bahlil', 'bahlil-lahadlia', 'auto', 'x')")
    # Record 1: only the duplicate takes part. Record 2: both do, the duplicate by a curator.
    c.execute("INSERT INTO record_figures (event_id, figure_id, role, source, quotes, assigned_by) VALUES "
              "(1, 'bahlil-lahadlia', 'quoted', 'quote', 1, 'auto'), "
              "(2, 'bahlil-lahadlia', 'actor', 'curator', 0, 'curator'), "
              "(2, 'bahlil-lahadalia', 'quoted', 'quote', 2, 'auto')")
    c.execute("INSERT INTO actor_reviews (event_id, owner_id, suggested_id, quotes, found_at) VALUES "
              "(1, 'prabowo', 'bahlil-lahadlia', 1, 'x'), (3, 'bahlil-lahadalia', 'bahlil-lahadlia', 1, 'x')")
    c.execute("INSERT INTO speaker_lessons (speaker, scope, figure_id, taught_by, created_at) VALUES "
              "('bahlil', 'prabowo', 'bahlil-lahadlia', 'curator', 'x'), "
              "('menteri', 'bahlil-lahadlia', 'prabowo', 'curator', 'x')")

    merge_figure(c, "bahlil-lahadlia", "bahlil-lahadalia")

    real = "bahlil-lahadalia"
    assert c.execute("SELECT figure_id FROM event_quotes").fetchone()[0] == real
    rf = {(r[0], r[1]): (r[2], r[3]) for r in c.execute(
        "SELECT event_id, figure_id, role, assigned_by FROM record_figures")}
    assert rf == {(1, real): ("quoted", "auto"), (2, real): ("actor", "curator")}
    assert [tuple(r) for r in c.execute("SELECT event_id, owner_id, suggested_id FROM actor_reviews")] == \
        [(1, "prabowo", real)]
    assert {tuple(r) for r in c.execute("SELECT speaker, scope, figure_id FROM speaker_lessons")} == \
        {("bahlil", "prabowo", real), ("menteri", real, "prabowo")}


def test_quotes_tied_between_duplicates_are_matched_after_the_merge(tmp_path):
    from jejak.quotes import rematch_waiting

    db.init_db(tmp_path / "t.db")
    c = db.connect(tmp_path / "t.db")
    c.execute("INSERT INTO figures (id, name) VALUES ('bahlil-lahadlia', 'Bahlil Lahadlia'), "
              "('bahlil-lahadalia', 'Bahlil Lahadalia'), ('prabowo', 'Prabowo Subianto')")
    c.execute("INSERT INTO events (id, figure_id, kind, status, created_at) "
              "VALUES (1, 'prabowo', 'record', 'new', 'x')")
    # "Bahlil" fit both spellings, so it was listed unmatched; a curator's "nobody" stays.
    c.execute("INSERT INTO event_quotes (event_id, quote, speaker, figure_id, assigned_by, found_at) VALUES "
              "(1, 'satu', 'Bahlil', NULL, 'auto', 'x'), (1, 'dua', 'Bahlil', NULL, 'curator', 'x')")
    assert rematch_waiting(c) == 0

    merge_figure(c, "bahlil-lahadlia", "bahlil-lahadalia")
    assert rematch_waiting(c) == 1
    assert dict(c.execute("SELECT quote, figure_id FROM event_quotes").fetchall()) == \
        {"satu": "bahlil-lahadalia", "dua": None}
