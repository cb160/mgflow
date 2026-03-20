import asyncio
import os
import uvicorn
from dotenv import load_dotenv
load_dotenv()
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from .database import init_db
from .routers import feed, save, clip, config
from . import poller as _poller

app = FastAPI(title="mgflow")
APP_VERSION = os.getenv("APP_VERSION", "dev")


@app.on_event("startup")
async def startup():
    await init_db()
    asyncio.create_task(_poller.poll_loop())


app.include_router(feed.router)
app.include_router(save.router)
app.include_router(clip.router)
app.include_router(config.router)

app.mount("/static", StaticFiles(directory="frontend"), name="static")


def _render_index():
    with open("frontend/index.html", "r") as f:
        html = f.read()
    return HTMLResponse(html.replace("{{ APP_VERSION }}", APP_VERSION))


@app.get("/")
async def root():
    return _render_index()


@app.get("/{path:path}")
async def spa_fallback(path: str):
    if path.startswith("api/"):
        return None
    return _render_index()


def run():
    uvicorn.run("backend.main:app", host="0.0.0.0", port=8000, reload=True)


if __name__ == "__main__":
    run()
