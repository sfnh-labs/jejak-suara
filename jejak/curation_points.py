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
auto-answering will be allowed to act on — with the same gate as auto-hide in
curation_suggest.py.

    python -m jejak.cli points
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timezone

from . import actors
from .cluster import _tokens
from .config import load_figures
from .quotes import _terms

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


def _norm(speaker: str) -> str:
    return re.sub(r"\s+", " ", speaker.strip().lower())


def _pembicara(conn: sqlite3.Connection, w: _Writer) -> None:
    figures = _speaker_terms(conn)
    names = {fid: name for fid, name, _ in figures}

    rows = conn.execute(
        """SELECT q.id, q.event_id, q.article_id, q.quote, q.speaker
             FROM event_quotes q JOIN events e ON e.id = q.event_id
            WHERE q.figure_id IS NULL AND q.assigned_by IS NOT 'curator'
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
        if band != "nama lengkap":
            key += f":{owner[r['event_id']]}" if r["event_id"] in owner else f":e{r['event_id']}"
        g = groups.setdefault(key, {"speaker": r["speaker"], "figure_id": fig, "band": band,
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
               "events": len(g["per_event"]), "claim": claim},
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
    """Refresh every kind's points. Answered points are never touched; open ones
    whose question went away are marked settled."""
    w = _Writer(conn)
    for kind in KINDS:
        PRODUCERS[kind](conn, w)
    settled = w.settle_the_rest()
    conn.commit()
    open_by_kind = dict(conn.execute(
        "SELECT kind, COUNT(*) FROM curation_points WHERE status IN ('open', 'lewati') GROUP BY kind"
    ).fetchall())
    return {**{f"open_{k}": open_by_kind.get(k, 0) for k in KINDS}, "settled": settled}


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
