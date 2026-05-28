"""Tests for GET /books/{book_id}/chapters/{chapter_id}/segments
and PATCH /segments/{segment_id} (B7).

Fixtures seed the DB directly — no analyze pipeline needed.
"""

from __future__ import annotations

import uuid

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
    VoiceProfile,
    get_db,
)
from backend.routes.book_segments import router as segments_router


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
def db_session(engine_and_session):
    """Yield a single DB session for the duration of one test."""
    _, TestSession = engine_and_session
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(scope="function")
def client(engine_and_session):
    """Build a minimal app with the segments router and temp DB."""
    _, TestSession = engine_and_session

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(segments_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c


# Shared book/chapter state for the fixture tree
_BOOK_ID: str = ""
_CHAPTER_ID: str = ""


@pytest.fixture(scope="function")
def seeded(engine_and_session):
    """Seed the DB and return a dict of IDs for all test objects."""
    _, TestSession = engine_and_session
    db = TestSession()

    # Book (normal analyzed state)
    book = Book(
        title="Test Book",
        author="Author",
        source_format="epub",
        status="analyzed",
    )
    db.add(book)
    db.flush()

    # Chapter
    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text="Some text.",
        word_count=2,
    )
    db.add(chapter)
    db.flush()

    # Characters
    narrator = BookCharacter(
        book_id=book.id,
        name="Narrator",
        is_narrator=True,
    )
    char1 = BookCharacter(
        book_id=book.id,
        name="Alice",
        is_narrator=False,
    )
    char2 = BookCharacter(
        book_id=book.id,
        name="Bob",
        is_narrator=False,
    )
    db.add_all([narrator, char1, char2])
    db.flush()

    # Narration segment (order=0)
    narration_seg = BookSegment(
        chapter_id=chapter.id,
        character_id=narrator.id,
        type="narration",
        order=0,
        text="Once upon a time.",
        emotion="neutral",
        emotion_intensity=0.5,
        delivery=None,
        audio_status="none",
    )
    # Dialogue segment (order=1)
    dialogue_seg = BookSegment(
        chapter_id=chapter.id,
        character_id=char1.id,
        type="dialogue",
        order=1,
        text="Hello, world!",
        emotion="happy",
        emotion_intensity=0.7,
        delivery=None,
        audio_status="none",
    )
    db.add_all([narration_seg, dialogue_seg])
    db.flush()

    # A minimal VoiceProfile for the Generation FK
    vp = VoiceProfile(name="test-voice", language="en")
    db.add(vp)
    db.flush()

    # A Generation linked to generated_seg
    gen = Generation(
        profile_id=vp.id,
        text="Old text.",
        audio_path="/fake/path.wav",
        duration=2.5,
        status="completed",
    )
    db.add(gen)
    db.flush()

    # A segment that already has audio (audio_status=completed)
    generated_seg = BookSegment(
        chapter_id=chapter.id,
        character_id=char1.id,
        type="dialogue",
        order=2,
        text="Old text.",
        emotion="calm",
        emotion_intensity=0.3,
        delivery=None,
        generation_id=gen.id,
        audio_status="completed",
    )
    db.add(generated_seg)
    db.flush()

    # A "generating" book/chapter for the 409 test
    gen_book = Book(
        title="Generating Book",
        author="Author",
        source_format="epub",
        status="generating",
    )
    db.add(gen_book)
    db.flush()

    gen_chapter = Chapter(
        book_id=gen_book.id,
        number=1,
        title="Gen Chapter",
        raw_text="Text.",
        word_count=1,
    )
    db.add(gen_chapter)
    db.flush()

    generating_char = BookCharacter(
        book_id=gen_book.id,
        name="GenChar",
        is_narrator=False,
    )
    db.add(generating_char)
    db.flush()

    generating_seg = BookSegment(
        chapter_id=gen_chapter.id,
        character_id=generating_char.id,
        type="dialogue",
        order=0,
        text="Generating...",
        emotion="neutral",
        emotion_intensity=0.5,
        delivery=None,
        audio_status="generating",
    )
    db.add(generating_seg)
    db.flush()

    db.commit()

    result = {
        "book_id": book.id,
        "chapter_id": chapter.id,
        "narrator_id": narrator.id,
        "char1_id": char1.id,
        "char2_id": char2.id,
        "narration_seg_id": narration_seg.id,
        "dialogue_seg_id": dialogue_seg.id,
        "generated_seg_id": generated_seg.id,
        "generating_seg_id": generating_seg.id,
        "gen_id": gen.id,
    }

    db.close()
    return result


@pytest.fixture
def book_id(seeded):
    return seeded["book_id"]


@pytest.fixture
def chapter_id(seeded):
    return seeded["chapter_id"]


@pytest.fixture
def segment_id(seeded):
    return seeded["narration_seg_id"]


@pytest.fixture
def other_character_id(seeded):
    return seeded["char2_id"]


@pytest.fixture
def dialogue_segment_id(seeded):
    return seeded["dialogue_seg_id"]


@pytest.fixture
def generated_segment_id(seeded):
    return seeded["generated_seg_id"]


@pytest.fixture
def generating_segment_id(seeded):
    return seeded["generating_seg_id"]


# ---------------------------------------------------------------------------
# Tests (from task spec)
# ---------------------------------------------------------------------------


def test_list_segments_ordered(client, seeded):
    """GET /books/{id}/chapters/{cid}/segments returns segments ordered by `order`."""
    book_id = seeded["book_id"]
    chapter_id = seeded["chapter_id"]
    r = client.get(f"/books/{book_id}/chapters/{chapter_id}/segments")
    assert r.status_code == 200, r.text
    segs = r.json()
    assert len(segs) > 0
    orders = [s["order"] for s in segs]
    assert orders == sorted(orders), f"Segments not ordered: {orders}"
    assert all("audio" in s for s in segs), "Some segments missing 'audio' field"


def test_list_segments_has_character_name(client, seeded):
    """SegmentResponse carries character_name resolved from BookCharacter."""
    book_id = seeded["book_id"]
    chapter_id = seeded["chapter_id"]
    segs = client.get(f"/books/{book_id}/chapters/{chapter_id}/segments").json()
    # The dialogue segment should have Alice as character_name
    dialogue_segs = [s for s in segs if s["type"] == "dialogue"]
    assert any(s["character_name"] == "Alice" for s in dialogue_segs)


def test_reassign_character(client, seeded):
    """PATCH /segments/{sid} with character_id reassigns the speaker."""
    segment_id = seeded["narration_seg_id"]
    other_character_id = seeded["char2_id"]
    r = client.patch(f"/segments/{segment_id}", json={"character_id": other_character_id})
    assert r.status_code == 200, r.text
    assert r.json()["character_id"] == other_character_id


def test_change_emotion(client, seeded):
    """PATCH /segments/{sid} with emotion and emotion_intensity updates them."""
    segment_id = seeded["narration_seg_id"]
    r = client.patch(
        f"/segments/{segment_id}",
        json={"emotion": "angry", "emotion_intensity": 0.8},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["emotion"] == "angry"
    assert abs(body["emotion_intensity"] - 0.8) < 0.001


def test_edit_text(client, seeded):
    """PATCH /segments/{sid} with text updates the text field."""
    segment_id = seeded["narration_seg_id"]
    r = client.patch(f"/segments/{segment_id}", json={"text": "New words."})
    assert r.status_code == 200, r.text
    assert r.json()["text"] == "New words."


def test_retype_dialogue_to_narration(client, seeded):
    """PATCH /segments/{sid} with type='narration' retypes a dialogue segment."""
    dialogue_segment_id = seeded["dialogue_seg_id"]
    r = client.patch(f"/segments/{dialogue_segment_id}", json={"type": "narration"})
    assert r.status_code == 200, r.text
    assert r.json()["type"] == "narration"


def test_retype_narration_to_dialogue(client, seeded):
    """PATCH /segments/{sid} with type='dialogue' retypes a narration segment."""
    narration_seg_id = seeded["narration_seg_id"]
    r = client.patch(f"/segments/{narration_seg_id}", json={"type": "dialogue"})
    assert r.status_code == 200, r.text
    assert r.json()["type"] == "dialogue"


def test_edit_invalidates_generated_audio(client, seeded):
    """PATCH on a segment with generation_id sets audio_status='stale'."""
    generated_segment_id = seeded["generated_seg_id"]
    r = client.patch(f"/segments/{generated_segment_id}", json={"text": "changed"})
    assert r.status_code == 200, r.text
    assert r.json()["audio"]["status"] == "stale"


def test_patch_while_generating_409(client, seeded):
    """PATCH /segments/{sid} returns 409 when the owning book is generating."""
    generating_segment_id = seeded["generating_seg_id"]
    r = client.patch(f"/segments/{generating_segment_id}", json={"emotion": "calm"})
    assert r.status_code == 409, r.text


def test_unknown_segment_404(client):
    """PATCH /segments/{sid} with unknown id returns 404."""
    r = client.patch("/segments/nope", json={"emotion": "x"})
    assert r.status_code == 404, r.text


def test_audio_object_structure(client, seeded):
    """Segment audio object has expected fields."""
    book_id = seeded["book_id"]
    chapter_id = seeded["chapter_id"]
    segs = client.get(f"/books/{book_id}/chapters/{chapter_id}/segments").json()
    # Find the generated segment (has generation_id and audio path)
    gen_segs = [s for s in segs if s["audio"]["generation_id"] is not None]
    assert len(gen_segs) > 0
    audio = gen_segs[0]["audio"]
    assert "generation_id" in audio
    assert "status" in audio
    # audio_path and duration_ms may be present


def test_list_unknown_book_or_chapter_returns_empty_or_404(client):
    """GET with unknown book_id/chapter_id returns either 404 or empty list."""
    r = client.get(f"/books/nonexistent-book/chapters/nonexistent-chapter/segments")
    # Either 404 or 200 with empty list is acceptable
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert r.json() == []


def test_list_segments_wrong_book_id_returns_404(client, seeded):
    """GET /books/{wrong_book_id}/chapters/{chapter_id}/segments returns 404.

    The chapter exists but belongs to a different book — the endpoint must
    validate the book_id ownership and refuse with 404.
    """
    chapter_id = seeded["chapter_id"]
    wrong_book_id = "not-the-right-book"
    r = client.get(f"/books/{wrong_book_id}/chapters/{chapter_id}/segments")
    assert r.status_code == 404, r.text


def test_change_delivery_invalidates_audio(client, seeded):
    """PATCH a generated segment's delivery field sets audio status to 'stale'.

    The delivery update path in update_segment must mark the segment stale
    when it already has a generation_id.
    """
    generated_segment_id = seeded["generated_seg_id"]
    r = client.patch(
        f"/segments/{generated_segment_id}",
        json={"delivery": "through gritted teeth"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["audio"]["status"] == "stale", (
        f"Expected 'stale' but got '{body['audio']['status']}'"
    )
    assert body["delivery"] == "through gritted teeth"
