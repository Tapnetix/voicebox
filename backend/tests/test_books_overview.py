"""Tests for B5: book_overview service + GET /books/{id} detail route.

Covers:
- Direct unit tests of chapter_generation_state for each state (none/partial/ready/error)
- Route test: GET /books/{id} returns chapters with generation_state and word_count
- Event-ordering test: character_detected before analysis_complete in run_analysis_task
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, Book, BookSegment, Chapter, get_db
from backend.routes.books import router as books_router


# ---------------------------------------------------------------------------
# Shared DB fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def engine_and_session(tmp_path):
    """Temp SQLite engine with all tables created."""
    db_path = tmp_path / "test.db"
    eng = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(eng)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=eng)
    return eng, TestSession


@pytest.fixture(scope="function")
def temp_db(engine_and_session):
    """Yield a single DB session for the duration of one test."""
    _, TestSession = engine_and_session
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _seed_chapter_with_segments(db, statuses: list[str]) -> Chapter:
    """Seed a Book + Chapter + BookSegments with the given audio_status values."""
    book = Book(
        title="Test Book",
        author="Author",
        source_format="txt",
        status="imported",
    )
    db.add(book)
    db.flush()

    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text="Some text",
        word_count=10,
    )
    db.add(chapter)
    db.flush()

    for i, status in enumerate(statuses):
        seg = BookSegment(
            chapter_id=chapter.id,
            type="narration",
            order=i,
            text=f"Sentence {i}.",
            audio_status=status,
        )
        db.add(seg)

    db.commit()
    db.refresh(chapter)
    return chapter


def _seed_chapter_no_segments(db) -> Chapter:
    """Seed a Book + Chapter with NO segments."""
    book = Book(
        title="Empty Book",
        author="Author",
        source_format="txt",
        status="imported",
    )
    db.add(book)
    db.flush()

    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text="",
        word_count=0,
    )
    db.add(chapter)
    db.commit()
    db.refresh(chapter)
    return chapter


# ---------------------------------------------------------------------------
# Unit tests: chapter_generation_state
# ---------------------------------------------------------------------------


def test_chapter_generation_state_none_no_segments(temp_db):
    """chapter_generation_state returns 'none' when chapter has no segments."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_no_segments(temp_db)
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "none", f"Expected 'none', got {result!r}"


def test_chapter_generation_state_none_all_none(temp_db):
    """chapter_generation_state returns 'none' when all segments have audio_status='none'."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["none", "none", "none"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "none", f"Expected 'none', got {result!r}"


def test_chapter_generation_state_ready(temp_db):
    """chapter_generation_state returns 'ready' when all segments are 'completed'."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["completed", "completed"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "ready", f"Expected 'ready', got {result!r}"


def test_chapter_generation_state_error(temp_db):
    """chapter_generation_state returns 'error' if any segment has audio_status='error'."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["completed", "error", "none"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "error", f"Expected 'error', got {result!r}"


def test_chapter_generation_state_partial_mixed(temp_db):
    """chapter_generation_state returns 'partial' for mixed non-error states."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["completed", "none"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "partial", f"Expected 'partial', got {result!r}"


def test_chapter_generation_state_partial_generating(temp_db):
    """chapter_generation_state returns 'partial' when some segments are generating."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["generating", "none"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "partial", f"Expected 'partial', got {result!r}"


def test_chapter_generation_state_partial_pending(temp_db):
    """chapter_generation_state returns 'partial' when segments are pending."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["pending", "none"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "partial", f"Expected 'partial', got {result!r}"


def test_chapter_generation_state_error_beats_partial(temp_db):
    """chapter_generation_state returns 'error' even if some segments are completed."""
    from backend.services.book_overview import chapter_generation_state

    # error takes priority over partial
    chapter = _seed_chapter_with_segments(temp_db, ["completed", "pending", "error"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "error", f"Expected 'error', got {result!r}"


def test_chapter_generation_state_single_completed(temp_db):
    """chapter_generation_state returns 'ready' for a single completed segment."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["completed"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "ready", f"Expected 'ready', got {result!r}"


def test_chapter_generation_state_single_error(temp_db):
    """chapter_generation_state returns 'error' for a single errored segment."""
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["error"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "error", f"Expected 'error', got {result!r}"


def test_chapter_generation_state_all_stale(temp_db):
    """chapter_generation_state returns 'partial' when all segments are 'stale'.

    'stale' is a non-none, non-completed, non-error audio_status introduced in B7.
    It counts as in-progress work, so the chapter is 'partial', not 'none'.
    """
    from backend.services.book_overview import chapter_generation_state

    chapter = _seed_chapter_with_segments(temp_db, ["stale", "stale", "stale"])
    result = chapter_generation_state(chapter.id, temp_db)
    assert result == "partial", f"Expected 'partial', got {result!r}"


# ---------------------------------------------------------------------------
# Route test: GET /books/{id} returns generation_state + word_count per chapter
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def books_client(engine_and_session, tmp_path, monkeypatch):
    """Minimal FastAPI app with books router and a temp SQLite DB."""
    _, TestSession = engine_and_session

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setenv("VOICEBOX_DATA_DIR", str(tmp_path))
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    app = FastAPI()
    app.include_router(books_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c, TestSession


def test_get_book_detail_chapters_have_generation_state_and_word_count(
    books_client,
):
    """GET /books/{id} returns chapters each with generation_state and word_count."""
    client, TestSession = books_client

    # Seed book + 2 chapters + segments directly in DB
    db = TestSession()
    book = Book(
        title="Detail Book",
        author="Author",
        source_format="txt",
        status="imported",
    )
    db.add(book)
    db.flush()

    ch1 = Chapter(
        book_id=book.id, number=1, title="Ch1", raw_text="Hello world.", word_count=2
    )
    ch2 = Chapter(
        book_id=book.id, number=2, title="Ch2", raw_text="Goodbye.", word_count=1
    )
    db.add(ch1)
    db.add(ch2)
    db.flush()

    # ch1: one completed segment → ready
    db.add(
        BookSegment(
            chapter_id=ch1.id, type="narration", order=0, text="Hello world.", audio_status="completed"
        )
    )
    # ch2: no segments → none
    db.commit()
    book_id = book.id
    db.close()

    r = client.get(f"/books/{book_id}")
    assert r.status_code == 200, r.text
    body = r.json()

    assert "chapters" in body
    chapters = body["chapters"]
    assert len(chapters) == 2

    # Chapters ordered by number
    ch1_resp = chapters[0]
    ch2_resp = chapters[1]

    # Both have generation_state and word_count
    assert "generation_state" in ch1_resp, "ch1 missing generation_state"
    assert "word_count" in ch1_resp, "ch1 missing word_count"
    assert "generation_state" in ch2_resp, "ch2 missing generation_state"
    assert "word_count" in ch2_resp, "ch2 missing word_count"

    # State values are correct
    assert ch1_resp["generation_state"] == "ready", (
        f"ch1 expected 'ready', got {ch1_resp['generation_state']!r}"
    )
    assert ch2_resp["generation_state"] == "none", (
        f"ch2 expected 'none', got {ch2_resp['generation_state']!r}"
    )

    # word_count is correct
    assert ch1_resp["word_count"] == 2
    assert ch2_resp["word_count"] == 1


def test_get_book_detail_unknown_returns_404(books_client):
    """GET /books/{id} with unknown id returns 404."""
    client, _ = books_client
    r = client.get(f"/books/{uuid.uuid4()}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Event-ordering test: character_detected before analysis_complete
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def seeded_book_id_for_ordering(temp_db):
    """Seed a Book + Chapter for the event-ordering test."""
    book = Book(
        title="Order Test Book",
        author="Test Author",
        source_format="txt",
        status="imported",
    )
    temp_db.add(book)
    temp_db.flush()

    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text='"Help me," said Alice. "No," said Bob.',
        word_count=8,
    )
    temp_db.add(chapter)
    temp_db.commit()
    temp_db.refresh(book)
    return book.id


@pytest.mark.asyncio
async def test_character_detected_before_analysis_complete(
    temp_db, seeded_book_id_for_ordering, monkeypatch
):
    """run_analysis_task emits character_detected event(s) before analysis_complete."""
    from backend.services import book_analysis, book_events, literary_analysis, voice_casting
    from backend.services.literary_analysis import BookAnalysis, ChapterAnalysis

    # Build a minimal fake analysis result
    characters = [
        {"name": "Alice", "dialogue_count": 1, "confidence": 0.9},
        {"name": "Bob", "dialogue_count": 1, "confidence": 0.9},
    ]
    segments = [
        {
            "type": "dialogue",
            "text": "Help me.",
            "order": 0,
            "speaker": "Alice",
            "emotion": None,
            "intensity": None,
        },
        {
            "type": "dialogue",
            "text": "No.",
            "order": 1,
            "speaker": "Bob",
            "emotion": None,
            "intensity": None,
        },
    ]
    chapter_analysis = ChapterAnalysis(
        segments=segments, characters=characters, flagged=False
    )
    fake_analysis = BookAnalysis(chapters=[chapter_analysis], characters=characters)

    async def fake_analyze_book(chapter_texts, model_size=None, progress_cb=None):
        return fake_analysis

    monkeypatch.setattr(literary_analysis, "analyze_book", fake_analyze_book)
    monkeypatch.setattr(voice_casting, "cast_book", lambda *a, **k: None)

    # Capture all published events in order
    seen: list[dict] = []
    monkeypatch.setattr(book_events, "publish", lambda bid, payload: seen.append(payload))

    await book_analysis.run_analysis_task(
        seeded_book_id_for_ordering, model_size="1.7B", db=temp_db
    )

    event_types = [e["type"] for e in seen]

    # Both event types must be present
    assert "character_detected" in event_types, (
        f"Missing character_detected events; saw: {event_types}"
    )
    assert "analysis_complete" in event_types, (
        f"Missing analysis_complete event; saw: {event_types}"
    )

    # The FIRST character_detected must appear before the analysis_complete
    first_detected_idx = event_types.index("character_detected")
    complete_idx = event_types.index("analysis_complete")
    assert first_detected_idx < complete_idx, (
        f"character_detected (idx {first_detected_idx}) must precede "
        f"analysis_complete (idx {complete_idx}); full sequence: {event_types}"
    )
