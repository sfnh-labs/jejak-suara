"""jejak/mentions.py: folding newly discovered names into the tracked roster."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import db, mentions  # noqa: E402

TRACKED = {"prabowo": "prabowo-subianto", "prabowo subianto": "prabowo-subianto"}


@pytest.mark.parametrize("name", [
    "Presiden Prabowo Subianto",
    "Prabowo Subianto",
    "Prabowo Subianto-Gibran Rakabuming",
])
def test_folds_spellings_of_a_tracked_name(name):
    assert mentions._same_as_tracked(name, TRACKED) == "prabowo-subianto"


@pytest.mark.parametrize("name", ["Listyo Sigit Prabowo", "Prabowo Didit"])
def test_shared_surname_is_not_the_same_person(name):
    assert mentions._same_as_tracked(name, TRACKED) is None


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    # Something on the roster, so promote_figures does not seed figures.toml.
    c.execute("INSERT INTO figures (id, name, aliases) VALUES ('x', 'Xavier Y', '[]')")
    yield c
    c.close()


def _candidate(conn: sqlite3.Connection, name: str, outlets: int) -> None:
    slug = mentions.slugify(name)
    conn.execute("INSERT INTO figure_candidates (slug, name) VALUES (?, ?)", (slug, name))
    for i in range(outlets):
        aid = f"{slug}-{i}"
        conn.execute(
            "INSERT INTO articles (id, source, url, title, fetched_at) "
            "VALUES (?, ?, ?, ?, '2026-10-13')",
            (aid, f"outlet{i}", f"https://x/{aid}", name),
        )
        conn.execute(
            "INSERT INTO figure_mentions (slug, article_id, role, source) "
            "VALUES (?, ?, '', ?)",
            (slug, aid, f"outlet{i}"),
        )


def test_new_names_wait_for_a_curator(conn):
    _candidate(conn, "Ahmad Muzani", 3)
    _candidate(conn, "Ahmad Muzani Tutup", 3)

    stats = mentions.promote_figures(conn)

    assert stats["queued"] == 2
    assert [r["id"] for r in conn.execute("SELECT id FROM figures")] == ["x"]
    statuses = {r["status"] for r in conn.execute("SELECT status FROM figure_candidates")}
    assert statuses == {"candidate"}


def test_longer_form_of_a_tracked_name_folds_in(conn):
    conn.execute("INSERT INTO figures (id, name, aliases) "
                 "VALUES ('ahmad-muzani', 'Ahmad Muzani', '[]')")
    _candidate(conn, "Ahmad Muzani Tutup", 3)

    stats = mentions.promote_figures(conn)

    assert stats["folded"] == 1
    aliases = json.loads(conn.execute(
        "SELECT aliases FROM figures WHERE id = 'ahmad-muzani'").fetchone()[0])
    assert aliases == ["Ahmad Muzani Tutup"]


def test_curated_role_is_kept(conn):
    conn.execute("INSERT INTO figures (id, name, role, aliases) "
                 "VALUES ('ahmad-muzani', 'Ahmad Muzani', 'Ketua MPR RI', '[]')")
    _candidate(conn, "Ahmad Muzani", 3)
    conn.execute("UPDATE figure_mentions SET role = 'Ketua' WHERE slug = 'ahmad-muzani'")

    mentions.promote_figures(conn)

    row = conn.execute("SELECT name, role FROM figures WHERE id = 'ahmad-muzani'").fetchone()
    assert (row["name"], row["role"]) == ("Ahmad Muzani", "Ketua MPR RI")


@pytest.mark.parametrize("text, name", [
    ("Ketua MPR RI Ahmad Muzani bersilaturahmi dengan Habib Umar bin Hafidz, "
     "mengapresiasi dakwahnya.", "Habib Umar bin Hafidz"),
    ("Ia bertemu Gus Yahya di kantor PBNU.", "Gus Yahya"),
])
def test_religious_honorific_marks_a_person(text, name):
    assert name in [m.name for m in mentions.extract(text)]


def test_shorter_form_is_left_for_the_curator():
    tracked = {"mahkamah agung sunarto": "mahkamah-agung-sunarto"}
    assert mentions._same_as_tracked("Mahkamah Agung", tracked) is None
