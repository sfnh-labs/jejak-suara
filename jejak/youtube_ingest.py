"""Ingest YouTube news video transcripts as article sources.

Searches YouTube for news videos mentioning tracked figures, fetches
auto-generated transcripts, and stores them as articles in the pipeline.
This adds TV/broadcast news coverage (Kompas TV, Metro TV, CNN Indonesia TV)
as a parallel source alongside RSS feeds.

Requires YOUTUBE_API_KEY (search only) — transcript fetching is free.
"""
from __future__ import annotations

import hashlib
import html
import os
import sqlite3
from datetime import datetime, timezone

from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import NoTranscriptFound

from .config import Figure, load_figures
from .ingest import _now
from .youtube import _get as yt_get, YouTubeError


# Indonesian news channels on YouTube we prioritise.
_NEWS_CHANNELS = {
    "kompastv": "Kompas TV",
    "metrotvnews": "Metro TV",
    "cnnindonesiaofficial": "CNN Indonesia TV",
    "tvOneNews": "tvOne",
    "inewsdotid": "iNews",
    "beritasatu": "Berita Satu",
}

_SEARCH_PARAMS = {
    "part": "snippet",
    "type": "video",
    "maxResults": 5,
    "relevanceLanguage": "id",
    "regionCode": "ID",
    "order": "date",
    "videoDuration": "medium",
}


def _search_videos(query: str) -> list[dict]:
    """Search YouTube for news videos matching query, return video metadata."""
    data = yt_get("search", {**_SEARCH_PARAMS, "q": query})
    videos = []
    for item in data.get("items", []):
        vid = item.get("id", {}).get("videoId")
        if not vid:
            continue
        snip = item.get("snippet", {})
        channel_id = snip.get("channelId", "")
        channel = _NEWS_CHANNELS.get(channel_id) or snip.get("channelTitle", "YouTube")
        videos.append({
            "id": vid,
            "title": snip.get("title", ""),
            "channel": channel,
            "published_at": snip.get("publishedAt", ""),
            "url": f"https://youtube.com/watch?v={vid}",
        })
    return videos


def _get_transcript(video_id: str) -> str | None:
    """Fetch the best available transcript for a video.

    Tries: manually uploaded Indonesian → auto-generated Indonesian → English.
    Returns concatenated text, or None if no transcript is found.
    """
    try:
        yt = YouTubeTranscriptApi()
        transcripts = yt.list(video_id)
    except Exception:
        return None

    # Prefer manually uploaded Indonesian, fall back to auto-generated.
    for lang in ("id", "en"):
        try:
            transcript = transcripts.find_transcript([lang])
            lines = transcript.fetch()
            return " ".join(html.unescape(l.text) for l in lines)
        except Exception:
            continue
    return None


def ingest_youtube(conn: sqlite3.Connection,
                   figures: list[Figure] | None = None,
                   days_back: int = 7) -> dict[str, int]:
    """Search for videos per figure, fetch transcripts, store as articles.

    Returns stats: {searched, transcribed, inserted, skipped_existing, errors}.
    """
    figures = figures or load_figures()
    stats = {"searched": 0, "transcribed": 0, "inserted": 0,
             "skipped_existing": 0, "errors": 0}

    for fig in figures:
        # Use the figure name only as the search query
        name = fig.name
        for vid in _search_videos(name):
            stats["searched"] += 1
            vid_id = f"yt-{vid['id']}"
            art_id = hashlib.sha256(vid_id.encode("utf-8")).hexdigest()

            exists = conn.execute(
                "SELECT 1 FROM articles WHERE id = ?", (art_id,)
            ).fetchone()
            if exists:
                stats["skipped_existing"] += 1
                continue

            transcript = _get_transcript(vid["id"])
            if not transcript:
                stats["errors"] += 1
                continue
            stats["transcribed"] += 1

            source = f"YouTube/{vid['channel']}"
            conn.execute(
                """INSERT INTO articles
                   (id, figure_id, source, url, title, summary, body,
                    published_at, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (art_id, fig.id, source, vid["url"], vid["title"],
                 None, transcript,
                 vid["published_at"], _now()),
            )
            stats["inserted"] += 1

    conn.commit()
    return stats
