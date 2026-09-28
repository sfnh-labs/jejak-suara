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


def find_quote(body: str, name: str, aliases: list[str]) -> str | None:
    """The longest quote in `body` explicitly attributed to this figure."""
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
    return max(found, key=len) if found else None


def quote_pending(conn: sqlite3.Connection) -> dict[str, int]:
    """Attach a quote to every record that has none yet and a fetched article.

    Records without a quote are rescanned each run, since their bodies keep
    arriving from the fetch queue. A miss writes nothing, so the Neon push,
    which only sends changed rows, costs nothing for them.
    """
    stats = {"scanned": 0, "quoted": 0}
    events = conn.execute(
        """SELECT DISTINCT e.id, f.name, f.aliases
             FROM events e
             JOIN figures f ON f.id = e.figure_id
             JOIN articles a ON a.event_id = e.id AND a.fetch_status = 'ok'
            WHERE e.kind = 'record' AND e.quote IS NULL"""
    ).fetchall()
    for ev in events:
        stats["scanned"] += 1
        try:
            aliases = json.loads(ev["aliases"]) if ev["aliases"] else []
        except (TypeError, ValueError):
            aliases = []
        best: tuple[str, str] | None = None
        for art in conn.execute(
            "SELECT url, body FROM articles WHERE event_id = ? AND fetch_status = 'ok' "
            "ORDER BY published_at",
            (ev["id"],),
        ):
            q = find_quote(art["body"], ev["name"], aliases)
            if q and (best is None or len(q) > len(best[0])):
                best = (q, art["url"])
        if best:
            conn.execute("UPDATE events SET quote = ?, quote_url = ? WHERE id = ?",
                         (*best, ev["id"]))
            stats["quoted"] += 1
    conn.commit()
    return stats
