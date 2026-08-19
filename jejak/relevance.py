"""Is a comment thread actually about the event? A collection-time gate.

The sentiment stage picks YouTube videos by searching an event's title and
date, takes what comes back, and until now never checked that the result was
about the event. When the event's own metadata was wrong the search still
returned *something*: event 6, "Menolak tuduhan kepemilikan saham FolaPlay",
collected 100 comments arguing about the free-meal programme, and they were
classified, stored, scored, and published as that event's public reaction —
with a buzzer anomaly percentage computed from them, next to a named official.

Word overlap does not catch this. A thread under "Massa HMI Tiba di Depan
Gedung DPR untuk Berdemonstrasi" talks about *mahasiswa*, a word the headline
never uses; a lexical test throws that thread away and keeps others that share
only common political vocabulary. So the gate uses the embedding model the
clusterer already loads, and compares the event's own text against the centroid
of the thread's comments. The centroid rather than the closest comment: the
question is what the thread is about on the whole, and a single stray
on-topic reply under an unrelated video should not admit the other twenty-nine.

THRESHOLD was read off the stored corpus rather than chosen. Over 272 (event,
video) pairs: the four videos of the FolaPlay event score 0.073-0.168, and
every hand-checked good thread scores 0.290 or better. 0.28 sits in that gap
and rejects 47 pairs, about 9% of collected comments.

It is a floor against gross mismatch, not a precision instrument. A video
merely adjacent to the story passes it, and the off-topic thread on event 8
scores 0.287 — close enough to the line to survive. Do not tighten it without
the corpus in front of you; the nearest good thread is three thousandths away.
"""
from __future__ import annotations

import os
import sqlite3

THRESHOLD = float(os.environ.get("RELEVANCE_THRESHOLD", "0.28"))

# Enough of a thread to characterise it. Embedding every comment of every
# candidate video is the expensive half of the gate and the centroid stops
# moving long before the fortieth comment.
MAX_SAMPLE = 40

# A centroid over one or two comments is just those comments, and scores
# accordingly wildly. Below this a thread is passed through unjudged: too
# little reaction to be worth rejecting, and too little to trust a rejection.
MIN_JUDGED = 3

# Articles carry the specifics a title leaves out — names, places, the actual
# claim — and that is what a comment thread can be matched against.
_MAX_ARTICLES = 4


def event_text(conn: sqlite3.Connection, event_id: int) -> str:
    """What the event is about, in the words of its own coverage."""
    row = conn.execute(
        "SELECT title FROM events WHERE id = ?", (event_id,)).fetchone()
    if not row:
        raise ValueError(f"event {event_id} not found")
    titles = [r["title"] for r in conn.execute(
        "SELECT title FROM articles WHERE event_id = ? LIMIT ?",
        (event_id, _MAX_ARTICLES))]
    return ". ".join([row["title"] or "", *titles]).strip()


def score_thread(event_vec, texts: list[str]) -> float:
    """Cosine between the event and the mean of the thread's comments."""
    import numpy as np

    from .embed import cosine_similarity, embed

    if not texts:
        return 0.0
    mat = np.array([embed(t) for t in texts[:MAX_SAMPLE]])
    centroid = mat.mean(axis=0)
    norm = float(np.linalg.norm(centroid))
    if norm == 0.0:
        return 0.0
    return cosine_similarity(event_vec, centroid / norm)


def filter_comments(conn: sqlite3.Connection, event_id: int,
                    comments: list[dict]) -> tuple[list[dict], list[dict]]:
    """Split comments into (on topic, rejected), one verdict per source thread.

    Grouped by `video_id`, which both channels populate — Reddit puts the post's
    id there. The thread is the unit that succeeds or fails: a search returns
    five videos and it is normal for some to be about the event and some not.

    Returns the kept comments in their original order, and a report of what was
    dropped: [{video_id, score, count}].
    """
    from .embed import embed

    if not comments:
        return [], []

    groups: dict[str, list[dict]] = {}
    for c in comments:
        groups.setdefault(c.get("video_id") or "", []).append(c)

    event_vec = embed(event_text(conn, event_id))
    verdicts: dict[str, float] = {}
    for vid, rows in groups.items():
        if len(rows) < MIN_JUDGED:
            verdicts[vid] = None
            continue
        verdicts[vid] = score_thread(event_vec, [r.get("text", "")
                                                 for r in rows])

    def passes(vid: str) -> bool:
        score = verdicts.get(vid)
        return score is None or score >= THRESHOLD

    kept = [c for c in comments if passes(c.get("video_id") or "")]
    dropped = [{"video_id": vid, "score": round(verdicts[vid], 3),
                "count": len(rows)}
               for vid, rows in groups.items() if not passes(vid)]
    return kept, dropped
