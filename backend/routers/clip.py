import asyncio
import io
import logging
import os
import tempfile
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/clip", tags=["clip"])
logger = logging.getLogger(__name__)

BLOCKS_URL = os.environ.get("BLOCKS_URL", "http://blocks.apps.svc.cluster.local")
DEFAULT_VIDEO_ID = "jdI7MZfMEFc"


class ClipRequest(BaseModel):
    note: str
    session_context: Optional[str] = ""
    video_time: Optional[int] = None
    video_id: Optional[str] = None


async def _find_or_create_page(client: httpx.AsyncClient, title: str) -> str:
    resp = await client.get(f"{BLOCKS_URL}/api/pages")
    resp.raise_for_status()
    for page in resp.json():
        if page.get("title") == title:
            return page["id"]
    resp = await client.post(f"{BLOCKS_URL}/api/pages", json={"title": title})
    resp.raise_for_status()
    return resp.json()["id"]


def _fmt_time(seconds: int) -> str:
    h, r = divmod(seconds, 3600)
    m, s = divmod(r, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def _last_in_list(blocks: list[dict], parent_id: Optional[str]) -> Optional[dict]:
    """Return the last block in a linked-list of siblings with the given parent_id.

    Blocks form a singly-linked list via predecessor_id.  The 'last' block is
    the one whose id does not appear as any other sibling's predecessor_id.
    """
    siblings = [b for b in blocks if b.get("parent_id") == parent_id]
    if not siblings:
        return None
    predecessor_ids = {b.get("predecessor_id") for b in siblings}
    for b in siblings:
        if b["id"] not in predecessor_ids:
            return b
    return siblings[-1]  # fallback (shouldn't happen)


async def _get_page_blocks(client: httpx.AsyncClient, page_id: str) -> list[dict]:
    resp = await client.get(f"{BLOCKS_URL}/api/blocks/page/{page_id}")
    resp.raise_for_status()
    return resp.json()


async def _find_or_create_session_block(
    client: httpx.AsyncClient,
    page_id: str,
    session_context: str,
    blocks: list[dict],
) -> str:
    """Return the id of the top-level session block, creating it if needed.

    The session block lives at the top level of the page (parent_id = null).
    If an identical block already exists it is reused; otherwise a new one is
    appended after the current last top-level block.
    """
    needle = session_context.strip()
    for b in blocks:
        if b.get("parent_id") is None and b.get("content", "").strip() == needle:
            return b["id"]

    last_top = _last_in_list(blocks, parent_id=None)
    resp = await client.post(
        f"{BLOCKS_URL}/api/blocks",
        json={
            "page_id": page_id,
            "parent_id": None,
            "predecessor_id": last_top["id"] if last_top else None,
            "content": session_context.strip(),
        },
    )
    resp.raise_for_status()
    return resp.json()["id"]


async def _capture_frame(video_id: str, timestamp: int) -> Optional[bytes]:
    """Extract a video frame at timestamp (seconds) using yt-dlp + ffmpeg."""
    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        proc = await asyncio.create_subprocess_exec(
            "yt-dlp", "-f", "best[height<=480]/best", "-g", url,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await asyncio.wait_for(proc.communicate(), timeout=20)
        if proc.returncode != 0:
            return None
        stream_url = stdout.decode().strip().split("\n")[0]

        with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
            tmp_path = f.name
        try:
            # Try seeking to the exact timestamp first (works for VODs)
            for ffmpeg_args in (
                ["-ss", str(timestamp), "-i", stream_url],  # seekable VOD
                ["-i", stream_url],                          # live stream: current frame
            ):
                proc2 = await asyncio.create_subprocess_exec(
                    "ffmpeg", "-y", *ffmpeg_args,
                    "-frames:v", "1", "-q:v", "2", tmp_path,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                await asyncio.wait_for(proc2.communicate(), timeout=30)
                if proc2.returncode == 0:
                    with open(tmp_path, "rb") as f:
                        return f.read()
                logger.debug("ffmpeg seek attempt failed (rc=%d), retrying without seek", proc2.returncode)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    except Exception as exc:
        logger.warning("Frame capture failed: %s", exc)
    return None


@router.post("")
async def create_clip(req: ClipRequest):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    page_title = f"Monkigras {today}"
    vid = req.video_id or DEFAULT_VIDEO_ID

    # Build clip note markdown (no session prefix — that's now the parent block)
    parts = [req.note]
    if req.video_time is not None:
        stream_url = f"https://www.youtube.com/watch?v={vid}&t={req.video_time}s"
        parts.append(f"⏱ [{_fmt_time(req.video_time)}]({stream_url})")
    markdown = "\n\n".join(parts)

    async with httpx.AsyncClient(timeout=20) as client:
        page_id = await _find_or_create_page(client, page_title)
        blocks = await _get_page_blocks(client, page_id)

        if req.session_context and req.session_context.strip():
            # Ensure a top-level session block exists, then clip goes under it
            session_block_id = await _find_or_create_session_block(
                client, page_id, req.session_context, blocks
            )
            # Re-fetch so we can find the last child of the (possibly new) session block
            blocks = await _get_page_blocks(client, page_id)
            parent_id: Optional[str] = session_block_id
        else:
            # No session → clip is a top-level block
            parent_id = None

        last_sibling = _last_in_list(blocks, parent_id=parent_id)

        resp = await client.post(
            f"{BLOCKS_URL}/api/blocks",
            json={
                "page_id": page_id,
                "parent_id": parent_id,
                "predecessor_id": last_sibling["id"] if last_sibling else None,
                "content": markdown,
            },
        )
        resp.raise_for_status()
        block_id = resp.json()["id"]

        # Capture frame at timestamp, upload as attachment, embed in block content
        try:
            img_bytes: Optional[bytes] = None
            if req.video_time is not None:
                img_bytes = await _capture_frame(vid, req.video_time)
            if img_bytes is None:
                # Fallback: static YouTube thumbnail
                fallback_url = f"https://img.youtube.com/vi/{vid}/maxresdefault.jpg"
                fb = await client.get(fallback_url, timeout=10)
                if fb.is_success:
                    img_bytes = fb.content
            if img_bytes is None:
                raise RuntimeError("no image obtained")
            ct = "image/jpeg"
            ext = "jpg"
            ts_str = datetime.now(timezone.utc).strftime("%H%M%S")
            upload_resp = await client.post(
                f"{BLOCKS_URL}/api/attachments",
                data={"block_id": block_id},
                files={"file": (f"clip_{ts_str}.{ext}", io.BytesIO(img_bytes), ct)},
            )
            upload_resp.raise_for_status()
            att_url = upload_resp.json().get("url")
            logger.info("Clip thumbnail saved: %s", att_url)
            if att_url:
                await client.patch(
                    f"{BLOCKS_URL}/api/blocks/{block_id}",
                    json={"content": markdown + f"\n\n![stream screenshot]({att_url})"},
                )
        except Exception as exc:
            logger.warning("Clip thumbnail failed: %s", exc)

    return {"ok": True, "page_id": page_id, "block_id": block_id}
