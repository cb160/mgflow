import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

DATABASE_URL = os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./mgflow.db")

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db():
    async with AsyncSessionLocal() as session:
        yield session


async def init_db():
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
    await _migrate()


async def _migrate():
    migrations = [
        "ALTER TABLE posts ADD COLUMN saved_to_blocks INTEGER DEFAULT 0",
        "ALTER TABLE posts ADD COLUMN saved_to_blocks_at DATETIME",
    ]
    async with engine.begin() as conn:
        for sql in migrations:
            try:
                await conn.execute(__import__("sqlalchemy").text(sql))
            except Exception:
                pass  # column already exists
