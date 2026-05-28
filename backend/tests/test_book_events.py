"""Tests for per-book SSE pub/sub (backend.services.book_events)."""

import asyncio

import pytest

from backend.services import book_events


@pytest.mark.asyncio
async def test_publish_reaches_only_matching_book():
    q_a = book_events.subscribe("book-a")
    q_b = book_events.subscribe("book-b")
    book_events.publish("book-a", {"type": "analysis_progress", "stage": "detect", "progress": 10})
    got = await asyncio.wait_for(q_a.get(), timeout=1.0)
    assert got["type"] == "analysis_progress"
    assert q_b.empty()
    book_events.unsubscribe("book-a", q_a)
    book_events.unsubscribe("book-b", q_b)


@pytest.mark.asyncio
async def test_payload_is_per_subscriber_copy():
    q1 = book_events.subscribe("b")
    q2 = book_events.subscribe("b")
    book_events.publish("b", {"type": "character_detected", "total": 1})
    e1 = await q1.get()
    e2 = await q2.get()
    assert e1 == e2 and e1 is not e2
    book_events.unsubscribe("b", q1)
    book_events.unsubscribe("b", q2)


def test_unsubscribe_unknown_is_safe():
    book_events.unsubscribe("nope", asyncio.Queue())  # must not raise
