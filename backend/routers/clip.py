import io
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import httpx
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/api/clip", tags=["clip"])
logger = logging.getLogger(__name__)

BLOCKS_URL = os.environ.get("BLOCKS_URL", "http://blocks.apps.svc.cluster.local")
YOUTUBE_VIDEO_ID = "jdI7MZfMEFc"
THUMBNAIL_URL = f"https://img.youtube.com/vi/{YOUTUBE_VIDEO_ID}/maxresdefault.jpg"


class ClipRequest(BaseModel):
    note: str
    session_context: Optional[str] = ""
    video_time: Optional[int] = None  # seconds from YT player


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


@router.post("")
async def create_clip(req: ClipRequest):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    page_title = f"Monkigras {today}"

    parts = []
    if req.session_context:
        parts.append(f"**Session:** {req.session_context}")
    parts.append(req.note)
    if req.video_time is not None:
        stream_url = f"https://www.youtube.com/watch?v={YOUTUBE_VIDEO_ID}&t={req.video_time}s"
        parts.append(f"⏱ [{_fmt_time(req.video_time)}]({stream_url})")
    markdown = "\n\n".join(parts)

    async with httpx.AsyncClient(timeout=20) as client:
        page_id = await _find_or_create_page(client, page_title)

        resp = await client.post(
            f"{BLOCKS_URL}/api/blocks",
            json={"page_id": page_id, "content": markdown, "type": "markdown"},
        )
        resp.raise_for_status()
        block_id = resp.json()["id"]

        # Fetch the live YouTube thumbnail and store it in blocks S3
        try:
            img_resp = await client.get(THUMBNAIL_URL, timeout=10)
            img_resp.raise_for_status()
            ct = img_resp.headers.get("content-type", "image/jpeg").split(";")[0].strip()
            ext = ct.split("/")[-1]
            ts_str = datetime.now(timezone.utc).strftime("%H%M%S")
            upload_resp = await client.post(
                f"{BLOCKS_URL}/api/attachments",
                data={"block_id": block_id},
                files={"file": (f"clip_{ts_str}.{ext}", io.BytesIO(img_resp.content), ct)},
            )
            upload_resp.raise_for_status()
            logger.info("Clip thumbnail saved: %s", upload_resp.json().get("url"))
        except Exception as exc:
            logger.warning("Clip thumbnail failed: %s", exc)

    return {"ok": True, "page_id": page_id, "block_id": block_id}
