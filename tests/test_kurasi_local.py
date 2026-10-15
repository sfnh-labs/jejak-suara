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


def test_alias_joins_an_existing_figure(conn):
    candidate_queue.refresh(conn)
    conn.execute("UPDATE candidate_review SET verdict = 'alias', curated_slug = 'ahmad-muzani' "
                 "WHERE slug = 'hafidz'")
    kurasi_ops.apply_candidate(conn, "hafidz")
    aliases = json.loads(conn.execute(
        "SELECT aliases FROM figures WHERE id = 'ahmad-muzani'").fetchone()[0])
    assert "Hafidz" in aliases
    assert conn.execute("SELECT status FROM figure_candidates WHERE slug = 'hafidz'").fetchone()[0] == "tracked"
    conn.execute("UPDATE candidate_review SET curated_slug = 'nobody' WHERE slug = 'hafidz'")
    with pytest.raises(kurasi_ops.Refused):
        kurasi_ops.apply_candidate(conn, "hafidz")


def _rework(conn, **fields):
    cols = {"event_id": 7, "note": "Muzani bukan pelakunya", "created_at": "2026-10-15", **fields}
    conn.execute(f"INSERT INTO rework_requests ({', '.join(cols)}) VALUES ({', '.join('?' * len(cols))})",
                 tuple(cols.values()))
    return conn.execute("SELECT max(id) FROM rework_requests").fetchone()[0]


@pytest.fixture
def fake_model(monkeypatch):
    seen = {}

    def fake(articles, figure_name=None, categories=None, framing=None, note=None, previous=None,
             examples=None):
        seen.update(figure_name=figure_name, framing=framing, note=note, previous=previous,
                    examples=examples)
        return ("Mobil orang kepercayaannya disita", "Penyitaan", "- KPK menyita mobil. [Sumber 1]", [])

    monkeypatch.setattr(kurasi_ops.summarize, "summarize_ollama", fake)
    return seen


def test_rework_drafts_without_touching_the_event(conn, fake_model):
    rid = _rework(conn, framing="about")
    kurasi_ops.run_rework(conn, rid)
    req = conn.execute("SELECT status, after FROM rework_requests WHERE id = ?", (rid,)).fetchone()
    assert req["status"] == "ready"
    assert json.loads(req["after"])["framing"] == "about"
    assert fake_model["framing"] == "about" and fake_model["note"] == "Muzani bukan pelakunya"
    assert conn.execute("SELECT title FROM events WHERE id = 7").fetchone()[0] == "Muzani tutup sidang"

    kurasi_ops.accept_rework(conn, rid)
    ev = conn.execute("SELECT title, framing, status FROM events WHERE id = 7").fetchone()
    assert (ev["title"], ev["framing"], ev["status"]) == ("Mobil orang kepercayaannya disita", "about", "approved")
    assert conn.execute("SELECT summary_text FROM event_summaries WHERE event_id = 7").fetchone()[0]


def test_rework_to_another_figure_and_to_peristiwa(conn, fake_model):
    rid = _rework(conn, new_figure_id="ahmad-muzani")
    kurasi_ops.run_rework(conn, rid)
    assert fake_model["figure_name"] == "Ahmad Muzani"
    kurasi_ops.accept_rework(conn, rid)
    assert conn.execute("SELECT figure_id FROM events WHERE id = 7").fetchone()[0] == "ahmad-muzani"
    assert {r[0] for r in conn.execute("SELECT figure_id FROM articles WHERE event_id = 7")} == {"ahmad-muzani"}

    rid = _rework(conn, to_peristiwa=1)
    kurasi_ops.run_rework(conn, rid)
    assert fake_model["figure_name"] is None
    kurasi_ops.accept_rework(conn, rid)
    ev = conn.execute("SELECT kind, figure_id FROM events WHERE id = 7").fetchone()
    assert (ev["kind"], ev["figure_id"]) == ("peristiwa", None)
    assert conn.execute("SELECT figure_id FROM event_figures WHERE event_id = 7").fetchone()[0] == "ahmad-muzani"


def test_rework_failure_is_recorded(conn, monkeypatch):
    def down(*a, **k):
        raise RuntimeError("Ollama not reachable")
    monkeypatch.setattr(kurasi_ops.summarize, "summarize_ollama", down)
    rid = _rework(conn)
    with pytest.raises(kurasi_ops.Refused):
        kurasi_ops.run_rework(conn, rid)
    row = conn.execute("SELECT status, error FROM rework_requests WHERE id = ?", (rid,)).fetchone()
    assert row["status"] == "failed" and "Ollama" in row["error"]


def test_not_a_person(conn):
    conn.execute("INSERT INTO figures (id, name, role, aliases, active) "
                 "VALUES ('istana-merdeka', 'Istana Merdeka', 'Presiden', '[]', 1)")
    conn.execute("INSERT INTO events (id, figure_id, kind, title, event_date, status, created_at) "
                 "VALUES (8, NULL, 'peristiwa', 'Upacara', '2026-10-01', 'new', '2026-10-01')")
    conn.execute("INSERT INTO event_figures (event_id, figure_id) VALUES (8, 'istana-merdeka')")
    conn.execute("UPDATE events SET figure_id = 'istana-merdeka' WHERE id = 7")
    conn.execute("UPDATE articles SET figure_id = 'istana-merdeka' WHERE id = 'a0'")
    kurasi_ops.not_a_person(conn, "istana-merdeka")
    assert conn.execute("SELECT active FROM figures WHERE id = 'istana-merdeka'").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM event_figures WHERE figure_id = 'istana-merdeka'").fetchone()[0] == 0
    assert conn.execute("SELECT figure_id FROM articles WHERE id = 'a0'").fetchone()[0] is None
    assert conn.execute("SELECT curated FROM events WHERE id = 7").fetchone()[0] == "rejected"
    assert conn.execute("SELECT reasons FROM curation_labels WHERE event_id = 7").fetchone()[0] == '["wrong_person"]'



def test_stage_catches_up_once_and_learns(conn, fake_model):
    from jejak import kurasi
    queued = _rework(conn, framing="about")          # left queued by a closed laptop
    stats = kurasi.run_stage(conn)
    assert stats["drafted"]["reworks"] == 1
    assert conn.execute("SELECT status FROM rework_requests WHERE id = ?", (queued,)).fetchone()[0] == "ready"
    # Drafted, not applied: the event is as it was until the curator accepts.
    assert conn.execute("SELECT framing FROM events WHERE id = 7").fetchone()[0] is None

    assert kurasi.run_stage(conn)["drafted"]["reworks"] == 0   # not redone

    kurasi.accept_rework(conn, queued)
    assert kurasi.run_stage(conn)["learned"]["summary"] == 1
    assert kurasi.run_stage(conn)["learned"]["summary"] == 0   # learned once
    lesson = conn.execute("SELECT wrong, note, right FROM curation_lessons").fetchone()
    assert "Muzani tutup sidang" in lesson["wrong"] and "Mobil orang" in lesson["right"]

    # The lesson comes back for a similar event of the same figure.
    found = kurasi.lessons_for(conn, "summary", "ahmad-muzani-tutup", {"muzani"}, exclude_event=99)
    assert found and found[0]["note"].startswith("Muzani bukan pelakunya")


def test_failed_draft_is_retried_at_most_twice(conn, monkeypatch):
    from jejak import kurasi

    def down(*a, **k):
        raise RuntimeError("Ollama not reachable")
    monkeypatch.setattr(kurasi.summarize, "summarize_ollama", down)
    rid = _rework(conn)
    for _ in range(4):
        kurasi.run_stage(conn)
    assert conn.execute("SELECT attempts FROM rework_requests WHERE id = ?", (rid,)).fetchone()[0] == 2


def test_rejected_first_words_are_learned(conn):
    from jejak import kurasi
    for i, n in enumerate(["Polisi Budi", "Polisi Andi", "Polisi Joko", "Istana Merdeka"]):
        conn.execute("INSERT INTO figure_candidates (slug, name, status) VALUES (?, ?, 'rejected')", (f"x{i}", n))
    assert kurasi.learn_name_prefixes(conn) == ["Polisi"]
