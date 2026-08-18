"""Minimal Reddit API client for r/indonesia comments (stdlib only).

Requires a Reddit app (free, created at https://www.reddit.com/prefs/apps).
Set these env vars:
  - REDDIT_CLIENT_ID     (required — the string under "personal use script")
  - REDDIT_CLIENT_SECRET (required)
  - REDDIT_USER_AGENT    (optional, defaults to a sensible value)

Rate limit: 60 requests per minute for OAuth apps.
"""
from __future__ import annotations

import base64
import json
import os
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API_URL = "https://oauth.reddit.com"
TIMEOUT = 20


class RedditError(RuntimeError):
    pass


def _get_client_id() -> str | None:
    return os.environ.get("REDDIT_CLIENT_ID")


# Cached bearer token: (token, expiry timestamp). Reddit allows 60 requests per
# minute and a token lasts ~24h, so minting one per request halved the budget
# for no reason.
_TOKEN_CACHE: tuple[str, float] | None = None
_TOKEN_SKEW = 60.0  # renew this many seconds before actual expiry


def _token() -> str:
    global _TOKEN_CACHE
    if _TOKEN_CACHE is not None:
        token, expires_at = _TOKEN_CACHE
        if time.time() < expires_at:
            return token

    cid = _get_client_id()
    secret = os.environ.get("REDDIT_CLIENT_SECRET")
    if not cid or not secret:
        raise RedditError(
            "REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET not set. "
            "Create an app at https://www.reddit.com/prefs/apps"
        )
    ua = os.environ.get("REDDIT_USER_AGENT",
                        "jejak-suara/0.1 (sentiment research)")
    # Basic auth: base64(client_id:client_secret)
    auth = base64.b64encode(f"{cid}:{secret}".encode()).decode()
    payload = urllib.parse.urlencode({"grant_type": "client_credentials"}).encode()
    req = urllib.request.Request(
        TOKEN_URL, data=payload,
        headers={
            "Authorization": f"Basic {auth}",
            "User-Agent": ua,
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            data = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise RedditError(f"Reddit auth failed: HTTP {e.code}") from e
    except urllib.error.URLError as e:
        raise RedditError(f"Reddit unreachable: {e.reason}") from e

    token = data.get("access_token")
    if not token:
        raise RedditError("Reddit auth returned no access_token")
    ttl = float(data.get("expires_in", 3600))
    _TOKEN_CACHE = (token, time.time() + max(ttl - _TOKEN_SKEW, 0.0))
    return token


def _get(endpoint: str, params: dict | None = None) -> dict | list:
    """GET an API endpoint. Listing endpoints return a JSON array, not an object."""
    token = _token()
    ua = os.environ.get("REDDIT_USER_AGENT",
                        "jejak-suara/0.1 (sentiment research)")
    url = f"{API_URL}{endpoint}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "User-Agent": ua,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RedditError(f"Reddit HTTP {e.code} on {endpoint}") from e
    except urllib.error.URLError as e:
        raise RedditError(f"Reddit unreachable: {e.reason}") from e


def search_posts(query: str, subreddit: str = "indonesia",
                 limit: int = 5) -> list[dict]:
    """Search r/indonesia for posts matching the query."""
    data = _get(f"/r/{subreddit}/search", {
        "q": query,
        "restrict_sr": "on",
        "sort": "comments",
        "limit": limit,
        "raw_json": "1",
    })
    if not isinstance(data, dict):
        return []
    posts = []
    for item in data.get("data", {}).get("children", []):
        d = item.get("data", {})
        if d.get("num_comments", 0) > 0:
            posts.append({
                "id": d["id"],
                "title": d.get("title", ""),
                "url": d.get("url", ""),
                "num_comments": d.get("num_comments", 0),
                "permalink": d.get("permalink", ""),
            })
    return posts


def post_comments(permalink: str, limit: int = 50) -> list[dict]:
    """Return top-level comments for a Reddit post.

    Shape matches `youtube.video_comments` — the sentiment stage consumes both
    channels through the same code path.
    """
    # permalink looks like /r/indonesia/comments/abc123/title/
    data = _get(f"{permalink.rstrip('/')}", {
        "limit": limit,
        "raw_json": "1",
    })
    if not isinstance(data, list) or len(data) < 2:
        return []
    comments = data[1].get("data", {}).get("children", [])
    out = []
    for c in comments:
        if c.get("kind") not in ("t1",):
            continue
        d = c.get("data", {})
        body = d.get("body", "")
        if not body or body in ("[removed]", "[deleted]"):
            continue
        created = d.get("created_utc")
        out.append({
            "comment_id": d.get("id", ""),
            "video_id": d.get("link_id", ""),
            # The subreddit is this platform's answer to "whose audience is
            # this", so it fills the same display slot as a YouTube channel.
            "channel": f"r/{d['subreddit']}" if d.get("subreddit") else "",
            "text": body,
            "author_id": d.get("author_fullname", ""),
            "author_name": d.get("author", ""),
            "like_count": d.get("ups", 0),
            "published_at": (
                datetime.fromtimestamp(created, tz=timezone.utc).isoformat()
                if created else ""
            ),
        })
    return out


def gather_comments(query: str, max_posts: int = 5,
                    per_post: int = 30, cap: int = 100) -> list[dict]:
    """Search r/indonesia for posts about `query` and collect up to `cap` comments."""
    if not _get_client_id():
        return []
    try:
        posts = search_posts(query, limit=max_posts)
    except RedditError:
        return []
    comments: list[dict] = []
    for post in posts:
        if len(comments) >= cap:
            break
        try:
            comments.extend(post_comments(post["permalink"], limit=per_post))
        except RedditError:
            continue
    return comments[:cap]
