import asyncio
import json
import logging
from datetime import datetime
from fastapi import APIRouter, Depends, Query
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..database import get_db, AsyncSessionLocal
from ..models import Post
from ..schemas import PostResponse
from ..poller import add_subscriber, remove_subscriber

router = APIRouter(prefix="/api/feed", tags=["feed"])
logger = logging.getLogger(__name__)


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
    }


@router.get("", response_model=list[PostResponse])
async def get_feed(
    limit: int = Query(200, le=500),
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


@router.get("/stream")
async def feed_stream():
    async def event_generator():
        # Send initial batch of last 50 posts
        async with AsyncSessionLocal() as db:
            stmt = select(Post).order_by(Post.indexed_at.desc()).limit(50)
            result = await db.execute(stmt)
            initial = list(reversed(result.scalars().all()))

        for p in initial:
            yield f"data: {json.dumps(_post_to_dict(p))}\n\n"

        q: asyncio.Queue = asyncio.Queue(maxsize=200)
        add_subscriber(q)
        keepalive_interval = 30
        try:
            while True:
                try:
                    post_data = await asyncio.wait_for(q.get(), timeout=keepalive_interval)
                    yield f"data: {json.dumps(post_data, default=str)}\n\n"
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
