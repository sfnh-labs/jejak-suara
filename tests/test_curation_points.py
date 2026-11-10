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


def test_evidence_falls_back_to_the_headline(conn):
    # The link's words are in the headline; the body is a teaser without them.
    _event(conn, 1, "suyudi", "Poster Gibran mundur atau dimundurkan muncul",
           "Isu hak menyatakan pendapat mencuat di berbagai fraksi.")
    _event(conn, 2, None, "PDIP dorong Gibran mundur")
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (1, 2, 0.45, ?, ?)", (json.dumps(["poster", "dimundurkan"]), NOW))
    cp.run(conn)
    p = _points(conn, "peristiwa")["peristiwa:1:2"]
    assert p["paragraph"] == "Poster Gibran mundur atau dimundurkan muncul"


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
# terkait and tentang


def _related(conn, eid, fid, source="owner", by="auto"):
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source, quotes, assigned_by) "
                 "VALUES (?, ?, 'related', ?, 0, ?)", (eid, fid, source, by))


def test_a_figure_related_on_no_quote_is_asked_with_the_paragraph_naming_them(conn):
    _event(conn, 1, "amran", "Satgas tegaskan stok aman",
           "Satgas meninjau pasar.\nMenteri Amran menegaskan stok beras aman sampai akhir tahun.")
    _event(conn, 2, "suyudi", "Lain", "Tidak ada nama di sini.")
    _related(conn, 1, "amran")
    _related(conn, 2, "suyudi")
    _related(conn, 2, "dasco", source="quote")  # their quotes are asked instead
    _related(conn, 2, "budi-a", by="curator")   # the curator's own
    cp.run(conn)
    pts = _points(conn, "terkait")
    assert set(pts) == {"terkait:1:amran", "terkait:2:suyudi"}
    p = pts["terkait:1:amran"]
    assert p["bucket"] == "disebut di liputan"
    assert json.loads(p["proposal"])["claim"] == "Catatan ini terkait Andi Amran Sulaiman"
    assert "Amran menegaskan" in p["paragraph"][p["hl_start"]:p["hl_end"]]
    assert pts["terkait:2:suyudi"]["bucket"] == "tak disebut di liputan"


def test_unnamed_in_the_text_points_at_their_quote(conn):
    # The coverage names someone else with the same first name; only the
    # quotes filed under the figure lead back to the paragraph.
    _event(conn, 1, "suyudi", "Syok",
           "Wakil Ketua Sufmi Hartono bicara.\n\"Kami syok sekali,\" kata Sufmi di Jakarta.")
    _quote(conn, 1, "Sufmi", "Kami syok sekali,", figure="dasco")
    fig = next(f for f in cp.load_figures(conn) if f.id == "dasco")
    ev = cp._actor_evidence(conn, 1, fig)
    assert ev[0] == "a1" and "kata Sufmi" in ev[1][ev[2]:ev[3]]


def test_whom_a_quote_is_about_is_asked_per_quote(conn):
    _event(conn, 1, "suyudi", "Syok", '"Pak Amran pun syok," kata Sufmi.')
    _quote(conn, 1, "Sufmi", "Pak Amran pun syok,", figure="dasco")
    conn.execute("INSERT INTO quote_subjects (quote_id, figure_id, status, band, created_at) "
                 "VALUES (1, 'amran', 'auto', 'sapaan', ?)", (NOW,))
    cp.run(conn)
    p = _points(conn, "tentang")["tentang:1:amran"]
    prop = json.loads(p["proposal"])
    assert p["bucket"] == "sapaan" and prop["claim"] == "Kutipan ini tentang Andi Amran Sulaiman"
    assert prop["speaker_name"] == "Sufmi Dasco Ahmad"
    assert "Pak Amran" in p["paragraph"][p["hl_start"]:p["hl_end"]]


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


# ---------------------------------------------------------------------------
# auto-answering and speaker lessons


def _proven(conn, kind, bucket, n=25):
    """n of the curator's Ya answers for this kind and band: enough to clear the gate."""
    for i in range(n):
        conn.execute("INSERT INTO curation_points (kind, key, event_id, proposal, bucket, status, "
                     "answered_by, answered_at, created_at, refreshed_at) "
                     "VALUES (?, ?, 1, '{}', ?, 'ya', 'curator', ?, ?, ?)",
                     (kind, f"old:{kind}:{i}", bucket, NOW, NOW, NOW))


def _switch_on(conn, *kinds, since=NOW):
    conn.execute("INSERT INTO pipeline_state (key, value, updated_at) VALUES ('curation_auto', ?, ?)",
                 (json.dumps({k: since for k in kinds}), NOW))


def _links(conn, n=40, score=0.6):
    _event(conn, 2, None, "Penindakan beras oplosan")
    for i in range(n):
        _event(conn, 100 + i, "suyudi", body="oplosan")
        conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                     "VALUES (?, 2, ?, '[\"oplosan\"]', ?)", (100 + i, score, NOW))


def test_auto_is_off_until_switched_on(conn):
    _links(conn)
    _proven(conn, "peristiwa", "kuat")
    cp.run(conn)
    assert conn.execute("SELECT count(*) FROM curation_points WHERE status = 'auto'").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM record_links WHERE verdict IS NOT NULL").fetchone()[0] == 0


def test_auto_answers_a_proven_band_and_leaves_spot_checks(conn):
    _links(conn)
    _event(conn, 99, "suyudi", body="oplosan")
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (99, 2, 0.3, '[]', ?)", (NOW,))  # a band not yet proven
    _proven(conn, "peristiwa", "kuat")
    _switch_on(conn, "peristiwa")
    stats = cp.run(conn)

    pts = _points(conn, "peristiwa")
    spot = {k for k in pts if k.startswith("peristiwa:1") and cp._is_spot_check(k)}
    assert spot == {"peristiwa:109:2", "peristiwa:120:2"}
    assert stats["auto_peristiwa"] == 38 and stats["spot_peristiwa"] == 2
    for key in spot:
        assert pts[key]["status"] == "open" and pts[key]["spot_check"] == 1
    assert pts["peristiwa:99:2"]["status"] == "open" and pts["peristiwa:99:2"]["spot_check"] == 0
    a = pts["peristiwa:100:2"]
    assert a["status"] == "auto" and a["answered_by"] == "auto"
    assert json.loads(a["answer"])["undo"] == {
        "kind": "pair", "table": "record_links", "pairs": [{"a": 100, "b": 2, "prev": None}]}
    verdicts = dict(conn.execute("SELECT record_id, verdict FROM record_links").fetchall())
    assert verdicts[100] == "confirmed" and verdicts[109] is None and verdicts[99] is None

    # A second run answers nothing new and keeps the spot checks open.
    again = cp.run(conn)
    assert "auto_peristiwa" not in again and "spot_peristiwa" not in again


def test_a_wrong_spot_check_switches_the_kind_off(conn):
    _links(conn)
    _proven(conn, "peristiwa", "kuat")
    _switch_on(conn, "peristiwa")
    cp.run(conn)
    conn.execute("UPDATE curation_points SET status = 'bukan', answered_by = 'curator', "
                 "answered_at = '2026-10-21T00:00:00+00:00' WHERE key = 'peristiwa:109:2'")
    _event(conn, 200, "suyudi", body="oplosan")
    conn.execute("INSERT INTO record_links (record_id, peristiwa_id, score, evidence, created_at) "
                 "VALUES (200, 2, 0.6, '[]', ?)", (NOW,))
    stats = cp.run(conn)

    assert stats["off_peristiwa"] == 1 and "auto_peristiwa" not in stats
    assert _points(conn, "peristiwa")["peristiwa:200:2"]["status"] == "open"
    assert cp.auto_kinds(conn) == {}
    off = json.loads(conn.execute(
        "SELECT value FROM pipeline_state WHERE key = 'curation_auto_off'").fetchone()[0])
    assert off["peristiwa"]["agreed"] == 0 and off["peristiwa"]["checked"] == 1


def test_checks_from_before_it_was_switched_on_do_not_count(conn):
    _links(conn, n=1)
    conn.execute("INSERT INTO curation_points (kind, key, event_id, proposal, bucket, status, spot_check, "
                 "answered_by, answered_at, created_at, refreshed_at) "
                 "VALUES ('peristiwa', 'old-check', 1, '{}', 'kuat', 'bukan', 1, 'curator', "
                 "'2026-10-01T00:00:00+00:00', ?, ?)", (NOW, NOW))
    _proven(conn, "peristiwa", "kuat", n=40)
    _switch_on(conn, "peristiwa")
    assert cp.run(conn)["auto_peristiwa"] == 1


def test_terkait_and_tentang_auto_answers_are_kept_by_their_stages(conn):
    from jejak import participants, subjects
    _event(conn, 1, "amran", body='Menteri Amran menegaskan stok aman. "Pak Suyudi setuju," kata Amran.')
    _quote(conn, 1, "Amran", "Pak Suyudi setuju,", figure="amran")
    subjects.backfill(conn)
    participants.backfill(conn)
    _proven(conn, "tentang", "sapaan")
    _event(conn, 2, "suyudi", body="Suyudi Ario Seto meninjau pasar.")
    participants.backfill(conn)
    _proven(conn, "terkait", "disebut di liputan")
    _switch_on(conn, "terkait", "tentang")
    cp.run(conn)
    assert conn.execute("SELECT status, assigned_by FROM quote_subjects").fetchone()[:] == ("confirmed", "point")
    assert tuple(conn.execute("SELECT role, assigned_by FROM record_figures "
                              "WHERE event_id = 2 AND figure_id = 'suyudi'").fetchone()) == ("related", "point")
    subjects.backfill(conn)
    participants.backfill(conn)
    assert conn.execute("SELECT status FROM quote_subjects").fetchone()[0] == "confirmed"
    assert conn.execute("SELECT assigned_by FROM record_figures "
                        "WHERE event_id = 2 AND figure_id = 'suyudi'").fetchone()[0] == "point"


def _figure_row(conn, eid, fid, role, quotes=0, by="auto"):
    conn.execute("INSERT INTO record_figures (event_id, figure_id, role, source, quotes, assigned_by) "
                 "VALUES (?, ?, ?, 'owner', ?, ?)", (eid, fid, role, quotes, by))


def test_open_checks_turns_automatic_speakers_into_points(conn):
    _event(conn, 1, "suyudi", "Satgas tegaskan stok aman",
           'Suyudi Ario Seto meninjau pasar.\n"Stok aman," kata Amran.\n"Kami kooperatif," kata Juru Bicara KPK Budi Prasetyo.')
    _quote(conn, 1, "Amran", "Stok aman,", "amran")
    _quote(conn, 1, "Juru Bicara KPK Budi Prasetyo", "Kami kooperatif,", "budi-b")
    _quote(conn, 1, "Dasco", "Sudah,", "dasco", by="curator")  # the curator's own: not re-checked

    assert cp.open_checks(conn, 1) == 2
    spk = _points(conn, "pembicara")
    assert {p["bucket"] for p in spk.values()} == {"otomatis · satu kata", "otomatis · nama lengkap"}
    assert {json.loads(p["proposal"])["check"] for p in spk.values()} == {"pembicara"}

    # The run asks nothing of these and must not settle them; opening again is a no-op.
    cp.run(conn)
    assert {r[0] for r in conn.execute("SELECT status FROM curation_points WHERE key LIKE 'cek:%'")} == {"open"}
    assert conn.execute("SELECT count(*) FROM curation_points WHERE key LIKE 'cek:%'").fetchone()[0] == 2


def test_an_office_alone_is_its_own_band(conn):
    fig = next(f for f in cp.load_figures(conn) if f.id == "budi-b")
    assert cp._check_band(fig, "Juru bicara KPK") == "otomatis · sebutan"
    assert cp._check_band(fig, "Budi") == "otomatis · satu kata"
    assert cp._check_band(fig, "Jubir KPK Budi Prasetyo") == "otomatis · nama lengkap"
