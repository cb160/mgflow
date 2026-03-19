FROM python:3.12-slim

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /bin/uv

WORKDIR /app

ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

# Copy dependency files and install
COPY pyproject.toml .
RUN uv sync --no-dev --no-editable

# Copy application code
COPY backend/ backend/
COPY frontend/ frontend/

# Persistent data directory (mount a PVC here)
RUN mkdir -p /data

ENV DATABASE_URL=sqlite+aiosqlite:////data/mgflow.db
ENV BLOCKS_URL=http://blocks.apps.svc.cluster.local

EXPOSE 8000

CMD ["/app/.venv/bin/uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
