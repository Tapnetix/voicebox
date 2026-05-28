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
