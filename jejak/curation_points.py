"""Curation points: the pipeline's open questions about a catatan, asked one at a time.

Four stages already leave questions for a curator, each in its own table with
its own verdict column, and almost none of them had been answered (2026-10:
212 peristiwa links, 349 follow-ups, 1,092 actor reviews, 26,102 quotes with
no speaker). This stage turns each into a point on the catatan it concerns:
the paragraph that raised it, what the pipeline proposes, and a score band.
/kurasi asks Ya / Bukan / Koreksi / Lewati and writes the answer back to the
row the question came from, so nothing downstream changes.

  peristiwa  record_links, verdict NULL       — is this catatan part of that peristiwa?
  lini       followup_links, verdict NULL     — does this catatan follow up that one?
  pelaku     actor_reviews, decision NULL     — is this other figure an actor of the catatan?
  pembicara  event_quotes, figure_id NULL     — whose words are these? Grouped by the
             speaker as written, so one answer settles every quote that names them the
             same way and points the same way.

Confidence is not the score. It is how often the curator agreed with points
of the same kind and band (calibration(), below), which is also what
auto-answering acts on — with the same gate as auto-hide in
curation_suggest.py, and only for the kinds the curator switched on
(auto_answer(), at the end). A pembicara answer is also kept as a speaker
lesson, which the quotes stage assigns the next such quote by.

    python -m jejak.cli points
"""
from __future__ import annotations

import json
import re
import sqlite3
import zlib
from collections import Counter, defaultdict
from datetime import datetime, timezone

from . import actors
from .cluster import _tokens
from .config import load_figures
from .quotes import _terms, apply_lessons, lesson_scope, norm_speaker

KINDS = ("peristiwa", "lini", "pelaku", "pembicara")

# The auto-answer gate, as for auto-hide (curation_suggest.py).
AUTO_MIN_ANSWERS = 25
AUTO_MIN_AGREEMENT = 0.95
PRIOR = 1.0  # pseudo-weight of one disagreement, so 3 of 3 is not 100%

# A group of quotes whose speaker matches no tracked figure, or one cut down
# to a single peristiwa, is only worth a question once it recurs: a one-off
# speaker is noise, and 6,900 single-peristiwa groups would bury the rest.
MIN_SMALL_GROUP = 3
# Evidence is shown in a card: a paragraph, cut around the part in question.
MAX_PARAGRAPH = 700


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Evidence


def _paragraphs(body: str | None) -> list[str]:
    return [p.strip() for p in (body or "").split("\n") if p.strip()]


def _cut(paragraph: str, start: int, end: int) -> tuple[str, int, int]:
    """The paragraph, trimmed to MAX_PARAGRAPH around [start, end) at word bounds."""
    if len(paragraph) <= MAX_PARAGRAPH:
        return paragraph, start, end
    room = max(0, MAX_PARAGRAPH - (end - start)) // 2
    lo = max(0, start - room)
    hi = min(len(paragraph), end + room)
    if lo > 0:
        sp = paragraph.find(" ", lo, start)
        lo = sp + 1 if sp >= 0 else lo
    if hi < len(paragraph):
        sp = paragraph.rfind(" ", end, hi)
        hi = sp if sp >= 0 else hi
    lead = "… " if lo > 0 else ""
    tail = " …" if hi < len(paragraph) else ""
    text = lead + paragraph[lo:hi] + tail
    return text, start - lo + len(lead), end - lo + len(lead)


_SENTENCE = re.compile(r"[^.!?]*[.!?]+[\"”]?\s*|[^.!?]+$")


def _sentences(paragraph: str) -> list[tuple[int, int]]:
    return [(m.start(), m.end()) for m in _SENTENCE.finditer(paragraph) if m.group().strip()]


def _best_sentence(paragraph: str, score) -> tuple[int, int]:
    """The sentence of `paragraph` that `score(text)` rates highest, as a span."""
    spans = _sentences(paragraph) or [(0, len(paragraph))]
    s, e = max(spans, key=lambda sp: score(paragraph[sp[0]:sp[1]]))
    while e > s and paragraph[e - 1].isspace():
        e -= 1
    return s, e


def _term_evidence(conn: sqlite3.Connection, event_id: int, terms: list[str]):
    """The paragraph of the event's coverage that shares the most of `terms`.

    `terms` are link.py's evidence words, tokenised as cluster._tokens does.
    Returns (article_id, paragraph, hl_start, hl_end) or None.
    """
    want = set(terms)
    if not want:
        return None
    best = None
    for art in conn.execute(
        "SELECT id, body FROM articles WHERE event_id = ? AND body IS NOT NULL "
        "ORDER BY published_at", (event_id,)
    ):
        for para in _paragraphs(art["body"]):
            hits = len(_tokens(para) & want)
            if hits and (best is None or hits > best[0]):
                best = (hits, art["id"], para)
    if best is None:
        return None
    _, article_id, para = best
    s, e = _best_sentence(para, lambda t: len(_tokens(t) & want))
    return (article_id, *_cut(para, s, e))


# ---------------------------------------------------------------------------
# Writing points


class _Writer:
    """Upserts points by key and remembers which keys this run still asks."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.now = _now()
        self.seen: set[str] = set()
        self.stats: Counter = Counter()

    def put(self, kind: str, key: str, event_id: int, proposal: dict, score: float | None,
            bucket: str, evidence=None, group_size: int = 1) -> None:
        self.seen.add(key)
        article_id, paragraph, hl_start, hl_end = evidence or (None, None, None, None)
        cur = self.conn.execute(
            """INSERT INTO curation_points
                   (kind, key, event_id, group_size, proposal, article_id, paragraph,
                    hl_start, hl_end, score, bucket, created_at, refreshed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT (key) DO UPDATE SET
                   event_id = excluded.event_id, group_size = excluded.group_size,
                   proposal = excluded.proposal, article_id = excluded.article_id,
                   paragraph = excluded.paragraph, hl_start = excluded.hl_start,
                   hl_end = excluded.hl_end, score = excluded.score, bucket = excluded.bucket,
                   refreshed_at = excluded.refreshed_at,
                   status = CASE WHEN status = 'settled' THEN 'open' ELSE status END
               WHERE status IN ('open', 'lewati', 'settled')""",
            (kind, key, event_id, group_size, json.dumps(proposal, ensure_ascii=False),
             article_id, paragraph, hl_start, hl_end, score, bucket, self.now, self.now),
        )
        self.stats[kind] += cur.rowcount

    def settle_the_rest(self) -> int:
        """Open points no producer asked again: their row was decided elsewhere,
        or the question went away (a link or review the pipeline withdrew)."""
        self.conn.execute("CREATE TEMP TABLE IF NOT EXISTS _seen_points (key TEXT PRIMARY KEY)")
        self.conn.execute("DELETE FROM _seen_points")
        self.conn.executemany("INSERT INTO _seen_points (key) VALUES (?)", [(k,) for k in self.seen])
        n = self.conn.execute(
            "UPDATE curation_points SET status = 'settled', refreshed_at = ? "
            "WHERE status IN ('open', 'lewati') AND key NOT IN (SELECT key FROM _seen_points)",
            (self.now,),
        ).rowcount
        self.conn.execute("DROP TABLE _seen_points")
        return n


def _titles(conn: sqlite3.Connection, ids) -> dict[int, str]:
    ids = list(set(ids))
    if not ids:
        return {}
    out = {}
    for i in range(0, len(ids), 500):
        chunk = ids[i:i + 500]
        out.update({r[0]: r[1] or "" for r in conn.execute(
            f"SELECT id, title FROM events WHERE id IN ({','.join('?' * len(chunk))})", chunk)})
    return out


def _band(value: float, cuts: tuple[float, ...], names: tuple[str, ...]) -> str:
    for cut, name in zip(cuts, names):
        if value < cut:
            return name
    return names[-1]


# ---------------------------------------------------------------------------
# Producers


def _peristiwa(conn: sqlite3.Connection, w: _Writer) -> None:
    rows = conn.execute(
        """SELECT l.record_id, l.peristiwa_id, l.score, l.evidence
             FROM record_links l
             JOIN events r ON r.id = l.record_id
             JOIN events p ON p.id = l.peristiwa_id
            WHERE l.verdict IS NULL AND r.curated IS NOT 'rejected'
              AND p.curated IS NOT 'rejected'"""
    ).fetchall()
    titles = _titles(conn, [r["peristiwa_id"] for r in rows])
    for r in rows:
        terms = json.loads(r["evidence"] or "[]")
        title = titles.get(r["peristiwa_id"], "")
        score = r["score"] or 0.0
        w.put("peristiwa", f"peristiwa:{r['record_id']}:{r['peristiwa_id']}", r["record_id"],
              {"peristiwa_id": r["peristiwa_id"], "title": title, "terms": terms,
               "claim": f"Catatan ini bagian dari “{title}”"},
              score, _band(score, (0.4, 0.5), ("lemah", "sedang", "kuat")),
              _term_evidence(conn, r["record_id"], terms))


def _lini(conn: sqlite3.Connection, w: _Writer) -> None:
    rows = conn.execute(
        """SELECT l.earlier_id, l.later_id, l.score, l.evidence
             FROM followup_links l
             JOIN events a ON a.id = l.earlier_id
             JOIN events b ON b.id = l.later_id
            WHERE l.verdict IS NULL AND a.curated IS NOT 'rejected'
              AND b.curated IS NOT 'rejected'"""
    ).fetchall()
    titles = _titles(conn, [r["earlier_id"] for r in rows])
    for r in rows:
        terms = json.loads(r["evidence"] or "[]")
        title = titles.get(r["earlier_id"], "")
        score = r["score"] or 0.0
        # Listed on the later one: that is the catatan the follow-up is news on.
        w.put("lini", f"lini:{r['earlier_id']}:{r['later_id']}", r["later_id"],
              {"earlier_id": r["earlier_id"], "later_id": r["later_id"], "title": title,
               "terms": terms, "claim": f"Catatan ini lanjutan dari “{title}”"},
              score, _band(score, (0.55, 0.65), ("lemah", "sedang", "kuat")),
              _term_evidence(conn, r["later_id"], terms))


def _pelaku(conn: sqlite3.Connection, w: _Writer) -> None:
    figures = {f.id: f for f in load_figures(conn)}
    rows = conn.execute(
        """SELECT v.event_id, v.owner_id, v.suggested_id, v.quotes
             FROM actor_reviews v JOIN events e ON e.id = v.event_id
            WHERE v.decision IS NULL AND e.curated IS NOT 'rejected'"""
    ).fetchall()
    for r in rows:
        fig = figures.get(r["suggested_id"])
        if fig is None:
            continue
        w.put("pelaku", f"pelaku:{r['event_id']}:{r['suggested_id']}", r["event_id"],
              {"figure_id": fig.id, "name": fig.name, "owner_id": r["owner_id"], "quotes": r["quotes"],
               "claim": f"{fig.name} ikut menjadi pelaku, bukan hanya disebut"},
              float(r["quotes"]), _band(r["quotes"], (2, 4), ("1 kutipan", "2-3 kutipan", "4+ kutipan")),
              _actor_evidence(conn, r["event_id"], fig))


def _actor_evidence(conn: sqlite3.Connection, event_id: int, fig):
    """Where the figure acts or speaks in the record's coverage: the paragraph
    holding actors.passage()'s first sentence, else the first that names them."""
    pat = actors._pattern(fig)
    terms = [t for t in fig.match_terms() if len(t) >= 4]
    if not terms:
        return None
    named = re.compile(r"\b(?:" + "|".join(re.escape(t) for t in terms) + r")\b", re.I)
    fallback = None
    for art in conn.execute(
        "SELECT id, body FROM articles WHERE event_id = ? AND body IS NOT NULL "
        "ORDER BY published_at", (event_id,)
    ):
        for para in _paragraphs(art["body"]):
            if pat is not None and actors.passage(para, pat):
                s, e = _best_sentence(para, lambda t: 2 if pat.search(t) else 1 if named.search(t) else 0)
                return (art["id"], *_cut(para, s, e))
            if fallback is None and named.search(para):
                s, e = _best_sentence(para, lambda t: 1 if named.search(t) else 0)
                fallback = (art["id"], *_cut(para, s, e))
    return fallback


# Pembicara bands, best first. The score only orders them; what each is worth
# is learned from the answers.
_SPEAKER_BANDS = {
    "nama lengkap": 0.9,   # one figure, matched on more than one word
    "satu kata": 0.7,      # one figure, matched on a single word ("Bahlil")
    "dari catatan": 0.6,   # several fit; the one taking part in the record wins
    "seri": 0.4,           # several fit and the record does not tell them apart
    "tanpa calon": 0.5,    # no tracked figure fits: probably someone untracked
}


def _speaker_terms(conn: sqlite3.Connection) -> list[tuple[str, str, list[tuple[str, re.Pattern]]]]:
    """[(id, name, [(term, pattern)])]: quotes._terms, plus every longer word of
    the name, which is how Indonesian reporting often shortens it ("Dasco",
    from Sufmi Dasco Ahmad). Patterns as quotes._names matches, compiled once."""
    out = []
    for r in conn.execute("SELECT id, name, aliases FROM figures WHERE active = 1"):
        try:
            aliases = json.loads(r["aliases"]) if r["aliases"] else []
        except (TypeError, ValueError):
            aliases = []
        terms = set(_terms(r["name"], aliases))
        terms |= {w for w in r["name"].split() if len(w) >= 5}
        out.append((r["id"], r["name"],
                    [(t, re.compile(rf"\b{re.escape(t)}\b")) for t in sorted(terms)]))
    return out


_norm = norm_speaker


def _pembicara(conn: sqlite3.Connection, w: _Writer) -> None:
    figures = _speaker_terms(conn)
    names = {fid: name for fid, name, _ in figures}

    rows = conn.execute(
        """SELECT q.id, q.event_id, q.article_id, q.quote, q.speaker
             FROM event_quotes q JOIN events e ON e.id = q.event_id
            WHERE q.figure_id IS NULL AND COALESCE(q.assigned_by, 'auto') = 'auto'
              AND q.speaker IS NOT NULL AND q.speaker != ''
              AND e.curated IS NOT 'rejected'"""
    ).fetchall()

    # Who fits each speaker string, by longest matching term — once per string.
    fits: dict[str, tuple[int, list[str]]] = {}
    for speaker in {r["speaker"] for r in rows}:
        best, ids = 0, []
        for fid, _, terms in figures:
            hit = max((len(t) for t, pat in terms if pat.search(speaker)), default=0)
            if hit > best:
                best, ids = hit, [fid]
            elif hit and hit == best:
                ids.append(fid)
        multiword = best and any(
            " " in t and len(t) == best and pat.search(speaker)
            for fid, _, terms in figures if fid in ids for t, pat in terms)
        fits[speaker] = (2 if multiword else 1 if best else 0, ids)

    # Who takes part in each record, to break ties.
    in_record: dict[int, set[str]] = defaultdict(set)
    owner: dict[int, str] = {}
    events = {r["event_id"] for r in rows}
    for r in conn.execute("SELECT event_id, figure_id FROM record_figures"):
        if r[0] in events:
            in_record[r[0]].add(r[1])
    for r in conn.execute("SELECT id, figure_id FROM events WHERE figure_id IS NOT NULL"):
        if r[0] in events:
            in_record[r[0]].add(r[1])
            owner[r[0]] = r[1]
    # How a speaker string was assigned before, for ties the record cannot break.
    usual: dict[str, Counter] = defaultdict(Counter)
    for r in conn.execute("SELECT speaker, figure_id FROM event_quotes "
                          "WHERE figure_id IS NOT NULL AND speaker IS NOT NULL"):
        usual[_norm(r[0])][r[1]] += 1

    groups: dict[str, dict] = {}
    for r in rows:
        strength, ids = fits[r["speaker"]]
        if not ids:
            fig, band = None, "tanpa calon"
        elif len(ids) == 1:
            fig, band = ids[0], "nama lengkap" if strength == 2 else "satu kata"
        else:
            here = [i for i in ids if i in in_record[r["event_id"]]]
            if len(here) == 1:
                fig, band = here[0], "dari catatan"
            else:
                pool = here or ids
                seen = usual[_norm(r["speaker"])]
                fig = max(sorted(pool), key=lambda i: seen[i])
                band = "seri"
        key = f"pembicara:{_norm(r['speaker'])}:{fig or '-'}"
        # Anything short of a full name is split by whose catatan it is in: a
        # bare "Budi" in KPK records is the KPK spokesman, in health records
        # the minister, and one answer must not cover both.
        # A peristiwa has no owner to go by, so there it is that peristiwa alone.
        scope = "" if band == "nama lengkap" else lesson_scope(owner.get(r["event_id"]), r["event_id"])
        if scope:
            key += f":{scope}"
        g = groups.setdefault(key, {"speaker": r["speaker"], "figure_id": fig, "band": band, "scope": scope,
                                    "split": band != "nama lengkap" and r["event_id"] not in owner,
                                    "candidates": ids, "quotes": [], "per_event": Counter()})
        # A group keeps its weakest band: a tie in one record makes the answer
        # less certain for the whole group.
        if _SPEAKER_BANDS[band] < _SPEAKER_BANDS[g["band"]]:
            g["band"] = band
        g["quotes"].append(r)
        g["per_event"][r["event_id"]] += 1

    for key, g in groups.items():
        if (g["figure_id"] is None or g["split"]) and len(g["quotes"]) < MIN_SMALL_GROUP:
            continue
        # Listed on the catatan with most of these quotes; earliest id on a tie.
        event_id = min(g["per_event"], key=lambda e: (-g["per_event"][e], e))
        first = next(q for q in g["quotes"] if q["event_id"] == event_id)
        name = names.get(g["figure_id"]) if g["figure_id"] else None
        claim = (f"“{g['speaker']}” di sini adalah {name}" if name
                 else f"“{g['speaker']}” bukan tokoh yang dilacak")
        w.put("pembicara", key, event_id,
              {"speaker": g["speaker"], "figure_id": g["figure_id"], "name": name,
               "candidates": [{"id": i, "name": names[i]} for i in g["candidates"]],
               "quote_ids": sorted(q["id"] for q in g["quotes"]),
               "events": len(g["per_event"]), "scope": g["scope"], "claim": claim},
              _SPEAKER_BANDS[g["band"]], g["band"],
              _quote_evidence(conn, first), group_size=len(g["quotes"]))


def _quote_evidence(conn: sqlite3.Connection, q):
    if not q["article_id"]:
        return None
    row = conn.execute("SELECT body FROM articles WHERE id = ?", (q["article_id"],)).fetchone()
    if row is None:
        return None
    for para in _paragraphs(row["body"]):
        at = para.find(q["quote"])
        if at >= 0:
            if at > 0 and para[at - 1] in "\"“":
                at -= 1
            # The quote and its attribution: through the speaker's name if it follows.
            end = at + len(q["quote"])
            tail = para.find(q["speaker"], end)
            if 0 <= tail - end <= 40:
                end = tail + len(q["speaker"])
            return (q["article_id"], *_cut(para, at, end))
    return None


PRODUCERS = {"peristiwa": _peristiwa, "lini": _lini, "pelaku": _pelaku, "pembicara": _pembicara}


def run(conn: sqlite3.Connection) -> dict[str, int]:
    """Refresh every kind's points, then auto-answer the kinds switched on.

    Answered points are never touched; open ones whose question went away are
    marked settled. Quotes a speaker lesson covers are assigned first, so they
    are not asked about again.
    """
    taught = apply_lessons(conn)
    w = _Writer(conn)
    for kind in KINDS:
        PRODUCERS[kind](conn, w)
    settled = w.settle_the_rest()
    conn.commit()
    auto = auto_answer(conn)
    open_by_kind = dict(conn.execute(
        "SELECT kind, COUNT(*) FROM curation_points WHERE status IN ('open', 'lewati') GROUP BY kind"
    ).fetchall())
    return {**{f"open_{k}": open_by_kind.get(k, 0) for k in KINDS}, "settled": settled,
            "taught": taught, **auto}


# ---------------------------------------------------------------------------
# Confidence


def calibration(conn: sqlite3.Connection) -> dict[str, dict[str, tuple[int, int]]]:
    """{kind: {bucket: (agreed, answered)}} over the curator's own answers.

    Auto answers are left out — they would be the model agreeing with itself —
    except auto_wrong, a spot-check or a "Salah" the curator gave against it.
    """
    out: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    for kind, bucket, status, n in conn.execute(
        """SELECT kind, bucket, status, COUNT(*) FROM curation_points
            WHERE status IN ('ya', 'bukan', 'koreksi', 'auto_wrong')
            GROUP BY kind, bucket, status"""
    ):
        cell = out[kind][bucket or ""]
        cell[1] += n
        if status == "ya":
            cell[0] += n
    return {k: {b: (c[0], c[1]) for b, c in v.items()} for k, v in out.items()}


def confidence(agreed: int, answered: int) -> float | None:
    """Agreement smoothed by PRIOR; None before any answer."""
    if not answered:
        return None
    return agreed / (answered + PRIOR)


def auto_eligible(agreed: int, answered: int) -> bool:
    c = confidence(agreed, answered)
    return answered >= AUTO_MIN_ANSWERS and c is not None and c >= AUTO_MIN_AGREEMENT


# ---------------------------------------------------------------------------
# Auto-answering
#
# A kind the curator switched on in /kurasi (pipeline_state 'curation_auto',
# {kind: when it was switched on}) has its open points answered Ya here, in
# the bands that have cleared the gate — re-checked every run, so a band that
# slips stops being answered. One point in SPOT_CHECK_EVERY is left open
# instead, marked spot_check, for the curator to answer. Those answers and
# every "Salah" on an auto answer are what keep the kind on: below the gate
# since it was switched on, it switches itself off, and 'curation_auto_off'
# says when and on what.
#
# Answering writes what /kurasi's answerPoint writes (web/src/lib/curationPoints.ts),
# and keeps the same record of what changed, so "Salah" can put it back.

AUTO_KEY = "curation_auto"
AUTO_OFF_KEY = "curation_auto_off"
SPOT_CHECK_EVERY = 20


def _get_state(conn: sqlite3.Connection, key: str) -> tuple[dict, str | None]:
    row = conn.execute("SELECT value, updated_at FROM pipeline_state WHERE key = ?", (key,)).fetchone()
    if row is None:
        return {}, None
    try:
        value = json.loads(row["value"])
    except (TypeError, ValueError):
        return {}, row["updated_at"]
    return (value if isinstance(value, dict) else {}), row["updated_at"]


def _set_state(conn: sqlite3.Connection, key: str, value: dict) -> None:
    conn.execute(
        "INSERT INTO pipeline_state (key, value, updated_at) VALUES (?, ?, ?) "
        "ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        (key, json.dumps(value, ensure_ascii=False), _now()))


def auto_kinds(conn: sqlite3.Connection) -> dict[str, str]:
    """{kind: switched on at} for the kinds auto-answering is on for."""
    value, updated_at = _get_state(conn, AUTO_KEY)
    # A bare true (switched on before the time was kept) counts from the last write.
    return {k: v if isinstance(v, str) else (updated_at or "")
            for k, v in value.items() if v and k in KINDS}


def spot_checks(conn: sqlite3.Connection, kind: str, since: str) -> tuple[int, int]:
    """(agreed, checked): the curator's answers on spot checks, and their
    "Salah"s on auto answers, since `since`."""
    agreed = checked = 0
    for (status,) in conn.execute(
        """SELECT status FROM curation_points
            WHERE kind = ? AND answered_by = 'curator' AND answered_at >= ?
              AND ((spot_check = 1 AND status IN ('ya', 'bukan', 'koreksi'))
                   OR status = 'auto_wrong')""",
        (kind, since),
    ):
        checked += 1
        agreed += status == "ya"
    return agreed, checked


def _keeps_up(agreed: int, checked: int) -> bool:
    return agreed == checked or agreed >= AUTO_MIN_AGREEMENT * checked


def _switch_off(conn: sqlite3.Connection, kind: str, agreed: int, checked: int) -> None:
    on, _ = _get_state(conn, AUTO_KEY)
    on.pop(kind, None)
    _set_state(conn, AUTO_KEY, on)
    off, _ = _get_state(conn, AUTO_OFF_KEY)
    off[kind] = {"at": _now(), "agreed": agreed, "checked": checked}
    _set_state(conn, AUTO_OFF_KEY, off)


def _is_spot_check(key: str) -> bool:
    # By key, not at random: the same point is the spot check on every run.
    return zlib.crc32(key.encode()) % SPOT_CHECK_EVERY == 0


def _confirm_pair(conn, table: str, a_col: str, b_col: str, a: int, b: int) -> dict:
    prev = conn.execute(f"SELECT verdict FROM {table} WHERE {a_col} = ? AND {b_col} = ?",
                        (a, b)).fetchone()
    conn.execute(
        f"""INSERT INTO {table} ({a_col}, {b_col}, origin, verdict, created_at)
            VALUES (?, ?, 'curator', 'confirmed', ?)
            ON CONFLICT ({a_col}, {b_col}) DO UPDATE SET verdict = excluded.verdict""",
        (a, b, _now()))
    return {"kind": "pair", "table": table,
            "pairs": [{"a": a, "b": b, "prev": prev[0] if prev else None}]}


def _yes_peristiwa(conn, event_id: int, prop: dict, point_id: int) -> dict:
    return _confirm_pair(conn, "record_links", "record_id", "peristiwa_id",
                         event_id, prop["peristiwa_id"])


def _yes_lini(conn, event_id: int, prop: dict, point_id: int) -> dict:
    return _confirm_pair(conn, "followup_links", "earlier_id", "later_id",
                         prop["earlier_id"], prop["later_id"])


def _yes_pelaku(conn, event_id: int, prop: dict, point_id: int) -> dict:
    fig = prop["figure_id"]
    prev = conn.execute("SELECT role, source, quotes, assigned_by FROM record_figures "
                        "WHERE event_id = ? AND figure_id = ?", (event_id, fig)).fetchone()
    review = conn.execute("SELECT decision FROM actor_reviews WHERE event_id = ?",
                          (event_id,)).fetchone()
    # assigned_by 'point': participants.py rebuilds only its own 'auto' rows.
    conn.execute(
        """INSERT INTO record_figures (event_id, figure_id, role, source, quotes, assigned_by)
           VALUES (?, ?, 'actor', 'point', ?, 'point')
           ON CONFLICT (event_id, figure_id) DO UPDATE SET
               role = 'actor', source = 'point', assigned_by = 'point'""",
        (event_id, fig, prop.get("quotes") or 0))
    conn.execute("UPDATE actor_reviews SET decision = 'actor', decided_at = ? "
                 "WHERE event_id = ? AND suggested_id = ?", (_now(), event_id, fig))
    return {"kind": "pelaku", "prev": dict(prev) if prev else None,
            "review": review[0] if review else None}


def replace_shown_quotes(conn: sqlite3.Connection, quote_ids: list[int],
                         target: str | None) -> list[dict]:
    """A record showing one of these quotes, now someone else's words, shows its
    owner's longest other quote instead, or none — as assignQuote does in
    /kurasi. Returns what each showed, for undoing."""
    prev = []
    for r in conn.execute(
        """SELECT DISTINCT e.id, e.quote, e.quote_url, e.figure_id
             FROM events e JOIN event_quotes q ON q.event_id = e.id AND q.quote = e.quote
            WHERE q.id IN (SELECT value FROM json_each(?))""",
        (json.dumps(quote_ids),),
    ).fetchall():
        if r["figure_id"] == target:
            continue
        nxt = conn.execute(
            "SELECT quote, url FROM event_quotes WHERE event_id = ? AND figure_id = ? AND quote != ? "
            "ORDER BY length(quote) DESC LIMIT 1", (r["id"], r["figure_id"], r["quote"])).fetchone()
        conn.execute("UPDATE events SET quote = ?, quote_url = ? WHERE id = ?",
                     (nxt["quote"] if nxt else "", nxt["url"] if nxt else None, r["id"]))
        prev.append({"event_id": r["id"], "quote": r["quote"], "url": r["quote_url"]})
    return prev


def teach_speaker(conn: sqlite3.Connection, prop: dict, figure_id: str | None,
                  point_id: int, by: str) -> dict | None:
    """Keep a pembicara answer as a speaker lesson, where the point's grouping
    says it holds. Returns what it replaced, for undoing; None for a point made
    before scopes were kept."""
    scope, speaker = prop.get("scope"), prop.get("speaker")
    if scope is None or not speaker:
        return None
    norm = norm_speaker(speaker)
    prev = conn.execute("SELECT figure_id, point_id, taught_by, created_at FROM speaker_lessons "
                        "WHERE speaker = ? AND scope = ?", (norm, scope)).fetchone()
    conn.execute(
        """INSERT INTO speaker_lessons (speaker, scope, figure_id, point_id, taught_by, created_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (speaker, scope) DO UPDATE SET figure_id = excluded.figure_id,
               point_id = excluded.point_id, taught_by = excluded.taught_by,
               created_at = excluded.created_at""",
        (norm, scope, figure_id, point_id, by, _now()))
    return {"speaker": norm, "scope": scope, "prev": dict(prev) if prev else None}


def _yes_pembicara(conn, event_id: int, prop: dict, point_id: int) -> dict:
    target = prop.get("figure_id")
    waiting = conn.execute(
        """SELECT id, figure_id, assigned_by FROM event_quotes
            WHERE id IN (SELECT value FROM json_each(?))
              AND figure_id IS NULL AND COALESCE(assigned_by, 'auto') = 'auto'""",
        (json.dumps(prop.get("quote_ids") or []),)).fetchall()
    ids = [q["id"] for q in waiting]
    conn.execute("UPDATE event_quotes SET figure_id = ?, assigned_by = 'point' "
                 "WHERE id IN (SELECT value FROM json_each(?))", (target, json.dumps(ids)))
    return {"kind": "quotes", "ids": ids,
            "prev": [{"figure_id": q["figure_id"], "assigned_by": q["assigned_by"]} for q in waiting],
            "shown": replace_shown_quotes(conn, ids, target),
            "lesson": teach_speaker(conn, prop, target, point_id, "auto")}


_YES = {"peristiwa": _yes_peristiwa, "lini": _yes_lini, "pelaku": _yes_pelaku,
        "pembicara": _yes_pembicara}


def auto_answer(conn: sqlite3.Connection) -> dict[str, int]:
    """Answer Ya to the open points of the kinds switched on, in their proven
    bands, leaving every SPOT_CHECK_EVERY-th open as a spot check. Kinds whose
    checks fell below the gate are switched off first."""
    on = auto_kinds(conn)
    stats: Counter = Counter()
    for kind, since in list(on.items()):
        agreed, checked = spot_checks(conn, kind, since)
        if not _keeps_up(agreed, checked):
            _switch_off(conn, kind, agreed, checked)
            del on[kind]
            stats[f"off_{kind}"] = 1
    cal = calibration(conn)
    now = _now()
    for kind in on:
        proven = {b for b, (a, n) in cal.get(kind, {}).items() if auto_eligible(a, n)}
        if not proven:
            continue
        for p in conn.execute(
            "SELECT id, key, event_id, bucket, proposal FROM curation_points "
            "WHERE kind = ? AND status = 'open' AND spot_check = 0", (kind,)
        ).fetchall():
            if (p["bucket"] or "") not in proven:
                continue
            if _is_spot_check(p["key"]):
                conn.execute("UPDATE curation_points SET spot_check = 1 WHERE id = ?", (p["id"],))
                stats[f"spot_{kind}"] += 1
                continue
            undo = _YES[kind](conn, p["event_id"], json.loads(p["proposal"]), p["id"])
            conn.execute(
                "UPDATE curation_points SET status = 'auto', answer = ?, answered_by = 'auto', "
                "answered_at = ? WHERE id = ?",
                (json.dumps({"label": None, "undo": undo}, ensure_ascii=False), now, p["id"]))
            stats[f"auto_{kind}"] += 1
    conn.commit()
    return dict(stats)
