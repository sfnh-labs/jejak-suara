"""Minimal YouTube Data API v3 client (stdlib only).

Used by the sentiment stage to gather PUBLIC REACTION to an event — comments on
news videos about it. Chosen as the lower-cost channel: a free daily quota
(10,000 units), legitimate ToS, and comments that map naturally to news events.

Quota cost per call: search.list = 100 units, videos.list and
commentThreads.list = 1 unit. One event costs 100-300 units (up to three
searches, see find_videos) — the free tier covers a few dozen events a day.

Requires a YOUTUBE_API_KEY environment variable.
"""
from __future__ import annotations

import json
import os
import urllib.error
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


# Set once YouTube answers 403 (the day's quota is spent, or the key is
# refused): every later call would fail the same way, so the rest of the
# stage stops asking instead of paying a failed round trip per event.
_refused = False


def _get(endpoint: str, params: dict) -> dict:
    global _refused
    if _refused:
        raise YouTubeError(f"quota spent or key refused (HTTP 403) - skipped {endpoint}")
    params = {**params, "key": _key()}
    url = f"{API}/{endpoint}?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 403:
            _refused = True
        raise YouTubeError(f"HTTP {e.code} on {endpoint}") from e
    except Exception as e:
        raise YouTubeError(f"{type(e).__name__} on {endpoint}") from e


def search_videos(query: str, max_results: int = 5,
                  region: str = "ID", language: str = "id",
                  published_after: str = "",
                  published_before: str = "") -> list[dict]:
    """Return {id, channel, title, description} for videos matching the query,
    most relevant first.

    The snippet rides along free: it is already in the search response this
    call pays 100 quota units for. The channel matters because a comment means
    little without knowing whose audience it came from — reaction under a
    partisan channel is not the same signal as reaction under a wire service —
    and the title and description let find_videos check the video is about
    the figure at all.

    `published_after`/`published_before` are RFC-3339 timestamps bounding when
    the video was uploaded. Unbounded, a search for an event's keywords ranks a
    years-old video about the same subject above this week's coverage of it,
    and its comments then get stored as reaction to something that had not
    happened when they were written.
    """
    params = {
        "part": "snippet",
        "q": query,
        "type": "video",
        "maxResults": max_results,
        "relevanceLanguage": language,
        "regionCode": region,
        "order": "relevance",
    }
    if published_after:
        params["publishedAfter"] = published_after
    if published_before:
        params["publishedBefore"] = published_before
    data = _get("search", params)
    out = []
    for item in data.get("items", []):
        vid = item.get("id", {}).get("videoId")
        if vid:
            snip = item.get("snippet", {})
            out.append({
                "id": vid,
                "channel": snip.get("channelTitle", ""),
                "title": snip.get("title", ""),
                "description": snip.get("description", ""),
            })
    return out


def video_views(ids: list[str]) -> dict[str, int]:
    """View count per video id: one videos.list call (1 unit) for up to 50 ids."""
    if not ids:
        return {}
    data = _get("videos", {"part": "statistics", "id": ",".join(ids[:50])})
    return {item["id"]: int(item.get("statistics", {}).get("viewCount", 0) or 0)
            for item in data.get("items", []) if item.get("id")}


# How many of a search's results find_videos considers, in YouTube's relevance
# order, before picking the most viewed. A search costs 100 units whatever
# maxResults is, so asking for more candidates is free.
CANDIDATES = 15
MOST_RELEVANT = 10
MAX_SEARCHES = 3


def _names_figure(video: dict, names: list[str]) -> bool:
    text = f"{video.get('title', '')} {video.get('description', '')}".lower()
    return any(n in text for n in names)


def find_videos(queries: list[str], names: list[str] = (), max_videos: int = 5,
                published_after: str = "",
                published_before: str = "") -> tuple[list[dict], str]:
    """The most viewed of the most relevant videos for the first query that finds any.

    Queries go from specific to broad: YouTube matches nearly every word of a
    query, so a long one finds nothing ("Airlangga Hartarto Menyatakan alasan
    penurunan anggaran Program Satu Orang": 0 videos; "Airlangga Hartarto
    anggaran": 912), and a few names find nothing on their own ("Eddy
    Soeparno": 0, "Eddy Soeparno MPR": 4,288). At most MAX_SEARCHES are tried.

    Of a search's results, only videos whose title or description contains
    one of `names` count — a search ranks a drama clip that shares one word
    with the query above nothing. The MOST_RELEVANT left, in YouTube's order,
    are then ranked by views and the top `max_videos` returned: the coverage
    most people watched is where most of the reaction is.

    Returns (videos, the query that found them); ([], "") if none did.
    """
    names = [n.lower() for n in names if n]
    for query in queries[:MAX_SEARCHES]:
        found = search_videos(query, max_results=CANDIDATES,
                              published_after=published_after,
                              published_before=published_before)
        if names:
            found = [v for v in found if _names_figure(v, names)]
        found = found[:MOST_RELEVANT]
        if not found:
            continue
        views = video_views([v["id"] for v in found])
        for v in found:
            v["views"] = views.get(v["id"], 0)
        found.sort(key=lambda v: v["views"], reverse=True)
        return found[:max_videos], query
    return [], ""


def video_comments(video_id: str, max_results: int = 50,
                   channel: str = "") -> list[dict]:
    """Return top-level comments for a video with metadata.

    Each dict: {comment_id, video_id, channel, text, author_id, author_name,
    like_count, published_at}. `comment_id` is stable across collections, so
    re-running sentiment updates existing rows instead of duplicating them.
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
        top = item.get("snippet", {}).get("topLevelComment", {})
        snip = top.get("snippet", {})
        text = snip.get("textDisplay") or snip.get("textOriginal")
        if not text:
            continue
        out.append({
            "comment_id": top.get("id") or item.get("id", ""),
            "video_id": video_id,
            "channel": channel,
            "text": text,
            "author_id": snip.get("authorChannelId", {}).get("value", ""),
            "author_name": snip.get("authorDisplayName", ""),
            "like_count": snip.get("likeCount", 0),
            "published_at": snip.get("publishedAt", ""),
        })
    return out


def gather_comments(queries: str | list[str], names: list[str] = (),
                    max_videos: int = 5, per_video: int = 30, cap: int = 100,
                    published_after: str = "",
                    published_before: str = "") -> list[dict]:
    """Collect up to `cap` comments from the videos find_videos picks.

    Each comment dict: {comment_id, video_id, channel, text, author_id,
    author_name, like_count, published_at, query}, `query` being the search
    that found its video.
    """
    if isinstance(queries, str):
        queries = [queries]
    videos, query = find_videos(queries, names, max_videos=max_videos,
                                published_after=published_after,
                                published_before=published_before)
    comments: list[dict] = []
    for vid in videos:
        for c in video_comments(vid["id"], max_results=per_video,
                                channel=vid["channel"]):
            c["query"] = query
            comments.append(c)
        if len(comments) >= cap:
            break
    return comments[:cap]
