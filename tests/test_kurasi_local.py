"""/kurasi on jejak.db: the names queue and the decisions the pipeline carries out."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "scripts"))

import kurasi_ops  # noqa: E402
from jejak import candidate_queue, db  # noqa: E402


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "t.db"
    db.init_db(path)
    c = db.connect(path)
    c.execute("INSERT INTO figures (id, name, role, aliases, active) "
              "VALUES ('ahmad-muzani', 'Ahmad Muzani', 'Ketua MPR RI', '[]', 1)")
    c.execute("INSERT INTO figures (id, name, role, aliases, active) "
              "VALUES ('ahmad-muzani-tutup', 'Ahmad Muzani Tutup', 'Ketua', '[]', 1)")
    c.execute("INSERT INTO events (id, figure_id, kind, title, event_date, status, created_at) "
              "VALUES (7, 'ahmad-muzani-tutup', 'record', 'Muzani tutup sidang', '2026-10-01', 'new', '2026-10-01')")
    c.execute("INSERT INTO figure_candidates (slug, name, status) VALUES ('hafidz', 'Hafidz', 'candidate')")
    for i, source in enumerate(["Kompas", "Detik", "Antara"]):
        aid = f"a{i}"
        c.execute("INSERT INTO articles (id, figure_id, source, url, title, summary, event_id, fetched_at) "
                  "VALUES (?, NULL, ?, ?, 'Muzani bertemu Habib', ?, 7, '2026-10-01')",
                  (aid, source, f"https://x/{i}", "Ketua MPR bertemu Habib Umar bin Hafidz di Jakarta."))
        c.execute("INSERT INTO figure_mentions (slug, article_id, role, source) "
                  "VALUES ('hafidz', ?, 'Habib', ?)", (aid, source))
    c.commit()
    return c


def test_queue_holds_corroborated_names_with_their_evidence(conn):
    assert candidate_queue.refresh(conn) == 1
    row = conn.execute("SELECT * FROM candidate_review WHERE slug = 'hafidz'").fetchone()
    assert (row["outlets"], row["mentions"], row["role"]) == (3, 3, "Habib")
    assert json.loads(row["records"])[0]["id"] == 7
    assert "Hafidz" in json.loads(row["headlines"])[0]["context"]


def test_refresh_keeps_a_curators_work(conn):
    candidate_queue.refresh(conn)
    conn.execute("UPDATE candidate_review SET notes = 'gelar, bukan nama' WHERE slug = 'hafidz'")
    conn.execute("DELETE FROM figure_mentions")
    candidate_queue.refresh(conn)
    assert conn.execute("SELECT notes FROM candidate_review WHERE slug = 'hafidz'").fetchone()[0]


def test_promote_creates_the_figure_as_typed(conn):
    candidate_queue.refresh(conn)
    conn.execute("""UPDATE candidate_review SET verdict = 'promote', full_name = 'Habib Umar',
                    aliases = 'Habib Umar bin Hafidz', curated_slug = 'habib-umar',
                    curated_positions = '[{"role": "Ulama", "org": "", "period": ""}]'
                    WHERE slug = 'hafidz'""")
    kurasi_ops.apply_candidate(conn, "hafidz")
    fig = conn.execute("SELECT name, role FROM figures WHERE id = 'habib-umar'").fetchone()
    assert (fig["name"], fig["role"]) == ("Habib Umar", "Ulama")
    assert conn.execute("SELECT applied_at FROM candidate_review WHERE slug = 'hafidz'").fetchone()[0]


def test_promote_refuses_a_taken_address(conn):
    candidate_queue.refresh(conn)
    conn.execute("UPDATE candidate_review SET verdict = 'promote', curated_slug = 'ahmad-muzani' "
                 "WHERE slug = 'hafidz'")
    with pytest.raises(kurasi_ops.Refused):
        kurasi_ops.apply_candidate(conn, "hafidz")


def test_reject_then_withdraw(conn):
    candidate_queue.refresh(conn)
    conn.execute("UPDATE candidate_review SET verdict = 'reject' WHERE slug = 'hafidz'")
    kurasi_ops.apply_candidate(conn, "hafidz")
    status = "SELECT status FROM figure_candidates WHERE slug = 'hafidz'"
    assert conn.execute(status).fetchone()[0] == "rejected"
    conn.execute("UPDATE candidate_review SET verdict = NULL WHERE slug = 'hafidz'")
    kurasi_ops.apply_candidate(conn, "hafidz")
    assert conn.execute(status).fetchone()[0] == "candidate"


def test_merge_moves_records_and_retires_the_duplicate(conn):
    kurasi_ops.merge(conn, "ahmad-muzani-tutup", "ahmad-muzani")
    assert conn.execute("SELECT figure_id FROM events WHERE id = 7").fetchone()[0] == "ahmad-muzani"
    assert conn.execute("SELECT active FROM figures WHERE id = 'ahmad-muzani-tutup'").fetchone()[0] == 0
    with pytest.raises(kurasi_ops.Refused):
        kurasi_ops.merge(conn, "ahmad-muzani", "ahmad-muzani-tutup")


def test_curated_column_exists(conn):
    conn.execute("UPDATE events SET curated = 'rejected' WHERE id = 7")
    assert conn.execute("SELECT curated FROM events WHERE id = 7").fetchone()[0] == "rejected"
