from datetime import datetime
from sqlalchemy import String, Text, Integer, DateTime
from sqlalchemy.orm import Mapped, mapped_column
from .database import Base


class Post(Base):
    __tablename__ = "posts"

    uri: Mapped[str] = mapped_column(String, primary_key=True)
    author_handle: Mapped[str] = mapped_column(String, nullable=False)
    author_display_name: Mapped[str] = mapped_column(String, nullable=True)
    author_avatar: Mapped[str] = mapped_column(String, nullable=True)
    text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    embeds_json: Mapped[str] = mapped_column(Text, nullable=True)
    like_count: Mapped[int] = mapped_column(Integer, default=0)
    reply_count: Mapped[int] = mapped_column(Integer, default=0)
    repost_count: Mapped[int] = mapped_column(Integer, default=0)
    indexed_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    saved_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
