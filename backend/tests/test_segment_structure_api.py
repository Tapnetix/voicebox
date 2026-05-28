"""Tests for B9: segment split and merge endpoints.

POST /segments/{segment_id}/split
POST /segments/merge
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
from backend.routes.book_segment_structure import router as structure_router
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
def client(engine_and_session):
    """Build minimal app with structure + segments routers and temp DB."""
    _, TestSession = engine_and_session

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(structure_router)
    app.include_router(segments_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="function")
def seeded(engine_and_session):
    """Seed DB and return IDs for all test objects."""
    _, TestSession = engine_and_session
    db = TestSession()

    # Normal book (analyzed state)
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
        raw_text="Hello there friend. Also a line. Third line.",
        word_count=9,
    )
    db.add(chapter)
    db.flush()

    char = BookCharacter(
        book_id=book.id,
        name="Alice",
        is_narrator=False,
    )
    db.add(char)
    db.flush()

    # Segment for split tests: text = "Hello there friend"
    split_seg = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="dialogue",
        order=0,
        text="Hello there friend",
        emotion="happy",
        emotion_intensity=0.7,
        delivery="softly",
        audio_status="none",
    )
    # Two adjacent segments for merge
    merge_seg_a = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="dialogue",
        order=1,
        text="First part",
        emotion="neutral",
        emotion_intensity=0.5,
        delivery=None,
        audio_status="none",
    )
    merge_seg_b = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="dialogue",
        order=2,
        text="second part",
        emotion="neutral",
        emotion_intensity=0.5,
        delivery=None,
        audio_status="none",
    )
    # Non-adjacent segment (order=3, will be order=3 after merge_seg_a and merge_seg_b)
    non_adjacent_seg = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="dialogue",
        order=3,
        text="Far away",
        emotion="neutral",
        emotion_intensity=0.5,
        delivery=None,
        audio_status="none",
    )
    db.add_all([split_seg, merge_seg_a, merge_seg_b, non_adjacent_seg])
    db.flush()

    # A minimal VoiceProfile for Generation FK
    vp = VoiceProfile(name="test-voice", language="en")
    db.add(vp)
    db.flush()

    # A generation for the "generated segment with text" fixture
    gen = Generation(
        profile_id=vp.id,
        text="Hello there friend",
        audio_path="/fake/path.wav",
        duration=2.5,
        status="completed",
    )
    db.add(gen)
    db.flush()

    # Segment with a generation (to test stale invalidation on split)
    generated_split_seg = BookSegment(
        chapter_id=chapter.id,
        character_id=char.id,
        type="dialogue",
        order=4,
        text="Split me generated",
        emotion="calm",
        emotion_intensity=0.3,
        delivery=None,
        generation_id=gen.id,
        audio_status="completed",
    )
    db.add(generated_split_seg)
    db.flush()

    # "Generating" book/chapter for 409 test
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

    gen_char = BookCharacter(
        book_id=gen_book.id,
        name="GenChar",
        is_narrator=False,
    )
    db.add(gen_char)
    db.flush()

    generating_seg = BookSegment(
        chapter_id=gen_chapter.id,
        character_id=gen_char.id,
        type="dialogue",
        order=0,
        text="Generating text here",
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
        "char_id": char.id,
        "split_seg_id": split_seg.id,
        "split_seg_text": split_seg.text,
        "merge_seg_a_id": merge_seg_a.id,
        "merge_seg_b_id": merge_seg_b.id,
        "non_adjacent_seg_id": non_adjacent_seg.id,
        "generated_split_seg_id": generated_split_seg.id,
        "generated_split_seg_text": generated_split_seg.text,
        "generating_seg_id": generating_seg.id,
        "generating_seg_text": generating_seg.text,
    }
    db.close()
    return result


@pytest.fixture
def a_segment_with_text(seeded):
    return seeded["split_seg_id"], seeded["split_seg_text"]


@pytest.fixture
def two_adjacent_segment_ids(seeded):
    return seeded["merge_seg_a_id"], seeded["merge_seg_b_id"]


@pytest.fixture
def non_adjacent_segment_ids(seeded):
    # split_seg (order=0) and non_adjacent_seg (order=3) are not adjacent
    return [seeded["split_seg_id"], seeded["non_adjacent_seg_id"]]


@pytest.fixture
def a_segment_id(seeded):
    return seeded["split_seg_id"]


@pytest.fixture
def generated_segment_with_text(seeded):
    return seeded["generated_split_seg_id"], seeded["generated_split_seg_text"]


@pytest.fixture
def generating_segment_with_text(seeded):
    return seeded["generating_seg_id"], seeded["generating_seg_text"]


# ---------------------------------------------------------------------------
# Helper
# ---------------------------------------------------------------------------


def merged_chapter_segments_url(merged: dict) -> str:
    """Build a list-segments URL from the merged segment response."""
    chapter_id = merged["chapter_id"]
    # We need the book_id — we'll use a different approach in the test
    # Actually we need the book_id from the DB. Instead, we'll test ordering
    # directly via the segments router using the chapter_id available.
    # Since we can't easily get book_id from the merged response alone,
    # we embed the chapter_id and look it up.
    return f"/chapters/{chapter_id}/segments_for_test"


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_split_produces_two_segments(client, a_segment_with_text, seeded):
    """POST /segments/{sid}/split returns two segments with correct split."""
    sid, text = a_segment_with_text
    # text = "Hello there friend", split at 'friend'
    at = text.index("friend")
    r = client.post(f"/segments/{sid}/split", json={"at_offset": at})
    assert r.status_code == 200, r.text
    data = r.json()
    assert len(data) == 2, f"Expected 2 segments, got {len(data)}"
    first, second = data
    assert first["text"].strip() == "Hello there"
    assert second["text"].strip() == "friend"
    assert second["order"] == first["order"] + 1
    assert second["character_id"] == first["character_id"]  # inherits, reassignable later


def test_split_inherits_type_emotion_delivery(client, a_segment_with_text):
    """New segment after split inherits type, emotion, emotion_intensity, delivery."""
    sid, text = a_segment_with_text
    at = text.index("friend")
    r = client.post(f"/segments/{sid}/split", json={"at_offset": at})
    assert r.status_code == 200, r.text
    first, second = r.json()
    assert second["type"] == first["type"]
    assert second["emotion"] == first["emotion"]
    assert second["emotion_intensity"] == first["emotion_intensity"]
    assert second["delivery"] == first["delivery"]


def test_split_renumbers_later_segments(client, a_segment_with_text, seeded):
    """After split, all later segments in chapter have order bumped by 1."""
    sid, text = a_segment_with_text
    at = text.index("friend")
    r = client.post(f"/segments/{sid}/split", json={"at_offset": at})
    assert r.status_code == 200, r.text
    # After split, the chapter has one more segment; orders must be contiguous 0..n-1
    book_id = seeded["book_id"]
    chapter_id = seeded["chapter_id"]
    segs_r = client.get(f"/books/{book_id}/chapters/{chapter_id}/segments")
    assert segs_r.status_code == 200, segs_r.text
    segs = segs_r.json()
    orders = [s["order"] for s in segs]
    assert orders == list(range(len(segs))), f"Orders not contiguous: {orders}"


def test_split_at_edge_is_400(client, a_segment_with_text):
    """400 when at_offset is 0 or >= len(text)."""
    sid, text = a_segment_with_text
    assert client.post(f"/segments/{sid}/split", json={"at_offset": 0}).status_code == 400
    assert client.post(f"/segments/{sid}/split", json={"at_offset": len(text)}).status_code == 400


def test_split_negative_offset_is_400(client, a_segment_with_text):
    """400 when at_offset is negative."""
    sid, _ = a_segment_with_text
    assert client.post(f"/segments/{sid}/split", json={"at_offset": -1}).status_code == 400


def test_merge_adjacent_segments(client, two_adjacent_segment_ids, seeded):
    """POST /segments/merge merges two adjacent segments into one."""
    a, b = two_adjacent_segment_ids
    r = client.post("/segments/merge", json={"segment_ids": [a, b]})
    assert r.status_code == 200, r.text
    merged = r.json()
    assert merged["id"] == a  # first id survives as the merged row
    assert "First part" in merged["text"]
    assert "second part" in merged["text"]
    # Verify chapter orders are contiguous
    book_id = seeded["book_id"]
    chapter_id = seeded["chapter_id"]
    segs_r = client.get(f"/books/{book_id}/chapters/{chapter_id}/segments")
    assert segs_r.status_code == 200, segs_r.text
    segs = segs_r.json()
    orders = [s["order"] for s in segs]
    assert orders == list(range(len(segs))), f"Orders not contiguous after merge: {orders}"


def test_merge_keeps_first_segment_metadata(client, two_adjacent_segment_ids, seeded):
    """Merged segment keeps first segment's character_id, type, emotion, delivery."""
    a, b = two_adjacent_segment_ids
    r = client.post("/segments/merge", json={"segment_ids": [a, b]})
    assert r.status_code == 200, r.text
    merged = r.json()
    # The first segment (merge_seg_a) had char.id, type=dialogue
    assert merged["character_id"] == seeded["char_id"]
    assert merged["type"] == "dialogue"


def test_merge_non_adjacent_is_400(client, non_adjacent_segment_ids):
    """400 when merging non-adjacent segments (gap in order)."""
    r = client.post("/segments/merge", json={"segment_ids": non_adjacent_segment_ids})
    assert r.status_code == 400, r.text


def test_merge_single_id_is_400(client, a_segment_id):
    """400 when only one segment_id is provided to merge."""
    assert client.post("/segments/merge", json={"segment_ids": [a_segment_id]}).status_code == 400


def test_merge_empty_ids_is_400(client):
    """400 when segment_ids is empty."""
    assert client.post("/segments/merge", json={"segment_ids": []}).status_code == 400


def test_split_invalidates_generated_audio(client, generated_segment_with_text):
    """Splitting a segment with generation_id sets first segment audio_status='stale'."""
    sid, text = generated_segment_with_text
    # text = "Split me generated", split at offset 3 ("Spl" | "it me generated")
    r = client.post(f"/segments/{sid}/split", json={"at_offset": 3})
    assert r.status_code == 200, r.text
    first, second = r.json()
    assert first["audio"]["status"] == "stale"
    # second segment has no generation
    assert second["audio"]["status"] == "none"


def test_split_while_generating_409(client, generating_segment_with_text):
    """409 when the owning book is currently generating."""
    sid, text = generating_segment_with_text
    assert client.post(f"/segments/{sid}/split", json={"at_offset": 3}).status_code == 409


def test_split_unknown_segment_404(client):
    """404 for unknown segment id in split."""
    assert client.post("/segments/nope/split", json={"at_offset": 1}).status_code == 404


def test_merge_unknown_segment_404(client, a_segment_id):
    """404 when one of the segment_ids is unknown."""
    r = client.post(
        "/segments/merge",
        json={"segment_ids": [a_segment_id, "nonexistent-id"]},
    )
    assert r.status_code == 404, r.text


def test_merge_mixed_chapters_is_400(client, engine_and_session, seeded):
    """400 when merging segments from different chapters."""
    _, TestSession = engine_and_session
    db = TestSession()

    # Create a segment in a different chapter
    book2 = Book(title="Book 2", source_format="epub", status="analyzed")
    db.add(book2)
    db.flush()
    chapter2 = Chapter(book_id=book2.id, number=1, raw_text="x", word_count=1)
    db.add(chapter2)
    db.flush()
    char2 = BookCharacter(book_id=book2.id, name="Bob", is_narrator=False)
    db.add(char2)
    db.flush()
    other_seg = BookSegment(
        chapter_id=chapter2.id,
        character_id=char2.id,
        type="dialogue",
        order=0,
        text="Other chapter segment",
        audio_status="none",
    )
    db.add(other_seg)
    db.commit()
    other_seg_id = other_seg.id
    db.close()

    a, _ = seeded["merge_seg_a_id"], seeded["merge_seg_b_id"]
    r = client.post("/segments/merge", json={"segment_ids": [a, other_seg_id]})
    assert r.status_code == 400, r.text


def test_merge_while_generating_409(client, engine_and_session):
    """409 when merging segments in a currently generating chapter."""
    _, TestSession = engine_and_session
    db = TestSession()

    gen_book = Book(title="Gen Book 2", source_format="epub", status="generating")
    db.add(gen_book)
    db.flush()
    gen_chapter = Chapter(book_id=gen_book.id, number=1, raw_text="x", word_count=1)
    db.add(gen_chapter)
    db.flush()
    gen_char = BookCharacter(book_id=gen_book.id, name="GC", is_narrator=False)
    db.add(gen_char)
    db.flush()
    seg1 = BookSegment(
        chapter_id=gen_chapter.id,
        character_id=gen_char.id,
        type="dialogue",
        order=0,
        text="Seg one",
        audio_status="none",
    )
    seg2 = BookSegment(
        chapter_id=gen_chapter.id,
        character_id=gen_char.id,
        type="dialogue",
        order=1,
        text="Seg two",
        audio_status="none",
    )
    db.add_all([seg1, seg2])
    db.commit()
    seg1_id, seg2_id = seg1.id, seg2.id
    db.close()

    r = client.post("/segments/merge", json={"segment_ids": [seg1_id, seg2_id]})
    assert r.status_code == 409, r.text
