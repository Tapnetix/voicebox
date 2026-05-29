"""Tests for segment regeneration endpoint (D3).

POST /segments/{segment_id}/regenerate:
- Creates a new GenerationVersion for the target segment only
- Leaves sibling segments' generations untouched
- Returns {segment_id, generation_id, version_id, status}
- Returns 404 for unknown segment
- Returns 409 if the chapter's book is currently generating
- Enqueues via serial TTS queue (does not synthesize inline)
- Accepts optional {emotion?, instruct?, seed?} body overrides
- Reuses compose_instruct(segment) when no overrides given
"""

import asyncio
import uuid
from unittest.mock import MagicMock, patch, AsyncMock

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
    GenerationVersion,
    Story,
    StoryItem,
    VoiceProfile,
    get_db,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def engine_and_session(tmp_path):
    """Create a temp SQLite engine with all tables."""
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


def _make_enqueue_mock(TestSession):
    """Return an enqueue_generation mock that marks the segment as 'completed'
    and runs any async hooks without real TTS."""

    def _get_test_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    def _run_with_test_db(gen_id, coro):
        import backend.database as _db_module

        # Mark the segment that references this generation_id as completed.
        db = TestSession()
        try:
            segs = (
                db.query(_db_module.BookSegment)
                .filter_by(generation_id=gen_id)
                .all()
            )
            for seg in segs:
                seg.audio_status = "completed"
            db.commit()
        finally:
            db.close()

        original_get_db = _db_module.get_db
        _db_module.get_db = _get_test_db
        try:
            asyncio.run(coro)
        except Exception:
            pass
        finally:
            _db_module.get_db = original_get_db

    return _run_with_test_db


@pytest.fixture(scope="function")
def client(engine_and_session, tmp_path, monkeypatch):
    """Build a minimal app with the book_regenerate router and mocked queue."""
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

    import backend.services.task_queue as tq_module
    monkeypatch.setattr(
        tq_module, "enqueue_generation", _make_enqueue_mock(TestSession)
    )

    from backend.routes.book_regenerate import router as regen_router

    app = FastAPI()
    app.include_router(regen_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="function")
def generated_book(engine_and_session, tmp_path, monkeypatch):
    """Seed a book whose chapter has two already-generated segments.

    Returns a dict with ids needed by each test.
    """
    _, TestSession = engine_and_session
    db = TestSession()

    monkeypatch.setenv("VOICEBOX_DATA_DIR", str(tmp_path))
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    # Voice profile
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
        raw_text="Line one. Line two.",
        word_count=4,
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

    # Story and two Generations (already rendered)
    story = Story(id=str(uuid.uuid4()), name="Chapter 1 Story")
    db.add(story)
    db.flush()
    chapter.story_id = story.id
    db.flush()

    gen1 = Generation(
        id=str(uuid.uuid4()),
        profile_id=profile.id,
        text="Line one.",
        language="en",
        engine="kokoro",
        model_size="1.7B",
        instruct=None,
        source="book_import",
        status="completed",
        audio_path="generations/gen1.wav",
    )
    gen2 = Generation(
        id=str(uuid.uuid4()),
        profile_id=profile.id,
        text="Line two.",
        language="en",
        engine="kokoro",
        model_size="1.7B",
        instruct=None,
        source="book_import",
        status="completed",
        audio_path="generations/gen2.wav",
    )
    db.add(gen1)
    db.add(gen2)
    db.flush()

    # Versions for each generation
    v1 = GenerationVersion(
        id=str(uuid.uuid4()),
        generation_id=gen1.id,
        label="original",
        audio_path="generations/gen1.wav",
        is_default=True,
    )
    v2 = GenerationVersion(
        id=str(uuid.uuid4()),
        generation_id=gen2.id,
        label="original",
        audio_path="generations/gen2.wav",
        is_default=True,
    )
    db.add(v1)
    db.add(v2)
    db.flush()

    # Story items
    si1 = StoryItem(
        id=str(uuid.uuid4()),
        story_id=story.id,
        generation_id=gen1.id,
        start_time_ms=0,
        track=0,
    )
    si2 = StoryItem(
        id=str(uuid.uuid4()),
        story_id=story.id,
        generation_id=gen2.id,
        start_time_ms=1,
        track=0,
    )
    db.add(si1)
    db.add(si2)
    db.flush()

    # Segments linked to their generations
    seg1 = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="narration",
        order=0,
        text="Line one.",
        emotion="calm",
        emotion_intensity=0.5,
        delivery="slowly",
        generation_id=gen1.id,
        audio_status="completed",
    )
    seg2 = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="narration",
        order=1,
        text="Line two.",
        emotion=None,
        emotion_intensity=None,
        delivery=None,
        generation_id=gen2.id,
        audio_status="completed",
    )
    db.add(seg1)
    db.add(seg2)
    db.commit()

    result = {
        "book_id": book.id,
        "chapter_id": chapter.id,
        "seg1_id": seg1.id,
        "seg2_id": seg2.id,
        "gen1_id": gen1.id,
        "gen2_id": gen2.id,
        "v1_id": v1.id,
        "v2_id": v2.id,
        "profile_id": profile.id,
    }
    db.close()
    return result


# ---------------------------------------------------------------------------
# 404 / 409 guard tests
# ---------------------------------------------------------------------------


def test_regenerate_unknown_segment_returns_404(client):
    """POST /segments/{unknown}/regenerate returns 404."""
    resp = client.post("/segments/does-not-exist/regenerate")
    assert resp.status_code == 404


def test_regenerate_returns_409_when_book_generating(
    client, generated_book, engine_and_session
):
    """POST /segments/{id}/regenerate returns 409 if book.status == 'generating'."""
    _, TestSession = engine_and_session
    db = TestSession()
    book = db.query(Book).filter_by(id=generated_book["book_id"]).first()
    book.status = "generating"
    db.commit()
    db.close()

    resp = client.post(f"/segments/{generated_book['seg1_id']}/regenerate")
    assert resp.status_code == 409


# ---------------------------------------------------------------------------
# Happy-path: new GenerationVersion created for target segment only
# ---------------------------------------------------------------------------


def test_regenerate_creates_new_version_for_target_segment(
    client, generated_book, engine_and_session
):
    """A new GenerationVersion is created for the target segment's generation."""
    _, TestSession = engine_and_session

    resp = client.post(f"/segments/{generated_book['seg1_id']}/regenerate")
    assert resp.status_code == 202

    body = resp.json()
    assert body["segment_id"] == generated_book["seg1_id"]
    assert body["generation_id"] == generated_book["gen1_id"]
    assert "version_id" in body
    assert body["version_id"] != generated_book["v1_id"]
    assert body["status"] == "pending"

    # Verify the new version is in the DB
    db = TestSession()
    new_version = (
        db.query(GenerationVersion).filter_by(id=body["version_id"]).first()
    )
    assert new_version is not None
    assert new_version.generation_id == generated_book["gen1_id"]
    db.close()


def test_regenerate_does_not_touch_sibling_segment(
    client, generated_book, engine_and_session
):
    """Regenerating seg1 leaves seg2's generation and versions untouched."""
    _, TestSession = engine_and_session

    # Record sibling's state before
    db = TestSession()
    sibling_versions_before = (
        db.query(GenerationVersion)
        .filter_by(generation_id=generated_book["gen2_id"])
        .count()
    )
    sibling_seg_before = (
        db.query(BookSegment).filter_by(id=generated_book["seg2_id"]).first()
    )
    sibling_gen_before = sibling_seg_before.generation_id
    db.close()

    client.post(f"/segments/{generated_book['seg1_id']}/regenerate")

    # Check sibling is unchanged
    db = TestSession()
    sibling_versions_after = (
        db.query(GenerationVersion)
        .filter_by(generation_id=generated_book["gen2_id"])
        .count()
    )
    sibling_seg_after = (
        db.query(BookSegment).filter_by(id=generated_book["seg2_id"]).first()
    )
    assert sibling_versions_after == sibling_versions_before
    assert sibling_seg_after.generation_id == sibling_gen_before
    db.close()


# ---------------------------------------------------------------------------
# Optional body overrides
# ---------------------------------------------------------------------------


def test_regenerate_accepts_optional_body(client, generated_book):
    """POST /segments/{id}/regenerate accepts emotion/instruct/seed overrides."""
    resp = client.post(
        f"/segments/{generated_book['seg1_id']}/regenerate",
        json={"emotion": "angry", "instruct": "through gritted teeth", "seed": 42},
    )
    assert resp.status_code == 202


def test_regenerate_with_empty_body(client, generated_book):
    """POST /segments/{id}/regenerate works with an empty body."""
    resp = client.post(
        f"/segments/{generated_book['seg1_id']}/regenerate", json={}
    )
    assert resp.status_code == 202


# ---------------------------------------------------------------------------
# Service-level unit tests
# ---------------------------------------------------------------------------


def test_regenerate_segment_service_creates_version(
    temp_db, generated_book, monkeypatch, tmp_path
):
    """regenerate_segment() returns a RegenerateResponse and new version exists."""
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    # Mock enqueue_generation to prevent real TTS
    enqueue_calls = []

    def mock_enqueue(gen_id, coro):
        enqueue_calls.append(gen_id)
        # Drain the coroutine so we don't leak it
        try:
            asyncio.run(coro)
        except Exception:
            pass

    import backend.services.task_queue as tq_module
    monkeypatch.setattr(tq_module, "enqueue_generation", mock_enqueue)

    from backend.services.book_regenerate import regenerate_segment

    result = regenerate_segment(generated_book["seg1_id"], db=temp_db)

    assert result.segment_id == generated_book["seg1_id"]
    assert result.generation_id == generated_book["gen1_id"]
    assert result.version_id is not None
    assert result.status == "pending"


def test_regenerate_segment_service_404_unknown(temp_db):
    """regenerate_segment() raises HTTPException(404) for unknown segment."""
    from fastapi import HTTPException
    from backend.services.book_regenerate import regenerate_segment

    with pytest.raises(HTTPException) as exc_info:
        regenerate_segment("does-not-exist", db=temp_db)
    assert exc_info.value.status_code == 404


def test_regenerate_segment_service_409_when_generating(
    temp_db, generated_book, engine_and_session
):
    """regenerate_segment() raises HTTPException(409) when book is generating."""
    _, TestSession = engine_and_session
    db = TestSession()
    book = db.query(Book).filter_by(id=generated_book["book_id"]).first()
    book.status = "generating"
    db.commit()
    db.close()

    from fastapi import HTTPException
    from backend.services.book_regenerate import regenerate_segment

    with pytest.raises(HTTPException) as exc_info:
        regenerate_segment(generated_book["seg1_id"], db=temp_db)
    assert exc_info.value.status_code == 409


def test_regenerate_segment_uses_compose_instruct_by_default(
    temp_db, generated_book, monkeypatch, tmp_path
):
    """When no instruct override, compose_instruct(segment) is used."""
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    enqueued_instrcuts = []

    def mock_enqueue(gen_id, coro):
        try:
            asyncio.run(coro)
        except Exception:
            pass

    import backend.services.task_queue as tq_module
    monkeypatch.setattr(tq_module, "enqueue_generation", mock_enqueue)

    # Patch run_generation to capture its instruct argument
    captured = {}

    async def mock_run_generation(**kwargs):
        captured.update(kwargs)

    import backend.services.generation as gen_module
    monkeypatch.setattr(gen_module, "run_generation", mock_run_generation)

    from backend.services.book_regenerate import regenerate_segment

    regenerate_segment(generated_book["seg1_id"], db=temp_db)

    # seg1 has emotion="calm", emotion_intensity=0.5, delivery="slowly"
    # compose_instruct should produce "calm, slowly" (or similar)
    assert "instruct" in captured
    assert captured["instruct"] is not None
    assert "calm" in captured["instruct"].lower() or "slowly" in captured["instruct"].lower()


def test_regenerate_segment_instruct_override_used(
    temp_db, generated_book, monkeypatch, tmp_path
):
    """When instruct override provided, it is forwarded to run_generation."""
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    def mock_enqueue(gen_id, coro):
        try:
            asyncio.run(coro)
        except Exception:
            pass

    import backend.services.task_queue as tq_module
    monkeypatch.setattr(tq_module, "enqueue_generation", mock_enqueue)

    captured = {}

    async def mock_run_generation(**kwargs):
        captured.update(kwargs)

    import backend.services.generation as gen_module
    monkeypatch.setattr(gen_module, "run_generation", mock_run_generation)

    from backend.services.book_regenerate import regenerate_segment

    regenerate_segment(
        generated_book["seg1_id"],
        instruct="whispering menacingly",
        db=temp_db,
    )

    assert captured.get("instruct") == "whispering menacingly"
