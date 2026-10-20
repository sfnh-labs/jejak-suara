"""jejak/curation_suggest.py: suggestions from /kurasi labels, and the auto-hide gate."""
from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import curation_suggest as cs, db  # noqa: E402

NOW = "2026-10-05T10:00:00+00:00"
DIM = 8


@pytest.fixture
def conn(tmp_path):
    path = tmp_path / "test.db"
    db.init_db(path)
    c = db.connect(path)
    yield c
    c.close()


def _vec(axis: int, rng: np.random.Generator, noise: float = 0.05) -> np.ndarray:
    v = np.zeros(DIM, dtype=np.float32)
    v[axis] = 1.0
    v += rng.normal(0, noise, DIM).astype(np.float32)
    return v / np.linalg.norm(v)


def _event(conn: sqlite3.Connection, eid: int, vec: np.ndarray, figure: str = "budi",
           title: str = "judul") -> None:
    conn.execute(
        "INSERT INTO events (id, figure_id, kind, title, event_date, last_seen, "
        "status, created_at) VALUES (?, ?, 'record', ?, ?, ?, 'new', ?)",
        (eid, figure, title, NOW, NOW, NOW),
    )
    aid = f"a{eid}"
    conn.execute(
        "INSERT INTO articles (id, figure_id, source, url, title, fetched_at, "
        "published_at, event_id) VALUES (?, ?, 'x', ?, ?, ?, ?, ?)",
        (aid, figure, f"https://x/{eid}", title, NOW, NOW, eid),
    )
    conn.execute(
        "INSERT INTO article_embeddings (article_id, text_hash, vec) VALUES (?, 'h', ?)",
        (aid, vec.astype(np.float32).tobytes()),
    )


def _label(conn: sqlite3.Connection, eid: int, verdict: str, reasons: list[str],
           title: str = "judul", outlets: int = 2) -> None:
    conn.execute(
        "INSERT INTO curation_labels (event_id, verdict, reasons, kind, figure_id, "
        "title, outlets, decided_at) VALUES (?, ?, ?, 'record', 'budi', ?, ?, ?)",
        (eid, verdict, json.dumps(reasons), title, outlets, NOW),
    )


def _seed(conn, n_each: int, rng) -> None:
    """n_each trivial takedowns along axis 0, n_each keeps along axis 1."""
    for i in range(n_each):
        _event(conn, 100 + i, _vec(0, rng), title="ucapan selamat ulang tahun")
        _label(conn, 100 + i, "rejected", ["trivial"], title="ucapan selamat ulang tahun", outlets=1)
        _event(conn, 200 + i, _vec(1, rng), title="anggaran pertahanan disahkan")
        _label(conn, 200 + i, "kept", [], title="anggaran pertahanan disahkan")


def _suggestion(conn, eid):
    return conn.execute(
        "SELECT reason, confidence, support, auto_hide FROM curation_suggestions WHERE event_id = ?",
        (eid,),
    ).fetchone()


def test_suggests_the_reason_of_similar_takedowns(conn):
    rng = np.random.default_rng(0)
    _seed(conn, 15, rng)
    _event(conn, 1, _vec(0, rng))   # looks like the takedowns
    _event(conn, 2, _vec(1, rng))   # looks like the keeps
    conn.commit()

    res = cs.run(conn, auto_hide=False)

    s = _suggestion(conn, 1)
    assert s["reason"] == "trivial"
    assert s["confidence"] >= cs.SUGGEST_AT
    assert s["support"] >= cs.MIN_SUPPORT
    assert s["auto_hide"] == 0
    assert _suggestion(conn, 2) is None
    assert res["suggested"] == 1
    # Labelled events are the curator's already; they are never scored.
    assert _suggestion(conn, 100) is None


def test_silent_below_min_labels(conn):
    rng = np.random.default_rng(1)
    _seed(conn, 5, rng)  # 10 labels < MIN_LABELS
    _event(conn, 1, _vec(0, rng))
    conn.commit()
    cs.run(conn, auto_hide=False)
    assert _suggestion(conn, 1) is None


def test_auto_hide_needs_the_flag_and_proven_precision(conn, monkeypatch):
    rng = np.random.default_rng(2)
    _seed(conn, 30, rng)
    _event(conn, 1, _vec(0, rng, noise=0.01))
    conn.commit()

    cs.run(conn, auto_hide=False)
    assert _suggestion(conn, 1)["auto_hide"] == 0

    cs.run(conn, auto_hide=True)
    assert _suggestion(conn, 1)["auto_hide"] == 1
    state = json.loads(conn.execute(
        "SELECT value FROM pipeline_state WHERE key = 'curation_model'"
    ).fetchone()[0])
    assert state["reasons"]["trivial"]["auto_eligible"] is True

    # Not enough leave-one-out evidence: the flag alone hides nothing.
    monkeypatch.setattr(cs, "AUTO_MIN_PREDICTIONS", 1000)
    cs.run(conn, auto_hide=True)
    assert _suggestion(conn, 1)["auto_hide"] == 0


def test_imprecise_reason_is_never_auto_hidden(conn):
    rng = np.random.default_rng(3)
    # The same kind of coverage, ruled both ways: 60% down, 40% kept.
    for i in range(50):
        _event(conn, 100 + i, _vec(0, rng))
        if i % 5 < 3:
            _label(conn, 100 + i, "rejected", ["trivial"])
        else:
            _label(conn, 100 + i, "kept", [])
    _event(conn, 1, _vec(0, rng))
    conn.commit()
    cs.run(conn, auto_hide=True)
    s = _suggestion(conn, 1)
    assert s is None or s["auto_hide"] == 0


def test_stale_suggestion_is_blanked_not_deleted(conn):
    rng = np.random.default_rng(4)
    _seed(conn, 15, rng)
    _event(conn, 1, _vec(0, rng))
    conn.commit()
    cs.run(conn, auto_hide=False)
    assert _suggestion(conn, 1)["reason"] == "trivial"

    # The curator changes their mind about the whole cluster.
    conn.execute("UPDATE curation_labels SET verdict = 'kept', reasons = '[]'")
    conn.commit()
    cs.run(conn, auto_hide=False)
    # Push only upserts, so the row has to stay and say "nothing".
    s = _suggestion(conn, 1)
    assert s is not None and s["reason"] is None and s["auto_hide"] == 0


def test_duplicate_is_never_suggested(conn):
    rng = np.random.default_rng(5)
    for i in range(25):
        _event(conn, 100 + i, _vec(0, rng))
        _label(conn, 100 + i, "rejected", ["duplicate"])
    _event(conn, 1, _vec(0, rng))
    conn.commit()
    cs.run(conn, auto_hide=False)
    assert _suggestion(conn, 1) is None


def test_report_names_reasons_and_marked_words(conn):
    rng = np.random.default_rng(6)
    _seed(conn, 15, rng)
    conn.commit()
    text = cs.report(conn)
    assert "Remeh / seremonial [trivial]: 15" in text
    assert "single-source 15/15" in text
    assert "ucapan" in text
    assert "leave-one-out" in text


def test_report_without_labels(conn):
    assert "No curation labels yet" in cs.report(conn)
