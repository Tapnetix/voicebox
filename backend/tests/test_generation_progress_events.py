"""Tests for D2: generation_progress / generation_complete SSE event publishing.

The completion hook in book_generation._generation_with_completion_hook is
extended to publish on the per-book SSE channel (book_events.publish, A7):

  generation_progress  — after each segment settles, with:
      { type, chapter_id, completed, errors, total, overall_progress }
  generation_complete  — when a chapter's segments are all done (or on error),
      with: { type, chapter_id? }

Tests drive the completion hook directly (bypassing the real TTS queue) by:
  1. Seeding the database with a Book + Chapter + BookSegment(s) + Generation rows.
  2. Calling `_generation_with_completion_hook(book_id, inner_coro)` with a
     no-op inner coroutine that first flips segment status to 'completed'.
  3. Inspecting the calls captured on `book_events.publish`.

Coverage target: ≥ 60% of backend.services.book_generation (new publish paths).
"""

from __future__ import annotations

import asyncio
import uuid
from unittest.mock import MagicMock, patch, call

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import (
    Base,
    Book,
    BookCharacter,
    BookSegment,
    Chapter,
    Generation,
    Story,
    StoryItem,
    VoiceProfile,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def engine_and_session(tmp_path):
    db_path = tmp_path / "test_progress.db"
    eng = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(eng)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=eng)
    return eng, TestSession


@pytest.fixture()
def temp_db(engine_and_session):
    _, TestSession = engine_and_session
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


def _make_test_db_getter(TestSession):
    """Return a get_db-compatible generator bound to *TestSession*."""
    def _get():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()
    return _get


def _seed_book_with_segments(db, n_segments: int = 2):
    """Seed one Book → Chapter → n BookSegments (all audio_status='none').

    Returns a dict with ids for easy lookup.
    """
    profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name="Test Voice",
        voice_type="preset",
        preset_engine="kokoro",
        preset_voice_id="af_heart",
        default_engine="kokoro",
        is_library=True,
    )
    db.add(profile)
    db.flush()

    book = Book(
        title="Progress Book",
        author="A",
        source_format="epub",
        status="analyzed",
    )
    db.add(book)
    db.flush()

    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text="Text.",
        word_count=1,
    )
    db.add(chapter)
    db.flush()

    char = BookCharacter(
        book_id=book.id,
        profile_id=profile.id,
        name="Narrator",
        is_narrator=True,
        dialogue_count=0,
    )
    db.add(char)
    db.flush()

    segments = []
    for i in range(n_segments):
        seg = BookSegment(
            chapter_id=chapter.id,
            character_id=char.id,
            type="narration",
            order=i,
            text=f"Sentence {i}.",
            audio_status="none",
        )
        db.add(seg)
        db.flush()
        segments.append(seg)

    db.commit()

    return {
        "book_id": book.id,
        "chapter_id": chapter.id,
        "seg_ids": [s.id for s in segments],
        "profile_id": profile.id,
    }


def _link_generation(db, seg_id: str, profile_id: str) -> str:
    """Create a Generation row and link it to a BookSegment.

    Returns the generation_id.
    """
    gen_id = str(uuid.uuid4())
    gen = Generation(
        id=gen_id,
        profile_id=profile_id,
        text="Sentence.",
        language="en",
        engine="kokoro",
        model_size="1.7B",
        source="book_import",
        status="pending",
    )
    db.add(gen)
    db.flush()

    from backend.database import BookSegment as BS
    seg = db.query(BS).filter_by(id=seg_id).first()
    seg.generation_id = gen_id
    seg.audio_status = "pending"

    db.commit()
    return gen_id


# ---------------------------------------------------------------------------
# Helper: run the completion hook with a no-op inner coro that first marks
# segments as 'completed' before the hook fires its logic.
# ---------------------------------------------------------------------------


async def _noop_coro():
    """Async no-op used as the inner_coro argument."""
    return


async def _run_hook(book_id: str, inner=None):
    """Await _generation_with_completion_hook with an optional inner coro."""
    from backend.services.book_generation import _generation_with_completion_hook
    await _generation_with_completion_hook(book_id, inner or _noop_coro())


# ---------------------------------------------------------------------------
# RED tests — these should FAIL before the publish calls are added.
# ---------------------------------------------------------------------------


def test_generation_progress_event_published_after_segment_completes(
    engine_and_session,
):
    """Completion hook publishes generation_progress for the settled chapter.

    Drives the hook by:
    1. Seeding 2 segments linked to 2 Generations.
    2. Marking both as 'completed' (simulating TTS worker success).
    3. Running the hook.
    4. Asserting book_events.publish was called with type='generation_progress'
       containing {chapter_id, completed, total, overall_progress}.
    """
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=2)
    book_id = seed["book_id"]
    chapter_id = seed["chapter_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    # Link segments to generations
    db = TestSession()
    for seg_id in seg_ids:
        _link_generation(db, seg_id, profile_id)
    db.close()

    # Mark all segments as completed
    db = TestSession()
    from backend.database import BookSegment
    for seg_id in seg_ids:
        seg = db.query(BookSegment).filter_by(id=seg_id).first()
        seg.audio_status = "completed"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be

    original_publish = be.publish
    be.publish = lambda book_id_, payload: published.append((book_id_, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    # Must have at least one generation_progress event
    progress_events = [p for _, p in published if p.get("type") == "generation_progress"]
    assert len(progress_events) >= 1, (
        f"Expected at least 1 generation_progress event; got {published!r}"
    )

    # The event must include the required fields
    ev = progress_events[0]
    for key in ("chapter_id", "completed", "errors", "total", "overall_progress"):
        assert key in ev, f"generation_progress event missing field {key!r}: {ev!r}"

    assert ev["chapter_id"] == chapter_id
    assert ev["completed"] == 2
    assert ev["total"] == 2
    assert ev["overall_progress"] == pytest.approx(1.0)


def test_generation_complete_event_published_when_chapter_done(
    engine_and_session,
):
    """Completion hook publishes generation_complete when chapter's segments all settle."""
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=1)
    book_id = seed["book_id"]
    chapter_id = seed["chapter_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    db = TestSession()
    _link_generation(db, seg_ids[0], profile_id)
    db.close()

    # Mark segment as completed
    db = TestSession()
    from backend.database import BookSegment
    seg = db.query(BookSegment).filter_by(id=seg_ids[0]).first()
    seg.audio_status = "completed"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be

    original_publish = be.publish
    be.publish = lambda book_id_, payload: published.append((book_id_, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    complete_events = [p for _, p in published if p.get("type") == "generation_complete"]
    assert len(complete_events) >= 1, (
        f"Expected at least 1 generation_complete event; got {published!r}"
    )
    ev = complete_events[0]
    # chapter_id is optional in spec but we emit it
    assert "type" in ev
    assert ev["type"] == "generation_complete"


def test_generation_progress_event_has_correct_chapter_id(
    engine_and_session,
):
    """generation_progress event carries the correct chapter_id from the book's chapter."""
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=2)
    book_id = seed["book_id"]
    chapter_id = seed["chapter_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    db = TestSession()
    for seg_id in seg_ids:
        _link_generation(db, seg_id, profile_id)
    db.close()

    db = TestSession()
    from backend.database import BookSegment
    for seg_id in seg_ids:
        seg = db.query(BookSegment).filter_by(id=seg_id).first()
        seg.audio_status = "completed"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be
    original_publish = be.publish
    be.publish = lambda bid, payload: published.append((bid, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    progress_events = [p for _, p in published if p.get("type") == "generation_progress"]
    assert progress_events, "No generation_progress events found"
    for ev in progress_events:
        assert ev["chapter_id"] == chapter_id, (
            f"chapter_id mismatch: expected {chapter_id!r}, got {ev['chapter_id']!r}"
        )


def test_generation_progress_fields_are_subset_of_event(
    engine_and_session,
):
    """Contract check: {chapter_id,completed,total,overall_progress} ⊆ progress event."""
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=3)
    book_id = seed["book_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    db = TestSession()
    for seg_id in seg_ids:
        _link_generation(db, seg_id, profile_id)
    db.close()

    # Mark 2/3 as completed, 1 as error
    db = TestSession()
    from backend.database import BookSegment
    for i, seg_id in enumerate(seg_ids):
        seg = db.query(BookSegment).filter_by(id=seg_id).first()
        seg.audio_status = "completed" if i < 2 else "error"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be
    original_publish = be.publish
    be.publish = lambda bid, payload: published.append((bid, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    progress_events = [p for _, p in published if p.get("type") == "generation_progress"]
    assert progress_events, "Expected generation_progress events"
    ev = progress_events[-1]  # use last (most up-to-date)

    # Contract: these fields must be present (superset check)
    required = {"chapter_id", "completed", "total", "overall_progress"}
    missing = required - ev.keys()
    assert not missing, f"generation_progress event missing keys: {missing!r}"

    assert ev["errors"] == 1
    assert ev["total"] == 3


def test_progress_events_published_on_book_channel(
    engine_and_session,
):
    """Events are published under the book_id channel, not the chapter_id."""
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=1)
    book_id = seed["book_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    db = TestSession()
    _link_generation(db, seg_ids[0], profile_id)
    db.close()

    db = TestSession()
    from backend.database import BookSegment
    seg = db.query(BookSegment).filter_by(id=seg_ids[0]).first()
    seg.audio_status = "completed"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be
    original_publish = be.publish
    be.publish = lambda bid, payload: published.append((bid, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    gen_events = [(bid, p) for bid, p in published if p.get("type") in ("generation_progress", "generation_complete")]
    assert gen_events, "No generation events found"
    for bid, _ in gen_events:
        assert bid == book_id, f"Event published on wrong channel: expected {book_id!r}, got {bid!r}"


def test_generation_complete_event_has_type_field(engine_and_session):
    """generation_complete event has type='generation_complete' and optionally chapter_id."""
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=1)
    book_id = seed["book_id"]
    chapter_id = seed["chapter_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    db = TestSession()
    _link_generation(db, seg_ids[0], profile_id)
    db.close()

    db = TestSession()
    from backend.database import BookSegment
    seg = db.query(BookSegment).filter_by(id=seg_ids[0]).first()
    seg.audio_status = "completed"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be
    original_publish = be.publish
    be.publish = lambda bid, payload: published.append((bid, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    complete_events = [p for _, p in published if p.get("type") == "generation_complete"]
    assert complete_events, "Expected at least one generation_complete event"
    ev = complete_events[0]
    assert ev["type"] == "generation_complete"
    # chapter_id may be present (we always emit it)
    if "chapter_id" in ev:
        assert ev["chapter_id"] == chapter_id or ev["chapter_id"] is None


def test_progress_then_complete_ordering(engine_and_session):
    """generation_progress events come before generation_complete in the publish sequence."""
    _, TestSession = engine_and_session

    db = TestSession()
    seed = _seed_book_with_segments(db, n_segments=2)
    book_id = seed["book_id"]
    profile_id = seed["profile_id"]
    seg_ids = seed["seg_ids"]
    db.close()

    db = TestSession()
    for seg_id in seg_ids:
        _link_generation(db, seg_id, profile_id)
    db.close()

    db = TestSession()
    from backend.database import BookSegment
    for seg_id in seg_ids:
        seg = db.query(BookSegment).filter_by(id=seg_id).first()
        seg.audio_status = "completed"
    db.commit()
    db.close()

    import backend.database as _db_module
    original_get_db = _db_module.get_db
    _db_module.get_db = _make_test_db_getter(TestSession)

    published = []
    import backend.services.book_events as be
    original_publish = be.publish
    be.publish = lambda bid, payload: published.append((bid, dict(payload)))

    try:
        asyncio.run(_run_hook(book_id))
    finally:
        _db_module.get_db = original_get_db
        be.publish = original_publish

    types = [p.get("type") for _, p in published]
    assert "generation_progress" in types, f"No generation_progress found in: {types}"
    assert "generation_complete" in types, f"No generation_complete found in: {types}"

    last_progress_idx = max(i for i, t in enumerate(types) if t == "generation_progress")
    first_complete_idx = types.index("generation_complete")
    assert last_progress_idx < first_complete_idx, (
        "generation_complete must come after generation_progress events"
    )
