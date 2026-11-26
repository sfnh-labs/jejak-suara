"""The curator's article labels on a peristiwa: applied, kept by the repair,
and used to score clustering rules."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from jejak import cluster, cluster_labels  # noqa: E402
from tests.test_peristiwa_drift import _drifted, _fresh, _stub_embed, _where  # noqa: E402


def _label(conn, article, event, verdict, anchor=None):
    conn.execute(
        "INSERT INTO cluster_labels (article_id, event_id, verdict, anchor_id, decided_at) "
        "VALUES (?, ?, ?, ?, '2026-11-20')", (article, event, verdict, anchor))
    conn.commit()


def test_an_out_article_leaves_and_the_event_is_summarized_again(tmp_path):
    conn = _fresh(tmp_path)
    _drifted(conn)
    _label(conn, "c0", 1, "out", anchor="f0")
    assert cluster_labels.apply_out(conn) == 1
    where = _where(conn)
    assert where["c0"] != 1
    assert conn.execute("SELECT status FROM events WHERE id = ?", (where["c0"],)).fetchone()[0] == "candidate"
    # Its quote went with it.
    assert conn.execute("SELECT event_id FROM event_quotes WHERE article_id = 'c0'").fetchone()[0] == where["c0"]
    assert conn.execute("SELECT count(*) FROM event_summaries WHERE event_id = 1").fetchone()[0] == 0
    # Applied once: a second run moves nothing.
    assert cluster_labels.apply_out(conn) == 0


def test_the_repair_keeps_an_out_article_apart(tmp_path, monkeypatch):
    """f3 reads like the flood to the rules; the curator said it is not."""
    conn = _fresh(tmp_path)
    _stub_embed(monkeypatch)
    _drifted(conn)
    _label(conn, "f3", 3, "out", anchor="f0")
    cluster.recluster_peristiwa(conn, "2026-10-01", apply=True)
    where = _where(conn)
    assert where["f3"] != where["f0"]
    assert where["f1"] == where["f0"]


def test_the_repair_keeps_confirmed_articles_together_under_their_event(tmp_path, monkeypatch):
    """The rules would split the meeting off the flood; the curator put c0 with it."""
    conn = _fresh(tmp_path)
    _stub_embed(monkeypatch)
    _drifted(conn)
    for a in ("f0", "f1", "c0"):
        _label(conn, a, 1, "in")
    cluster.recluster_peristiwa(conn, "2026-10-01", apply=True)
    where = _where(conn)
    assert where["c0"] == where["f0"] == where["f1"] == 1


def test_evaluate_scores_the_rules_with_the_labels_hidden(tmp_path, monkeypatch):
    conn = _fresh(tmp_path)
    _stub_embed(monkeypatch)
    _drifted(conn)
    for a in ("f0", "f1"):
        _label(conn, a, 1, "in")
    _label(conn, "f3", 3, "out", anchor="f0")
    before = _where(conn)
    out = cluster_labels.evaluate(conn, "2026-10-01")
    assert (out["together_pairs"], out["kept_together"]) == (1, 1)
    # f3 joins the flood under the rules, against the label.
    assert out["apart_pairs"] == 1 and out["kept_apart"] == 0
    assert _where(conn) == before


def test_evaluate_tries_a_constant_and_puts_it_back(tmp_path, monkeypatch):
    conn = _fresh(tmp_path)
    _stub_embed(monkeypatch)
    _drifted(conn)
    _label(conn, "f3", 3, "out", anchor="f0")
    was = cluster.PERISTIWA_THRESHOLD
    strict = cluster_labels.evaluate(conn, "2026-10-01", {"PERISTIWA_THRESHOLD": 1.01})
    assert strict["kept_apart"] == strict["apart_pairs"] == 1
    assert cluster.PERISTIWA_THRESHOLD == was


def test_a_labelled_article_outlives_its_stale_candidate(tmp_path):
    conn = _fresh(tmp_path)
    _drifted(conn)
    _label(conn, "c2", 2, "out", anchor="c1")
    conn.execute("UPDATE events SET status = 'candidate', created_at = '2026-01-01' WHERE id = 2")
    conn.commit()
    cluster.prune_candidates(conn)
    assert "c2" in _where(conn)
