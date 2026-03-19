import asyncio
import logging
from datetime import datetime
from sqlalchemy import select
from .database import AsyncSessionLocal
from .models import Post
from .bluesky import fetch_posts, fetch_all_since, CONFERENCE_START

logger = logging.getLogger(__name__)

_subscribers: set[asyncio.Queue] = set()
POLL_INTERVAL = 90


def add_subscriber(q: asyncio.Queue):
    _subscribers.add(q)


def remove_subscriber(q: asyncio.Queue):
    _subscribers.discard(q)


def _notify(event_type: str, data: dict):
    dead = set()
    for q in _subscribers:
        try:
            q.put_nowait({"event": event_type, **data})
        except asyncio.QueueFull:
            dead.add(q)
    _subscribers.difference_update(dead)


def notify_saved(uri: str):
    _notify("saved", {"uri": uri})


async def _upsert_posts(posts: list[dict]) -> int:
    """Insert new posts, update counts/embeds for existing. Returns new post count."""
    new_count = 0
    async with AsyncSessionLocal() as db:
        for p in posts:
            existing = await db.get(Post, p["uri"])
            if existing is None:
                db.add(Post(**p))
                new_count += 1
                _notify("post", p)
            else:
                existing.like_count = p["like_count"]
                existing.reply_count = p["reply_count"]
                existing.repost_count = p["repost_count"]
                if p.get("embeds_json"):
                    existing.embeds_json = p["embeds_json"]
        await db.commit()
    return new_count


async def initial_load():
    """Fetch all #monkigras posts since conference start and store them."""
    logger.info("Starting historical backfill since %s", CONFERENCE_START.isoformat())
    posts = await fetch_all_since(CONFERENCE_START)
    if posts:
        new = await _upsert_posts(posts)
        logger.info("Historical backfill complete: %d total, %d new", len(posts), new)
    else:
        logger.info("Historical backfill: no posts found")


async def poll_once():
    try:
        posts, _ = await fetch_posts()
    except Exception as exc:
        logger.warning("Bluesky fetch failed: %s", exc)
        return

    new_count = await _upsert_posts(posts)
    logger.info("Poll complete: %d new out of %d", new_count, len(posts))


async def poll_loop():
    await asyncio.sleep(3)
    await initial_load()
    while True:
        await poll_once()
        await asyncio.sleep(POLL_INTERVAL)
