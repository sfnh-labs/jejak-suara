"""Biographical facts in an article, drafted for a figure's CV.

Some coverage is not an act at all: an appointment, a new office, someone's
background. A curator marks it in /kurasi ("Jadikan info CV"), and the local
model reads the event's articles and lists only what they state about the
figure — offices, plain facts, education — for the curator to check, edit and
accept. Grounding is the same rule as summarize.py: nothing from memory.
"""
from __future__ import annotations

import json
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


def _chat_json(messages: list[dict]) -> dict:
    payload = json.dumps({
        "model": summarize.OLLAMA_MODEL, "messages": messages, "stream": False,
        "format": "json", "options": {"num_predict": 800, "temperature": 0},
    }).encode()
    req = urllib.request.Request(f"{summarize.OLLAMA_BASE_URL}/api/chat", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Ollama not reachable at {summarize.OLLAMA_BASE_URL}. "
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
    out = _clean(raw)
    out["sources"] = [{"label": f"{a['source']}: {a['title']}", "url": a["url"]}
                      for a in articles if a["url"]][:3]
    return out
