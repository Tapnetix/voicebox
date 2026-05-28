"""Server-Sent-Event streams the frontend subscribes to.

``GET /events/speak`` — broadcasts ``speak-start`` / ``speak-end`` events
whenever an agent-initiated speak (MCP tool or POST /speak) runs. The
DictateWindow uses them to show the floating pill in a `speaking` state.

``GET /events/books/{book_id}`` — per-book progress stream for analysis,
generation, and export stages. All events are generic ``message`` events
carrying a ``type`` discriminator in the JSON payload (see contract 04).
"""

import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse

from .. import database
from ..database import get_db
from ..mcp_server import events as mcp_events
from ..services import book_events


logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/events/speak")
async def speak_events(request: Request):
    """SSE stream of speak-start / speak-end events."""

    async def event_stream():
        queue = mcp_events.subscribe()
        try:
            # Immediate hello so EventSource knows the connection is live.
            yield {"event": "ready", "data": "{}"}
            while True:
                if await request.is_disconnected():
                    return
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    # Heartbeat so proxies don't reap idle streams.
                    yield {"event": "ping", "data": "{}"}
                    continue
                kind = event.pop("kind", "message")
                yield {"event": kind, "data": json.dumps(event)}
        finally:
            mcp_events.unsubscribe(queue)

    return EventSourceResponse(event_stream())


@router.get("/events/books/{book_id}")
async def book_events_stream(book_id: str, request: Request, db: Session = Depends(get_db)):
    """SSE stream of analysis/generation/export progress events for one book.

    All progress events are emitted as generic ``message`` events carrying a
    ``type`` discriminator in the JSON payload — not named SSE events — so the
    browser ``EventSource`` listener handles them via ``onmessage``.

    The stream opens with a ``ready`` hello so the client knows the connection
    is live, then emits ``ping`` heartbeats every ~15 s to keep proxies from
    reaping idle streams.
    """
    if db.query(database.Book).filter_by(id=book_id).first() is None:
        raise HTTPException(404, "Book not found")

    async def event_stream():
        queue = book_events.subscribe(book_id)
        try:
            # Immediate hello so EventSource knows the connection is live.
            yield {"event": "ready", "data": "{}"}
            while True:
                if await request.is_disconnected():
                    return
                try:
                    payload = await asyncio.wait_for(queue.get(), timeout=15.0)
                except TimeoutError:
                    # Heartbeat so proxies don't reap idle streams.
                    yield {"event": "ping", "data": "{}"}
                    continue
                yield {"event": "message", "data": json.dumps(payload)}
        finally:
            book_events.unsubscribe(book_id, queue)

    return EventSourceResponse(event_stream())
