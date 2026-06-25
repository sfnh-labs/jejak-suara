"""Stage 3 — Summarize an event, grounded in its sources.

This is the legally load-bearing stage. We do NOT let the model write in its own
voice from memory. Instead we hand it the actual articles as citable documents,
so every sentence it produces is tied back to a specific source.

Uses a local Ollama model with inline citation markers [Sumber N].

Settings:
  - OLLAMA_MODEL    (default: qwen2.5:7b)
  - OLLAMA_BASE_URL (default: http://localhost:11434)
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

SYSTEM = """You are an editorial assistant for a public accountability archive documenting public officials.
You write neutral, factual, NON-DEFAMATORY summaries of a single news event,
grounded ONLY in the provided source documents.

Hard rules:
- Report what outlets reported; do not assert anything as established fact in
  your own voice. Prefer "According to [outlet], ..." / "[Outlet] reported ...".
- Use ONLY information present in the documents. Never add context, motive, or
  conclusions from outside knowledge. If sources disagree, say so plainly.
- Neutral register. No characterisation, no adjectives of judgement, no
  speculation about intent or guilt.
- Write in Indonesian (Bahasa Indonesia), matching the sources.
- Format as bullet points (one bullet per key fact), each ending with [Sumber N].
  Keep the total short — 3-6 bullets. No introductory paragraph, no closing
  sentence — just the bullets.

You are drafting for a human editor who will review before anything is published."""


def _ollama_chat(messages: list[dict]) -> dict:
    """Call the Ollama chat API and return the parsed response body."""
    url = f"{OLLAMA_BASE_URL}/api/chat"
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": 1024},
    }).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"Ollama API error: {e.code} {e.reason}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(
            f"Ollama not reachable at {OLLAMA_BASE_URL}. "
            f"Is ollama serve running? ({e.reason})"
        ) from e


def _format_articles(articles: list[sqlite3.Row]) -> str:
    """Format articles as numbered text blocks for Ollama."""
    blocks = []
    for i, a in enumerate(articles, 1):
        body = a["title"]
        full = a["body"] if "body" in a.keys() else None
        if full:
            body += "\n\n" + full
        elif a["summary"]:
            body += "\n\n" + a["summary"]
        source = f"{a['source']} — {a['published_at'] or 'tanggal tidak diketahui'}"
        blocks.append(f"[Sumber {i}]: {source}\n\n{body}")
    return "\n\n---\n\n".join(blocks)


_OLLAMA_USER_PROMPT = (
    "Tuliskan ringkasan netral peristiwa di atas dalam format poin-poin "
    "(bullet points). Setiap poin harus satu fakta kunci dan diakhiri dengan "
    "tanda [Sumber 1], [Sumber 2], dan seterusnya. "
    "Jika hanya satu sumber yang melaporkannya, nyatakan bahwa peristiwa ini "
    "belum terkonfirmasi oleh media lain. "
    "Jangan gunakan paragraf pembuka atau penutup — langsung poin-poin saja."
)


def summarize_ollama(articles: list[sqlite3.Row]) -> tuple[str, list[dict]]:
    """Summarize via a local Ollama model with inline citation markers."""
    formatted = _format_articles(articles)
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"{formatted}\n\n{_OLLAMA_USER_PROMPT}"},
    ]
    result = _ollama_chat(messages)
    text = result.get("message", {}).get("content", "").strip()

    citations: list[dict] = []
    for m in re.finditer(r'\[Sumber (\d+)\]', text):
        idx = int(m.group(1)) - 1
        if 0 <= idx < len(articles):
            a = articles[idx]
            citations.append({
                "cited_text": m.group(0),
                "document_index": idx,
                "document_title": (
                    f"{a['source']} — {a['published_at'] or 'tanggal tidak diketahui'}"
                ),
            })

    return text, citations


def summarize_event(conn: sqlite3.Connection, event_id: int) -> dict:
    """Generate a grounded draft summary for one event and store it.

    Sets the event status to 'approved' (ready for the public timeline).
    Returns a small result dict for logging.
    """
    articles = conn.execute(
        "SELECT source, url, title, summary, body, published_at FROM articles "
        "WHERE event_id = ? ORDER BY published_at",
        (event_id,),
    ).fetchall()
    if not articles:
        raise ValueError(f"event {event_id} has no articles")

    outlets = {a["source"] for a in articles}
    corroboration = len(outlets)
    single_source = 1 if corroboration < 2 else 0

    summary_text, citations = summarize_ollama(articles)
    model_used = f"ollama/{OLLAMA_MODEL}"

    conn.execute(
        """INSERT INTO event_summaries
           (event_id, summary_text, citations_json, corroboration_count,
            single_source_flag, model, generated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id) DO UPDATE SET
             summary_text=excluded.summary_text,
             citations_json=excluded.citations_json,
             corroboration_count=excluded.corroboration_count,
             single_source_flag=excluded.single_source_flag,
             model=excluded.model,
             generated_at=excluded.generated_at""",
        (event_id, summary_text, json.dumps(citations, ensure_ascii=False),
         corroboration, single_source, model_used,
         datetime.now(timezone.utc).isoformat()),
    )
    conn.execute("UPDATE events SET status = 'approved' WHERE id = ?", (event_id,))
    conn.commit()

    return {
        "event_id": event_id,
        "outlets": sorted(outlets),
        "corroboration": corroboration,
        "single_source": bool(single_source),
        "citations": len(citations),
        "chars": len(summary_text),
        "model": model_used,
    }


def summarize_pending(conn: sqlite3.Connection, limit: int = 20) -> list[dict]:
    """Summarize all events still in 'new' status (up to `limit`)."""
    ids = [r["id"] for r in conn.execute(
        "SELECT id FROM events WHERE status = 'new' ORDER BY created_at LIMIT ?",
        (limit,),
    ).fetchall()]
    return [summarize_event(conn, eid) for eid in ids]
