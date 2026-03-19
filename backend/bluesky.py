import json
import os
import httpx
from datetime import datetime
from typing import Any

SEARCH_URL = "https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts"
SESSION_URL = "https://bsky.social/xrpc/com.atproto.server.createSession"
BLUESKY_HANDLE = os.environ.get("BLUESKY_HANDLE", "")
BLUESKY_APP_PASSWORD = os.environ.get("BLUESKY_APP_PASSWORD", "")

_access_token: str | None = None


async def _get_token() -> str | None:
    global _access_token
    if _access_token:
        return _access_token
    if not BLUESKY_HANDLE or not BLUESKY_APP_PASSWORD:
        return None
    async with httpx.AsyncClient(timeout=15) as client:
        resp = await client.post(SESSION_URL, json={
            "identifier": BLUESKY_HANDLE,
            "password": BLUESKY_APP_PASSWORD,
        })
        resp.raise_for_status()
        _access_token = resp.json()["accessJwt"]
    return _access_token


def _parse_embed(embed: dict | None) -> dict | None:
    if not embed:
        return None
    t = embed.get("$type", "")
    if "images" in t:
        images = []
        for img in embed.get("images", []):
            images.append({
                "type": "image",
                "thumb": img.get("image", {}).get("ref", {}).get("$link"),
                "fullsize": img.get("image", {}).get("ref", {}).get("$link"),
                "alt": img.get("alt", ""),
                "mime": img.get("image", {}).get("mimeType"),
            })
        return {"type": "images", "images": images}
    if "external" in t:
        ext = embed.get("external", {})
        return {
            "type": "external",
            "uri": ext.get("uri"),
            "title": ext.get("title"),
            "description": ext.get("description"),
            "thumb": ext.get("thumb", {}).get("ref", {}).get("$link") if isinstance(ext.get("thumb"), dict) else None,
        }
    if "record" in t and "embed" not in t:
        rec = embed.get("record", {})
        return {
            "type": "quote",
            "uri": rec.get("uri"),
            "author_handle": rec.get("author", {}).get("handle"),
            "text": rec.get("value", {}).get("text", ""),
        }
    return {"type": "unknown", "raw": t}


def _parse_post_view(post_view: dict) -> dict | None:
    try:
        post = post_view.get("post", post_view)
        author = post.get("author", {})
        record = post.get("record", {})
        indexed_at_str = post.get("indexedAt") or record.get("createdAt", "")
        try:
            indexed_at = datetime.fromisoformat(indexed_at_str.replace("Z", "+00:00"))
        except Exception:
            indexed_at = datetime.utcnow()

        embed = _parse_embed(post.get("embed") or record.get("embed"))

        return {
            "uri": post["uri"],
            "author_handle": author.get("handle", ""),
            "author_display_name": author.get("displayName"),
            "author_avatar": author.get("avatar"),
            "text": record.get("text", ""),
            "embeds_json": json.dumps(embed) if embed else None,
            "like_count": post.get("likeCount", 0) or 0,
            "reply_count": post.get("replyCount", 0) or 0,
            "repost_count": post.get("repostCount", 0) or 0,
            "indexed_at": indexed_at,
        }
    except (KeyError, TypeError):
        return None


async def fetch_posts(cursor: str | None = None) -> tuple[list[dict], str | None]:
    global _access_token
    params: dict[str, Any] = {
        "q": "#monkigras",
        "sort": "latest",
        "limit": 100,
    }
    if cursor:
        params["cursor"] = cursor

    token = await _get_token()
    headers: dict[str, str] = {"User-Agent": "mgflow/1.0 (https://github.com/cb160/mgflow)"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    async with httpx.AsyncClient(timeout=20, headers=headers) as client:
        resp = await client.get(SEARCH_URL, params=params)
        if resp.status_code == 401 and token:
            # Token expired — refresh once
            _access_token = None
            token = await _get_token()
            if token:
                headers["Authorization"] = f"Bearer {token}"
            resp = await client.get(SEARCH_URL, params=params)
        resp.raise_for_status()
        data = resp.json()

    posts = []
    for item in data.get("posts", []):
        parsed = _parse_post_view({"post": item} if "uri" in item else item)
        if parsed:
            posts.append(parsed)

    return posts, data.get("cursor")
