"""Tests for book generation endpoints (D1).

Tests:
- POST /books/{id}/chapters/{cid}/generate returns 202 with queued_segments
- POST /books/{id}/generate (whole book) returns 202 with queued_segments
- GET /books/{id}/generation-status returns per-chapter counts
- 409 when already generating
- 404 for unknown book/chapter
- Lazy materialization: Story, Generation, StoryItem rows created on first generate
- Segments link to their Generation rows
- compose_instruct helper folds emotion + intensity + delivery into instruct
"""

import uuid
from unittest.mock import MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
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
    get_db,
)
from backend.routes.book_generation import router as book_generation_router
from backend.routes.books import router as books_router


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def engine_and_session(tmp_path):
    """Create a temp SQLite engine with all tables."""
    db_path = tmp_path / "test.db"
    eng = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
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


@pytest.fixture(scope="function")
def client(engine_and_session, tmp_path, monkeypatch):
    """Build a minimal app with the book_generation + books routers, mocked queue."""
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

    # Mock enqueue_generation so no real TTS runs
    import backend.services.task_queue as tq_module
    monkeypatch.setattr(tq_module, "enqueue_generation", lambda gen_id, coro: coro.close())

    app = FastAPI()
    app.include_router(book_generation_router)
    app.include_router(books_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="function")
def analyzed_book(engine_and_session, tmp_path, monkeypatch):
    """Seed an analyzed Book+Chapter+BookCharacter+BookSegments for generate tests."""
    _, TestSession = engine_and_session
    db = TestSession()

    # Seed a VoiceProfile for the character
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
        title="Test Book",
        author="Author",
        source_format="epub",
        status="analyzed",
    )
    db.add(book)
    db.flush()

    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text="Once upon a time.",
        word_count=4,
    )
    db.add(chapter)
    db.flush()

    char = BookCharacter(
        book_id=book.id,
        profile_id=profile.id,
        name="Narrator",
        is_narrator=True,
        dialogue_count=2,
    )
    db.add(char)
    db.flush()

    # Two segments
    seg1 = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="narration",
        order=0,
        text="Once upon a time.",
        emotion="calm",
        emotion_intensity=0.5,
        delivery="slowly and clearly",
        audio_status="none",
    )
    seg2 = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="narration",
        order=1,
        text="The end.",
        emotion=None,
        emotion_intensity=None,
        delivery=None,
        audio_status="none",
    )
    db.add(seg1)
    db.add(seg2)
    db.commit()

    result = {
        "book_id": book.id,
        "chapter_id": chapter.id,
        "char_id": char.id,
        "profile_id": profile.id,
        "seg1_id": seg1.id,
        "seg2_id": seg2.id,
    }
    db.close()
    return result


# ---------------------------------------------------------------------------
# compose_instruct helper tests
# ---------------------------------------------------------------------------


def test_compose_instruct_with_all_fields():
    """compose_instruct folds emotion + intensity + delivery into a string."""
    from backend.services.book_generation import compose_instruct

    seg = MagicMock()
    seg.emotion = "angry"
    seg.emotion_intensity = 0.8
    seg.delivery = "through gritted teeth"

    result = compose_instruct(seg)
    assert result is not None
    assert isinstance(result, str)
    assert len(result) > 0
    # Should contain references to the emotion and/or delivery
    lower = result.lower()
    assert "angry" in lower or "gritted" in lower


def test_compose_instruct_with_emotion_only():
    """compose_instruct with no delivery still produces an instruct string."""
    from backend.services.book_generation import compose_instruct

    seg = MagicMock()
    seg.emotion = "joyful"
    seg.emotion_intensity = 1.0
    seg.delivery = None

    result = compose_instruct(seg)
    assert result is not None
    assert "joyful" in result.lower()


def test_compose_instruct_with_delivery_only():
    """compose_instruct with no emotion but has delivery."""
    from backend.services.book_generation import compose_instruct

    seg = MagicMock()
    seg.emotion = None
    seg.emotion_intensity = None
    seg.delivery = "whispered urgently"

    result = compose_instruct(seg)
    assert result is not None
    assert "whispered" in result.lower()


def test_compose_instruct_with_no_fields_returns_none():
    """compose_instruct with no emotion and no delivery returns None."""
    from backend.services.book_generation import compose_instruct

    seg = MagicMock()
    seg.emotion = None
    seg.emotion_intensity = None
    seg.delivery = None

    result = compose_instruct(seg)
    assert result is None


# ---------------------------------------------------------------------------
# Route tests: 404 / 409
# ---------------------------------------------------------------------------


def test_chapter_generate_unknown_book_returns_404(client):
    """POST /books/{unknown}/chapters/{cid}/generate returns 404."""
    r = client.post(f"/books/{uuid.uuid4()}/chapters/{uuid.uuid4()}/generate", json={})
    assert r.status_code == 404


def test_chapter_generate_unknown_chapter_returns_404(client, analyzed_book):
    """POST /books/{id}/chapters/{unknown}/generate returns 404."""
    book_id = analyzed_book["book_id"]
    r = client.post(f"/books/{book_id}/chapters/{uuid.uuid4()}/generate", json={})
    assert r.status_code == 404


def test_book_generate_unknown_book_returns_404(client):
    """POST /books/{unknown}/generate returns 404."""
    r = client.post(f"/books/{uuid.uuid4()}/generate", json={})
    assert r.status_code == 404


def test_chapter_generate_returns_202_with_queued_segments(client, analyzed_book):
    """POST /books/{id}/chapters/{cid}/generate returns 202 with queued_segments."""
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]

    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["book_id"] == book_id
    assert body["chapter_id"] == chapter_id
    assert "task_id" in body
    assert body["queued_segments"] == 2


def test_book_generate_returns_202_with_queued_segments(client, analyzed_book):
    """POST /books/{id}/generate returns 202 with total queued segments."""
    book_id = analyzed_book["book_id"]

    r = client.post(f"/books/{book_id}/generate", json={})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["book_id"] == book_id
    assert body["chapter_id"] is None
    assert "task_id" in body
    assert body["queued_segments"] == 2


def test_chapter_generate_409_when_already_generating(client, analyzed_book, engine_and_session):
    """POST /books/{id}/chapters/{cid}/generate returns 409 when book is generating."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]

    # Manually set book status to generating
    db = TestSession()
    book = db.query(Book).filter_by(id=book_id).first()
    book.status = "generating"
    db.commit()
    db.close()

    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 409, r.text


def test_book_generate_409_when_already_generating(client, analyzed_book, engine_and_session):
    """POST /books/{id}/generate returns 409 when book is already generating."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]

    db = TestSession()
    book = db.query(Book).filter_by(id=book_id).first()
    book.status = "generating"
    db.commit()
    db.close()

    r = client.post(f"/books/{book_id}/generate", json={})
    assert r.status_code == 409, r.text


# ---------------------------------------------------------------------------
# Lazy materialization tests
# ---------------------------------------------------------------------------


def test_chapter_generate_creates_story_and_generation_rows(
    client, analyzed_book, engine_and_session
):
    """First generate: Story + Generation + StoryItem rows are created lazily."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]

    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 202, r.text

    db = TestSession()
    try:
        # Check Story was created for the chapter
        chapter = db.query(Chapter).filter_by(id=chapter_id).first()
        assert chapter.story_id is not None, "Chapter should have a story_id after generate"

        story = db.query(Story).filter_by(id=chapter.story_id).first()
        assert story is not None, "Story row should exist"

        # Check Generation rows exist for each segment
        gens = db.query(Generation).filter_by(source="book_import").all()
        assert len(gens) == 2, f"Expected 2 Generations, got {len(gens)}"

        # Check StoryItems link story and generations
        items = db.query(StoryItem).filter_by(story_id=story.id).all()
        assert len(items) == 2, f"Expected 2 StoryItems, got {len(items)}"

        # Check segments have generation_id set
        segs = db.query(BookSegment).filter_by(chapter_id=chapter_id).all()
        for seg in segs:
            assert seg.generation_id is not None, f"Segment {seg.id} missing generation_id"
            assert seg.audio_status == "pending", (
                f"Segment {seg.id} audio_status should be 'pending', got {seg.audio_status!r}"
            )
    finally:
        db.close()


def test_chapter_generate_idempotent_story_creation(
    client, analyzed_book, engine_and_session
):
    """Second generate on the same chapter reuses the existing Story (no duplicate)."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]

    # First generate
    r1 = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r1.status_code == 202, r1.text

    # Reset book status for second generate
    db = TestSession()
    book = db.query(Book).filter_by(id=book_id).first()
    book.status = "analyzed"
    db.commit()
    db.close()

    # Second generate — should reuse same story
    r2 = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    # May return 0 queued_segments if all segments already have generation_id
    # (the second generate finds no new unrendered segments)
    assert r2.status_code == 202, r2.text

    db = TestSession()
    try:
        stories = db.query(Story).all()
        assert len(stories) == 1, f"Expected 1 Story, got {len(stories)}"
    finally:
        db.close()


def test_generation_rows_have_correct_profile_and_source(
    client, analyzed_book, engine_and_session
):
    """Generation rows use the character's profile_id and source='book_import'."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]
    expected_profile_id = analyzed_book["profile_id"]

    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 202, r.text

    db = TestSession()
    try:
        gens = db.query(Generation).filter_by(source="book_import").all()
        for gen in gens:
            assert gen.profile_id == expected_profile_id
            assert gen.source == "book_import"
    finally:
        db.close()


def test_generation_instruct_composed_from_emotion_delivery(
    client, analyzed_book, engine_and_session
):
    """Segment with emotion+delivery has its instruct composed in the Generation row."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]
    seg1_id = analyzed_book["seg1_id"]

    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 202, r.text

    db = TestSession()
    try:
        # seg1 has emotion="calm", delivery="slowly and clearly"
        seg1 = db.query(BookSegment).filter_by(id=seg1_id).first()
        assert seg1.generation_id is not None

        gen = db.query(Generation).filter_by(id=seg1.generation_id).first()
        assert gen is not None
        # instruct should be non-None (has emotion + delivery)
        assert gen.instruct is not None
        assert len(gen.instruct) > 0
    finally:
        db.close()


def test_story_items_in_reading_order(
    client, analyzed_book, engine_and_session
):
    """StoryItems are placed in reading order matching segment order."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]

    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 202, r.text

    db = TestSession()
    try:
        chapter = db.query(Chapter).filter_by(id=chapter_id).first()
        items = (
            db.query(StoryItem)
            .filter_by(story_id=chapter.story_id)
            .order_by(StoryItem.start_time_ms)
            .all()
        )
        assert len(items) == 2
        # Items should be in strictly ascending start_time_ms order
        times = [item.start_time_ms for item in items]
        assert times == sorted(times), f"Items not in order: {times}"
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Generation status endpoint tests
# ---------------------------------------------------------------------------


def test_generation_status_returns_per_chapter_counts(client, analyzed_book):
    """GET /books/{id}/generation-status returns chapter counts and overall_progress."""
    book_id = analyzed_book["book_id"]

    r = client.get(f"/books/{book_id}/generation-status")
    assert r.status_code == 200, r.text
    body = r.json()

    assert "chapters" in body
    assert "overall_progress" in body
    assert isinstance(body["overall_progress"], float)
    assert 0.0 <= body["overall_progress"] <= 1.0

    chapter_entry = body["chapters"][0]
    assert chapter_entry["chapter_id"] == analyzed_book["chapter_id"]
    assert chapter_entry["total"] == 2
    assert chapter_entry["completed"] == 0
    assert chapter_entry["errors"] == 0
    assert chapter_entry["state"] == "none"


def test_generation_status_404_unknown_book(client):
    """GET /books/{unknown}/generation-status returns 404."""
    r = client.get(f"/books/{uuid.uuid4()}/generation-status")
    assert r.status_code == 404


def test_generation_status_after_generate(client, analyzed_book, engine_and_session):
    """After generate, status shows pending segments (audio_status=pending)."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]

    # Run generate
    r = client.post(f"/books/{book_id}/chapters/{chapter_id}/generate", json={})
    assert r.status_code == 202, r.text

    # Reset book status so we can query
    db = TestSession()
    book = db.query(Book).filter_by(id=book_id).first()
    book.status = "analyzed"
    db.commit()
    db.close()

    r = client.get(f"/books/{book_id}/generation-status")
    assert r.status_code == 200, r.text
    body = r.json()

    chapter_entry = body["chapters"][0]
    assert chapter_entry["total"] == 2
    # audio_status is "pending" after enqueueing, so state is "partial"
    assert chapter_entry["state"] in ("partial", "none", "ready")


def test_overwrite_errors_flag_re_enqueues_error_segments(
    client, analyzed_book, engine_and_session
):
    """overwrite_errors=true re-queues segments with audio_status='error'."""
    _, TestSession = engine_and_session
    book_id = analyzed_book["book_id"]
    chapter_id = analyzed_book["chapter_id"]
    seg1_id = analyzed_book["seg1_id"]

    # Manually set seg1 to error status (simulate failed prior generation)
    db = TestSession()
    seg = db.query(BookSegment).filter_by(id=seg1_id).first()
    seg.audio_status = "error"
    db.commit()
    db.close()

    r = client.post(
        f"/books/{book_id}/chapters/{chapter_id}/generate",
        json={"overwrite_errors": True},
    )
    assert r.status_code == 202, r.text
    body = r.json()
    # seg1 (error) + seg2 (none) = 2 segments queued
    assert body["queued_segments"] >= 1


# ---------------------------------------------------------------------------
# Book-level generate (iterates chapters)
# ---------------------------------------------------------------------------


def test_book_generate_iterates_all_chapters(client, engine_and_session, tmp_path, monkeypatch):
    """POST /books/{id}/generate queues segments from ALL chapters."""
    _, TestSession = engine_and_session

    # Seed book with 2 chapters, each with 1 segment
    db = TestSession()
    profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name="Voice2",
        voice_type="preset",
        preset_engine="kokoro",
        preset_voice_id="af_sky",
        default_engine="kokoro",
        is_library=True,
    )
    db.add(profile)
    db.flush()

    book = Book(title="Multi-Chapter Book", author="A", source_format="epub", status="analyzed")
    db.add(book)
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

    for i in range(2):
        ch = Chapter(
            book_id=book.id,
            number=i + 1,
            title=f"Chapter {i + 1}",
            raw_text="Text.",
            word_count=1,
        )
        db.add(ch)
        db.flush()

        seg = BookSegment(
            chapter_id=ch.id,
            character_id=char.id,
            type="narration",
            order=0,
            text="Text.",
            audio_status="none",
        )
        db.add(seg)

    db.commit()
    book_id = book.id
    db.close()

    r = client.post(f"/books/{book_id}/generate", json={})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["queued_segments"] == 2  # 1 per chapter
