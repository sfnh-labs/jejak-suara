"""jejak/curation_points.py: open questions per catatan, their evidence, and confidence."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import curation_points as cp, db  # noqa: E402

NOW = "2026-10-20T10:00:00+00:00"


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    for fid, name, aliases in [
        ("suyudi", "Suyudi Ario Seto", []),
        ("amran", "Andi Amran Sulaiman", ["Amran"]),
        ("dasco", "Sufmi Dasco Ahmad", []),
        ("budi-a", "Budi Gunadi Sadikin", []),
        ("budi-b", "Budi Prasetyo", []),
    ]:
        c.execute("INSERT INTO figures (id, name, aliases) VALUES (?, ?, ?)",
                  (fid, name, json.dumps(aliases)))
    yield c
    c.close()


def _event(conn, eid, figure=None, title="judul", body=None):
    conn.execute(
        "INSERT INTO events (id, figure_id, kind, title, event_date, last_seen, status, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, 'new', ?)",
        (eid, figure, "record" if figure else "peristiwa", title, NOW, NOW, NOW))
    if body is not None:
        conn.execute(
            "INSERT INTO articles (id, figure_id, source, url, title, body, fetch_status, "
            "fetched_at, published_at, event_id) VALUES (?, ?, 'Antara', ?, ?, ?, 'ok', ?, ?, ?)",
            (f"a{eid}", figure, f"https://x/{eid}", title, body, NOW, NOW, eid))


def _quote(conn, eid, speaker, text, figure=None, by="auto"):
    conn.execute(
        "INSERT INTO event_quotes (event_id, article_id, quote, speaker, figure_id, assigned_by, found_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)", (eid, f"a{eid}", text, speaker, figure, by, NOW))


def _points(conn, kind):
    return {r["key"]: r for r in conn.execute(
        "SELECT * FROM curation_points WHERE kind = ? ORDER BY key", (kind,))}


# ---------------------------------------------------------------------------
# peristiwa and lini


def test_peristiwa_link_becomes_a_point_with_its_evidence(conn):
    _event(conn, 1, "suyudi", "Bareskrim naikkan 98 laporan",
           "Pembukaan berita.\nPenyidik menindak beras oplosan di gudang. Kalimat lain tentang cuaca.\nPenutup.")
    _event(conn, 2, None, "Penindakan beras oplosan")
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (1, 2, 0.52, ?, ?)", (json.dumps(["oplosan", "gudang"]), NOW))
    cp.run(conn)

    p = _points(conn, "peristiwa")["peristiwa:1:2"]
    assert p["event_id"] == 1 and p["status"] == "open" and p["bucket"] == "kuat"
    assert json.loads(p["proposal"])["claim"] == "Catatan ini bagian dari “Penindakan beras oplosan”"
    assert p["paragraph"].startswith("Penyidik menindak")
    assert p["paragraph"][p["hl_start"]:p["hl_end"]] == "Penyidik menindak beras oplosan di gudang."


def test_rerun_neither_duplicates_nor_touches_an_answer(conn):
    _event(conn, 1, "suyudi", body="oplosan gudang")
    _event(conn, 2, None)
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (1, 2, 0.30, '[\"oplosan\"]', ?)", (NOW,))
    cp.run(conn)
    conn.execute("UPDATE curation_points SET status = 'ya', answered_by = 'curator'")
    conn.execute("UPDATE record_links SET score = 0.9")  # the pipeline changes its mind
    cp.run(conn)

    rows = conn.execute("SELECT status, score FROM curation_points").fetchall()
    assert [(r["status"], r["score"]) for r in rows] == [("ya", 0.30)]


def test_a_question_decided_elsewhere_is_settled(conn):
    _event(conn, 1, "suyudi", body="x")
    _event(conn, 2, None)
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (1, 2, 0.45, '[]', ?)", (NOW,))
    cp.run(conn)
    conn.execute("UPDATE record_links SET verdict = 'confirmed'")  # from the existing link list
    assert cp.run(conn)["settled"] == 1
    assert conn.execute("SELECT status FROM curation_points").fetchone()[0] == "settled"


def test_followup_is_listed_on_the_later_catatan(conn):
    _event(conn, 1, "suyudi", "Satgas sidak gudang Karawang")
    _event(conn, 3, "suyudi", "Bareskrim naikkan laporan", "Kasus gudang Karawang naik ke penyidikan.")
    conn.execute("INSERT INTO followup_links (earlier_id, later_id, score, evidence, created_at) "
                 "VALUES (1, 3, 0.7, '[\"karawang\"]', ?)", (NOW,))
    cp.run(conn)
    p = _points(conn, "lini")["lini:1:3"]
    assert p["event_id"] == 3 and p["bucket"] == "kuat"
    assert json.loads(p["proposal"])["title"] == "Satgas sidak gudang Karawang"


def test_rejected_catatan_get_no_points(conn):
    _event(conn, 1, "suyudi", body="x")
    _event(conn, 2, None)
    conn.execute("UPDATE events SET curated = 'rejected' WHERE id = 1")
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (1, 2, 0.45, '[]', ?)", (NOW,))
    cp.run(conn)
    assert _points(conn, "peristiwa") == {}


# ---------------------------------------------------------------------------
# pelaku


def test_actor_review_points_at_the_paragraph_naming_them(conn):
    _event(conn, 1, "suyudi", "Satgas tegaskan stok aman",
           "Satgas meninjau pasar.\nMenteri Amran menegaskan stok beras aman sampai akhir tahun.")
    conn.execute("INSERT INTO actor_reviews (event_id, owner_id, suggested_id, quotes, found_at) "
                 "VALUES (1, 'suyudi', 'amran', 2, ?)", (NOW,))
    cp.run(conn)
    p = _points(conn, "pelaku")["pelaku:1:amran"]
    assert p["bucket"] == "2-3 kutipan"
    assert json.loads(p["proposal"])["claim"] == "Andi Amran Sulaiman ikut menjadi pelaku, bukan hanya disebut"
    assert "Amran menegaskan" in p["paragraph"][p["hl_start"]:p["hl_end"]]


# ---------------------------------------------------------------------------
# pembicara


def test_one_speaker_one_point_across_catatan(conn):
    for eid in (1, 2):
        _event(conn, eid, "suyudi", body=f"“Kalimat nomor {eid} yang cukup panjang untuk kutipan,” kata Dasco.")
        _quote(conn, eid, "Dasco", f"Kalimat nomor {eid} yang cukup panjang untuk kutipan")
    _event(conn, 3, "amran", body="“Satu lagi kalimat yang cukup panjang untuk kutipan,” kata Dasco.")
    _quote(conn, 3, "Dasco", "Satu lagi kalimat yang cukup panjang untuk kutipan")
    cp.run(conn)

    pts = _points(conn, "pembicara")
    # A middle name is enough to find him; a single word splits by whose catatan it is in.
    assert set(pts) == {"pembicara:dasco:dasco:suyudi", "pembicara:dasco:dasco:amran"}
    p = pts["pembicara:dasco:dasco:suyudi"]
    assert p["group_size"] == 2 and p["bucket"] == "satu kata"
    prop = json.loads(p["proposal"])
    assert prop["figure_id"] == "dasco" and len(prop["quote_ids"]) == 2
    assert p["paragraph"][p["hl_start"]:p["hl_end"]].endswith("kata Dasco")
    assert p["paragraph"][p["hl_start"]] == "“"


def test_tie_is_broken_by_who_takes_part(conn):
    _event(conn, 1, "suyudi", body="x")
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source) "
                 "VALUES (1, 'budi-b', 'quoted', 'quote')")
    _quote(conn, 1, "Budi", "Penyidik melakukan penggeledahan di rumah pihak swasta itu")
    cp.run(conn)
    (p,) = _points(conn, "pembicara").values()
    assert json.loads(p["proposal"])["figure_id"] == "budi-b" and p["bucket"] == "dari catatan"
    assert {c["id"] for c in json.loads(p["proposal"])["candidates"]} == {"budi-a", "budi-b"}


def test_small_groups_wait(conn):
    # No tracked figure fits, twice: not yet a question.
    _event(conn, 1, "suyudi", body="x")
    for i in range(2):
        _quote(conn, 1, "Taufik", f"Kalimat ke-{i} yang cukup panjang dari seorang rektor")
    # A peristiwa has no owner: split to that peristiwa, so it needs three too.
    _event(conn, 2, None, body="x")
    for i in range(2):
        _quote(conn, 2, "Budi", f"Kalimat ke-{i} yang cukup panjang dari juru bicara")
    cp.run(conn)
    assert _points(conn, "pembicara") == {}

    _quote(conn, 1, "Taufik", "Kalimat ketiga yang cukup panjang dari seorang rektor")
    cp.run(conn)
    (p,) = _points(conn, "pembicara").values()
    assert p["key"] == "pembicara:taufik:-:suyudi" and p["group_size"] == 3
    assert json.loads(p["proposal"])["claim"] == "“Taufik” bukan tokoh yang dilacak"


def test_a_curators_none_is_not_asked_again(conn):
    _event(conn, 1, "suyudi", body="x")
    for i in range(3):
        _quote(conn, 1, "Taufik", f"Kalimat ke-{i} yang cukup panjang dari seorang rektor", by="curator")
    cp.run(conn)
    assert _points(conn, "pembicara") == {}


# ---------------------------------------------------------------------------
# evidence and confidence


def test_long_paragraph_is_cut_around_the_part_in_question():
    para = ("awal " * 200) + "INTI KALIMAT." + (" akhir" * 200)
    start = para.index("INTI")
    text, s, e = cp._cut(para, start, start + len("INTI KALIMAT."))
    assert len(text) <= cp.MAX_PARAGRAPH + 4
    assert text.startswith("… ") and text.endswith(" …")
    assert text[s:e] == "INTI KALIMAT."


def test_calibration_counts_the_curators_answers_only(conn):
    rows = [("ya", "kuat")] * 24 + [("bukan", "kuat"), ("koreksi", "lemah"), ("auto", "kuat"),
                                     ("auto_wrong", "kuat"), ("open", "kuat"), ("settled", "kuat")]
    for i, (status, bucket) in enumerate(rows):
        conn.execute("INSERT INTO curation_points (kind, key, event_id, proposal, bucket, status, "
                     "created_at, refreshed_at) VALUES ('peristiwa', ?, 1, '{}', ?, ?, ?, ?)",
                     (f"k{i}", bucket, status, NOW, NOW))
    cal = cp.calibration(conn)
    assert cal == {"peristiwa": {"kuat": (24, 26), "lemah": (0, 1)}}


def test_auto_gate():
    assert cp.confidence(0, 0) is None
    assert not cp.auto_eligible(24, 24)   # too few
    assert cp.auto_eligible(25, 25)       # 25 / 26 ≥ 95%
    assert not cp.auto_eligible(25, 26)   # one disagreement: 25 / 27 < 95%
