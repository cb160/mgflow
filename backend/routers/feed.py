import asyncio
import json
import logging
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_db, AsyncSessionLocal
from ..models import Post
from ..schemas import PostResponse
from ..poller import add_subscriber, remove_subscriber
from ..bluesky import CONFERENCE_START

router = APIRouter(prefix="/api/feed", tags=["feed"])
logger = logging.getLogger(__name__)

BUCKET_MINUTES = 15


def _post_to_dict(p: Post) -> dict:
    return {
        "uri": p.uri,
        "author_handle": p.author_handle,
        "author_display_name": p.author_display_name,
        "author_avatar": p.author_avatar,
        "text": p.text,
        "embeds_json": p.embeds_json,
        "like_count": p.like_count,
        "reply_count": p.reply_count,
        "repost_count": p.repost_count,
        "indexed_at": p.indexed_at.isoformat(),
        "saved_to_blocks": p.saved_to_blocks or False,
    }


@router.get("", response_model=list[PostResponse])
async def get_feed(
    limit: int = Query(500, le=1000),
    before: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    stmt = select(Post).order_by(Post.indexed_at.desc()).limit(limit)
    if before:
        try:
            dt = datetime.fromisoformat(before)
            stmt = stmt.where(Post.indexed_at < dt)
        except ValueError:
            pass
    result = await db.execute(stmt)
    return result.scalars().all()


@router.get("/timeline")
async def get_timeline(db: AsyncSession = Depends(get_db)):
    stmt = select(Post).where(Post.indexed_at >= CONFERENCE_START).order_by(Post.indexed_at)
    result = await db.execute(stmt)
    posts = result.scalars().all()

    buckets: dict[str, dict] = {}
    for p in posts:
        dt = p.indexed_at
        minute_bucket = (dt.minute // BUCKET_MINUTES) * BUCKET_MINUTES
        key = dt.replace(minute=minute_bucket, second=0, microsecond=0).isoformat()
        if key not in buckets:
            buckets[key] = {"start": key, "count": 0, "saved_count": 0}
        buckets[key]["count"] += 1
        if p.saved_to_blocks:
            buckets[key]["saved_count"] += 1

    return {
        "buckets": sorted(buckets.values(), key=lambda x: x["start"]),
        "conference_start": CONFERENCE_START.replace(tzinfo=None).isoformat(),
        "total": len(posts),
        "saved_total": sum(1 for p in posts if p.saved_to_blocks),
    }


@router.get("/stream")
async def feed_stream():
    async def event_generator():
        # Send initial batch — all posts since conference start, newest first
        async with AsyncSessionLocal() as db:
            stmt = select(Post).where(
                Post.indexed_at >= CONFERENCE_START
            ).order_by(Post.indexed_at.desc())
            result = await db.execute(stmt)
            initial = result.scalars().all()

        for p in initial:
            yield f"data: {json.dumps(_post_to_dict(p))}\n\n"

        q: asyncio.Queue = asyncio.Queue(maxsize=500)
        add_subscriber(q)
        keepalive_interval = 30
        try:
            while True:
                try:
                    event = await asyncio.wait_for(q.get(), timeout=keepalive_interval)
                    yield f"data: {json.dumps(event, default=str)}\n\n"
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
        except asyncio.CancelledError:
            pass
        finally:
            remove_subscriber(q)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )
