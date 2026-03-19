import io
import json
import logging
import os
from datetime import datetime, timezone

import httpx
from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from ..database import AsyncSessionLocal
from ..models import Post
from ..schemas import SaveToBlocksRequest

router = APIRouter(prefix="/api/save", tags=["save"])
logger = logging.getLogger(__name__)

BLOCKS_URL = os.environ.get("BLOCKS_URL", "http://blocks.apps.svc.cluster.local")


def _post_url(handle: str, uri: str) -> str:
    rkey = uri.split("/")[-1]
    return f"https://bsky.app/profile/{handle}/post/{rkey}"


def _format_markdown(post: Post) -> str:
    profile_url = f"https://bsky.app/profile/{post.author_handle}"
    post_url = _post_url(post.author_handle, post.uri)
    ts = post.indexed_at.strftime("%Y-%m-%d %H:%M UTC")
    name = post.author_display_name or post.author_handle
    return (
        f"**[{name}]({profile_url})** — {ts}\n\n"
        f"{post.text}\n\n"
        f"[View on Bluesky]({post_url})"
    )


async def _find_or_create_page(client: httpx.AsyncClient, title: str) -> str:
    resp = await client.get(f"{BLOCKS_URL}/api/pages")
    resp.raise_for_status()
    pages = resp.json()
    for page in pages:
        if page.get("title") == title:
            return page["id"]

    resp = await client.post(f"{BLOCKS_URL}/api/pages", json={"title": title})
    resp.raise_for_status()
    return resp.json()["id"]


async def _create_block(client: httpx.AsyncClient, page_id: str, content: str) -> str:
    resp = await client.post(
        f"{BLOCKS_URL}/api/blocks",
        json={"page_id": page_id, "content": content, "type": "markdown"},
    )
    resp.raise_for_status()
    return resp.json()["id"]


def _extract_images(embed: dict) -> list[tuple[str, str]]:
    """Return (url, alt) pairs for all images in an embed, including nested ones."""
    if not embed:
        return []
    t = embed.get("type", "")
    if t == "images":
        return [(img["fullsize"] or img["thumb"], img.get("alt", ""))
                for img in embed.get("images", [])
                if img.get("fullsize") or img.get("thumb")]
    if t == "recordWithMedia":
        return _extract_images(embed.get("media") or {})
    if t == "quote":
        return _extract_images(embed.get("nested_embed") or {})
    return []


async def _upload_image(client: httpx.AsyncClient, block_id: str, image_url: str, alt: str):
    try:
        img_resp = await client.get(image_url, timeout=15)
        img_resp.raise_for_status()
        content_type = img_resp.headers.get("content-type", "image/jpeg")
        ext = content_type.split("/")[-1].split(";")[0]
        filename = f"image.{ext}"
        files = {
            "file": (filename, io.BytesIO(img_resp.content), content_type),
            "block_id": (None, block_id),
        }
        upload_resp = await client.post(f"{BLOCKS_URL}/api/attachments", files=files)
        upload_resp.raise_for_status()
    except Exception as exc:
        logger.warning("Failed to upload image: %s", exc)


@router.post("")
async def save_to_blocks(req: SaveToBlocksRequest):
    async with AsyncSessionLocal() as db:
        post = await db.get(Post, req.uri)

    if not post:
        raise HTTPException(404, "Post not found in local cache")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    page_title = f"Monkigras {today}"
    markdown = _format_markdown(post)

    async with httpx.AsyncClient(timeout=20) as client:
        page_id = await _find_or_create_page(client, page_title)
        block_id = await _create_block(client, page_id, markdown)

        # Upload image attachments if present
        if post.embeds_json:
            try:
                embed = json.loads(post.embeds_json)
                for image_url, alt in _extract_images(embed):
                    await _upload_image(client, block_id, image_url, alt)
            except (json.JSONDecodeError, KeyError):
                pass

    return {"ok": True, "page_id": page_id, "block_id": block_id}
