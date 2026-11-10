"""Stage 2b' — Whom each quote is about.

A quote has a speaker (event_quotes.figure_id), and its words often name
someone else: "Pak Surya telepon saya, saya sampaikan, Pak Surya pun syok",
said by NasDem's Sugeng, is about Surya Paloh. Each tracked figure a quote's
words name, other than its speaker, goes to quote_subjects; the record then
counts them as Terkait (jejak/participants.py) and /kurasi asks the curator
to confirm (a 'tentang' point).

How the quote names them is the band:

  nama lengkap  a full name or multi-word alias ("Prabowo Subianto")
  alias         a one-word alias the roster lists ("Prabowo", "Jokowi")
  sapaan        an honorific and one word of the name ("Pak Surya");
                when several figures fit, the one the record already
                concerns, else none

Only the stage's own rows ('auto') are rebuilt; a curator's confirmed or
rejected ones stay as they are.
"""
from __future__ import annotations

import json
import re
import sqlite3
from collections import Counter, defaultdict
from datetime import datetime, timezone

BANDS = ("nama lengkap", "alias", "sapaan")

_HONORIFIC = r"(?:Pak|Bu|Bapak|Ibu|Mas|Mbak|Bang|Kak|Cak|Ning)"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _alternation(terms) -> str:
    return "|".join(re.escape(t) for t in sorted(terms, key=len, reverse=True))


class Index:
    """Every active figure's names, one pattern per band over the whole
    roster: a quote is read three times, not three times per figure."""

    def __init__(self, conn: sqlite3.Connection):
        self.terms: dict[str, dict[str, set[str]]] = {b: defaultdict(set) for b in BANDS}
        for r in conn.execute("SELECT id, name, aliases FROM figures WHERE active = 1"):
            try:
                aliases = [a for a in json.loads(r["aliases"] or "[]") if isinstance(a, str)]
            except (TypeError, ValueError):
                aliases = []
            for t in {t.strip() for t in (r["name"], *aliases) if " " in t.strip()}:
                self.terms["nama lengkap"][t].add(r["id"])
            for t in {t.strip() for t in aliases if " " not in t.strip() and len(t.strip()) >= 4}:
                self.terms["alias"][t].add(r["id"])
            for w in {w for w in r["name"].split() if len(w) >= 4}:
                self.terms["sapaan"][w].add(r["id"])
        self.patterns = {
            b: re.compile(rf"\b{_HONORIFIC}\s+({_alternation(t)})\b" if b == "sapaan"
                          else rf"\b({_alternation(t)})\b")
            for b, t in self.terms.items() if t
        }

    def hits(self, quote: str, band: str) -> set[str]:
        pat = self.patterns.get(band)
        if pat is None:
            return set()
        return {f for m in pat.finditer(quote) for f in self.terms[band][m.group(1)]}


def find(quote: str, speaker_id: str | None, index: Index, in_record: set[str]) -> dict[str, str]:
    """{figure id: band} for the figures the quote's words name, each in its strongest band."""
    found: dict[str, str] = {}
    for band in ("nama lengkap", "alias"):
        for f in index.hits(quote, band):
            found.setdefault(f, band)
    # "Pak Agus" fits every Agus on the roster: keep it only when one of them
    # is already in the record, or there is just the one.
    honorific = [f for f in index.hits(quote, "sapaan") if f not in found and f != speaker_id]
    if len(honorific) > 1:
        honorific = [f for f in honorific if f in in_record]
    if len(honorific) == 1:
        found[honorific[0]] = "sapaan"
    found.pop(speaker_id, None)
    return found


def backfill(conn: sqlite3.Connection) -> dict:
    """Rebuild the automatic quote_subjects rows. Safe to repeat."""
    index = Index(conn)
    in_record: dict[int, set[str]] = defaultdict(set)
    for r in conn.execute("SELECT event_id, figure_id FROM record_figures WHERE role = 'related' "
                          "UNION SELECT id, figure_id FROM events WHERE figure_id IS NOT NULL "
                          "UNION SELECT event_id, figure_id FROM event_quotes WHERE figure_id IS NOT NULL"):
        in_record[r[0]].add(r[1])
    decided = {(r[0], r[1]) for r in conn.execute(
        "SELECT quote_id, figure_id FROM quote_subjects WHERE status <> 'auto'")}

    rows = []
    for q in conn.execute("SELECT id, event_id, quote, figure_id FROM event_quotes"):
        for fid, band in find(q["quote"], q["figure_id"], index, in_record[q["event_id"]]).items():
            if (q["id"], fid) not in decided:
                rows.append((q["id"], fid, band))

    now = _now()
    conn.execute("DELETE FROM quote_subjects WHERE status = 'auto'")
    conn.executemany(
        "INSERT OR IGNORE INTO quote_subjects (quote_id, figure_id, status, band, assigned_by, created_at) "
        "VALUES (?, ?, 'auto', ?, 'auto', ?)",
        [(q, f, b, now) for q, f, b in rows])
    conn.commit()
    bands = Counter(b for _, _, b in rows)
    return {"subjects": len(rows), **{b.replace(" ", "_"): bands.get(b, 0) for b in BANDS}}
