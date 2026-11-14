"""Peristiwa that drift: an article has to sit with a cluster's articles, and
recluster_peristiwa repairs clusters that drifted before it had to."""
from __future__ import annotations

import math
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import cluster, db  # noqa: E402
from jejak.cluster import _Idf, _Open, _sits_with  # noqa: E402

FLOOD = {"banjir", "bandang", "sungai", "meluap", "warga", "mengungsi"}
CABINET = {"rapat", "kabinet", "menteri", "sidang", "fiskal", "defisit"}


def _vec(deg: float):
    rad = math.radians(deg)
    return np.array([math.cos(rad), math.sin(rad)], dtype=np.float32)


def _idf():
    return _Idf([FLOOD, FLOOD, CABINET, CABINET, {"gempa", "bumi", "aceh", "korban"}])


def _flood_cluster() -> _Open:
    ev = _Open(1, None, cluster._parse("2026-11-01"), _vec(0), _vec(0), set())
    for _ in range(3):
        ev.add(_vec(0), set(FLOOD))
    return ev


def test_an_article_like_the_cluster_sits_with_it():
    assert _sits_with(_flood_cluster(), _vec(5), set(FLOOD), _idf())


def test_close_in_meaning_but_sharing_no_words_with_any_article_does_not():
    """What drift looked like: the model rates it near, the words say otherwise."""
    assert not _sits_with(_flood_cluster(), _vec(5), set(CABINET), _idf())


def test_sharing_words_but_far_from_most_articles_does_not():
    # cos(60deg) = 0.5, under PERISTIWA_MEDIAN_SIM.
    assert not _sits_with(_flood_cluster(), _vec(60), set(FLOOD), _idf())


def test_sharing_words_with_one_member_only_does_not():
    """How 26051 chained: each article matched just the article before it."""
    ev = _flood_cluster()
    ev.add(_vec(5), set(CABINET))          # the one stray member already in, and the nearest
    assert not _sits_with(ev, _vec(5), set(CABINET), _idf())


def test_the_lead_leaves_out_appended_background_and_boilerplate():
    background = "Para tersangka ialah Irjen Ahrie Sonta dan Irjen Slamet Uliandi. " * 3
    art = {
        "title": "Megawati Tak Pegang Ponsel",
        "summary": '<img src="https://akcdn.detik.net.id/visual/foto.jpeg" /> Megawati bercerita',
        "body": "Megawati bercerita soal ponsel.\n" + "isi berita " * 80
                + "\nSaksikan Live DetikSore\n" + background,
    }
    toks = cluster._lead_tokens(art)
    assert {"megawati", "ponsel", "bercerita"} <= toks
    assert not toks & {"sonta", "uliandi", "akcdn", "jpeg", "saksikan", "detiksore"}


def test_casual_speech_is_not_shared_meaning():
    art = {"title": "Relawan datang", "summary": "", "body": "Ya gitu loh, nggak apa-apa kan."}
    assert not cluster._lead_tokens(art) & {"gitu", "loh", "nggak", "kan"}


# ---------------------------------------------------------------------------
# recluster_peristiwa

def _fresh(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    return db.connect(path)


def _stub_embed(monkeypatch):
    def fake(text: str):
        return _vec(90 if "kabinet" in text else 0)
    monkeypatch.setattr(cluster, "embed", fake)


def _event(conn, eid, title, status="summarized", curated=None):
    conn.execute(
        "INSERT INTO events (id, kind, title, event_date, status, curated, created_at) "
        "VALUES (?, 'peristiwa', ?, '2026-11-01T00:00:00+00:00', ?, ?, '2026-11-01')",
        (eid, title, status, curated))


def _article(conn, aid, event_id, source, words, day):
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, published_at, fetched_at, event_id) "
        "VALUES (?, NULL, ?, ?, ?, ?, '2026-11-01', ?)",
        (aid, source, f"http://x/{aid}", " ".join(sorted(words)), f"2026-11-0{day}T00:00:00+00:00", event_id))


def _drifted(conn):
    """Event 1 holds a flood and, wrongly, a cabinet meeting; event 2 more of
    the meeting; event 3 one more flood article."""
    _event(conn, 1, "Banjir bandang", curated="kept")
    _event(conn, 2, "Rapat kabinet")
    _event(conn, 3, "Banjir lagi")
    for i, src in enumerate(("Detik", "CNN Indonesia", "Antara")):
        _article(conn, f"f{i}", 1, src, FLOOD, i + 1)
    _article(conn, "f3", 3, "Republika", FLOOD, 4)
    _article(conn, "c0", 1, "Detik", CABINET, 2)
    _article(conn, "c1", 1, "Kompas", CABINET, 3)
    _article(conn, "c2", 2, "Republika", CABINET, 4)
    conn.execute(
        "INSERT INTO event_summaries (event_id, summary_text, citations_json, corroboration_count, "
        "single_source_flag, model, generated_at) VALUES (1, '- banjir', '[]', 3, 0, 'm', '2026-11-02')")
    # The same words quoted by two outlets: the curator named the speaker on one.
    for aid, eid, by in (("c0", 1, "auto"), ("c2", 2, "curator")):
        conn.execute(
            "INSERT INTO event_quotes (event_id, article_id, quote, speaker, figure_id, assigned_by, found_at) "
            "VALUES (?, ?, 'Anggaran tidak berubah', 'Sri', ?, ?, '2026-11-02')",
            (eid, aid, "sri-mulyani" if by == "curator" else None, by))
    conn.commit()


def _where(conn):
    return {r["id"]: r["event_id"] for r in conn.execute("SELECT id, event_id FROM articles")}


def test_without_apply_nothing_changes(tmp_path, monkeypatch):
    conn = _fresh(tmp_path)
    _stub_embed(monkeypatch)
    _drifted(conn)
    before = _where(conn)
    stats = cluster.recluster_peristiwa(conn, "2026-10-01")
    assert stats["moved"] > 0
    assert _where(conn) == before


def test_a_drifted_peristiwa_is_split_and_keeps_its_id(tmp_path, monkeypatch):
    conn = _fresh(tmp_path)
    _stub_embed(monkeypatch)
    _drifted(conn)

    stats = cluster.recluster_peristiwa(conn, "2026-10-01", apply=True)

    at = _where(conn)
    # The flood keeps event 1 (most of its articles) and the curator's verdict.
    assert {at[f"f{i}"] for i in range(4)} == {1}
    e1 = conn.execute("SELECT status, curated FROM events WHERE id = 1").fetchone()
    assert e1["curated"] == "kept"
    # Its articles changed, so its summary is written again.
    assert e1["status"] == "new"
    assert conn.execute("SELECT count(*) FROM event_summaries WHERE event_id = 1").fetchone()[0] == 0
    # The meeting is one event: event 2, where its remaining articles were.
    assert {at["c0"], at["c1"], at["c2"]} == {2}
    # Event 3 lost its only article to the flood.
    assert conn.execute("SELECT status FROM events WHERE id = 3").fetchone()[0] == "dissolved"
    assert stats["dissolved"] == 1

    # One quote now, with the curator's speaker.
    quotes = conn.execute("SELECT event_id, figure_id, assigned_by FROM event_quotes").fetchall()
    assert [tuple(q) for q in quotes] == [(2, "sri-mulyani", "curator")]


def test_a_stale_candidate_with_quotes_expires_instead_of_being_deleted(tmp_path):
    """A peristiwa the repair put back to candidate still has quotes and points."""
    conn = _fresh(tmp_path)
    _event(conn, 1, "Dulu terbit", status="candidate")
    _event(conn, 2, "Tak pernah terbit", status="candidate")
    _article(conn, "a1", 1, "Detik", FLOOD, 1)
    _article(conn, "a2", 2, "Detik", CABINET, 1)
    conn.execute("UPDATE events SET created_at = '2026-01-01'")
    conn.execute(
        "INSERT INTO event_quotes (event_id, article_id, quote, found_at) VALUES (1, 'a1', 'Air naik', '2026-11-02')")
    conn.commit()

    assert cluster.prune_candidates(conn) == 2

    assert conn.execute("SELECT status FROM events WHERE id = 1").fetchone()[0] == "expired"
    assert conn.execute("SELECT count(*) FROM articles WHERE id = 'a1'").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM events WHERE id = 2").fetchone()[0] == 0
