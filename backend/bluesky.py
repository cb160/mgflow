import asyncio
import json
import os
import httpx
from datetime import datetime, timezone
from typing import Any

CONFERENCE_START = datetime(2026, 3, 19, 0, 0, 0, tzinfo=timezone.utc)

SEARCH_URL = "https://bsky.social/xrpc/app.bsky.feed.searchPosts"
SESSION_URL = "https://bsky.social/xrpc/com.atproto.server.createSession"
_raw_handle = os.environ.get("BSKY_HANDLE", "")
BLUESKY_HANDLE = _raw_handle if "." in _raw_handle else f"{_raw_handle}.bsky.social"
BLUESKY_APP_PASSWORD = os.environ.get("BSKY_APP_PASSWORD", "")

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
            # view format has thumb/fullsize as full URLs; record format has image.ref.$link
            thumb = img.get("thumb") or img.get("image", {}).get("ref", {}).get("$link")
            fullsize = img.get("fullsize") or thumb
            images.append({
                "type": "image",
                "thumb": thumb,
                "fullsize": fullsize,
                "alt": img.get("alt", ""),
            })
        return {"type": "images", "images": images}
    if "external" in t:
        ext = embed.get("external", {})
        raw_thumb = ext.get("thumb")
        # view: thumb is a URL string; record: thumb is a blob dict
        thumb = raw_thumb if isinstance(raw_thumb, str) else (
            raw_thumb.get("ref", {}).get("$link") if isinstance(raw_thumb, dict) else None
        )
        return {
            "type": "external",
            "uri": ext.get("uri"),
            "title": ext.get("title"),
            "description": ext.get("description"),
            "thumb": thumb,
        }
    if "recordWithMedia" in t:
        media = _parse_embed(embed.get("media"))
        rec = embed.get("record", {}).get("record", {})
        return {
            "type": "recordWithMedia",
            "media": media,
            "quote": {
                "uri": rec.get("uri"),
                "author_handle": rec.get("author", {}).get("handle"),
                "author_display_name": rec.get("author", {}).get("displayName"),
                "text": rec.get("value", {}).get("text", ""),
            },
        }
    if "record" in t:
        rec = embed.get("record", {})
        # Extract any images nested inside the quoted post's embeds[]
        nested_embed = None
        for ne in rec.get("embeds", []):
            parsed = _parse_embed(ne)
            if parsed and parsed.get("type") in ("images", "external"):
                nested_embed = parsed
                break
        return {
            "type": "quote",
            "uri": rec.get("uri"),
            "author_handle": rec.get("author", {}).get("handle"),
            "author_display_name": rec.get("author", {}).get("displayName"),
            "text": rec.get("value", {}).get("text", ""),
            "nested_embed": nested_embed,
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


async def fetch_all_since(since_dt: datetime) -> list[dict]:
    """Paginate through all #monkigras posts back to since_dt."""
    import logging
    logger = logging.getLogger(__name__)
    all_posts: list[dict] = []
    cursor: str | None = None
    since_str = since_dt.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    page = 0

    while True:
        try:
            posts, cursor = await fetch_posts(cursor=cursor)
        except Exception as exc:
            logger.warning("fetch_all_since error on page %d: %s", page, exc)
            break

        if not posts:
            break

        stop = False
        for p in posts:
            # Normalise both to naive UTC for comparison
            post_dt = p["indexed_at"].replace(tzinfo=None) if p["indexed_at"].tzinfo else p["indexed_at"]
            since_naive = since_dt.replace(tzinfo=None)
            if post_dt < since_naive:
                stop = True
                break
            all_posts.append(p)

        if stop:
            break

        page += 1
        logger.info("fetch_all_since page %d: %d posts total so far", page, len(all_posts))

        if not cursor:
            break
        await asyncio.sleep(0.5)  # be polite to the API

    return all_posts
