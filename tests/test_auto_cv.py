"""jejak/kurasi.py auto_cv: CV material found, drafted and applied with no curator."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import cv_extract, db, kurasi  # noqa: E402

NOW = "2026-10-15T10:00:00+00:00"


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    c.execute("INSERT INTO figures (id, name, positions, facts) VALUES (?, ?, ?, ?)",
              ("ferry", "Ferry Juliantono",
               json.dumps([{"role": "Wakil Menteri", "org": "Koperasi", "period": "2024–2025"}]),
               json.dumps([{"label": "Partai", "value": "Gerindra"}])))
    c.execute("INSERT INTO figures (id, name) VALUES ('prabowo', 'Prabowo Subianto')")
    yield c
    c.close()


def _record(conn, eid: int, figure: str, title: str, curated: str | None = None) -> None:
    conn.execute(
        "INSERT INTO events (id, figure_id, kind, title, event_date, last_seen, status, "
        "created_at, curated) VALUES (?, ?, 'record', ?, ?, ?, 'approved', ?, ?)",
        (eid, figure, title, NOW, NOW, NOW, curated))
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, summary, fetched_at, "
        "published_at, event_id) VALUES (?, ?, 'Antara', ?, ?, ?, ?, ?, ?)",
        (f"a{eid}", figure, f"https://x/{eid}", title, BODY, NOW, NOW, eid))


BODY = ("Ferry Juliantono dilantik menjadi Menteri Koperasi. Partai Gerindra mengusung Ferry. "
        "Ia lulusan S1 Universitas Padjadjaran.")


APPOINTED = {
    "positions": [{"role": "Menteri", "org": "Koperasi", "period": "2025 – kini"}],
    "facts": [{"label": "Partai", "value": "Partai Gerindra"}],
    "education": [{"year": "", "detail": "S1 Universitas Padjadjaran"}],
}


@pytest.fixture
def model(monkeypatch):
    """The local model, stubbed: a classify call (num_predict 120) says whether
    the record is CV material by its title; a draft call returns APPOINTED."""
    calls = []

    def chat(messages, num_predict=800):
        text = messages[-1]["content"]
        calls.append(num_predict)
        if num_predict == 120:
            return {"cv": "Dilantik" in text, "why": "pelantikan" if "Dilantik" in text else "ucapan"}
        return APPOINTED

    monkeypatch.setattr(cv_extract, "_chat_json", chat)
    return calls


def test_appointment_goes_onto_the_cv_and_the_record_comes_down(conn, model):
    _record(conn, 1, "ferry", "Dilantik Menjadi Menteri Koperasi")
    conn.commit()

    stats = kurasi.auto_cv(conn)

    assert stats["applied"] == 1
    f = conn.execute("SELECT positions, facts, education, role, sources, cv_curated "
                     "FROM figures WHERE id = 'ferry'").fetchone()
    positions = json.loads(f["positions"])
    # The current office goes first and becomes the title; the old one stays.
    assert positions[0]["role"] == "Menteri" and len(positions) == 2
    assert f["role"] == "Menteri Koperasi"
    # A label the CV already has keeps its value (it may be the curator's).
    assert json.loads(f["facts"]) == [{"label": "Partai", "value": "Gerindra"}]
    assert json.loads(f["education"]) == [{"detail": "S1 Universitas Padjadjaran"}]
    assert json.loads(f["sources"])[0]["url"] == "https://x/1"
    assert f["cv_curated"] == 0

    ev = conn.execute("SELECT curated FROM events WHERE id = 1").fetchone()
    assert ev["curated"] == "rejected"
    label = conn.execute("SELECT reasons, note FROM curation_labels WHERE event_id = 1").fetchone()
    assert json.loads(label["reasons"]) == ["cv_material"]
    assert label["note"].startswith(kurasi.AUTO_CV_NOTE)
    p = conn.execute("SELECT status, origin, learned_at FROM cv_proposals WHERE event_id = 1").fetchone()
    assert (p["status"], p["origin"]) == ("accepted", "auto") and p["learned_at"]


def test_an_act_is_checked_once_and_left_alone(conn, model):
    # Passes the keyword screen ("ditunjuk"), but is something he did.
    _record(conn, 2, "prabowo", "Menolak ditunjuk menjadi Menteri Keuangan")
    conn.commit()

    assert kurasi.auto_cv(conn)["not_cv"] == 1
    assert conn.execute("SELECT curated FROM events WHERE id = 2").fetchone()[0] is None
    assert model == [120]   # no draft for a record that is not CV material
    # Never asked about again.
    assert kurasi.auto_cv(conn)["checked"] == 0


def test_screen_skips_ordinary_and_ruled_records(conn, model):
    _record(conn, 3, "prabowo", "Meresmikan bendungan di Jawa Tengah")      # no CV words
    _record(conn, 4, "ferry", "Dilantik Menjadi Menteri Koperasi", curated="kept")  # curator ruled
    conn.commit()
    assert kurasi.cv_candidates(conn) == []
    assert kurasi.auto_cv(conn)["checked"] == 0 and model == []


def test_model_down_stops_the_run_and_writes_nothing(conn, monkeypatch):
    _record(conn, 5, "ferry", "Dilantik Menjadi Menteri Koperasi")
    conn.commit()

    def down(messages, num_predict=800):
        raise cv_extract.ModelDown("Ollama not reachable")

    monkeypatch.setattr(cv_extract, "_chat_json", down)
    assert kurasi.auto_cv(conn)["failed"] == 1
    assert conn.execute("SELECT count(*) FROM cv_proposals").fetchone()[0] == 0
    # Still a candidate for the next run.
    assert [r["id"] for r in kurasi.cv_candidates(conn)] == [5]


def test_auto_rows_teach_no_lessons(conn, model):
    _record(conn, 6, "ferry", "Dilantik Menjadi Menteri Koperasi")
    conn.commit()
    kurasi.auto_cv(conn)
    kurasi.learn(conn)
    assert conn.execute("SELECT count(*) FROM curation_lessons").fetchone()[0] == 0


def test_one_bad_answer_skips_only_that_record(conn, monkeypatch):
    _record(conn, 7, "ferry", "Dilantik Menjadi Menteri Koperasi")
    _record(conn, 8, "ferry", "Ditunjuk Menjadi Ketua Kadin")
    conn.commit()
    seen = []

    def chat(messages, num_predict=800):
        seen.append(num_predict)
        raise RuntimeError("the model did not return JSON")

    monkeypatch.setattr(cv_extract, "_chat_json", chat)
    stats = kurasi.auto_cv(conn)
    assert stats["failed"] == 2 and len(seen) == 2   # both tried, neither recorded
    assert len(kurasi.cv_candidates(conn)) == 2


def test_ground_keeps_only_what_the_articles_say():
    # The real failure: a karhutla meeting drafted into family facts from memory.
    text = ("Prabowo Subianto memimpin rapat penanganan karhutla di Istana. "
            "Hadir pula Menteri Kehutanan. Mantan istri Prabowo, Titiek Soeharto, ikut hadir.")
    draft = {
        "positions": [{"role": "Presiden", "org": "Republik Indonesia", "period": "2024 – kini"},
                      {"role": "Menteri", "org": "Kehutanan", "period": ""}],
        "facts": [{"label": "Ayah", "value": "Soeharto, Presiden Indonesia"},   # no "ayah" with it
                  {"label": "Istri", "value": "Hansie Prabowo"},                # not in the text
                  {"label": "Istri", "value": "Titiek Soeharto"}],              # stated
        "education": [{"year": "", "detail": "Belum dinyatakan"}],
    }
    out = cv_extract.ground(draft, text)
    # "Presiden" is not in the text; the Kehutanan office is (whose it is, the
    # classifier and the prompt answer, not this check).
    assert [p["org"] for p in out["positions"]] == ["Kehutanan"]
    assert out["facts"] == [{"label": "Istri", "value": "Titiek Soeharto"}]
    assert out["education"] == []


@pytest.mark.parametrize("title,name,office", [
    ("Dilantik Menjadi Menko Polkam", "Dudung Abdurachman", "Menko Polkam"),
    ('Hasan Nasbi "Is Back", Dilantik Prabowo Jadi Penasihat Khusus Presiden', "Hasan Nasbi",
     "Penasihat Khusus Presiden"),
    ("Maruli Simanjuntak Dilantik Jadi Wakil Panglima TNI, Tandyo Budi KSAD", "Maruli Simanjuntak",
     "Wakil Panglima TNI"),
    ("Ditunjuk kembali sebagai Menteri Sosial", "Saifullah Yusuf", "Menteri Sosial"),
    ("Menjabat Ketua Harian", "Ferry Juliantono", "Ketua Harian"),
    ("Profil Irjen Pol Suyudi Ario Seto yang Dilantik Prabowo Jadi Kepala BNN", "Suyudi Ario Seto",
     "Kepala BNN"),
    # Acts, or someone else's appointment: no office.
    ("Menolak dilantik menjadi Ketua Umum Partai Nasdem", "Prabowo Subianto", None),
    ("Menandatangani Dokumen Setelah Dilantik", "Prabowo Subianto", None),
    ("Kata-kata Dito Ariotedjo Usai Ditunjuk Prabowo Jadi Menpora", "Dito Ariotedjo", None),
    ("Menyatakan akan dilantik menjadi Kepala Otorita IKN", "Basuki Hadimuljono", None),
    ("Usai Dilantik, Dofiri dan Djamari Langsung Menghadap Prabowo", "Prabowo Subianto", None),
])
def test_office_from_title(title, name, office):
    assert cv_extract.office_from_title(title, name) == office


def test_title_appointment_skips_the_classifier(conn, model):
    _record(conn, 9, "ferry", "Ditunjuk sebagai Menteri Koperasi")
    conn.commit()
    assert kurasi.auto_cv(conn)["applied"] == 1
    assert model == [800]   # draft only; the title settled whether it is CV material


def test_an_old_record_adds_but_never_retitles(conn, model, monkeypatch):
    # A year-old appointment: its "– kini" office is history by now.
    _record(conn, 10, "ferry", "Dilantik Menjadi Menteri Koperasi")
    conn.execute("UPDATE events SET event_date = '2025-09-01T00:00:00+00:00' WHERE id = 10")
    conn.execute("UPDATE figures SET role = 'Wakil Menteri Koperasi' WHERE id = 'ferry'")
    conn.commit()
    assert kurasi.auto_cv(conn)["applied"] == 1
    f = conn.execute("SELECT positions, role FROM figures WHERE id = 'ferry'").fetchone()
    positions = json.loads(f["positions"])
    assert positions[0]["role"] == "Wakil Menteri"     # order untouched
    assert positions[-1]["role"] == "Menteri"           # appended
    assert f["role"] == "Wakil Menteri Koperasi"        # title untouched


def test_ground_drops_facts_true_only_on_the_day():
    text = "Prabowo dilantik pada usia 73 tahun. Ia lahir 55 tahun lalu di Jakarta."
    draft = {"positions": [], "education": [],
             "facts": [{"label": "Usia", "value": "73 tahun"},
                       {"label": "Lahir", "value": "55 tahun lalu, Jakarta"}]}
    assert cv_extract.ground(draft, text)["facts"] == []
