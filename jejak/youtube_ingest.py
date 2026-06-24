"""Ingest YouTube news video transcripts as article sources.

Searches YouTube for news videos mentioning tracked figures, fetches
auto-generated transcripts, and stores them as articles in the pipeline.
This adds TV/broadcast news coverage (Kompas TV, Metro TV, CNN Indonesia TV)
as a parallel source alongside RSS feeds.

Supports both Indonesian and international news channels. International
transcripts are later auto-translated to Indonesian by the translate stage.

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

# International news channels known to cover Indonesian topics.
# Maps channel title (case-insensitive substring) to standardised source name.
_INTL_CHANNELS = {
    "al jazeera": "Al Jazeera",
    "bloomberg": "Bloomberg",
    "bbc news": "BBC News",
    "reuters": "Reuters",
    "associated press": "Associated Press",
    "channel newsasia": "Channel NewsAsia",
    "cna": "Channel NewsAsia",
    "south china morning post": "South China Morning Post",
    "dw news": "DW News",
    "france 24": "France 24",
    "abc news": "ABC News",
    "nikkei asia": "Nikkei Asia",
    "guardian news": "The Guardian",
}

_ID_SEARCH_PARAMS = {
    "part": "snippet",
    "type": "video",
    "maxResults": 5,
    "relevanceLanguage": "id",
    "regionCode": "ID",
    "order": "date",
    "videoDuration": "medium",
}

_INTL_SEARCH_PARAMS = {
    "part": "snippet",
    "type": "video",
    "maxResults": 5,
    "order": "date",
    "videoDuration": "medium",
}


def _match_intl_channel(channel_title: str) -> str | None:
    """Return standardised source name if channel_title matches an international outlet."""
    low = channel_title.lower()
    for key, name in _INTL_CHANNELS.items():
        if key in low:
            return name
    return None


def _search_videos(query: str, params: dict) -> list[dict]:
    """Search YouTube for videos matching query with given params, return video metadata."""
    data = yt_get("search", {**params, "q": query})
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


def _search_intl_videos(query: str) -> list[dict]:
    """Search for videos on international news channels covering the query."""
    data = yt_get("search", {**_INTL_SEARCH_PARAMS, "q": query})
    videos = []
    for item in data.get("items", []):
        vid = item.get("id", {}).get("videoId")
        if not vid:
            continue
        snip = item.get("snippet", {})
        channel_title = snip.get("channelTitle", "")
        std_name = _match_intl_channel(channel_title)
        if not std_name:
            continue  # only keep known international news channels
        videos.append({
            "id": vid,
            "title": snip.get("title", ""),
            "channel": std_name,
            "published_at": snip.get("publishedAt", ""),
            "url": f"https://youtube.com/watch?v={vid}",
        })
    return videos


def _get_transcript(video_id: str, prefer_id: bool = True) -> str | None:
    """Fetch the best available transcript for a video.

    When prefer_id is True (domestic channels), tries Indonesian then English.
    When False (international channels), tries English then Indonesian.
    Returns concatenated text, or None if no transcript is found.
    """
    try:
        yt = YouTubeTranscriptApi()
        transcripts = yt.list(video_id)
    except Exception:
        return None

    langs = ("id", "en") if prefer_id else ("en", "id")
    for lang in langs:
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

    Searches both Indonesian and international news channels.
    International transcripts will be auto-translated by the translate stage.

    Returns stats: {searched, transcribed, inserted, skipped_existing, errors}.
    """
    figures = figures or load_figures()
    stats = {"searched": 0, "transcribed": 0, "inserted": 0,
             "skipped_existing": 0, "errors": 0}

    for fig in figures:
        name = fig.name

        # 1. Domestic Indonesian channels (language/region restricted)
        for vid in _search_videos(name, _ID_SEARCH_PARAMS):
            _store_video(conn, vid, fig, stats, international=False)

        # 2. International news channels (no language restriction)
        for vid in _search_intl_videos(name):
            _store_video(conn, vid, fig, stats, international=True)

    conn.commit()
    return stats


def _store_video(conn: sqlite3.Connection, vid: dict, fig: Figure,
                 stats: dict, international: bool = False) -> None:
    """Store a single YouTube video as an article, updating stats in-place."""
    stats["searched"] += 1
    vid_id = f"yt-{vid['id']}"
    art_id = hashlib.sha256(vid_id.encode("utf-8")).hexdigest()

    exists = conn.execute(
        "SELECT 1 FROM articles WHERE id = ?", (art_id,)
    ).fetchone()
    if exists:
        stats["skipped_existing"] += 1
        return

    transcript = _get_transcript(vid["id"], prefer_id=not international)
    if not transcript:
        stats["errors"] += 1
        return
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
