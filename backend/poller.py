import asyncio
import logging
from datetime import datetime
from sqlalchemy import select, update
from .database import AsyncSessionLocal
from .models import Post
from .bluesky import fetch_posts

logger = logging.getLogger(__name__)

_subscribers: set[asyncio.Queue] = set()
POLL_INTERVAL = 90


def add_subscriber(q: asyncio.Queue):
    _subscribers.add(q)


def remove_subscriber(q: asyncio.Queue):
    _subscribers.discard(q)


def _notify_new(post_data: dict):
    dead = set()
    for q in _subscribers:
        try:
            q.put_nowait(post_data)
        except asyncio.QueueFull:
            dead.add(q)
    _subscribers.difference_update(dead)


async def poll_once():
    try:
        posts, _ = await fetch_posts()
    except Exception as exc:
        logger.warning("Bluesky fetch failed: %s", exc)
        return

    new_count = 0
    updated_count = 0

    async with AsyncSessionLocal() as db:
        for p in posts:
            existing = await db.get(Post, p["uri"])
            if existing is None:
                db.add(Post(**p))
                new_count += 1
                _notify_new(p)
            else:
                existing.like_count = p["like_count"]
                existing.reply_count = p["reply_count"]
                existing.repost_count = p["repost_count"]
                updated_count += 1
        await db.commit()

    logger.info("Poll complete: %d new, %d updated", new_count, updated_count)


async def poll_loop():
    await asyncio.sleep(5)  # brief startup delay
    while True:
        await poll_once()
        await asyncio.sleep(POLL_INTERVAL)
