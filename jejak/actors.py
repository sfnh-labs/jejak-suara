"""Other figures' own statements inside an article, as records of theirs.

Ingest gives an article to one figure, by its headline. Everyone else the
article quotes is lost: "Fadli Zon Respons Polisi Cabut Izin Konser" also
carries the MUI chair urging the government to cancel the concert, and that
belongs on his timeline, not under Fadli Zon's record as a related figure — he
is not a party to Fadli Zon's act.

So each tracked figure stated *doing* something in an article they do not own
("Menteri PU, Dody Hanggodo, menegaskan …", "… ujar Juru Bicara KPK Budi
Prasetyo") gets a derived article: a row of their own holding just that
passage, same outlet, URL and headline. It then goes through clustering and
summarizing like any other article, so it joins a record they already have on
the same thing or starts one. Merely being named ("Prabowo meminta Dody …")
does not count.

A passage that recalls something earlier ("sebelumnya disuarakan", "Sabtu (9/5)
lalu") would be misdated by the article's own date, so it may only join a
record that already exists (derived_mode 'join'; cluster.py drops it if none
matches).
"""
from __future__ import annotations

import hashlib
import re
import sqlite3
from datetime import datetime, timedelta, timezone

from .config import Figure, load_figures

# Only recent coverage: a figure's record from a months-old article is a
# history entry, and the scan would otherwise start with the whole archive.
WINDOW_DAYS = 30

# Speech and stance verbs that make the figure before them the actor.
_ACTS = ("mengatakan|menyatakan|menegaskan|mendesak|meminta|menolak|mengkritik|"
         "menilai|menyebut|mengusulkan|mengimbau|memprotes|membantah|mengklaim|"
         "menjelaskan|berpendapat|mengaku|menyampaikan|mengungkapkan|menyoroti|"
         "menuding|menuntut|mengecam|mendukung|menyerukan|memperingatkan|"
         "menginstruksikan|memerintahkan|mengumumkan|melaporkan|menanggapi|"
         "membela|berjanji|menjanjikan")
# Quote attribution after the quote: '"…," kata Seskab Teddy Indra Wijaya'.
_SAID = "kata|ujar|ucap|tutur|jelas|tegas|imbuh|tambah|ungkap|sebut"
# Between the name and the verb only a bracketed alias or a comma-enclosed
# office may stand. Anything else means the verb has another subject:
# "… dengan Mentan Andi Amran Sulaiman, Mendagri mengungkapkan …".
_GAP = re.compile(r"\s*(\([^()]*\))?\s*(,[^,]{1,80},|,)?\s*")
_SENTENCE = re.compile(r"(?<=[.!?\"”])\s+(?=[A-Z\"“])")
# The passage carries on in the next sentence: a quote, or "Ia/Dia …".
_CONTINUES = re.compile(r"^([\"“]|(Ia|Dia|Menurutnya|Menurut dia)\b)|"
                        r"\b(katanya|ujarnya|tuturnya|imbuhnya|tambahnya|jelasnya|tegasnya)\b")
_PAST = re.compile(r"\b(sebelumnya|silam|pernah)\b|"
                   r"\b(pekan|minggu|bulan|tahun|waktu|hari)\s+lalu\b|\)\s*lalu\b", re.I)
# A spokesperson's statements are their institution's case updates (Jubir KPK
# alone matched 37 articles in two weeks), not their own record.
_SPOKESPERSON = re.compile(r"^(juru bicara|jubir)\b", re.I)
# Follow-on sentences kept after the matched one.
_MAX_FOLLOW = 3
# Matched sentences per figure per article.
_MAX_HITS = 3


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _pattern(f: Figure) -> re.Pattern | None:
    terms = sorted({t for t in f.match_terms() if len(t) >= 4}, key=len, reverse=True)
    if not terms:
        return None
    alt = "|".join(re.escape(t) for t in terms)
    return re.compile(
        rf"\b(?:{alt})\b(?P<gap>[^.;:!?]{{0,90}}?)\b(?:{_ACTS})\b"
        rf"|\b(?:{_SAID})(?:nya)?\s+(?:[A-Z][\w.]*\s+){{0,3}}(?:{alt})\b", re.I)


def passage(body: str, pat: re.Pattern) -> str | None:
    """The sentences where the figure is the one acting, with the sentence
    before each for context and the ones that carry its quote on."""
    sents = _SENTENCE.split(body)
    keep: list[int] = []
    hits = 0
    for i, s in enumerate(sents):
        m = pat.search(s)
        if not m or not _GAP.fullmatch(m.group("gap") or ""):
            continue
        keep += [i - 1, i] if i else [i]
        j = i + 1
        while j < len(sents) and j - i <= _MAX_FOLLOW and _CONTINUES.search(sents[j]):
            keep.append(j)
            j += 1
        hits += 1
        if hits == _MAX_HITS:
            break
    if not keep:
        return None
    return " ".join(sents[i].strip() for i in sorted(set(keep)))


def derived_id(url: str, figure_id: str) -> str:
    return hashlib.sha256(f"{url}#{figure_id}".encode("utf-8")).hexdigest()


def derive(conn: sqlite3.Connection, limit: int = 1000) -> dict[str, int]:
    """Scan recent fetched articles once each and write the derived articles."""
    stats = {"scanned": 0, "derived": 0, "join_only": 0}
    figures = load_figures(conn)
    roles = dict(conn.execute("SELECT id, coalesce(role, '') FROM figures").fetchall())
    pats = [(f, p) for f in figures
            if not _SPOKESPERSON.match(roles.get(f.id, "")) and (p := _pattern(f))]
    since = (datetime.now(timezone.utc) - timedelta(days=WINDOW_DAYS)).isoformat()
    rows = conn.execute(
        """SELECT id, figure_id, source, url, title, body, published_at, fetched_at
             FROM articles
            WHERE derived_from IS NULL AND actors_scanned_at IS NULL
              AND fetch_status = 'ok' AND body IS NOT NULL AND body_original IS NULL
              AND published_at >= ?
            ORDER BY published_at DESC
            LIMIT ?""",
        (since, limit),
    ).fetchall()
    for a in rows:
        stats["scanned"] += 1
        for f, pat in pats:
            if f.id == a["figure_id"]:
                continue
            text = passage(a["body"], pat)
            if text is None:
                continue
            mode = "join" if _PAST.search(text) else "record"
            did = derived_id(a["url"], f.id)
            cur = conn.execute(
                """INSERT OR IGNORE INTO articles
                       (id, figure_id, source, url, title, body, fetch_status,
                        published_at, fetched_at, derived_from, derived_mode)
                   VALUES (?, ?, ?, ?, ?, ?, 'ok', ?, ?, ?, ?)""",
                (did, f.id, a["source"], a["url"], a["title"], text,
                 a["published_at"], a["fetched_at"], a["id"], mode))
            if cur.rowcount:
                # Its names were already mined from the article it came from.
                conn.execute("INSERT OR IGNORE INTO article_scans (article_id) VALUES (?)", (did,))
                stats["derived"] += 1
                stats["join_only"] += mode == "join"
        conn.execute("UPDATE articles SET actors_scanned_at = ? WHERE id = ?", (_now(), a["id"]))
        conn.commit()
    return stats
