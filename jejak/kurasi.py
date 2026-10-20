"""Curation work the pipeline carries out: drafting what a curator asked for in
/kurasi, and the nightly `kurasi` stage that catches up and learns from it.

Requests start the moment the curator makes them (scripts/kurasi_ops.py, run
by the page in the background). The stage only takes what that left undone —
still queued, abandoned mid-run, or failed because Ollama was down — so
nothing is drafted twice, and nothing it drafts for a request is applied
without the curator accepting it.

The one exception is CV material (auto_cv): records that are a fact about
their figure rather than an act are found, drafted and put on the CV by the
stage itself, and come down as "Bahan CV".
"""
from __future__ import annotations

import json
import re
import sqlite3
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
# CV material, found and applied without the curator

AUTO_CV_PER_RUN = 40     # model checks per run; the rest wait for the next one
AUTO_CV_NOTE = "Otomatis: masuk CV"
# Only a record this recent may reorder a CV. A profile from last year still
# says "Sekretaris Kabinet (2015 – kini)"; put first, it would make a past
# office the figure's title.
FRESH_DAYS = 60


def _same(a: str, b: str) -> bool:
    return a.strip().lower() == b.strip().lower()


def apply_cv(conn, figure_id: str, kept: dict, fresh: bool = True) -> None:
    """Merge CV entries into a figure.

    Offices already listed (same role and body) are not repeated. A current one
    ("… – kini") from a `fresh` record goes first, since the first office is
    the figure's title; from an older record everything is only appended, and
    the title stays. A fact is added only under a label the CV lacks: what is
    there may be the curator's, and a newer article is no better source for a
    birth date. The articles join the CV's sources.
    `cv_curated` is left alone: these are the model's, not the curator's, and
    scripts/import_cv.py may still replace them.
    """
    f = conn.execute("SELECT positions, facts, education, sources FROM figures WHERE id = ?",
                     (figure_id,)).fetchone()
    if f is None:
        raise Refused(f"unknown figure: {figure_id}")

    def load(raw):
        try:
            v = json.loads(raw or "[]")
        except ValueError:
            return []
        return v if isinstance(v, list) else []

    positions = load(f["positions"])
    for pos in kept.get("positions", []):
        if any(_same(x.get("role", ""), pos["role"]) and _same(x.get("org", ""), pos["org"])
               for x in positions):
            continue
        if fresh and re.search(r"kini|sekarang", pos.get("period", ""), re.I):
            positions.insert(0, pos)
        else:
            positions.append(pos)
    facts = load(f["facts"])
    for fact in kept.get("facts", []):
        if not any(_same(x.get("label", ""), fact["label"]) for x in facts):
            facts.append(fact)
    education = load(f["education"])
    for e in kept.get("education", []):
        if not any(_same(x.get("detail", ""), e["detail"]) for x in education):
            education.append({"year": e["year"], "detail": e["detail"]} if e.get("year")
                             else {"detail": e["detail"]})
    sources = load(f["sources"])
    for src in kept.get("sources", []):
        if not any(x.get("url") == src["url"] for x in sources):
            sources.append(src)
    title = (" ".join(x for x in (positions[0].get("role", "").strip(),
                                  positions[0].get("org", "").strip()) if x)
             if positions and fresh else None)
    conn.execute(
        "UPDATE figures SET positions = ?, role = COALESCE(?, role), facts = ?, education = ?, "
        "sources = ? WHERE id = ?",
        (json.dumps(positions, ensure_ascii=False), title or None,
         json.dumps(facts, ensure_ascii=False), json.dumps(education, ensure_ascii=False),
         json.dumps(sources, ensure_ascii=False), figure_id))


def _take_down_as_cv(conn, event_id: int, figure_id: str) -> None:
    """The record comes down as "Bahan CV", as setCuration in /kurasi records it."""
    conn.execute("UPDATE events SET curated = 'rejected' WHERE id = ?", (event_id,))
    conn.execute(
        """INSERT INTO curation_labels
                  (event_id, verdict, reasons, note, kind, figure_id, title, summary,
                   outlets, suggested, decided_at)
           SELECT e.id, 'rejected', ?, ?, e.kind, e.figure_id, e.title, es.summary_text,
                  (SELECT count(DISTINCT a.source) FROM articles a WHERE a.event_id = e.id),
                  NULL, ?
             FROM events e LEFT JOIN event_summaries es ON es.event_id = e.id
            WHERE e.id = ?
           ON CONFLICT (event_id) DO UPDATE
              SET verdict = excluded.verdict, reasons = excluded.reasons, note = excluded.note,
                  title = excluded.title, summary = excluded.summary,
                  outlets = excluded.outlets, decided_at = excluded.decided_at""",
        (json.dumps(["cv_material"]), f"{AUTO_CV_NOTE} {figure_id}", _now(), event_id))


def _add_title_office(conn, draft: dict, event_id: int, office: str) -> None:
    """The office named in the title, as "<year> – kini" from the record's
    date, when the model found none. When it did, its fuller name for the same
    office ("Kepala Badan Narkotika Nasional" for "Kepala BNN") is kept and the
    title's short one would only repeat it."""
    if draft["positions"]:
        return
    when = conn.execute("SELECT event_date FROM events WHERE id = ?", (event_id,)).fetchone()[0] or ""
    period = f"{when[:4]} – kini" if when[:4].isdigit() else ""
    draft["positions"].insert(0, {"role": office, "org": "", "period": period})


def _is_fresh(conn, event_id: int) -> bool:
    when = conn.execute("SELECT event_date FROM events WHERE id = ?", (event_id,)).fetchone()[0]
    try:
        then = datetime.fromisoformat(when)
    except (TypeError, ValueError):
        return False
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - then).days <= FRESH_DAYS


def cv_candidates(conn, limit: int = AUTO_CV_PER_RUN) -> list[sqlite3.Row]:
    """Live, unruled records not yet checked whose own title passes the CV
    keyword screen, newest first. The title, not the headlines: a record's
    title is written about its figure, while one headline among many naming
    someone's appointment says nothing about whose CV it is."""
    rows = conn.execute(
        """SELECT e.id, e.figure_id, e.title
             FROM events e JOIN figures f ON f.id = e.figure_id AND f.active
            WHERE e.kind = 'record' AND e.status IN ('new', 'summarized', 'approved')
              AND e.curated IS NULL
              AND NOT EXISTS (SELECT 1 FROM cv_proposals p WHERE p.event_id = e.id)
            ORDER BY coalesce(e.last_seen, e.event_date) DESC""").fetchall()
    return [r for r in rows if cv_extract.CANDIDATE.search(r["title"] or "")][:limit]


def auto_cv(conn, limit: int = AUTO_CV_PER_RUN) -> dict[str, int]:
    """Find CV material among new records and apply it, with no curator step.

    For each candidate the local model first says whether the record is a fact
    about its figure (an appointment, a profile, family) rather than an act;
    if so it drafts the entries, they go onto the figure's CV, and the record
    comes down as "Bahan CV". Every candidate leaves one cv_proposals row
    (origin 'auto'), applied or not, so it is never checked twice. The row is
    written only once the model is done: a crash mid-run leaves nothing half
    applied, and the record is simply checked again next run.
    """
    stats = {"checked": 0, "applied": 0, "not_cv": 0, "empty": 0, "failed": 0}
    for r in cv_candidates(conn, limit):
        now = _now()
        name = conn.execute("SELECT name FROM figures WHERE id = ?", (r["figure_id"],)).fetchone()[0]
        # Titles that settle it outright: an appointment ("Dilantik Menjadi
        # Menko Polkam"), whose office is read from the title itself, or a
        # profile of the figure. The 7B model calls being sworn in an "act" too
        # often to be asked about these.
        office = cv_extract.office_from_title(r["title"], name)
        try:
            if office or cv_extract.is_profile_of(r["title"], name):
                is_cv, why = True, "judul: pelantikan/penunjukan" if office else "judul: profil"
            else:
                is_cv, why = cv_extract.is_cv_material(conn, r["id"], r["figure_id"])
            draft = None
            if is_cv:
                draft = cv_extract.draft_cv(conn, r["id"], r["figure_id"], None,
                                            examples=lessons_for(conn, "cv", r["figure_id"],
                                                                 event_words(conn, r["id"])))
                if office:
                    _add_title_office(conn, draft, r["id"], office)
        except cv_extract.ModelDown as e:
            # Nothing to gain from the rest of the list; it waits for next run.
            stats["failed"] += 1
            print(f"auto_cv: stopped at event {r['id']}: {e}")
            break
        except (RuntimeError, ValueError) as e:
            # One bad answer (not JSON) or a record with no articles: skip it,
            # unrecorded, so the next run tries it again.
            stats["failed"] += 1
            print(f"auto_cv: skipped event {r['id']}: {e}")
            continue
        stats["checked"] += 1
        entries = sum(len(draft[k]) for k in ("positions", "facts", "education")) if draft else 0
        if is_cv and entries:
            status, error = "accepted", None
        elif is_cv:
            status, error = "discarded", f"auto: bahan CV, tetapi tak ada isian ({why})"
        else:
            status, error = "discarded", f"auto: bukan bahan CV ({why})"
        with conn:
            conn.execute(
                """INSERT INTO cv_proposals
                       (event_id, figure_id, note, status, proposal, accepted, error,
                        created_at, finished_at, decided_at, learned_at, origin)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'auto')""",
                (r["id"], r["figure_id"], why or None, status,
                 json.dumps(draft, ensure_ascii=False) if draft else None,
                 json.dumps(draft, ensure_ascii=False) if status == "accepted" else None,
                 error, now, now, now, now))
            if status == "accepted":
                apply_cv(conn, r["figure_id"], draft, fresh=_is_fresh(conn, r["id"]))
                _take_down_as_cv(conn, r["id"], r["figure_id"])
                stats["applied"] += 1
            else:
                stats["not_cv" if not is_cv else "empty"] += 1
    return stats


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
    stats: dict = {"drafted": catch_up(conn), "cv_auto": auto_cv(conn), "learned": learn(conn)}
    stats["name_prefixes"] = learn_name_prefixes(conn)
    stats["names_queue"] = candidate_queue.refresh(conn)
    stats["lessons_active"] = conn.execute(
        "SELECT count(*) FROM curation_lessons WHERE active = 1").fetchone()[0]
    stats["labels"] = conn.execute("SELECT count(*) FROM curation_labels").fetchone()[0]
    conn.execute("INSERT INTO kurasi_reports (run_at, stats) VALUES (?, ?)",
                 (_now(), json.dumps(stats, ensure_ascii=False)))
    conn.commit()
    return stats
