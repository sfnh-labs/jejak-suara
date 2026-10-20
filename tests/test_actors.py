"""jejak/actors.py: another figure's own statement inside an article becomes theirs."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import actors, cluster, db, ingest, summarize  # noqa: E402
from jejak.config import Figure  # noqa: E402

NOW = "2026-10-15T10:00:00+00:00"


def _pat(name: str, *aliases: str):
    return actors._pattern(Figure(id="x", name=name, role="", aliases=list(aliases)))


@pytest.mark.parametrize("body,name,found", [
    # Appositive office between name and verb.
    ("Menteri PU, Dody Hanggodo, menegaskan Kementerian PU terus mendorong irigasi.",
     "Dody Hanggodo", True),
    # Attribution after the quote.
    ('"Masih ada 639 hektare dalam pemadaman," kata Seskab Teddy Indra Wijaya.',
     "Teddy Indra Wijaya", True),
    # Bracketed alias.
    ("Presiden ke-7 RI Joko Widodo (Jokowi) menyebut polemik ijazah operasi politik.",
     "Joko Widodo", True),
    # Someone else is the subject of the verb.
    ("Melalui SEB dengan Mentan Andi Amran Sulaiman, Mendagri mengungkapkan BPP jadi wadah.",
     "Andi Amran Sulaiman", False),
    # Named as the object of another's act.
    ("Wakil Ketua Komisi IV Alex Indra Lukman meminta Presiden Prabowo Subianto membuka data.",
     "Prabowo Subianto", False),
])
def test_passage_needs_the_figure_to_act(body, name, found):
    assert (actors.passage(body, _pat(name)) is not None) == found


def test_passage_keeps_context_and_the_quote_that_follows():
    body = ("Penolakan terhadap konser Bocelli sebelumnya disuarakan MUI. "
            "Ketua MUI Bidang Hubungan Luar Negeri, Sudarnoto Abdul Hakim, mendesak "
            "pemerintah membatalkan konser tersebut. "
            '"Ini soal rekam jejak," ujarnya. '
            "Fadli Zon menghormati keputusan polisi.")
    text = actors.passage(body, _pat("Sudarnoto Abdul Hakim"))
    assert text.startswith("Penolakan terhadap konser")   # what "konser tersebut" is
    assert "rekam jejak" in text
    assert "Fadli Zon" not in text


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    for fid, name, role in [("fadli-zon", "Fadli Zon", "Menteri Kebudayaan"),
                            ("sudarnoto", "Sudarnoto Abdul Hakim", "Ketua MUI"),
                            ("budi-prasetyo", "Budi Prasetyo", "Juru Bicara KPK")]:
        c.execute("INSERT INTO figures (id, name, role) VALUES (?, ?, ?)", (fid, name, role))
    yield c
    c.close()


def _article(conn, aid, owner, body, when=None):
    when = when or actors._now()
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, body, fetch_status, "
        "published_at, fetched_at) VALUES (?, ?, 'CNN Indonesia', ?, ?, ?, 'ok', ?, ?)",
        (aid, owner, f"https://x/{aid}", "Fadli Zon Respons Polisi Cabut Izin Konser",
         body, when, when))
    conn.commit()


BOCELLI = ("Menteri Kebudayaan Fadli Zon menghormati keputusan polisi. "
           "Ketua MUI, Sudarnoto Abdul Hakim, mendesak pemerintah membatalkan konser itu. "
           '"Pemeriksaan masih berjalan," kata Juru Bicara KPK Budi Prasetyo.')


def test_derive_copies_the_statement_out_once(conn):
    _article(conn, "a1", "fadli-zon", BOCELLI)

    assert actors.derive(conn) == {"scanned": 1, "derived": 1, "join_only": 0}
    row = conn.execute("SELECT * FROM articles WHERE derived_from = 'a1'").fetchone()
    # The MUI chair's own article; never Fadli Zon's (the owner) and never the
    # spokesperson's routine update.
    assert row["figure_id"] == "sudarnoto" and row["derived_mode"] == "record"
    assert row["url"] == "https://x/a1" and row["fetch_status"] == "ok"
    assert "mendesak" in row["body"]
    assert conn.execute("SELECT 1 FROM article_scans WHERE article_id = ?", (row["id"],)).fetchone()

    assert actors.derive(conn)["scanned"] == 0


def test_a_recalled_statement_may_only_join(conn):
    _article(conn, "a2", "fadli-zon",
             "Penolakan sebelumnya disuarakan MUI. Ketua MUI, Sudarnoto Abdul Hakim, "
             "mendesak pemerintah membatalkan konser itu.")
    assert actors.derive(conn)["join_only"] == 1


def test_old_articles_are_not_scanned(conn):
    _article(conn, "a3", "fadli-zon", BOCELLI, when="2025-01-01T00:00:00+00:00")
    assert actors.derive(conn)["scanned"] == 0


def test_reattribute_leaves_derived_articles_with_their_figure(conn, monkeypatch):
    _article(conn, "a4", "fadli-zon", BOCELLI)
    actors.derive(conn)
    monkeypatch.setattr(ingest, "_attribute", lambda text, figures: None)
    ingest.reattribute(conn, figures=[], only_unclustered=True)
    assert conn.execute(
        "SELECT figure_id FROM articles WHERE derived_from = 'a4'").fetchone()[0] == "sudarnoto"


def test_cluster_drops_a_join_only_passage_with_nothing_to_join(conn, monkeypatch):
    monkeypatch.setattr(cluster, "embed", lambda text: [1.0, 0.0])
    monkeypatch.setattr(cluster, "load_figures", lambda *a: [])
    _article(conn, "a5", "fadli-zon",
             "Penolakan sebelumnya disuarakan MUI. Ketua MUI, Sudarnoto Abdul Hakim, "
             "mendesak pemerintah membatalkan konser itu.")
    actors.derive(conn)
    stats = cluster.cluster(conn)
    assert stats["derived_dropped"] == 1
    assert conn.execute("SELECT count(*) FROM articles WHERE derived_from IS NOT NULL").fetchone()[0] == 0
    # The article it came from still makes Fadli Zon's record.
    assert conn.execute("SELECT figure_id FROM events").fetchall()[0][0] == "fadli-zon"


def test_summarizer_sees_the_passage_not_the_other_figures_headline(conn):
    _article(conn, "a6", "fadli-zon", BOCELLI)
    actors.derive(conn)
    row = conn.execute("SELECT source, url, title, summary, body, published_at, derived_from "
                       "FROM articles WHERE derived_from = 'a6'").fetchone()
    text = summarize._format_articles([row])
    assert "Fadli Zon Respons" not in text and "mendesak" in text
