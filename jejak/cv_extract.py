"""Biographical facts in an article, drafted for a figure's CV.

Some coverage is not an act at all: an appointment, a new office, someone's
background. The `kurasi` stage finds it on its own (jejak/kurasi.py
auto_cv): a keyword screen picks candidates, `is_cv_material` asks the local
model whether the record is a fact about its figure rather than something
they did, and `draft_cv` lists only what the articles state about the figure —
offices, plain facts, education. Grounding is the same rule as summarize.py:
nothing from memory.
"""
from __future__ import annotations

import json
import re
import sqlite3
import urllib.error
import urllib.request

from . import summarize

SYSTEM = """You extract biographical facts about ONE person from news articles,
for a public accountability archive's CV of that person.

Hard rules:
- Use ONLY what the documents explicitly state about {name}. Nothing from
  outside knowledge, no guesses, no inference about intent.
- Skip anything about other people, unless it states {name}'s relation to them
  (e.g. a fact "Hubungan keluarga": "Paman dari ...").
- Write in Indonesian, matching the documents.
- If the documents state nothing biographical about {name}, return empty lists.

Return JSON only, exactly this shape:
{{"positions": [{{"role": "...", "org": "...", "period": "..."}}],
  "facts": [{{"label": "...", "value": "..."}}],
  "education": [{{"year": "...", "detail": "..."}}]}}

- positions: offices {name} holds or held. role = the office ("Sekretaris"),
  org = the body ("Dinas PMD Sumatera Utara"), period = years as written, or
  "" when not stated. A new appointment is "<year> – kini".
- facts: short label/value pairs ("Lahir", "Partai"). A relative is labelled
  by what they are TO {name}, value = who they are: {{"label": "Ayah",
  "value": "<nama>, <jabatannya bila disebut>"}} means that person is
  {name}'s father. Never "Ayah dari" / "Paman dari" — that reverses it.
- education: year as written or "", detail = degree and institution."""

PROMPT = ("Daftar fakta biografis tentang {name} dari dokumen di atas, "
          "dalam JSON sesuai bentuk yang diminta.{note}")


_WORD = re.compile(r"[a-z0-9]+")

# An appointment, read straight from a record's title: "Dilantik Menjadi Menko
# Polkam", "Hasan Nasbi … Dilantik Prabowo Jadi Penasihat Khusus Presiden",
# "Menjabat Ketua Harian". The verb must open the title or follow the figure's
# name, so "Menolak dilantik menjadi …" (an act) never matches. The office runs
# to the end of the clause.
_APPOINTED = re.compile(
    r"^(?:(?P<name>.+?)\s+)?(?:kembali\s+)?(?:resmi\s+)?"
    r"(?:dilantik|ditunjuk|diangkat|terpilih|dikukuhkan)(?:\s+kembali)?"
    r"(?:\s+(?!jadi\b|menjadi\b|sebagai\b)\S+){0,2}?\s+(?:jadi|menjadi|sebagai)\s+(?P<office>.+)$"
    r"|^(?:resmi\s+)?menjabat\s+(?:sebagai\s+)?(?P<office2>.+)$",
    re.I,
)
_CLAUSE_END = re.compile(r"\s*(?:[,;:|(]|\s-\s|\s(?:usai|setelah|pada|gantikan|menggantikan|"
                         r"oleh|periode|tahun)\s).*$", re.I)


def office_from_title(title: str, name: str) -> str | None:
    """The office a record's title says its figure was appointed to, or None."""
    m = _APPOINTED.match((title or "").strip())
    if not m:
        return None
    lead = _WORD.findall((m.group("name") or "").lower())
    # Text before the verb must open with the figure ('Hasan Nasbi "Is Back",')
    # or a profile of them. Anything else is another subject, and a time word
    # makes the appointment background to something said or done after it
    # ("Kata-kata Dito Usai Ditunjuk Jadi Menpora").
    if lead:
        if lead[0] not in set(_WORD.findall(name.lower())) | {"profil", "sosok", "biodata"}:
            return None
        if set(lead) & {"usai", "setelah", "saat", "sebelum", "jelang", "sejak", "kata"}:
            return None
    office = _CLAUSE_END.sub("", m.group("office") or m.group("office2") or "").strip(' ."“”')
    return office if 2 < len(office) <= 120 else None


def is_profile_of(title: str, name: str) -> bool:
    """"Profil <the figure> …": a profile of the record's own figure."""
    m = re.match(r"^(?:profil|biodata|sosok|rekam jejak)\s+(.+)", (title or "").strip(), re.I)
    if not m:
        return False
    first = [w for w in _WORD.findall(name.lower()) if len(w) > 2][:2]
    head = set(_WORD.findall(m.group(1).lower())[:4])
    return bool(first) and any(w in head for w in first)


# Words that put a record in the running for CV material: being appointed,
# elected or sworn in, a profile, a background, a wealth report, family. Only a
# screen — most matches are acts after all ("Menolak ditunjuk …") or about
# someone else, which is what the model check is for. "melantik" (swearing
# someone else in) is the figure acting, and is deliberately absent.
CANDIDATE = re.compile(
    r"\b(dilantik|ditunjuk|diangkat|terpilih|resmi (menjabat|jadi|menjadi)|menjabat|"
    r"dicopot|diberhentikan|profil|sosok|biodata|latar belakang|rekam jejak|"
    r"harta kekayaan|lhkpn|riwayat (hidup|pendidikan|jabatan)|lulusan|"
    r"anak (dari|sulung|bungsu)|putra|putri|istri|suami|menantu|keponakan)\b",
    re.I,
)

CLASSIFY = """You sort news coverage of ONE person, {name}, for a public
accountability archive. The archive records what {name} DOES and SAYS; facts
ABOUT {name} belong in their CV instead.

Answer "cv": true only when the documents are mainly a fact about {name}
themselves: {name} being appointed, elected, sworn in, promoted or removed
from an office; a profile of {name}; {name}'s background, education, family
ties or wealth report.

Answer "cv": false when the documents are mainly something {name} did or said
(a statement, a decision, a visit, swearing SOMEONE ELSE in, refusing an
office), or mainly about another person.

Being sworn in or appointed is something that HAPPENS TO {name}, not an act
of theirs, even when the headline reads like news. Examples, for a person X:
- "Dilantik Menjadi Menko Polkam" -> true (X's new office)
- "X Dilantik Prabowo Jadi Penasihat Khusus Presiden" -> true
- "Menjabat Ketua Harian" / "Ditunjuk sebagai Wakil Ketua Umum PBNU" -> true
- "Profil X, Kakorlantas Baru" -> true
- "Menyatakan harta kekayaan mencapai Rp5 miliar" -> true (X's wealth report)
- "Menolak dilantik menjadi Ketua Umum Partai" -> false (X refused: an act)
- "Menandatangani Dokumen Setelah Dilantik" -> false (signing is the act)
- "Setahun Dilantik, X Temui Mahasiswa" -> false (meeting students is the act)
- "Profil Y, Tersangka Korupsi" filed under X -> false (about Y, not X)

Return JSON only: {{"cv": true or false, "why": "<one short sentence>"}}"""


def is_cv_material(conn: sqlite3.Connection, event_id: int, figure_id: str) -> tuple[bool, str]:
    """Whether a record is a fact about its figure rather than an act, by the
    local model reading the record's title and summary and its headlines —
    enough to tell, and a fraction of the full articles' reading time."""
    fig = conn.execute("SELECT name FROM figures WHERE id = ?", (figure_id,)).fetchone()
    if fig is None:
        raise ValueError(f"unknown figure: {figure_id}")
    ev = conn.execute(
        "SELECT e.title, es.summary_text FROM events e "
        "LEFT JOIN event_summaries es ON es.event_id = e.id WHERE e.id = ?", (event_id,)).fetchone()
    heads = [r[0] for r in conn.execute(
        "SELECT title FROM articles WHERE event_id = ? AND title IS NOT NULL "
        "ORDER BY published_at, id LIMIT 8", (event_id,))]
    if ev is None or not heads:
        raise ValueError(f"event {event_id} has no articles")
    doc = (f"Judul catatan: {ev['title'] or ''}\n"
           f"Ringkasan: {(ev['summary_text'] or '')[:1500]}\n"
           "Judul artikel:\n" + "\n".join(f"- {h}" for h in heads))
    raw = _chat_json([
        {"role": "system", "content": CLASSIFY.format(name=fig["name"])},
        {"role": "user", "content": doc
         + f"\n\nApakah ini terutama keterangan tentang {fig['name']} "
           "(bahan CV), bukan perbuatan atau ucapannya? Jawab JSON."},
    ], num_predict=120)
    return raw.get("cv") is True, str(raw.get("why") or "").strip()[:300]


class ModelDown(RuntimeError):
    """Ollama cannot be reached: nothing later in a run will fare better."""


def _chat_json(messages: list[dict], num_predict: int = 800) -> dict:
    payload = json.dumps({
        "model": summarize.OLLAMA_MODEL, "messages": messages, "stream": False,
        "format": "json", "options": {"num_predict": num_predict, "temperature": 0},
    }).encode()
    req = urllib.request.Request(f"{summarize.OLLAMA_BASE_URL}/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = json.loads(resp.read())
    except urllib.error.URLError as e:
        raise ModelDown(f"Ollama not reachable at {summarize.OLLAMA_BASE_URL}. "
                           f"Is ollama serve running? ({getattr(e, 'reason', e)})") from e
    try:
        return json.loads(body.get("message", {}).get("content", "") or "{}")
    except ValueError as e:
        raise RuntimeError("the model did not return JSON") from e


def _clean(raw: dict) -> dict:
    """Keep only well-formed entries; the model's shape is a request, not a promise."""
    def rows(key: str, fields: tuple[str, ...], need: tuple[str, ...]) -> list[dict]:
        out = []
        for item in raw.get(key) or []:
            if not isinstance(item, dict):
                continue
            row = {f: str(item.get(f) or "").strip() for f in fields}
            if all(row[n] for n in need):
                out.append(row)
        return out[:8]
    return {
        "positions": rows("positions", ("role", "org", "period"), ("role",)),
        "facts": rows("facts", ("label", "value"), ("label", "value")),
        "education": rows("education", ("year", "detail"), ("detail",)),
    }


# A value that says the documents said nothing is not an entry, and neither is
# one true only on the day it was written ("Usia: 73 tahun", "55 tahun lalu").
_PLACEHOLDER = re.compile(r"belum (di)?(nyatakan|sebut|ketahui)|tidak (di)?(sebut|ketahui|dinyatakan)|"
                          r"^-+$|^n/?a$|^\?$|tahun lalu|^\d+ tahun$|\busia\b", re.I)
_RELATIVE_LABEL = re.compile(r"^(usia|umur)$", re.I)
_FILLER = set("""dan dari di ke yang untuk dengan atau the of ri republik indonesia
             kepala ketua wakil anggota menteri""".split())


def _words(text: str) -> list[str]:
    return [w for w in _WORD.findall(text.lower()) if len(w) > 2 and w not in _FILLER]


def _sentences(text: str) -> list[str]:
    return [x.lower() for x in re.split(r"(?<=[.!?])\s+|\n+", text) if x.strip()]


def ground(draft: dict, text: str) -> dict:
    """Only what the articles actually say: every entry's distinctive words
    must be in the text, and a fact's label (a relation, "Ayah") must share a
    sentence with its value. A small model fills a CV form from memory when the
    articles are thin, and these entries go onto a public CV unreviewed.
    """
    low = text.lower()
    present = set(_WORD.findall(low))
    sentences = _sentences(text)

    def stated(value: str, need: float = 1.0) -> bool:
        ws = _words(value)
        return bool(ws) and sum(w in present for w in ws) >= need * len(ws)

    out = {"positions": [], "facts": [], "education": []}
    for p in draft.get("positions", []):
        if not _PLACEHOLDER.search(p["role"]) and stated(f"{p['role']} {p['org']}", 0.75):
            out["positions"].append(p)
    for f in draft.get("facts", []):
        if (_PLACEHOLDER.search(f["value"]) or _RELATIVE_LABEL.match(f["label"].strip())
                or not stated(f["value"], 0.75)):
            continue
        label, names = f["label"].lower(), _words(f["value"])[:2]
        if any(label in s and all(n in s for n in names) for s in sentences):
            out["facts"].append(f)
    for e in draft.get("education", []):
        if not _PLACEHOLDER.search(e["detail"]) and stated(e["detail"], 0.75):
            out["education"].append(e)
    return out


def draft_cv(conn: sqlite3.Connection, event_id: int, figure_id: str,
             note: str | None = None, examples: list[dict] | None = None) -> dict:
    """What the event's articles say about the figure, as CV entries."""
    fig = conn.execute("SELECT name FROM figures WHERE id = ?", (figure_id,)).fetchone()
    if fig is None:
        raise ValueError(f"unknown figure: {figure_id}")
    articles = conn.execute(
        "SELECT source, url, title, summary, body, published_at FROM articles "
        "WHERE event_id = ? ORDER BY published_at, id", (event_id,)).fetchall()
    if not articles:
        raise ValueError(f"event {event_id} has no articles")
    name = fig["name"]
    extra = f"\n\nCatatan kurator: {note.strip()}" if note and note.strip() else ""
    # The curator's past corrections of drafts like this (jejak/kurasi.py).
    for i, ex in enumerate(examples or [], 1):
        extra += (f"\n\n[Contoh koreksi kurator {i}, dokumen lain — pelajari, jangan salin]"
                  f"\nDraf model: {ex['wrong']}\nYang diterima kurator: {ex['right']}")
    raw = _chat_json([
        {"role": "system", "content": SYSTEM.format(name=name)},
        {"role": "user", "content": summarize._format_articles(articles)
         + "\n\n" + PROMPT.format(name=name, note=extra)},
    ])
    text = "\n".join(" ".join(x for x in (a["title"], a["summary"], a["body"]) if x) for a in articles)
    out = ground(_clean(raw), text)
    out["sources"] = [{"label": f"{a['source']}: {a['title']}", "url": a["url"]}
                      for a in articles if a["url"]][:3]
    return out
