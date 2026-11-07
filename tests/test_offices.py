"""jejak/offices.py: a figure's main office as role and organisation, as a jabatan point."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import curation_points as cp, cv_extract, db, offices, organizations  # noqa: E402

NOW = "2026-11-01T10:00:00+00:00"

SEED = """
[[org]]
name = "Dewan Perwakilan Rakyat"
short = "DPR"
aliases = ["DPR RI"]
kind = "parlemen"

[[org]]
name = "Partai Demokrat"
kind = "partai"
"""


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    seed = tmp_path / "orgs.toml"
    seed.write_text(SEED)
    organizations.seed(c, seed)
    yield c
    c.close()


def _figure(conn, fid, name, role, positions=None):
    conn.execute("INSERT INTO figures (id, name, role, aliases, positions) VALUES (?, ?, ?, '[]', ?)",
                 (fid, name, role, json.dumps(positions) if positions is not None else None))


def _event(conn, eid, figure, body):
    conn.execute(
        "INSERT INTO events (id, figure_id, kind, title, event_date, last_seen, status, created_at) "
        "VALUES (?, ?, 'record', 'judul', ?, ?, 'new', ?)", (eid, figure, NOW, NOW, NOW))
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, body, fetch_status, "
        "fetched_at, published_at, event_id) VALUES (?, ?, 'Antara', ?, 'judul', ?, 'ok', ?, ?, ?)",
        (f"a{eid}", figure, f"https://x/{eid}", body, NOW, NOW, eid))


def _positions(conn, fid):
    return json.loads(conn.execute("SELECT positions FROM figures WHERE id = ?", (fid,)).fetchone()[0])


def _point(conn):
    w = cp._Writer(conn)
    cp._jabatan(conn, w)
    return conn.execute("SELECT * FROM curation_points WHERE kind = 'jabatan'").fetchone()


# ---------------------------------------------------------------------------
# Reading an office


def test_a_label_ending_with_a_known_organisation_splits_there(conn):
    index = organizations.index(conn)
    dpr = index["dpr"]
    assert offices.split_label("Wakil Ketua Komisi III DPR RI", index) == ("Wakil Ketua Komisi III", dpr)
    assert offices.split_label("Ketua Umum Partai Demokrat", index)[0] == "Ketua Umum"
    assert offices.split_label("DPR", index) is None  # no office left
    assert offices.split_label("Gubernur Bali", index) is None


@pytest.mark.parametrize("role, org, spellings, want", [
    ("Menteri Dalam Negeri", "Kementerian Dalam Negeri", [], "Menteri"),
    ("Wakil Ketua DPR", "Dewan Perwakilan Rakyat", ["Dewan Perwakilan Rakyat", "DPR", "DPR RI"], "Wakil Ketua"),
    ("Wali Kota Malang", "Pemerintah Kota Malang", [], "Wali Kota"),
    ("Gubernur", "Pemerintah Provinsi Bali", [], "Gubernur"),
])
def test_the_role_loses_the_organisation_written_into_it(role, org, spellings, want):
    assert offices.trim_role(role, org, spellings) == want


def test_not_an_organisation():
    for org in ("Dapil Jawa Barat VII", "Pemilu 2024", "Bidang Politik dan Keamanan",
                "Formula E Jakarta 2022", "Pramono Anung–Rano Karno"):
        assert not offices.is_org(org), org
    assert offices.is_org("Pemerintah Provinsi Bali")


def test_grounded_by_a_spelling_or_by_the_distinctive_words():
    assert offices.grounded("Wakil Ketua", "Dewan Perwakilan Rakyat", "Wakil Ketua DPR RI Sufmi Dasco",
                            ["Dewan Perwakilan Rakyat", "DPR"])
    assert offices.grounded("Gubernur", "Pemerintah Provinsi Bali", "Gubernur Bali Wayan Koster", [])
    assert not offices.grounded("Gubernur", "Pemerintah Provinsi Bali", "Wakil Gubernur Banten", [])
    assert not offices.grounded("Menteri", "Kementerian Keuangan", "Mantan menteri itu berkata", [])


def test_the_cv_keeps_an_office_named_the_short_way_and_drops_a_dapil():
    draft = {"positions": [{"role": "Gubernur", "org": "Pemerintah Provinsi Bali", "period": ""},
                           {"role": "Anggota DPR", "org": "Dapil Bali", "period": ""}],
             "facts": [], "education": []}
    out = cv_extract.ground(draft, "Gubernur Bali Wayan Koster, mantan anggota DPR dari dapil Bali.")
    assert out["positions"] == [{"role": "Gubernur", "org": "Pemerintah Provinsi Bali", "period": ""},
                                {"role": "Anggota DPR", "org": "", "period": ""}]


# ---------------------------------------------------------------------------
# Proposing


def test_a_label_split_needs_no_model_and_becomes_a_point(conn):
    _figure(conn, "ahy", "Agus Harimurti Yudhoyono", "Ketua Umum Partai Demokrat")
    _event(conn, 1, "ahy", "Ketua Umum Partai Demokrat Agus Harimurti Yudhoyono mengecam penyadapan.")
    assert offices.propose(conn, use_model=False)["dari_label"] == 1
    p = _point(conn)
    prop = json.loads(p["proposal"])
    assert (p["event_id"], p["bucket"], prop["role"], prop["org"]) == (1, "dari label", "Ketua Umum", "Partai Demokrat")
    assert "Agus Harimurti" in p["paragraph"][p["hl_start"]:p["hl_end"]]
    # Waiting on an answer: not proposed again.
    assert offices.propose(conn, use_model=False)["dari_label"] == 0


def test_the_model_is_trimmed_and_must_be_stated_beside_the_name(conn, monkeypatch):
    _figure(conn, "luthfi", "Ahmad Luthfi", "Gubernur Jawa Tengah")
    _figure(conn, "soni", "Andra Soni", "Gubernur Banten")
    _event(conn, 1, "luthfi", "Gubernur Jawa Tengah Ahmad Luthfi menegaskan komitmen itu.")
    _event(conn, 2, "soni", "Andra Soni hadir. Turut hadir Wakil Gubernur Banten Achmad Dimyati.")
    answers = {"Ahmad Luthfi": {"role": "Gubernur Jawa Tengah", "org": "Pemerintah Provinsi Jawa Tengah"},
               "Andra Soni": {"role": "Gubernur", "org": "Pemerintah Provinsi Banten"}}
    monkeypatch.setattr(offices, "ask_model", lambda name, *a: answers[name])
    out = offices.propose(conn)
    assert (out["model"], out["model_ungrounded"]) == (1, 1)
    row = conn.execute("SELECT figure_id, role, org, band FROM office_proposals").fetchone()
    assert tuple(row) == ("luthfi", "Gubernur", "Pemerintah Provinsi Jawa Tengah", "model, baru")


def test_a_figure_with_a_linked_office_is_not_asked(conn):
    dpr = organizations.index(conn)["dpr"]
    _figure(conn, "puan", "Puan Maharani", "Ketua DPR",
            [{"role": "Ketua", "org": "DPR", "period": "", "org_id": dpr}])
    _event(conn, 1, "puan", "Ketua DPR Puan Maharani mendukung langkah itu.")
    assert offices.propose(conn, use_model=False)["dari_label"] == 0


# ---------------------------------------------------------------------------
# Answering


def _proposed(conn):
    _figure(conn, "sahroni", "Ahmad Sahroni", "Wakil Ketua Komisi III DPR",
            [{"role": "Wakil Ketua Komisi III DPR", "org": "", "period": "2024 – kini"},
             {"role": "Anggota", "org": "Partai NasDem", "period": ""}])
    _event(conn, 1, "sahroni", "Wakil Ketua Komisi III DPR RI Ahmad Sahroni menyatakan rapat terbuka.")
    offices.propose(conn, use_model=False)
    return _point(conn)


def test_ya_writes_the_office_over_the_entry_it_fixes_and_undo_puts_it_back(conn):
    p = _proposed(conn)
    before = conn.execute("SELECT positions FROM figures WHERE id = 'sahroni'").fetchone()[0]
    offices.answer(conn, p["id"], "ya")
    pos = _positions(conn, "sahroni")
    dpr = organizations.index(conn)["dpr"]
    assert pos[0] == {"role": "Wakil Ketua Komisi III", "org": "Dewan Perwakilan Rakyat",
                      "period": "2024 – kini", "org_id": dpr}
    assert pos[1]["org"] == "Partai NasDem" and len(pos) == 2
    assert conn.execute("SELECT cv_curated FROM figures WHERE id = 'sahroni'").fetchone()[0] == 1
    assert conn.execute("SELECT verdict FROM office_proposals").fetchone()[0] == "confirmed"
    # The question went away; organisations.link keeps the id it was given.
    organizations.link(conn)
    assert _positions(conn, "sahroni")[0]["org_id"] == dpr

    offices.undo(conn, p["id"])
    assert conn.execute("SELECT positions FROM figures WHERE id = 'sahroni'").fetchone()[0] == before
    status = conn.execute("SELECT status FROM curation_points WHERE id = ?", (p["id"],)).fetchone()[0]
    assert status == "open"
    assert conn.execute("SELECT verdict FROM office_proposals").fetchone()[0] is None


def test_a_correction_to_a_new_organisation_adds_it_and_undo_takes_it_away(conn):
    p = _proposed(conn)
    offices.answer(conn, p["id"], "koreksi", "Ketua", "Pemerintah Kota Malang")
    pos = _positions(conn, "sahroni")
    org = conn.execute("SELECT id FROM organizations WHERE name = 'Pemerintah Kota Malang'").fetchone()
    # Another office than the one written there: that one stays below.
    assert pos[0] == {"role": "Ketua", "org": "Pemerintah Kota Malang", "period": "", "org_id": org[0]}
    assert pos[1]["role"] == "Wakil Ketua Komisi III DPR"
    label = json.loads(conn.execute("SELECT answer FROM curation_points WHERE id = ?", (p["id"],)).fetchone()[0])["label"]
    assert label == "Ketua – Pemerintah Kota Malang"
    offices.undo(conn, p["id"])
    assert conn.execute("SELECT 1 FROM organizations WHERE name = 'Pemerintah Kota Malang'").fetchone() is None


def test_a_correction_that_is_no_organisation_is_refused(conn):
    p = _proposed(conn)
    with pytest.raises(offices.Refused):
        offices.answer(conn, p["id"], "koreksi", "Anggota", "Dapil DKI Jakarta III")


def test_bukan_keeps_the_cv_and_the_figure_waits(conn):
    p = _proposed(conn)
    before = conn.execute("SELECT positions FROM figures WHERE id = 'sahroni'").fetchone()[0]
    offices.answer(conn, p["id"], "bukan")
    assert conn.execute("SELECT positions FROM figures WHERE id = 'sahroni'").fetchone()[0] == before
    assert conn.execute("SELECT verdict FROM office_proposals").fetchone()[0] == "rejected"
    # The label split was turned down; with no model nothing else is proposed.
    assert offices.propose(conn, use_model=False)["dari_label"] == 0


def test_undo_refuses_when_the_cv_changed_since(conn):
    p = _proposed(conn)
    offices.answer(conn, p["id"], "ya")
    conn.execute("UPDATE figures SET positions = '[]' WHERE id = 'sahroni'")
    with pytest.raises(offices.Refused):
        offices.undo(conn, p["id"])


def test_a_point_fixed_elsewhere_settles(conn):
    p = _proposed(conn)
    dpr = organizations.index(conn)["dpr"]
    conn.execute("UPDATE figures SET positions = ? WHERE id = 'sahroni'",
                 (json.dumps([{"role": "Wakil Ketua", "org": "DPR", "period": "", "org_id": dpr}]),))
    assert _point(conn)["id"] == p["id"]  # the old row; no new one asked
    assert conn.execute("SELECT verdict FROM office_proposals").fetchone()[0] == "settled"


def test_auto_answering_and_salah(conn):
    p = _proposed(conn)
    for i in range(25):
        conn.execute("INSERT INTO curation_points (kind, key, event_id, proposal, bucket, status, "
                     "answered_by, answered_at, created_at, refreshed_at) "
                     "VALUES ('jabatan', ?, 1, '{}', 'dari label', 'ya', 'curator', ?, ?, ?)",
                     (f"old:{i}", NOW, NOW, NOW))
    conn.execute("INSERT INTO pipeline_state (key, value, updated_at) VALUES ('curation_auto', ?, ?)",
                 (json.dumps({"jabatan": NOW}), NOW))
    before = conn.execute("SELECT positions FROM figures WHERE id = 'sahroni'").fetchone()[0]
    if cp._is_spot_check(f"jabatan:{json.loads(p['proposal'])['proposal_id']}"):
        pytest.skip("this key is a spot check")
    assert cp.auto_answer(conn).get("auto_jabatan") == 1
    assert _positions(conn, "sahroni")[0]["role"] == "Wakil Ketua Komisi III"
    offices.undo(conn, p["id"], salah=True)
    assert conn.execute("SELECT positions FROM figures WHERE id = 'sahroni'").fetchone()[0] == before
    assert conn.execute("SELECT status FROM curation_points WHERE id = ?", (p["id"],)).fetchone()[0] == "auto_wrong"
    assert conn.execute("SELECT verdict FROM office_proposals").fetchone()[0] == "rejected"
