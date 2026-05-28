"""Tests for per-book SSE pub/sub (backend.services.book_events)."""

import asyncio
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, Book, get_db
from backend.routes import events
from backend.routes.events import router as events_router
from backend.services import book_events


# ---------------------------------------------------------------------------
# Pure pub/sub unit tests
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Route-level tests — /events/books/{book_id}
#
# sse-starlette's EventSourceResponse is an INFINITE stream, so reading it
# through any live transport (TestClient or httpx ASGITransport aiter_bytes)
# blocks waiting for a body that never completes.  For the streaming path we
# instead call the route handler directly and pull a bounded number of events
# off the returned EventSourceResponse.body_iterator with asyncio.wait_for —
# deterministic and non-hanging.  The 404 path is synchronous (raised before
# the stream starts) so it is asserted through the normal TestClient.
# ---------------------------------------------------------------------------


def _make_session(tmp_path):
    db_path = tmp_path / "test_events.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    return sessionmaker(autocommit=False, autoflush=False, bind=engine)


class _FakeRequest:
    """Minimal Starlette-Request stand-in — never reports disconnected."""

    async def is_disconnected(self) -> bool:
        return False


def test_sse_unknown_book_returns_404(tmp_path):
    """GET /events/books/<unknown> must return 404 at connect time (contract 04)."""
    Session = _make_session(tmp_path)

    def override_get_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(events_router)
    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as c:
        assert c.get("/events/books/does-not-exist").status_code == 404


@pytest.mark.asyncio
async def test_sse_known_book_emits_ready_then_published_message(tmp_path):
    """Known book: the stream opens with a 'ready' hello, and a payload
    published while it is open arrives as a generic 'message' event whose
    JSON carries the type discriminator (contract 04 framing)."""
    Session = _make_session(tmp_path)
    db = Session()
    book_id = str(uuid.uuid4())
    db.add(Book(id=book_id, title="Test Book", source_format="txt", status="imported"))
    db.commit()

    resp = await events.book_events_stream(book_id, _FakeRequest(), db)
    body = resp.body_iterator
    try:
        first = await asyncio.wait_for(body.__anext__(), timeout=5.0)
        assert first["event"] == "ready"

        book_events.publish(book_id, {"type": "test_event", "value": 42})
        nxt = await asyncio.wait_for(body.__anext__(), timeout=5.0)
        assert nxt["event"] == "message"
        assert '"test_event"' in nxt["data"]
    finally:
        await body.aclose()
        db.close()
