"""Curation work the pipeline carries out: drafting what a curator asked for in
/kurasi, and the nightly `kurasi` stage that catches up and learns from it.

Requests start the moment the curator makes them (scripts/kurasi_ops.py, run
by the page in the background). The stage only takes what that left undone —
still queued, abandoned mid-run, or failed because Ollama was down — so
nothing is drafted twice, and nothing it drafts is applied without the
curator accepting it.
"""
from __future__ import annotations

import json
from datetime import datetime, timezone

from . import cv_extract, summarize


class Refused(Exception):
    """A decision that cannot be carried out as given."""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _snapshot(conn, event_id: int) -> dict:
    row = conn.execute(
        """SELECT e.kind, e.figure_id, e.framing, e.title, e.event_type, s.summary_text
             FROM events e LEFT JOIN event_summaries s ON s.event_id = e.id
            WHERE e.id = ?""", (event_id,)).fetchone()
    if row is None:
        raise Refused(f"no event {event_id}")
    return dict(row)


def run_rework(conn, request_id: int) -> str:
    """Draft what a rework request asks for. Leaves the event untouched.

    Commits its own progress, since the page reads the status while the
    model is writing.
    """
    req = conn.execute("SELECT * FROM rework_requests WHERE id = ?", (request_id,)).fetchone()
    if req is None:
        raise Refused(f"no rework request {request_id}")
    conn.execute("UPDATE rework_requests SET status = 'running', error = NULL, "
                 "attempts = attempts + 1 WHERE id = ?", (request_id,))
    conn.commit()
    try:
        before = _snapshot(conn, req["event_id"])
        kind = "peristiwa" if req["to_peristiwa"] else before["kind"]
        figure_id = None if kind == "peristiwa" else (req["new_figure_id"] or before["figure_id"])
        if req["new_figure_id"] and kind == "record":
            fig = conn.execute("SELECT active FROM figures WHERE id = ?",
                               (req["new_figure_id"],)).fetchone()
            if fig is None or not fig["active"]:
                raise Refused(f"unknown or retired figure: {req['new_figure_id']}")
        framing = (None if kind == "peristiwa" else
                   "about" if req["framing"] == "about" else
                   None if req["framing"] == "own" else before["framing"])
        draft = summarize.draft_event(
            conn, req["event_id"], kind=kind, figure_id=figure_id or "",
            framing=framing or "own", note=req["note"],
            examples=lessons_for(conn, "summary", figure_id, event_words(conn, req["event_id"]),
                                 exclude_event=req["event_id"]))
        after = {"kind": kind, "figure_id": figure_id, "framing": framing,
                 "title": draft["title"] or before["title"],
                 "event_type": draft["category"] or before["event_type"],
                 "summary_text": draft["summary_text"]}
        conn.execute(
            """UPDATE rework_requests SET status = 'ready', before = ?, after = ?, draft = ?,
                      finished_at = ? WHERE id = ?""",
            (json.dumps(before, ensure_ascii=False), json.dumps(after, ensure_ascii=False),
             json.dumps(draft, ensure_ascii=False), _now(), request_id))
        return f"rework {request_id}: ready — {after['title']!r}"
    except Exception as e:  # recorded for the page, whatever it was
        conn.execute(
            "UPDATE rework_requests SET status = 'failed', error = ?, finished_at = ? WHERE id = ?",
            (str(e), _now(), request_id))
        conn.commit()
        raise Refused(str(e)) from e


def draft_cv(conn, proposal_id: int) -> str:
    """Draft a "Jadikan info CV" proposal. Commits its own progress."""
    row = conn.execute("SELECT * FROM cv_proposals WHERE id = ?", (proposal_id,)).fetchone()
    if row is None:
        raise Refused(f"no CV proposal {proposal_id}")
    conn.execute("UPDATE cv_proposals SET status = 'running', error = NULL, "
                 "attempts = attempts + 1 WHERE id = ?", (proposal_id,))
    conn.commit()
    try:
        draft = cv_extract.draft_cv(conn, row["event_id"], row["figure_id"], row["note"],
                                    examples=lessons_for(conn, "cv", row["figure_id"],
                                                         event_words(conn, row["event_id"])))
    except Exception as e:  # recorded for the page, whatever it was
        conn.execute("UPDATE cv_proposals SET status = 'failed', error = ?, finished_at = ? "
                     "WHERE id = ?", (str(e), _now(), proposal_id))
        conn.commit()
        raise Refused(str(e)) from e
    conn.execute("UPDATE cv_proposals SET status = 'ready', proposal = ?, finished_at = ? "
                 "WHERE id = ?", (json.dumps(draft, ensure_ascii=False), _now(), proposal_id))
    n = sum(len(draft[k]) for k in ("positions", "facts", "education"))
    return f"cv proposal {proposal_id}: {n} entries"


def accept_rework(conn, request_id: int) -> str:
    """Make a ready rework the event's entry: kind, figure, framing and text."""
    req = conn.execute("SELECT * FROM rework_requests WHERE id = ?", (request_id,)).fetchone()
    if req is None or req["status"] != "ready":
        raise Refused(f"rework {request_id} is not ready to accept")
    event_id = req["event_id"]
    after = json.loads(req["after"])
    before = json.loads(req["before"])
    if after["kind"] != before["kind"]:
        # A record made a peristiwa belongs to nobody; its figure stays on it
        # as a related figure. Links and follow-ups assumed the old kind.
        conn.execute("UPDATE events SET kind = ?, figure_id = ? WHERE id = ?",
                     (after["kind"], after["figure_id"], event_id))
        if before["figure_id"]:
            conn.execute("INSERT OR IGNORE INTO event_figures (event_id, figure_id) VALUES (?, ?)",
                         (event_id, before["figure_id"]))
        conn.execute("DELETE FROM record_links WHERE record_id = ? OR peristiwa_id = ?",
                     (event_id, event_id))
        conn.execute("DELETE FROM followup_links WHERE earlier_id = ? OR later_id = ?",
                     (event_id, event_id))
    elif after["figure_id"] != before["figure_id"]:
        conn.execute("UPDATE events SET figure_id = ? WHERE id = ?", (after["figure_id"], event_id))
        conn.execute("UPDATE articles SET figure_id = ? WHERE event_id = ?",
                     (after["figure_id"], event_id))
        # A record's follow-ups are the same figure's records; no longer.
        conn.execute("DELETE FROM followup_links WHERE earlier_id = ? OR later_id = ?",
                     (event_id, event_id))
    conn.execute("UPDATE events SET framing = ? WHERE id = ?", (after["framing"], event_id))
    summarize.store_draft(conn, json.loads(req["draft"]))
    conn.execute("UPDATE rework_requests SET status = 'accepted', decided_at = ? WHERE id = ?",
                 (_now(), request_id))
    return f"rework {request_id}: accepted for event {event_id}"




# ---------------------------------------------------------------------------
# Learning from the curator

_STOP = set("""yang dengan untuk dari dalam akan pada tidak juga atau sudah karena bahwa
oleh saat setelah masih para lebih belum hingga agar bisa harus menjadi terkait usai
tentang terhadap kepada sebagai bersama secara berbagai beberapa indonesia presiden
menteri pemerintah tahun kembali tersebut menurut dilakukan melakukan""".split())


def words_of(text: str) -> set[str]:
    import re
    return {w for w in re.findall(r"[a-z]{5,}", (text or "").lower()) if w not in _STOP}


def event_words(conn, event_id: int) -> set[str]:
    """What an event is about, from its article headlines and its title."""
    text = " ".join(r[0] or "" for r in conn.execute(
        "SELECT title FROM articles WHERE event_id = ? UNION ALL SELECT title FROM events WHERE id = ?",
        (event_id, event_id)))
    return words_of(text)


def lessons_for(conn, kind: str, figure_id: str | None, words: set[str],
                k: int = 2, exclude_event: int | None = None) -> list[dict]:
    """The curator's past corrections most like this case, best first.

    Same figure counts for most, then shared distinctive words. A lesson with
    neither is not shown: an unrelated example teaches a small model nothing.
    """
    scored = []
    for r in conn.execute(
        "SELECT id, event_id, figure_id, words, wrong, note, right FROM curation_lessons "
        "WHERE kind = ? AND active = 1", (kind,)):
        if exclude_event is not None and r["event_id"] == exclude_event:
            continue
        shared = len(words & set(json.loads(r["words"] or "[]")))
        score = (3 if figure_id and r["figure_id"] == figure_id else 0) + shared
        if score >= 2:
            scored.append((score, r["id"], {"wrong": r["wrong"], "note": r["note"], "right": r["right"]}))
    scored.sort(key=lambda x: (-x[0], -x[1]))
    return [x[2] for x in scored[:k]]


def _snapshot_text(snap: dict | None) -> str:
    if not snap:
        return ""
    return f"JUDUL: {snap.get('title') or '-'}\n{snap.get('summary_text') or ''}".strip()


def learn(conn) -> dict[str, int]:
    """Turn every decided request not yet learned from into a lesson (or not).

    A discarded draft teaches nothing certain and is only marked; an accepted
    CV draft the curator did not change is the model getting it right, and is
    marked too. Each request is learned from once (`learned_at`).
    """
    now = _now()
    stats = {"summary": 0, "cv": 0, "marked": 0}
    for r in conn.execute(
        "SELECT * FROM rework_requests WHERE status IN ('accepted', 'discarded') "
        "AND learned_at IS NULL").fetchall():
        if r["status"] == "accepted" and r["before"] and r["after"]:
            before, after = json.loads(r["before"]), json.loads(r["after"])
            asked = [r["note"] or ""]
            if r["framing"] == "about":
                asked.append("(Sudut pandang: liputan tentang tokoh, bukan perbuatannya.)")
            if r["to_peristiwa"]:
                asked.append("(Dijadikan peristiwa, bukan catatan satu tokoh.)")
            conn.execute(
                """INSERT OR IGNORE INTO curation_lessons
                       (kind, source, event_id, figure_id, words, wrong, note, right, created_at)
                   VALUES ('summary', ?, ?, ?, ?, ?, ?, ?, ?)""",
                (f"rework:{r['id']}", r["event_id"], after.get("figure_id") or before.get("figure_id"),
                 json.dumps(sorted(event_words(conn, r["event_id"]))),
                 _snapshot_text(before), " ".join(a for a in asked if a).strip(),
                 _snapshot_text(after), now))
            stats["summary"] += 1
        else:
            stats["marked"] += 1
        conn.execute("UPDATE rework_requests SET learned_at = ? WHERE id = ?", (now, r["id"]))
    for r in conn.execute(
        "SELECT * FROM cv_proposals WHERE status IN ('accepted', 'discarded') "
        "AND learned_at IS NULL").fetchall():
        drafted = json.loads(r["proposal"] or "{}")
        kept = json.loads(r["accepted"] or "null")
        drafted.pop("sources", None)
        if kept is not None:
            kept.pop("sources", None)
        if r["status"] == "accepted" and kept is not None and kept != drafted:
            conn.execute(
                """INSERT OR IGNORE INTO curation_lessons
                       (kind, source, event_id, figure_id, words, wrong, note, right, created_at)
                   VALUES ('cv', ?, ?, ?, ?, ?, ?, ?, ?)""",
                (f"cv:{r['id']}", r["event_id"], r["figure_id"],
                 json.dumps(sorted(event_words(conn, r["event_id"]))),
                 json.dumps(drafted, ensure_ascii=False), r["note"] or "",
                 json.dumps(kept, ensure_ascii=False), now))
            stats["cv"] += 1
        else:
            stats["marked"] += 1
        conn.execute("UPDATE cv_proposals SET learned_at = ? WHERE id = ?", (now, r["id"]))
    return stats


def learn_name_prefixes(conn, min_names: int = 3) -> list[str]:
    """First words the curator keeps rejecting as names ("Polisi", "Istana").

    A word that starts at least `min_names` rejected names — and no tracked
    figure's name — is kept in pipeline_state; the names queue leaves out
    names that start with it.
    """
    from collections import Counter
    rejected = [r[0] for r in conn.execute(
        """SELECT name FROM figure_candidates WHERE status = 'rejected'
           UNION
           SELECT name FROM figures WHERE active = 0 AND origin = 'discovered'
             AND id NOT IN (SELECT figure_id FROM events WHERE figure_id IS NOT NULL)""")]
    counts = Counter(n.split()[0] for n in rejected if n and len(n.split()) > 1)
    tracked_first = {r[0].split()[0] for r in conn.execute(
        "SELECT name FROM figures WHERE active = 1") if r[0]}
    learned = sorted(w for w, n in counts.items() if n >= min_names and w not in tracked_first)
    conn.execute(
        """INSERT INTO pipeline_state (key, value, updated_at) VALUES ('learned_name_prefixes', ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
        (json.dumps(learned, ensure_ascii=False), _now()))
    return learned


# ---------------------------------------------------------------------------
# The stage

def catch_up(conn) -> dict[str, int]:
    """Draft what the page started but did not finish. Never applies anything."""
    stale = datetime.fromtimestamp(datetime.now(timezone.utc).timestamp() - 15 * 60,
                                   timezone.utc).isoformat()
    pick = """status = 'queued'
              OR (status = 'running' AND created_at < ?)
              OR (status = 'failed' AND attempts < 2
                  AND (error LIKE '%Ollama%' OR error LIKE '%timed out%'))"""
    stats = {"reworks": 0, "cv": 0, "failed": 0}
    for table, run, key in (("rework_requests", run_rework, "reworks"),
                            ("cv_proposals", draft_cv, "cv")):
        for (rid,) in conn.execute(f"SELECT id FROM {table} WHERE {pick}", (stale,)).fetchall():
            try:
                run(conn, rid)
                conn.commit()
                stats[key] += 1
            except Refused:
                stats["failed"] += 1
    return stats


def run_stage(conn) -> dict:
    """The nightly `kurasi` stage: catch up, learn, refresh the names queue, report."""
    from . import candidate_queue
    stats: dict = {"drafted": catch_up(conn), "learned": learn(conn)}
    stats["name_prefixes"] = learn_name_prefixes(conn)
    stats["names_queue"] = candidate_queue.refresh(conn)
    stats["lessons_active"] = conn.execute(
        "SELECT count(*) FROM curation_lessons WHERE active = 1").fetchone()[0]
    stats["labels"] = conn.execute("SELECT count(*) FROM curation_labels").fetchone()[0]
    conn.execute("INSERT INTO kurasi_reports (run_at, stats) VALUES (?, ?)",
                 (_now(), json.dumps(stats, ensure_ascii=False)))
    conn.commit()
    return stats
