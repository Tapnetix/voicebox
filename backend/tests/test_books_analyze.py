"""Tests for POST /books/{id}/analyze (B4).

Tests:
- 202 response with status=analyzing
- 409 conflict when book is already analyzing or generating
- Materialization of rows and event ordering (character_detected before analysis_complete)
"""

import asyncio
import io
import uuid
from unittest.mock import AsyncMock

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, Book, BookCharacter, BookSegment, Chapter, get_db
from backend.routes.book_analysis import router as book_analysis_router
from backend.routes.books import router as books_router


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _epub_bytes() -> bytes:
    """Build a minimal valid EPUB in memory."""
    from ebooklib import epub

    b = epub.EpubBook()
    b.set_title("Silo")
    b.add_author("Hugh Howey")

    chapter = epub.EpubHtml(title="Chapter 1", file_name="c1.xhtml")
    chapter.content = "<p>Dark night of the soul. \"Help me,\" said Holston. \"No,\" said Allison.</p>"
    b.add_item(chapter)

    b.spine = ["nav", chapter]
    b.add_item(epub.EpubNcx())
    b.add_item(epub.EpubNav())

    buf = io.BytesIO()
    epub.write_epub(buf, b)
    return buf.getvalue()


def _make_fake_book_analysis(character_names: list[str]):
    """Build a BookAnalysis-like object with given character names."""
    from backend.services.literary_analysis import BookAnalysis, ChapterAnalysis

    characters = [
        {"name": name, "dialogue_count": 2, "confidence": 0.9}
        for name in character_names
    ]
    segments = [
        {"type": "narration", "text": "Dark night.", "order": 0, "speaker": None, "emotion": None, "intensity": None},
        {"type": "dialogue", "text": "Help me.", "order": 1, "speaker": character_names[0], "emotion": None, "intensity": None},
    ]
    chapter = ChapterAnalysis(segments=segments, characters=characters, flagged=False)
    return BookAnalysis(chapters=[chapter], characters=characters)


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
    """Build a minimal app with a temp SQLite DB and the books + book_analysis routers."""
    _, TestSession = engine_and_session

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    # Point the data dir at tmp_path so cover files go somewhere writable
    monkeypatch.setenv("VOICEBOX_DATA_DIR", str(tmp_path))
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    # Prevent the background task from running actual analysis in route tests.
    # We mock enqueue_analysis to just flip the status without starting a real task.
    import backend.services.book_analysis as ba_svc

    def mock_enqueue(book_id, model_size, narrator_voice_id):
        """Flip status synchronously, return a fake task_id, don't run pipeline."""
        db = TestSession()
        try:
            book = db.query(Book).filter_by(id=book_id).first()
            if book is not None:
                book.status = "analyzing"
                db.commit()
        finally:
            db.close()
        return str(uuid.uuid4())

    monkeypatch.setattr(ba_svc, "enqueue_analysis", mock_enqueue)

    app = FastAPI()
    # book_analysis_router must be registered before books_router so the real
    # route takes precedence over the stub in books.py (belt-and-suspenders;
    # the stub is also removed, but this ordering is the canonical rule).
    app.include_router(book_analysis_router)
    app.include_router(books_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="function")
def book_id(client):
    """Import a book and return its id."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    r = client.post("/books/import", files=files)
    assert r.status_code == 200, r.text
    return r.json()["id"]


@pytest.fixture(scope="function")
def seeded_book_id(temp_db):
    """Seed a Book+Chapter directly for the materialization test."""
    book = Book(title="Silo", author="Hugh Howey", source_format="epub", status="imported")
    temp_db.add(book)
    temp_db.flush()

    chapter = Chapter(
        book_id=book.id,
        number=1,
        title="Chapter 1",
        raw_text='Dark night. "Help me," said Holston. "No," said Allison.',
        word_count=12,
    )
    temp_db.add(chapter)
    temp_db.commit()
    temp_db.refresh(book)
    return book.id


# ---------------------------------------------------------------------------
# Route tests (202 / 409)
# ---------------------------------------------------------------------------


def test_analyze_returns_202_and_sets_status(client, book_id):
    """POST /books/{id}/analyze returns 202 with status=analyzing."""
    r = client.post(f"/books/{book_id}/analyze", json={"model_size": "1.7B"})
    assert r.status_code == 202, r.text
    body = r.json()
    assert body["status"] == "analyzing"
    assert body["book_id"] == book_id
    assert "task_id" in body


def test_analyze_unknown_book_returns_404(client):
    """POST /books/{unknown}/analyze returns 404."""
    r = client.post(f"/books/{uuid.uuid4()}/analyze", json={})
    assert r.status_code == 404


def test_analyze_conflict_when_already_analyzing(client, book_id, engine_and_session):
    """POST /books/{id}/analyze 409s when book is already analyzing."""
    _, TestSession = engine_and_session
    # Manually set status to analyzing in the DB
    db = TestSession()
    book = db.query(Book).filter_by(id=book_id).first()
    book.status = "analyzing"
    db.commit()
    db.close()

    r = client.post(f"/books/{book_id}/analyze", json={})
    assert r.status_code == 409, r.text


def test_analyze_conflict_when_generating(client, book_id, engine_and_session):
    """POST /books/{id}/analyze 409s when book is already generating."""
    _, TestSession = engine_and_session
    db = TestSession()
    book = db.query(Book).filter_by(id=book_id).first()
    book.status = "generating"
    db.commit()
    db.close()

    r = client.post(f"/books/{book_id}/analyze", json={})
    assert r.status_code == 409, r.text


def test_analyze_empty_body_accepted(client, book_id):
    """POST /books/{id}/analyze with no body (defaults) returns 202."""
    r = client.post(f"/books/{book_id}/analyze", json={})
    assert r.status_code == 202


# ---------------------------------------------------------------------------
# Materialization + event ordering tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_materialization_creates_rows_and_emits_events(
    temp_db, seeded_book_id, monkeypatch
):
    """run_analysis_task creates BookCharacter+BookSegment rows and emits events in order."""
    from backend.services import book_analysis, book_events, literary_analysis, voice_casting

    fake_analysis = _make_fake_book_analysis(["Holston", "Allison"])

    async def fake_analyze_book(chapters, model_size=None):
        return fake_analysis

    monkeypatch.setattr(literary_analysis, "analyze_book", fake_analyze_book)
    monkeypatch.setattr(voice_casting, "cast_book", lambda *a, **k: None)

    seen = []
    monkeypatch.setattr(book_events, "publish", lambda bid, p: seen.append(p))

    await book_analysis.run_analysis_task(
        seeded_book_id, model_size="1.7B", db=temp_db
    )

    # Characters: 2 named + 1 narrator = at least 3
    char_count = temp_db.query(BookCharacter).filter_by(book_id=seeded_book_id).count()
    assert char_count >= 3, f"Expected >= 3 BookCharacters, got {char_count}"

    # Segments should have been created
    seg_count = temp_db.query(BookSegment).count()
    assert seg_count > 0, "Expected at least one BookSegment"

    # Event ordering: character_detected must appear before analysis_complete
    types = [p["type"] for p in seen]
    assert "character_detected" in types, f"Missing character_detected events; saw: {types}"
    assert "analysis_complete" in types, f"Missing analysis_complete event; saw: {types}"
    first_detected_idx = types.index("character_detected")
    complete_idx = types.index("analysis_complete")
    assert first_detected_idx < complete_idx, (
        f"character_detected (idx {first_detected_idx}) must come before "
        f"analysis_complete (idx {complete_idx})"
    )

    # Book status should be "analyzed" on success
    temp_db.refresh(temp_db.query(Book).filter_by(id=seeded_book_id).first())
    book = temp_db.query(Book).filter_by(id=seeded_book_id).first()
    assert book.status == "analyzed"


@pytest.mark.asyncio
async def test_materialization_emits_analysis_progress_events(
    temp_db, seeded_book_id, monkeypatch
):
    """run_analysis_task emits analysis_progress events at key stages."""
    from backend.services import book_analysis, book_events, literary_analysis, voice_casting

    fake_analysis = _make_fake_book_analysis(["Holston"])

    async def fake_analyze_book(chapters, model_size=None):
        return fake_analysis

    monkeypatch.setattr(literary_analysis, "analyze_book", fake_analyze_book)
    monkeypatch.setattr(voice_casting, "cast_book", lambda *a, **k: None)

    seen = []
    monkeypatch.setattr(book_events, "publish", lambda bid, p: seen.append(p))

    await book_analysis.run_analysis_task(
        seeded_book_id, model_size="1.7B", db=temp_db
    )

    progress_stages = [
        p.get("stage") for p in seen if p.get("type") == "analysis_progress"
    ]
    assert len(progress_stages) >= 1, "Expected at least one analysis_progress event"


@pytest.mark.asyncio
async def test_error_flips_status_and_emits_error_event(
    temp_db, seeded_book_id, monkeypatch
):
    """run_analysis_task flips status=error and emits an error event on failure."""
    from backend.services import book_analysis, book_events, literary_analysis

    async def failing_analyze(chapters, model_size=None):
        raise RuntimeError("LLM exploded")

    monkeypatch.setattr(literary_analysis, "analyze_book", failing_analyze)

    seen = []
    monkeypatch.setattr(book_events, "publish", lambda bid, p: seen.append(p))

    await book_analysis.run_analysis_task(
        seeded_book_id, model_size="1.7B", db=temp_db
    )

    book = temp_db.query(Book).filter_by(id=seeded_book_id).first()
    assert book.status == "error"

    error_events = [p for p in seen if p.get("type") == "error"]
    assert len(error_events) >= 1, f"Expected error event; saw: {[p['type'] for p in seen]}"


# ---------------------------------------------------------------------------
# enqueue_analysis entry-point test
# ---------------------------------------------------------------------------


def test_enqueue_analysis_flips_status_and_returns_task_id(
    engine_and_session, monkeypatch
):
    """enqueue_analysis flips book.status to 'analyzing' and returns a non-empty task_id.

    Calls enqueue_analysis directly with:
    - a real temp DB (seeded with a Book)
    - task_queue.create_background_task monkeypatched to a no-op (no real pipeline)
    - database.get_db redirected to the temp TestSession
    """
    import backend.database as db_module
    import backend.services.task_queue as tq_module
    from backend.services import book_analysis as ba_svc

    _, TestSession = engine_and_session

    # Seed a Book in the temp DB
    db = TestSession()
    book = Book(title="Enqueue Test", author="Test", source_format="epub", status="imported")
    db.add(book)
    db.commit()
    db.refresh(book)
    book_id = book.id
    db.close()

    # Redirect database.get_db so enqueue_analysis obtains sessions from the temp DB
    def fake_get_db():
        session = TestSession()
        try:
            yield session
        finally:
            session.close()

    monkeypatch.setattr(db_module, "get_db", fake_get_db)

    # Stub out task_queue.create_background_task — return a dummy task object.
    # Close the coroutine immediately to suppress "coroutine was never awaited" warnings.
    class _DummyTask:
        pass

    def _noop_create_background_task(coro):
        coro.close()
        return _DummyTask()

    monkeypatch.setattr(tq_module, "create_background_task", _noop_create_background_task)

    # Call the production entry-point
    task_id = ba_svc.enqueue_analysis(book_id, "1.7B", "auto")

    # Assert: task_id is a non-empty string
    assert isinstance(task_id, str) and len(task_id) > 0, (
        f"Expected non-empty task_id string, got {task_id!r}"
    )

    # Assert: book.status is now "analyzing" in the DB
    verify_db = TestSession()
    try:
        refreshed = verify_db.query(Book).filter_by(id=book_id).first()
        assert refreshed is not None, "Book disappeared from DB"
        assert refreshed.status == "analyzing", (
            f"Expected status='analyzing', got {refreshed.status!r}"
        )
    finally:
        verify_db.close()


# ---------------------------------------------------------------------------
# Fix 1: Integration test — analysis→casting seam (role + VoiceProfile type)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_integration_major_gets_designed_minor_gets_preset(
    temp_db, seeded_book_id, monkeypatch
):
    """Integration: run_analysis_task with real cast_book (not mocked).

    A major character (role='major', vocal_description set) must receive a
    VoiceProfile with voice_type='designed'.
    A minor character (role='minor') must receive a VoiceProfile with
    voice_type='preset' (given a Kokoro language + non-exhausted pool).
    """
    from backend.database import VoiceProfile
    from backend.services import book_analysis, book_events, literary_analysis
    from backend.services.literary_analysis import BookAnalysis, ChapterAnalysis

    # Realistic mock output: Holston is major (high dialogue count, vocal desc),
    # Allison is minor.
    major_char = {
        "name": "Holston",
        "dialogue_count": 10,
        "confidence": 0.95,
        "role": "major",
        "gender": "male",
        "age_range": "40s",
        "vocal_description": "a deep, weathered male voice with quiet authority",
        "archetype": "hero",
        "color": "#3366cc",
        "age_estimate": "40s",
        "traits": ["stoic", "determined"],
    }
    minor_char = {
        "name": "Allison",
        "dialogue_count": 2,
        "confidence": 0.8,
        "role": "minor",
        "gender": "female",
        "age_range": "30s",
        "vocal_description": None,
        "archetype": None,
        "color": "#cc3333",
        "age_estimate": "30s",
        "traits": [],
    }

    segments = [
        {"type": "narration", "text": "Dark night.", "order": 0, "speaker": None, "emotion": None, "intensity": None},
        {"type": "dialogue", "text": "Help me.", "order": 1, "speaker": "Holston", "emotion": None, "intensity": None},
        {"type": "dialogue", "text": "No.", "order": 2, "speaker": "Allison", "emotion": None, "intensity": None},
    ]
    chapter = ChapterAnalysis(
        segments=segments,
        characters=[major_char, minor_char],
        flagged=False,
    )
    fake_analysis = BookAnalysis(
        chapters=[chapter],
        characters=[major_char, minor_char],
    )

    async def fake_analyze_book(chapters, model_size=None):
        return fake_analysis

    monkeypatch.setattr(literary_analysis, "analyze_book", fake_analyze_book)

    # Mock the Kokoro preset pool so cast_book can assign a preset to Allison
    import backend.services.voice_casting as vc_module
    monkeypatch.setattr(vc_module, "_get_preset_ids", lambda engine: ["af_heart", "af_sky"])

    # Suppress SSE publish noise
    monkeypatch.setattr(book_events, "publish", lambda bid, p: None)

    # Run with REAL cast_book (not mocked)
    await book_analysis.run_analysis_task(
        seeded_book_id, model_size="1.7B", db=temp_db, narrator_voice_id="auto"
    )

    # Retrieve materialized characters
    chars = temp_db.query(BookCharacter).filter_by(book_id=seeded_book_id).all()
    char_by_name = {c.name: c for c in chars}

    holston = char_by_name.get("Holston")
    allison = char_by_name.get("Allison")

    assert holston is not None, "Holston character not materialized"
    assert allison is not None, "Allison character not materialized"

    # Major character must have role='major'
    assert holston.role == "major", f"Expected role='major' for Holston, got {holston.role!r}"
    # Minor character must have role='minor'
    assert allison.role == "minor", f"Expected role='minor' for Allison, got {allison.role!r}"

    # Major must get a designed VoiceProfile
    assert holston.profile_id is not None, "Holston has no profile_id"
    holston_profile = temp_db.get(VoiceProfile, holston.profile_id)
    assert holston_profile is not None, "Holston's VoiceProfile not found"
    assert holston_profile.voice_type == "designed", (
        f"Expected Holston voice_type='designed', got {holston_profile.voice_type!r}"
    )

    # Minor must get a preset VoiceProfile (language="en" → Kokoro eligible)
    assert allison.profile_id is not None, "Allison has no profile_id"
    allison_profile = temp_db.get(VoiceProfile, allison.profile_id)
    assert allison_profile is not None, "Allison's VoiceProfile not found"
    assert allison_profile.voice_type == "preset", (
        f"Expected Allison voice_type='preset', got {allison_profile.voice_type!r}"
    )


# ---------------------------------------------------------------------------
# Fix 2: narrator_voice_id pre-assignment test
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_narrator_voice_id_applied_before_casting(
    temp_db, seeded_book_id, monkeypatch
):
    """When narrator_voice_id is a real profile id, the narrator gets that profile."""
    from backend.database import VoiceProfile
    from backend.services import book_analysis, book_events, literary_analysis

    fake_analysis = _make_fake_book_analysis(["Holston"])

    async def fake_analyze_book(chapters, model_size=None):
        return fake_analysis

    monkeypatch.setattr(literary_analysis, "analyze_book", fake_analyze_book)
    monkeypatch.setattr(book_events, "publish", lambda bid, p: None)

    import backend.services.voice_casting as vc_module
    monkeypatch.setattr(vc_module, "_get_preset_ids", lambda engine: ["af_heart"])

    # Seed a pre-existing voice profile to use as narrator_voice_id
    narrator_profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name="Custom Narrator",
        voice_type="preset",
        preset_engine="kokoro",
        preset_voice_id="af_heart",
        default_engine="kokoro",
        is_library=True,
    )
    temp_db.add(narrator_profile)
    temp_db.commit()

    narrator_profile_id = narrator_profile.id

    await book_analysis.run_analysis_task(
        seeded_book_id,
        model_size="1.7B",
        db=temp_db,
        narrator_voice_id=narrator_profile_id,
    )

    # The narrator character should have the pre-assigned profile
    narrator_char = (
        temp_db.query(BookCharacter)
        .filter_by(book_id=seeded_book_id, is_narrator=True)
        .first()
    )
    assert narrator_char is not None
    assert narrator_char.profile_id == narrator_profile_id, (
        f"Expected narrator profile_id={narrator_profile_id!r}, "
        f"got {narrator_char.profile_id!r}"
    )


# ---------------------------------------------------------------------------
# Fix 4: dialogue_count recomputed from materialized segments
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_materialization_recounts_dialogue_from_segments(
    temp_db, seeded_book_id, monkeypatch
):
    """After materialization, dialogue_count reflects real BookSegment rows.

    The narrator has both narration and dialogue segments assigned to it
    (via the analysis pipeline); its recomputed count must reflect ALL
    segments (narrator counting rule).
    """
    from backend.database import BookSegment
    from backend.services import book_analysis, book_events, literary_analysis

    fake_analysis = _make_fake_book_analysis(["Holston"])

    async def fake_analyze_book(chapters, model_size=None):
        return fake_analysis

    monkeypatch.setattr(literary_analysis, "analyze_book", fake_analyze_book)
    monkeypatch.setattr(book_events, "publish", lambda bid, p: None)

    import backend.services.voice_casting as vc_module
    monkeypatch.setattr(vc_module, "_get_preset_ids", lambda engine: ["af_heart"])
    monkeypatch.setattr(vc_module, "cast_book", lambda *a, **k: None)

    await book_analysis.run_analysis_task(
        seeded_book_id, model_size="1.7B", db=temp_db
    )

    narrator = (
        temp_db.query(BookCharacter)
        .filter_by(book_id=seeded_book_id, is_narrator=True)
        .first()
    )
    assert narrator is not None

    # Count segments actually assigned to the narrator in the DB
    actual_seg_count = (
        temp_db.query(BookSegment)
        .filter(BookSegment.character_id == narrator.id)
        .count()
    )

    # The narrator's dialogue_count should equal its total segment count
    # (because _recount_dialogue for is_narrator=True counts all segments)
    assert narrator.dialogue_count == actual_seg_count, (
        f"Narrator dialogue_count={narrator.dialogue_count} but has "
        f"{actual_seg_count} segments in DB"
    )
