"""Stage 5 — Public-reaction sentiment (lower-cost channel).

For an event, gather public comments from YouTube news videos and classify each
one's stance toward the figure/event. Classification uses a local Ollama model.

IMPORTANT framing: this measures *public reaction on one platform*, not truth and
not a verdict. It is brigadable and platform-skewed. Always surface it labelled
as "public reaction (YouTube)" with the sample size — never as judgement.
"""
from __future__ import annotations

import json
import os
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timezone

from . import reddit, youtube

CHANNEL = "social"

OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "qwen2.5:7b")
OLLAMA_BASE_URL = os.environ.get("OLLAMA_BASE_URL", "http://localhost:11434")

_SYSTEM = """You classify the stance of a single social-media comment toward the
public figure or event it discusses. Output exactly one label per comment:
- "negative": critical, disapproving, or hostile toward the figure/event
- "neutral": factual, off-topic, ambiguous, or no clear stance
- "positive": supportive, approving, or praising

Judge stance toward the figure/event only — not the comment's general mood.
Return labels in the SAME ORDER as the numbered comments."""

_SCORE = {"negative": -1.0, "neutral": 0.0, "positive": 1.0}


def _ollama_chat(messages: list[dict]) -> dict:
    """Call the Ollama chat API and return the parsed response."""
    url = f"{OLLAMA_BASE_URL}/api/chat"
    payload = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": False,
        "options": {"num_predict": 2048},
    }).encode()
    req = urllib.request.Request(
        url, data=payload, headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read())
    except urllib.error.URLError as e:
        raise RuntimeError(f"Ollama not reachable: {e.reason}") from e


_BATCH = int(os.environ.get("SENTIMENT_BATCH", "25"))


def classify_comments(comments: list[str]) -> list[str | None]:
    """Return a stance label per comment, aligned by position.

    An entry is None where the model's output could not be aligned to that
    comment; callers drop those rather than counting them as neutral.
    """
    labels: list[str | None] = []
    for i in range(0, len(comments), _BATCH):
        labels.extend(_classify_batch(comments[i:i + _BATCH]))
    return labels


def _classify_batch(batch: list[str]) -> list[str | None]:
    """Classify one batch, halving it when the model miscounts its output."""
    if not batch:
        return []
    numbered = "\n".join(f"{i+1}. {c}" for i, c in enumerate(batch))
    prompt = f"Classify these {len(batch)} comments:\n\n{numbered}"
    try:
        return list(_classify_ollama(batch, prompt))
    except ValueError:
        if len(batch) == 1:
            return [None]
        mid = len(batch) // 2
        return _classify_batch(batch[:mid]) + _classify_batch(batch[mid:])


def _classify_ollama(comments: list[str], prompt: str) -> list[str]:
    """Classify via local Ollama model — parse labels from free-text output."""
    messages = [
        {"role": "system", "content": _SYSTEM},
        {"role": "user", "content": prompt +
         "\n\nReturn one label per line, numbered (1. negative, 2. neutral, etc)."},
    ]
    result = _ollama_chat(messages)
    text = result.get("message", {}).get("content", "")

    labels: list[str] = []
    valid = {"negative", "neutral", "positive"}
    for line in text.splitlines():
        line = line.strip().lower()
        m = re.match(r"\d+[.)]\s*(\w+)", line)
        word = m.group(1) if m else line.split()[-1] if line else ""
        if word in valid:
            labels.append(word)

    if len(labels) != len(comments):
        # Padding a short response with "neutral" would report a full
        # sample_size built partly from labels the model never produced, and
        # bias the score toward zero. Refuse the batch instead.
        raise ValueError(
            f"model returned {len(labels)} labels for {len(comments)} comments"
        )
    return labels


_SAMPLE_PER_STANCE = 2     # how many example comments to keep per stance
_SAMPLE_MAX_LEN = 240      # truncate long comments for display


def _sample_comments(comments: list[str], labels: list[str]) -> list[dict]:
    """Pick a few example comments per stance, for display only."""
    picked: list[dict] = []
    for stance in ("negative", "neutral", "positive"):
        n = 0
        for text, label in zip(comments, labels):
            if label != stance:
                continue
            text = " ".join(text.split())
            if len(text) > _SAMPLE_MAX_LEN:
                text = text[:_SAMPLE_MAX_LEN].rstrip() + "…"
            picked.append({"text": text, "label": label})
            n += 1
            if n >= _SAMPLE_PER_STANCE:
                break
    return picked


def _aggregate(labels: list[str]) -> tuple[float, str, dict]:
    """Mean score in [-1,1], bucketed overall label, and a distribution."""
    dist = {"negative": 0, "neutral": 0, "positive": 0}
    for l in labels:
        dist[l] = dist.get(l, 0) + 1
    score = sum(_SCORE[l] for l in labels) / len(labels)
    label = "neutral"
    if score > 0.15:
        label = "positive"
    elif score < -0.15:
        label = "negative"
    return score, label, dist


_QUERY_STOPWORDS = {
    "dan", "di", "ke", "dari", "yang", "untuk", "dengan", "pada", "bahas",
    "soal", "hingga", "akan", "bakal", "buka", "suara", "kabar", "kemarin",
}
_QUERY_MAX_WORDS = 7


def _query_for_event(conn: sqlite3.Connection, event_id: int) -> str:
    row = conn.execute(
        "SELECT e.title, e.figure_id FROM events e WHERE e.id = ?", (event_id,)
    ).fetchone()
    if not row:
        raise ValueError(f"event {event_id} not found")

    from .config import load_figures
    fig = next((f for f in load_figures() if f.id == row["figure_id"]), None)
    name = fig.name if fig else ""

    title = row["title"] or ""
    title_l = title.lower()
    have_name = bool(fig) and any(term in title_l for term in fig.match_terms())

    keywords = [w for w in title.split() if w.lower() not in _QUERY_STOPWORDS]
    keywords = keywords[:_QUERY_MAX_WORDS]

    parts = ([name] if name and not have_name else []) + keywords
    return " ".join(parts).strip()


def _store_comments(conn: sqlite3.Connection, event_id: int,
                    comments: list[dict], labels: list[str]) -> None:
    """Store individual comments with their stance labels.

    Upserts on the platform's own comment id, so re-running sentiment refreshes
    like counts and stances in place instead of duplicating the event's
    comment history.
    """
    now = datetime.now(timezone.utc).isoformat()
    for cmt, label in zip(comments, labels):
        conn.execute(
            """INSERT INTO comments
               (event_id, comment_id, video_id, author_id, author_name, text,
                like_count, published_at, stance, collected_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(event_id, comment_id) DO UPDATE SET
                 like_count=excluded.like_count,
                 stance=excluded.stance,
                 collected_at=excluded.collected_at""",
            (event_id,
             cmt.get("comment_id", ""),
             cmt.get("video_id", ""),
             cmt.get("author_id", ""),
             cmt.get("author_name", ""),
             cmt.get("text", ""),
             cmt.get("like_count", 0),
             cmt.get("published_at", ""),
             label,
             now),
        )


def _run_sentiment(conn: sqlite3.Connection, event_id: int,
                   query: str, comments: list[dict],
                   channel: str) -> dict:
    """Classify, aggregate, store sentiment + individual comments."""
    if not comments:
        return {"event_id": event_id, "query": query, "sample_size": 0,
                "channel": channel, "note": "no comments gathered"}

    raw_labels = classify_comments([c["text"] for c in comments])

    # Drop anything the model could not label rather than counting it as
    # neutral, which would inflate sample_size and pull the score toward zero.
    pairs = [(c, l) for c, l in zip(comments, raw_labels) if l is not None]
    unclassified = len(comments) - len(pairs)
    if not pairs:
        return {"event_id": event_id, "query": query, "channel": channel,
                "sample_size": 0, "note": "no comments could be classified"}

    kept = [c for c, _ in pairs]
    labels = [l for _, l in pairs]
    score, label, dist = _aggregate(labels)
    samples = _sample_comments([c["text"] for c in kept], labels)

    conn.execute(
        """INSERT INTO sentiment
           (event_id, channel, score, label, sample_size, samples_json, collected_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(event_id, channel) DO UPDATE SET
             score=excluded.score,
             label=excluded.label,
             sample_size=excluded.sample_size,
             samples_json=excluded.samples_json,
             collected_at=excluded.collected_at""",
        (event_id, channel, score, label, len(labels),
         json.dumps(samples, ensure_ascii=False),
         datetime.now(timezone.utc).isoformat()),
    )

    _store_comments(conn, event_id, kept, labels)

    conn.commit()
    result = {"event_id": event_id, "query": query, "channel": channel,
              "sample_size": len(labels), "score": round(score, 3),
              "label": label, "distribution": dist, "samples": len(samples)}
    if unclassified:
        result["note"] = f"{unclassified} comment(s) could not be classified"
    return result


def sentiment_event(conn: sqlite3.Connection, event_id: int,
                    cap: int = 100) -> list[dict]:
    """Gather + classify public reaction for one event across channels.

    Runs YouTube (if YOUTUBE_API_KEY is set) and Reddit (always, best-effort).
    Each channel is stored as a separate row.
    Returns a list of result dicts (one per channel).
    """
    query = _query_for_event(conn, event_id)
    results: list[dict] = []

    try:
        yt_comments = youtube.gather_comments(query, cap=cap)
        results.append(_run_sentiment(
            conn, event_id, query, yt_comments, "youtube"))
    except Exception as e:
        results.append({"event_id": event_id, "query": query,
                        "channel": "youtube", "note": str(e)})

    try:
        reddit_comments = reddit.gather_comments(query, cap=cap)
        results.append(_run_sentiment(
            conn, event_id, query, reddit_comments, "reddit"))
    except Exception as e:
        results.append({"event_id": event_id, "query": query,
                        "channel": "reddit", "note": str(e)})

    return results


_FRESH_DAYS = int(os.environ.get("SENTIMENT_FRESH_DAYS", "3"))
# Deliberately longer than the 6-hour pipeline cron: at 6 hours every recent
# event was re-collected on literally every run, spending YouTube quota to
# re-classify comments that had barely changed.
_STALE_HOURS = int(os.environ.get("SENTIMENT_STALE_HOURS", "24"))


def sentiment_pending(conn: sqlite3.Connection, limit: int = 20) -> list[dict]:
    """Run sentiment for events that need it.

    Two categories:
    1. Approved events with no sentiment rows at all (brand-new).
    2. Approved events from the last N days whose last sentiment is stale
       (older than M hours), so we re-fetch fresh comments.
    """
    ids = [r["id"] for r in conn.execute(
        """SELECT e.id FROM events e
           WHERE e.status = 'approved'
             AND (
               NOT EXISTS (SELECT 1 FROM sentiment s WHERE s.event_id = e.id)
               OR (
                 e.event_date >= datetime('now', ? || ' days', 'start of day')
                 AND EXISTS (
                   SELECT 1 FROM sentiment s
                   WHERE s.event_id = e.id
                   GROUP BY s.event_id
                   HAVING max(s.collected_at) <= datetime('now', ? || ' hours')
                 )
               )
             )
           ORDER BY e.event_date DESC LIMIT ?""",
        (str(-_FRESH_DAYS), str(-_STALE_HOURS), limit),
    ).fetchall()]
    results: list[dict] = []
    for eid in ids:
        # No delete pass: sentiment and comments upsert on their natural keys,
        # so re-collection refreshes rows and adds newly-posted comments while
        # keeping the ones that have scrolled out of the platform's response.
        results.extend(sentiment_event(conn, eid))
    return results
