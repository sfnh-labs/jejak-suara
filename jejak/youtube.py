"""Minimal YouTube Data API v3 client (stdlib only).

Used by the sentiment stage to gather PUBLIC REACTION to an event — comments on
news videos about it. Chosen as the lower-cost channel: a free daily quota
(10,000 units), legitimate ToS, and comments that map naturally to news events.

Quota cost per call: search.list = 100 units, commentThreads.list = 1 unit.
So one event ≈ 100 + (a few) units — a few hundred events/day fit the free tier.

Requires a YOUTUBE_API_KEY environment variable.
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/youtube/v3"
TIMEOUT = 20


class YouTubeError(RuntimeError):
    pass


def _key() -> str:
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        raise YouTubeError("YOUTUBE_API_KEY not set")
    return key


def _get(endpoint: str, params: dict) -> dict:
    params = {**params, "key": _key()}
    url = f"{API}/{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise YouTubeError(f"HTTP {e.code} on {endpoint}") from e
    except Exception as e:
        raise YouTubeError(f"{type(e).__name__} on {endpoint}") from e


def search_videos(query: str, max_results: int = 5,
                  region: str = "ID", language: str = "id") -> list[str]:
    """Return video IDs matching the query (most relevant first)."""
    data = _get("search", {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": max_results,
        "relevanceLanguage": language,
        "regionCode": region,
        "order": "relevance",
    })
    return [item["id"]["videoId"] for item in data.get("items", [])
            if item.get("id", {}).get("videoId")]


def video_comments(video_id: str, max_results: int = 50) -> list[dict]:
    """Return top-level comments for a video with metadata.

    Each dict: {text, author_id, author_name, like_count, published_at}
    Returns [] if comments are disabled or the video is unavailable.
    """
    try:
        data = _get("commentThreads", {
            "part": "snippet",
            "videoId": video_id,
            "maxResults": min(max_results, 100),
            "order": "relevance",
            "textFormat": "plainText",
        })
    except YouTubeError:
        return []
    out = []
    for item in data.get("items", []):
        snip = item.get("snippet", {}).get("topLevelComment", {}).get("snippet", {})
        text = snip.get("textDisplay") or snip.get("textOriginal")
        if not text:
            continue
        out.append({
            "text": text,
            "author_id": snip.get("authorChannelId", {}).get("value", ""),
            "author_name": snip.get("authorDisplayName", ""),
            "like_count": snip.get("likeCount", 0),
            "published_at": snip.get("publishedAt", ""),
        })
    return out


def gather_comments(query: str, max_videos: int = 5,
                    per_video: int = 30, cap: int = 100) -> list[dict]:
    """Search for videos about `query` and collect up to `cap` comments total.

    Returns list of dicts with {text, author_id, author_name, like_count, published_at}.
    """
    comments: list[dict] = []
    for vid in search_videos(query, max_results=max_videos):
        comments.extend(video_comments(vid, max_results=per_video))
        if len(comments) >= cap:
            break
    return comments[:cap]
