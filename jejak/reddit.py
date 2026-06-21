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
import urllib.parse
import urllib.request

TOKEN_URL = "https://www.reddit.com/api/v1/access_token"
API_URL = "https://oauth.reddit.com"
TIMEOUT = 20


class RedditError(RuntimeError):
    pass


def _get_client_id() -> str | None:
    return os.environ.get("REDDIT_CLIENT_ID")


def _token() -> str:
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
    return token


def _get(endpoint: str, params: dict | None = None) -> dict:
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


def post_comments(permalink: str, limit: int = 50) -> list[str]:
    """Return top-level comment texts for a Reddit post."""
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
        body = c.get("data", {}).get("body", "")
        if body and body not in ("[removed]", "[deleted]"):
            out.append(body)
    return out


def gather_comments(query: str, max_posts: int = 5,
                    per_post: int = 30, cap: int = 100) -> list[str]:
    """Search r/indonesia for posts about `query` and collect up to `cap` comments."""
    if not _get_client_id():
        return []
    try:
        posts = search_posts(query, limit=max_posts)
    except RedditError:
        return []
    comments: list[str] = []
    for post in posts:
        if len(comments) >= cap:
            break
        comments.extend(post_comments(post["permalink"], limit=per_post))
    return comments[:cap]
