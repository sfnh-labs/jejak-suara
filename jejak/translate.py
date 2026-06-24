"""Translate non-Indonesian article bodies to Indonesian.

Only articles from international (non-Indonesian) sources are processed —
domestic Indonesian outlets already publish in Bahasa Indonesia.

A separate pipeline stage (run after fetch) that detects the language of each
article body and, if not Indonesian, translates it via Ollama.

The original text is preserved in `body_original` so the UI can offer a toggle.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")
TRANSLATE_BATCH = int(os.environ.get("TRANSLATE_BATCH", "5"))

# Only translate articles from sources NOT in this list.
# Domestic Indonesian outlets already publish in Bahasa Indonesia.
_DOMESTIC_SOURCES = {
    "Antara", "Kompas", "Tempo", "CNN Indonesia", "Detik",
    "Republika", "Kompas TV", "Metro TV", "CNN Indonesia TV",
    "tvOne", "iNews", "Berita Satu",
}

_TRANSLATE_PROMPT = """You are a professional translator. Translate the following news article text to Indonesian (Bahasa Indonesia).

Rules:
- Translate faithfully; do not add, omit, or editorialise.
- Preserve all names, dates, numbers, and quotes exactly as-is.
- Maintain the original paragraph structure.
- Return ONLY the translated text, with no preamble, no explanation, no notes.

Text to translate:
---BEGIN ARTICLE---
{text}
---END ARTICLE---"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ollama_complete(prompt: str) -> str | None:
    """Call Ollama completion endpoint, return response text or None."""
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": False,
        "options": {"temperature": 0.0, "num_predict": 4096},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{OLLAMA_BASE_URL}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read().decode("utf-8")
            data = json.loads(body)
            return data.get("response", "").strip()
    except Exception as exc:
        logger.warning("Ollama translation call failed: %s", exc)
        return None


def _detect_with_ollama(text: str) -> str | None:
    """Use Ollama to detect the language of a text snippet."""
    snippet = text[:500].strip()
    prompt = (
        "Identify the language of the following text. "
        "Return ONLY the ISO 639-1 two-letter language code (e.g. 'en', 'id', 'ar', 'zh'). "
        "If unsure, return 'id'.\n\nText:\n" + snippet
    )
    result = _ollama_complete(prompt)
    if result:
        return result.strip().lower()[:2]
    return None


def detect_lang(text: str) -> str:
    """Detect language of text. Returns ISO 639-1 code (default 'id' on failure)."""
    if not text or len(text.strip()) < 20:
        return "id"
    try:
        from langdetect import detect
        try:
            lang = detect(text)
            return lang if isinstance(lang, str) else "id"
        except Exception:
            pass
    except ImportError:
        logger.info("langdetect not installed, falling back to Ollama detection")
    result = _detect_with_ollama(text)
    return result if result else "id"


def translate_to_id(text: str) -> str | None:
    """Translate text to Indonesian using Ollama. Returns translated text or None."""
    if not text or len(text.strip()) < 20:
        return text
    prompt = _TRANSLATE_PROMPT.format(text=text)
    result = _ollama_complete(prompt)
    if result and len(result) > 20:
        return result
    return None


def translate_articles(conn: sqlite3.Connection, limit: int = TRANSLATE_BATCH) -> dict[str, int]:
    """Translate non-ID article bodies from international sources.

    Only processes articles from sources NOT in _DOMESTIC_SOURCES (e.g. Al Jazeera,
    BBC, The Guardian) where body_original IS NULL and body is not NULL.

    Returns counts: {checked, already_id, translated, skipped, errors}.
    """
    stats = {"checked": 0, "already_id": 0, "translated": 0, "skipped": 0, "errors": 0}

    placeholders = ",".join("?" for _ in _DOMESTIC_SOURCES)
    rows = conn.execute(
        f"""SELECT id, body, source FROM articles
           WHERE body IS NOT NULL AND body_original IS NULL
             AND source NOT IN ({placeholders})
           LIMIT ?""",
        (*_DOMESTIC_SOURCES, limit),
    ).fetchall()

    for art in rows:
        stats["checked"] += 1
        art_id, body, source = art["id"], art["body"], art["source"]

        lang = detect_lang(body)
        if lang == "id":
            conn.execute(
                "UPDATE articles SET body_lang = ?, body_original = '' WHERE id = ?",
                (lang, art_id),
            )
            stats["already_id"] += 1
            continue

        logger.info("Translating %s article %s (detected: %s)…", source, art_id[:12], lang)
        translated = translate_to_id(body)
        if translated:
            conn.execute(
                """UPDATE articles
                   SET body_original = ?, body = ?, body_lang = ?
                   WHERE id = ?""",
                (body, translated, lang, art_id),
            )
            stats["translated"] += 1
        else:
            conn.execute(
                "UPDATE articles SET body_lang = ? WHERE id = ?",
                (lang, art_id),
            )
            stats["errors"] += 1

    conn.commit()
    return stats
