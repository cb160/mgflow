import json
import os
import re
from fastapi import APIRouter

router = APIRouter(prefix="/api/config", tags=["config"])

# Store config alongside the SQLite database file
_db_url = os.environ.get("DATABASE_URL", "sqlite+aiosqlite:///./mgflow.db")
_m = re.match(r'sqlite\+aiosqlite:///(.+)', _db_url)
_db_path = _m.group(1) if _m else "./mgflow.db"
_config_dir = os.path.dirname(os.path.abspath(_db_path))
CONFIG_PATH = os.path.join(_config_dir, "streams_config.json")

DEFAULT_CONFIG = {
    "streams": [{"id": "jdI7MZfMEFc", "name": "Monkigras Main Stream"}],
    "active_stream": "jdI7MZfMEFc",
}


def _load() -> dict:
    try:
        with open(CONFIG_PATH) as f:
            data = json.load(f)
        if data.get("streams"):
            return data
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        pass
    return dict(DEFAULT_CONFIG)


def _save(data: dict) -> None:
    with open(CONFIG_PATH, "w") as f:
        json.dump(data, f)


@router.get("/streams")
async def get_streams():
    return _load()


@router.put("/streams")
async def put_streams(body: dict):
    _save(body)
    return {"ok": True}
