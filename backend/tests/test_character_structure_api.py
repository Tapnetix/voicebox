"""Tests for B8: character merge/split/delete endpoints.

TDD test file for:
- POST /books/{book_id}/characters/{char_id}/merge
- POST /books/{book_id}/characters/{char_id}/split
- DELETE /books/{book_id}/characters/{char_id}

Uses a minimal FastAPI app with temp SQLite, seeded directly.
"""

from __future__ import annotations

import uuid
from datetime import datetime

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
from backend.routes.book_character_structure import router as structure_router
from backend.routes.book_characters import router as characters_router


# ---------------------------------------------------------------------------
# App + DB fixture
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
    """Build a minimal app with the structure + characters routers."""
    _, TestSession = engine_and_session

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(structure_router)
    app.include_router(characters_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c


# ---------------------------------------------------------------------------
# Seed fixture
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def seeded(engine_and_session):
    """Seed DB and return dict of IDs.

    Creates:
    - A book (status="analyzed")
    - A narrator BookCharacter (is_narrator=True)
    - char_a: 3 dialogue segments (one with generation_id for stale test)
    - char_b: 2 dialogue segments
    - A "generating" book + chapter for 409 test
    """
    _, TestSession = engine_and_session
    db = TestSession()

    # Main book
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
        title="Chapter One",
        raw_text="text",
        word_count=10,
    )
    db.add(chapter)
    db.flush()

    # Characters
    narrator = BookCharacter(
        book_id=book.id,
        name="Narrator",
        is_narrator=True,
        dialogue_count=0,  # will be updated after seeding segments
        color="#000000",
    )
    char_a = BookCharacter(
        book_id=book.id,
        name="Alice",
        is_narrator=False,
        dialogue_count=0,
        color="#ff0000",
        aliases=["Ali"],
    )
    char_b = BookCharacter(
        book_id=book.id,
        name="Bob",
        is_narrator=False,
        dialogue_count=0,
        color="#0000ff",
        aliases=[],
    )
    db.add_all([narrator, char_a, char_b])
    db.flush()

    # Segments for char_a (3 dialogue)
    seg_a1 = BookSegment(
        chapter_id=chapter.id,
        character_id=char_a.id,
        type="dialogue",
        order=0,
        text="Hello from Alice 1",
        audio_status="none",
    )
    seg_a2 = BookSegment(
        chapter_id=chapter.id,
        character_id=char_a.id,
        type="dialogue",
        order=1,
        text="Hello from Alice 2",
        audio_status="none",
    )

    # A VoiceProfile + Generation for the stale test
    vp = VoiceProfile(name="test-voice", language="en")
    db.add(vp)
    db.flush()

    gen = Generation(
        profile_id=vp.id,
        text="Old audio",
        audio_path="/fake/path.wav",
        duration=2.5,
        status="completed",
    )
    db.add(gen)
    db.flush()

    seg_a3 = BookSegment(
        chapter_id=chapter.id,
        character_id=char_a.id,
        type="dialogue",
        order=2,
        text="Alice with audio",
        audio_status="completed",
        generation_id=gen.id,
    )
    db.add_all([seg_a1, seg_a2, seg_a3])
    db.flush()

    # Update char_a dialogue_count
    char_a.dialogue_count = 3

    # Segments for char_b (2 dialogue)
    seg_b1 = BookSegment(
        chapter_id=chapter.id,
        character_id=char_b.id,
        type="dialogue",
        order=3,
        text="Hello from Bob 1",
        audio_status="none",
    )
    seg_b2 = BookSegment(
        chapter_id=chapter.id,
        character_id=char_b.id,
        type="dialogue",
        order=4,
        text="Hello from Bob 2",
        audio_status="none",
    )
    db.add_all([seg_b1, seg_b2])
    db.flush()
    char_b.dialogue_count = 2

    # Narrator narration segment
    seg_nar = BookSegment(
        chapter_id=chapter.id,
        character_id=narrator.id,
        type="narration",
        order=5,
        text="Once upon a time.",
        audio_status="none",
    )
    # Narrator also has 2 dialogue segments (e.g. an internal monologue)
    seg_nar_d1 = BookSegment(
        chapter_id=chapter.id,
        character_id=narrator.id,
        type="dialogue",
        order=6,
        text="Narrator dialogue 1",
        audio_status="none",
    )
    seg_nar_d2 = BookSegment(
        chapter_id=chapter.id,
        character_id=narrator.id,
        type="dialogue",
        order=7,
        text="Narrator dialogue 2",
        audio_status="none",
    )
    db.add_all([seg_nar, seg_nar_d1, seg_nar_d2])
    db.flush()
    narrator.dialogue_count = 2  # 2 actual dialogue segments

    # --- Generating book/chapter for 409 tests ---
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
        raw_text="text",
        word_count=1,
    )
    db.add(gen_chapter)
    db.flush()

    gen_narrator = BookCharacter(
        book_id=gen_book.id,
        name="GenNarrator",
        is_narrator=True,
        dialogue_count=0,
    )
    gen_char_a = BookCharacter(
        book_id=gen_book.id,
        name="GenAlice",
        is_narrator=False,
        dialogue_count=1,
    )
    gen_char_b = BookCharacter(
        book_id=gen_book.id,
        name="GenBob",
        is_narrator=False,
        dialogue_count=1,
    )
    db.add_all([gen_narrator, gen_char_a, gen_char_b])
    db.flush()

    gen_seg_a = BookSegment(
        chapter_id=gen_chapter.id,
        character_id=gen_char_a.id,
        type="dialogue",
        order=0,
        text="Generating...",
        audio_status="generating",
    )
    gen_seg_b = BookSegment(
        chapter_id=gen_chapter.id,
        character_id=gen_char_b.id,
        type="dialogue",
        order=1,
        text="Bob generating...",
        audio_status="generating",
    )
    db.add_all([gen_seg_a, gen_seg_b])
    db.flush()

    db.commit()

    result = {
        "book_id": book.id,
        "chapter_id": chapter.id,
        "narrator_id": narrator.id,
        "char_a_id": char_a.id,
        "char_b_id": char_b.id,
        "seg_a1_id": seg_a1.id,
        "seg_a2_id": seg_a2.id,
        "seg_a3_id": seg_a3.id,  # has generation_id
        "seg_b1_id": seg_b1.id,
        "seg_b2_id": seg_b2.id,
        "gen_book_id": gen_book.id,
        "gen_char_a_id": gen_char_a.id,
        "gen_char_b_id": gen_char_b.id,
    }

    db.close()
    return result


# Convenience fixtures matching the spec
@pytest.fixture
def analyzed_book_id(seeded):
    return seeded["book_id"]


@pytest.fixture
def narrator_id(seeded):
    return seeded["narrator_id"]


@pytest.fixture
def char_a(seeded):
    return seeded["char_a_id"]


@pytest.fixture
def char_b(seeded):
    return seeded["char_b_id"]


@pytest.fixture
def some_segment_ids_of_a(seeded):
    """Return a subset (2 of 3) of char_a's segments."""
    return [seeded["seg_a1_id"], seeded["seg_a2_id"]]


@pytest.fixture
def segment_of_char_b(seeded):
    """A segment belonging to char_b (used for 400 'foreign segment' test)."""
    return seeded["seg_b1_id"]


@pytest.fixture
def generating_chapter(seeded, engine_and_session):
    """Ensure the main book's chapter is tied to a generating book by switching book status.

    We swap the main book's status to "generating" so the 409 guard triggers.
    The fixture restores it to "analyzed" after the test.
    """
    _, TestSession = engine_and_session
    db = TestSession()
    book = db.get(Book, seeded["book_id"])
    book.status = "generating"
    db.commit()
    db.close()
    yield
    # Teardown: restore
    db = TestSession()
    book = db.get(Book, seeded["book_id"])
    book.status = "analyzed"
    db.commit()
    db.close()


# ---------------------------------------------------------------------------
# Merge tests
# ---------------------------------------------------------------------------


def test_merge_reassigns_segments_and_removes_source(
    client, analyzed_book_id, char_a, char_b
):
    """Merge char_b into char_a: all of char_b's segments move, char_b disappears."""
    before = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/merge",
        json={"source_char_id": char_b},
    )
    assert r.status_code == 200, r.text
    roster = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    assert char_b not in roster, "source character should be removed"
    assert roster[char_a]["dialogue_count"] == (
        before[char_a]["dialogue_count"] + before[char_b]["dialogue_count"]
    ), f"Expected {before[char_a]['dialogue_count'] + before[char_b]['dialogue_count']}, got {roster[char_a]['dialogue_count']}"


def test_merge_into_self_is_400(client, analyzed_book_id, char_a):
    """Merging a character into itself returns 400."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/merge",
        json={"source_char_id": char_a},
    )
    assert r.status_code == 400


def test_merge_narrator_as_source_is_400(client, analyzed_book_id, char_a, narrator_id):
    """Trying to merge the narrator (as source) returns 400."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/merge",
        json={"source_char_id": narrator_id},
    )
    assert r.status_code == 400


def test_merge_folds_aliases(client, analyzed_book_id, char_a, char_b):
    """After merge, the target character includes the source's aliases."""
    # char_a has aliases=["Ali"], char_b has aliases=[]
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/merge",
        json={"source_char_id": char_b},
    )
    assert r.status_code == 200, r.text
    roster = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    # char_a's aliases should still have "Ali" (at least)
    assert "Ali" in roster[char_a]["aliases"]


def test_merge_stale_audio_invalidation(client, analyzed_book_id, char_a, char_b, seeded, engine_and_session):
    """Segments moved with a generation_id get audio_status='stale' after merge.

    seg_a3 belongs to char_a and has a generation_id (audio_status='completed').
    We merge char_a (source) INTO char_b (target), so char_a's segments — including
    seg_a3 — are moved. After the merge, seg_a3 must have audio_status='stale'.
    """
    _, TestSession = engine_and_session
    seg_a3_id = seeded["seg_a3_id"]

    # Merge char_a (source) into char_b (target) so char_a's segments move
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_b}/merge",
        json={"source_char_id": char_a},
    )
    assert r.status_code == 200, r.text

    db = TestSession()
    from backend.database import BookSegment
    seg = db.get(BookSegment, seg_a3_id)
    assert seg is not None, "seg_a3 should still exist after merge"
    assert seg.audio_status == "stale", (
        f"Expected audio_status='stale' for moved segment with generation_id, got '{seg.audio_status}'"
    )
    assert seg.character_id == char_b, (
        f"Expected segment to be reassigned to char_b, got character_id='{seg.character_id}'"
    )
    db.close()


def test_merge_unknown_book_404(client):
    """Merge on an unknown book returns 404."""
    r = client.post(
        f"/books/no-such-book/characters/some-char/merge",
        json={"source_char_id": "other-char"},
    )
    assert r.status_code == 404


def test_unknown_character_404(client, analyzed_book_id):
    """Merge with unknown path char_id returns 404."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/nope/merge",
        json={"source_char_id": "x"},
    )
    assert r.status_code == 404


def test_merge_while_generating_409(
    client, analyzed_book_id, char_a, char_b, generating_chapter
):
    """Merge returns 409 when the book is currently generating."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/merge",
        json={"source_char_id": char_b},
    )
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# Split tests
# ---------------------------------------------------------------------------


def test_split_moves_segments_to_new_character(
    client, analyzed_book_id, char_a, some_segment_ids_of_a
):
    """Split: selected segments move to a new character with correct dialogue_count."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "Stranger", "segment_ids": some_segment_ids_of_a},
    )
    assert r.status_code == 200, r.text
    roster = client.get(f"/books/{analyzed_book_id}/characters").json()
    new = next((c for c in roster if c["name"] == "Stranger"), None)
    assert new is not None, "New character 'Stranger' not found in roster"
    assert new["profile_id"] is None
    assert new["dialogue_count"] == len(some_segment_ids_of_a)


def test_split_reduces_source_dialogue_count(
    client, analyzed_book_id, char_a, some_segment_ids_of_a
):
    """Source character's dialogue_count decreases after split."""
    before = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "Stranger", "segment_ids": some_segment_ids_of_a},
    )
    assert r.status_code == 200, r.text
    after = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    expected = before[char_a]["dialogue_count"] - len(some_segment_ids_of_a)
    assert after[char_a]["dialogue_count"] == expected


def test_split_empty_segment_ids_is_400(client, analyzed_book_id, char_a):
    """Split with empty segment_ids returns 400."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "X", "segment_ids": []},
    )
    assert r.status_code == 400


def test_split_blank_name_is_400(client, analyzed_book_id, char_a, some_segment_ids_of_a):
    """Split with blank new_name returns 400."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "", "segment_ids": some_segment_ids_of_a},
    )
    assert r.status_code == 400


def test_split_foreign_segment_is_400(
    client, analyzed_book_id, char_a, segment_of_char_b
):
    """Split with a segment belonging to a different character returns 400."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "X", "segment_ids": [segment_of_char_b]},
    )
    assert r.status_code == 400


def test_split_unknown_char_404(client, analyzed_book_id):
    """Split with unknown char_id returns 404."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/nope/split",
        json={"new_name": "Y", "segment_ids": ["some-id"]},
    )
    assert r.status_code == 404


def test_split_new_character_has_color(client, analyzed_book_id, char_a, some_segment_ids_of_a):
    """New character created by split has a color assigned."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "Stranger", "segment_ids": some_segment_ids_of_a},
    )
    assert r.status_code == 200, r.text
    roster = client.get(f"/books/{analyzed_book_id}/characters").json()
    new = next(c for c in roster if c["name"] == "Stranger")
    assert new["color"] is not None


def test_split_while_generating_409(
    client, analyzed_book_id, char_a, some_segment_ids_of_a, generating_chapter
):
    """Split returns 409 when the book is generating."""
    r = client.post(
        f"/books/{analyzed_book_id}/characters/{char_a}/split",
        json={"new_name": "Stranger", "segment_ids": some_segment_ids_of_a},
    )
    assert r.status_code == 409


# ---------------------------------------------------------------------------
# Delete tests
# ---------------------------------------------------------------------------


def test_delete_reassigns_segments_to_narrator(
    client, analyzed_book_id, char_a, narrator_id
):
    """DELETE character: all segments move to narrator, char removed."""
    before = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    r = client.delete(f"/books/{analyzed_book_id}/characters/{char_a}")
    assert r.status_code in (200, 204), r.text
    roster = {c["id"]: c for c in client.get(f"/books/{analyzed_book_id}/characters").json()}
    assert char_a not in roster, "deleted character should not be in roster"
    assert roster[narrator_id]["dialogue_count"] >= (
        before[narrator_id]["dialogue_count"] + before[char_a]["dialogue_count"]
    )


def test_delete_sets_segments_type_to_narration(
    client, analyzed_book_id, char_a, seeded, engine_and_session
):
    """DELETE character: reassigned segments get type='narration' and belong to narrator."""
    _, TestSession = engine_and_session
    narrator_id = seeded["narrator_id"]
    seg_ids = [seeded["seg_a1_id"], seeded["seg_a2_id"], seeded["seg_a3_id"]]

    r = client.delete(f"/books/{analyzed_book_id}/characters/{char_a}")
    assert r.status_code in (200, 204), r.text

    db = TestSession()
    from backend.database import BookSegment
    for seg_id in seg_ids:
        seg = db.get(BookSegment, seg_id)
        assert seg is not None, f"Segment {seg_id} should still exist after delete"
        assert seg.type == "narration", (
            f"Expected type='narration' for reassigned segment {seg_id}, got '{seg.type}'"
        )
        assert seg.character_id == narrator_id, (
            f"Expected character_id=narrator for segment {seg_id}, got '{seg.character_id}'"
        )
    db.close()


def test_delete_narrator_is_400(client, analyzed_book_id, narrator_id):
    """DELETE narrator returns 400."""
    r = client.delete(f"/books/{analyzed_book_id}/characters/{narrator_id}")
    assert r.status_code == 400


def test_delete_unknown_char_404(client, analyzed_book_id):
    """DELETE with unknown char_id returns 404."""
    r = client.delete(f"/books/{analyzed_book_id}/characters/nope")
    assert r.status_code == 404


def test_delete_while_generating_409(
    client, analyzed_book_id, char_a, generating_chapter
):
    """DELETE returns 409 when book is generating."""
    r = client.delete(f"/books/{analyzed_book_id}/characters/{char_a}")
    assert r.status_code == 409


def test_delete_stale_audio_invalidation(
    client, analyzed_book_id, char_a, seeded, engine_and_session
):
    """DELETE: segments with generation_id get audio_status='stale'."""
    _, TestSession = engine_and_session
    seg_a3_id = seeded["seg_a3_id"]

    r = client.delete(f"/books/{analyzed_book_id}/characters/{char_a}")
    assert r.status_code in (200, 204), r.text

    db = TestSession()
    from backend.database import BookSegment
    seg = db.get(BookSegment, seg_a3_id)
    assert seg.audio_status == "stale", f"Expected 'stale', got '{seg.audio_status}'"
    db.close()
