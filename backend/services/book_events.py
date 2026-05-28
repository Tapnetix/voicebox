"""Per-book in-memory pub/sub for the /events/books/{book_id} SSE stream.

Subscribers register per book_id. The producer calls publish() with a book_id
and payload dict; each subscriber for that book_id receives an independent copy
of the payload so mutations (e.g. pop()) in one consumer don't affect others.

Usage::

    # Producer
    from backend.services import book_events
    book_events.publish("book-123", {"type": "analysis_progress", "progress": 42})

    # Consumer (SSE handler)
    queue = book_events.subscribe("book-123")
    try:
        payload = await queue.get()
    finally:
        book_events.unsubscribe("book-123", queue)
"""

import asyncio
from typing import Any

# Keyed by book_id — one set of queues per book.
_subscribers: dict[str, set[asyncio.Queue[dict[str, Any]]]] = {}


def subscribe(book_id: str) -> asyncio.Queue[dict[str, Any]]:
    """Register a new subscriber for *book_id*; caller must call unsubscribe() when done."""
    queue: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=128)
    _subscribers.setdefault(book_id, set()).add(queue)
    return queue


def unsubscribe(book_id: str, queue: asyncio.Queue[dict[str, Any]]) -> None:
    """Remove *queue* from *book_id*'s subscriber set. Safe if already removed."""
    subs = _subscribers.get(book_id)
    if subs:
        subs.discard(queue)
        if not subs:
            _subscribers.pop(book_id, None)


def publish(book_id: str, payload: dict[str, Any]) -> None:
    """Fan out *payload* to all subscribers of *book_id*.

    Non-blocking: if a subscriber's queue is full the event is dropped rather
    than blocking the producer. Each subscriber receives an independent dict
    copy so consumers can mutate freely without affecting siblings.
    """
    for queue in list(_subscribers.get(book_id, ())):
        try:
            queue.put_nowait(dict(payload))  # per-subscriber copy
        except asyncio.QueueFull:
            pass  # slow subscriber — skip, don't block the producer
