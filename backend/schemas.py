from datetime import datetime
from typing import Any, Optional
from pydantic import BaseModel


class PostResponse(BaseModel):
    uri: str
    author_handle: str
    author_display_name: Optional[str]
    author_avatar: Optional[str]
    text: str
    embeds_json: Optional[str]
    like_count: int
    reply_count: int
    repost_count: int
    indexed_at: datetime

    model_config = {"from_attributes": True}


class SaveToBlocksRequest(BaseModel):
    uri: str
