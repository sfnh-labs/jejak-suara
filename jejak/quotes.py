"""The figure's own words, lifted verbatim from a record's source articles.

A summary paraphrases; a reader deciding what someone actually said wants the
sentence as printed. This is pattern-based on purpose: a model asked to "keep
the quote" rewords it, and a quote that is not character-for-character what the
outlet printed is worse than none.

Only explicit attribution counts — the quote is followed by a speech verb and
the figure's name ("…," kata Puan) or preceded by the name and a speech verb
(Puan mengatakan, "…"). Indonesian reporting names the speaker on the first
quote and writes "ujarnya" on the rest; those follow-ups are skipped, because
by then another speaker may have been introduced in between.
"""
from __future__ import annotations

import json
import re
import sqlite3
from datetime import datetime, timezone

_OPEN, _CLOSE = "\"“", "\"”"
_QUOTE = rf"[{_OPEN}](?P<q>[^{_OPEN}{_CLOSE}\n]{{40,320}})[{_CLOSE}]"
_AFTER_VERBS = (
    "kata|ujar|ucap|tutur|ungkap|jelas|tegas|imbuh|tambah|sebut|papar|terang"
)
_BEFORE_VERBS = (
    "mengatakan|menegaskan|menyatakan|menuturkan|mengungkapkan|menjelaskan|"
    "menyebut|menambahkan|berkata|bilang"
)
# "…," kata Presiden Prabowo — the name may carry a title of a few words.
_QUOTE_THEN_NAME = re.compile(
    _QUOTE + rf"\s*,?\s*(?:{_AFTER_VERBS})\s+(?P<who>[^.,;\n]{{2,60}})")
# Prabowo mengatakan, "…"
_NAME_THEN_QUOTE = re.compile(
    rf"(?P<who>[^.\n\"“”]{{2,120}}?)\b(?:{_BEFORE_VERBS})\b[^.\n\"“”]{{0,40}}?[,:]?\s*"
    + _QUOTE)


def _terms(name: str, aliases: list[str]) -> list[str]:
    """What the figure is called in running text: full names plus the first and
    last word of the name, which is how the second reference is usually written."""
    words = name.split()
    out = {name, *aliases, *(w for w in (words[0], words[-1]) if len(w) >= 4)}
    return [t for t in out if t]


def _speaker(words: list[str]) -> str:
    """The unbroken run of capitalised words at the start of `words`.

    Offices and names are both capitalised, so this is the speaker with their
    title and nothing else: "kata Menteri ESDM Bahlil usai bertemu Presiden
    Prabowo" names Bahlil — the lowercase "usai" ends the run before Prabowo.
    """
    run = []
    for w in words:
        if not w[:1].isupper():
            break
        run.append(w)
    return " ".join(run)


def _names(who: str, terms: list[str]) -> bool:
    return any(re.search(rf"\b{re.escape(t)}\b", who) for t in terms)


def find_quote(body: str, name: str, aliases: list[str],
               exclude: set[str] | frozenset[str] = frozenset()) -> str | None:
    """The longest quote in `body` explicitly attributed to this figure, other than `exclude`."""
    if not body:
        return None
    terms = _terms(name, aliases)
    found = [
        m.group("q").strip().rstrip(",")
        for m in _QUOTE_THEN_NAME.finditer(body)
        if _names(_speaker(m.group("who").split()), terms)
    ] + [
        m.group("q").strip().rstrip(",")
        for m in _NAME_THEN_QUOTE.finditer(body)
        # Read backwards from the verb: the run ending right before it.
        if _names(" ".join(_speaker(m.group("who").split()[::-1]).split()[::-1]), terms)
    ]
    found = [q for q in found if q not in exclude]
    return max(found, key=len) if found else None


def quote_pending(conn: sqlite3.Connection, full: bool = False) -> dict[str, int]:
    """Attach a quote to every record that has none yet and a fetched article.

    Only records with an article body the stage has not read yet (quote_scans)
    are looked at, since a body that held no quote last run holds none now.
    A curator sending a record back to the pipeline's pick clears its scans,
    so it is read again. `full` rereads every record without a quote, as after
    adding a figure's aliases. A miss writes nothing, so the Neon push, which
    only sends changed rows, costs nothing for them.
    """
    stats = {"scanned": 0, "quoted": 0}
    unread = "" if full else """
              AND NOT EXISTS (SELECT 1 FROM quote_scans s
                               WHERE s.article_id = a.id AND s.event_id = e.id)"""
    events = conn.execute(
        f"""SELECT DISTINCT e.id, f.name, f.aliases
             FROM events e
             JOIN figures f ON f.id = e.figure_id
             JOIN articles a ON a.event_id = e.id AND a.fetch_status = 'ok'
            WHERE e.kind = 'record' AND e.quote IS NULL{unread}"""
    ).fetchall()
    for ev in events:
        stats["scanned"] += 1
        try:
            aliases = json.loads(ev["aliases"]) if ev["aliases"] else []
        except (TypeError, ValueError):
            aliases = []
        # Quotes the curator said are someone else's words are never picked.
        disowned = {r[0] for r in conn.execute(
            "SELECT quote FROM event_quotes WHERE event_id = ? AND assigned_by IN ('curator', 'lesson') "
            "AND figure_id IS NOT (SELECT figure_id FROM events WHERE id = ?)",
            (ev["id"], ev["id"]))}
        best: tuple[str, str] | None = None
        for art in conn.execute(
            "SELECT url, body FROM articles WHERE event_id = ? AND fetch_status = 'ok' "
            "ORDER BY published_at",
            (ev["id"],),
        ):
            q = find_quote(art["body"], ev["name"], aliases, disowned)
            if q and (best is None or len(q) > len(best[0])):
                best = (q, art["url"])
        if best:
            conn.execute("UPDATE events SET quote = ?, quote_url = ? WHERE id = ?",
                         (*best, ev["id"]))
            stats["quoted"] += 1
    # After the records: collect_quotes marks the bodies read.
    stats.update(collect_quotes(conn, full=full))
    conn.commit()
    return stats


def all_quotes(body: str) -> list[tuple[str, str]]:
    """Every explicitly attributed quote in `body`, with the speaker as written.

    The same two patterns as find_quote, for anyone: (quote, speaker), where
    the speaker is the run of capitalised words at the attribution ("Said",
    "Kapolri Jenderal Suyudi"). Follow-ups ("…," ujarnya) are still skipped:
    by then another speaker may have been introduced.
    """
    if not body:
        return []
    out: dict[str, str] = {}
    for m in _QUOTE_THEN_NAME.finditer(body):
        who = _speaker(m.group("who").split())
        if who:
            out.setdefault(m.group("q").strip().rstrip(","), who)
    for m in _NAME_THEN_QUOTE.finditer(body):
        who = " ".join(_speaker(m.group("who").split()[::-1]).split()[::-1])
        if who:
            out.setdefault(m.group("q").strip().rstrip(","), who)
    return list(out.items())


def norm_speaker(speaker: str) -> str:
    """A speaker as written, compared without case or spacing (speaker_lessons' key)."""
    return re.sub(r"\s+", " ", speaker.strip().lower())


def lesson_scope(owner: str | None, event_id: int) -> str:
    """Where in the archive an event is, for speaker_lessons: its figure's
    catatan, or a peristiwa by itself."""
    return owner or f"e{event_id}"


def load_lessons(conn: sqlite3.Connection) -> dict[tuple[str, str], str | None]:
    """{(speaker, scope): figure id or None} from the curator's answers."""
    return {(r[0], r[1]): r[2] for r in conn.execute(
        "SELECT speaker, scope, figure_id FROM speaker_lessons")}


def lesson_for(lessons: dict, speaker: str, owner: str | None, event_id: int):
    """The lesson that covers this speaker here: the scoped one before the
    everywhere one. (found, figure id or None)."""
    norm = norm_speaker(speaker)
    for scope in (lesson_scope(owner, event_id), ""):
        if (norm, scope) in lessons:
            return True, lessons[(norm, scope)]
    return False, None


def apply_lessons(conn: sqlite3.Connection) -> int:
    """Assign the quotes still waiting whose speaker a lesson covers: the ones
    collected before the answer that taught it. Returns how many."""
    lessons = load_lessons(conn)
    if not lessons:
        return 0
    done = 0
    for q in conn.execute(
        """SELECT q.id, q.event_id, q.speaker, e.figure_id AS owner
             FROM event_quotes q JOIN events e ON e.id = q.event_id
            WHERE q.figure_id IS NULL AND COALESCE(q.assigned_by, 'auto') = 'auto'
              AND q.speaker IS NOT NULL AND q.speaker != ''"""
    ).fetchall():
        found, fig = lesson_for(lessons, q["speaker"], q["owner"], q["event_id"])
        if found:
            conn.execute("UPDATE event_quotes SET figure_id = ?, assigned_by = 'lesson' WHERE id = ?",
                         (fig, q["id"]))
            done += 1
    return done


def match_speaker(speaker: str, figures: list[tuple[str, list[str]]],
                  prefer: str | None = None) -> str | None:
    """The tracked figure a written speaker names, if exactly one fits.

    `figures` is [(id, terms)]. The longest matching term wins, so "Said
    Abdullah" beats a bare "Said"; `prefer` (the record's own figure) wins a
    tie, since a record's quotes are mostly its owner's.
    """
    best: tuple[int, str] | None = None
    tied = False
    for fid, terms in figures:
        hit = max((len(t) for t in terms if _names(speaker, [t])), default=0)
        if not hit:
            continue
        if best is None or hit > best[0] or (hit == best[0] and fid == prefer):
            tied = best is not None and hit == best[0] and fid != prefer and best[1] != prefer
            best = (hit, fid)
        elif hit == best[0] and best[1] != prefer:
            tied = True
    return None if best is None or tied else best[1]


def collect_quotes(conn: sqlite3.Connection, event_ids: list[int] | None = None,
                   full: bool = False) -> dict[str, int]:
    """List every attributed quote of each event in event_quotes. Commits in batches.

    New quotes are matched to a tracked figure, or to who the curator said a
    speaker written that way is (speaker_lessons) before any name matching; a
    quote already listed keeps its assignment, a curator's above all. Reads only the bodies quote_scans
    has no row for, unless `full` or the events are named.
    """
    figures = []
    for r in conn.execute("SELECT id, name, aliases FROM figures WHERE active = 1"):
        try:
            aliases = json.loads(r["aliases"]) if r["aliases"] else []
        except (TypeError, ValueError):
            aliases = []
        figures.append((r["id"], _terms(r["name"], aliases)))
    lessons = load_lessons(conn)
    where = "a.fetch_status = 'ok' AND a.event_id IS NOT NULL"
    params: list = []
    if event_ids is not None:
        where += f" AND a.event_id IN ({','.join('?' * len(event_ids)) or 'NULL'})"
        params = list(event_ids)
    elif not full:
        where += (" AND NOT EXISTS (SELECT 1 FROM quote_scans s"
                  " WHERE s.article_id = a.id AND s.event_id = a.event_id)")
    stats = {"articles": 0, "quotes": 0}
    now = datetime.now(timezone.utc).isoformat()
    for art in conn.execute(
        f"""SELECT a.id, a.url, a.body, a.event_id, e.figure_id AS owner
              FROM articles a JOIN events e ON e.id = a.event_id WHERE {where}""",
        params,
    ).fetchall():
        stats["articles"] += 1
        # In batches: a full pass reads every article, and one transaction
        # held the write lock long enough to fail the fetch backfill.
        if stats["articles"] % 500 == 0:
            conn.commit()
        for quote, speaker in all_quotes(art["body"]):
            taught, fig = lesson_for(lessons, speaker, art["owner"], art["event_id"])
            if not taught:
                fig = match_speaker(speaker, figures, art["owner"])
            cur = conn.execute(
                """INSERT OR IGNORE INTO event_quotes
                       (event_id, article_id, url, quote, speaker, figure_id, assigned_by, found_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                (art["event_id"], art["id"], art["url"], quote, speaker, fig,
                 "lesson" if taught else "auto", now),
            )
            stats["quotes"] += cur.rowcount
        conn.execute("INSERT OR REPLACE INTO quote_scans (article_id, event_id, scanned_at) "
                     "VALUES (?, ?, ?)", (art["id"], art["event_id"], now))
    return stats
