"""Tests for POST /books/{id}/export and GET /books/{id}/export/download (D7).

Tests:
- 202 response with status=exporting
- 409 when book is generating
- 422 when no audio exists (export-before-audio)
- 422 for invalid format
- GET /export/download returns FileResponse with correct headers
- GET /export/download 404 before export completes
- Background task fires export_book and publishes SSE events
"""

from __future__ import annotations

import asyncio
import os
import tempfile
import uuid
from pathlib import Path
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
    get_db,
)
from backend.routes.book_export import router as book_export_router
from backend.routes.books import router as books_router


# ---------------------------------------------------------------------------
# Helpers / Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def engine_and_session(tmp_path):
    db_path = tmp_path / "test.db"
    eng = create_engine(
        f"sqlite:///{db_path}", connect_args={"check_same_thread": False}
    )
    Base.metadata.create_all(eng)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=eng)
    return eng, TestSession


@pytest.fixture(scope="function")
def temp_db(engine_and_session):
    _, TestSession = engine_and_session
    db = TestSession()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture(scope="function")
def client(engine_and_session, tmp_path, monkeypatch):
    """Minimal FastAPI app with temp DB, books + book_export routers."""
    _, TestSession = engine_and_session

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    # Patch config data dir so export writes go to tmp_path
    monkeypatch.setattr(
        "backend.services.book_export_api.get_data_dir",
        lambda: tmp_path,
    )

    app = FastAPI()
    app.include_router(books_router)
    app.include_router(book_export_router)
    app.dependency_overrides[get_db] = override_get_db
    return TestClient(app, raise_server_exceptions=False)


def _make_book(db, title="Test Book", status="ready") -> Book:
    book = Book(
        id=str(uuid.uuid4()),
        title=title,
        source_format="epub",
        status=status,
    )
    db.add(book)
    db.commit()
    db.refresh(book)
    return book


def _make_chapter_with_audio(db, book_id: str) -> Chapter:
    """Create a chapter with one completed-audio segment."""
    chapter = Chapter(
        id=str(uuid.uuid4()),
        book_id=book_id,
        number=1,
        title="Chapter One",
        raw_text="Hello world.",
        word_count=2,
    )
    db.add(chapter)
    db.flush()

    gen = Generation(
        id=str(uuid.uuid4()),
        profile_id="dummy",
        text="Hello world.",
        audio_path="/fake/seg.wav",
        status="completed",
    )
    db.add(gen)
    db.flush()

    char = BookCharacter(
        id=str(uuid.uuid4()),
        book_id=book_id,
        name="Narrator",
        is_narrator=True,
    )
    db.add(char)
    db.flush()

    seg = BookSegment(
        id=str(uuid.uuid4()),
        chapter_id=chapter.id,
        character_id=char.id,
        type="narration",
        order=0,
        text="Hello world.",
        generation_id=gen.id,
        audio_status="completed",
    )
    db.add(seg)
    db.commit()
    return chapter


def _make_chapter_no_audio(db, book_id: str) -> Chapter:
    """Create a chapter with zero rendered segments."""
    chapter = Chapter(
        id=str(uuid.uuid4()),
        book_id=book_id,
        number=1,
        title="Chapter One",
        raw_text="Not yet rendered.",
        word_count=3,
    )
    db.add(chapter)
    db.commit()
    return chapter


# ---------------------------------------------------------------------------
# POST /books/{id}/export — happy path
# ---------------------------------------------------------------------------


class TestExportStart:
    def test_202_with_status_exporting(self, client, temp_db, monkeypatch):
        """POST export returns 202 with {book_id, task_id, status=exporting}."""
        book = _make_book(temp_db, status="ready")
        _make_chapter_with_audio(temp_db, book.id)

        # Stub out the export task so nothing real runs.
        # Close the coroutine to avoid "coroutine was never awaited" RuntimeWarning.
        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        resp = client.post(
            f"/books/{book.id}/export",
            json={"format": "m4b"},
        )
        assert resp.status_code == 202, resp.text
        body = resp.json()
        assert body["book_id"] == book.id
        assert body["status"] == "exporting"
        assert "task_id" in body

    def test_book_status_flipped_to_exporting(self, client, temp_db, monkeypatch):
        """The book's status is synchronously flipped to 'exporting' before 202."""
        book = _make_book(temp_db, status="ready")
        _make_chapter_with_audio(temp_db, book.id)

        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        client.post(f"/books/{book.id}/export", json={"format": "m4b"})

        temp_db.expire_all()
        updated = temp_db.query(Book).filter_by(id=book.id).first()
        assert updated.status == "exporting"

    def test_options_passed_through(self, client, temp_db, monkeypatch):
        """All request options (format, bitrate, title, author) arrive at export_book."""
        book = _make_book(temp_db, status="ready")
        _make_chapter_with_audio(temp_db, book.id)

        captured_options = {}

        def fake_export_book(chapters, output_dir, options=None, progress_callback=None):
            captured_options.update(options or {})
            return ("/tmp/x.m4b", "x.m4b")

        monkeypatch.setattr(
            "backend.services.book_export_api.audiobook_export.export_book",
            fake_export_book,
        )

        # We need a running event loop for create_background_task
        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        client.post(
            f"/books/{book.id}/export",
            json={
                "format": "m4b",
                "bitrate": "128k",
                "title": "My Book",
                "author": "Jane Doe",
            },
        )


# ---------------------------------------------------------------------------
# POST /books/{id}/export — error paths
# ---------------------------------------------------------------------------


class TestExportErrors:
    def test_404_unknown_book(self, client):
        resp = client.post(
            f"/books/{uuid.uuid4()}/export",
            json={"format": "m4b"},
        )
        assert resp.status_code == 404

    def test_409_when_generating(self, client, temp_db, monkeypatch):
        """Returns 409 if book is currently generating."""
        book = _make_book(temp_db, status="generating")

        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        resp = client.post(f"/books/{book.id}/export", json={"format": "m4b"})
        assert resp.status_code == 409

    def test_422_export_before_audio(self, client, temp_db, monkeypatch):
        """Returns 422 when no segments have completed audio."""
        book = _make_book(temp_db, status="analyzed")
        _make_chapter_no_audio(temp_db, book.id)

        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        resp = client.post(f"/books/{book.id}/export", json={"format": "m4b"})
        assert resp.status_code == 422, resp.text

    def test_422_invalid_format(self, client, temp_db, monkeypatch):
        """Returns 422 for an invalid format value."""
        book = _make_book(temp_db, status="ready")
        _make_chapter_with_audio(temp_db, book.id)

        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        resp = client.post(f"/books/{book.id}/export", json={"format": "ogg"})
        assert resp.status_code == 422, resp.text

    def test_422_export_before_audio_no_segments(self, client, temp_db, monkeypatch):
        """422 when chapter exists but has zero segments (no audio at all)."""
        book = _make_book(temp_db, status="analyzed")
        # Book has a chapter but no segments
        chapter = Chapter(
            id=str(uuid.uuid4()),
            book_id=book.id,
            number=1,
            title="Empty",
            raw_text="Nothing",
            word_count=1,
        )
        temp_db.add(chapter)
        temp_db.commit()

        monkeypatch.setattr(
            "backend.services.book_export_api.task_queue.create_background_task",
            lambda coro: coro.close(),
        )

        resp = client.post(f"/books/{book.id}/export", json={"format": "m4b"})
        assert resp.status_code == 422, resp.text


# ---------------------------------------------------------------------------
# GET /books/{id}/export/download
# ---------------------------------------------------------------------------


class TestExportDownload:
    def test_404_before_export_completes(self, client, temp_db, monkeypatch):
        """Download before export completed returns 404."""
        book = _make_book(temp_db, status="ready")

        resp = client.get(f"/books/{book.id}/export/download")
        assert resp.status_code == 404

    def test_404_unknown_book(self, client):
        resp = client.get(f"/books/{uuid.uuid4()}/export/download")
        assert resp.status_code == 404

    def test_file_response_correct_headers(self, tmp_path, engine_and_session, monkeypatch):
        """When download file exists, GET returns the file with correct headers."""
        _, TestSession = engine_and_session

        def override_get_db():
            db = TestSession()
            try:
                yield db
            finally:
                db.close()

        # Create a real file for the download
        export_file = tmp_path / "exports" / "test.m4b"
        export_file.parent.mkdir(parents=True, exist_ok=True)
        export_file.write_bytes(b"FAKE_M4B_DATA")

        # Patch data dir so the route can serve the file
        monkeypatch.setattr(
            "backend.services.book_export_api.get_data_dir",
            lambda: tmp_path,
        )

        db = TestSession()
        book = Book(
            id=str(uuid.uuid4()),
            title="Test",
            source_format="epub",
            status="ready",
        )
        db.add(book)
        db.commit()

        # Patch the in-memory export cache
        import backend.services.book_export_api as svc
        svc._export_cache[book.id] = {
            "path": str(export_file),
            "filename": "test.m4b",
        }
        db.close()

        app = FastAPI()
        app.include_router(book_export_router)
        app.dependency_overrides[get_db] = override_get_db
        tc = TestClient(app, raise_server_exceptions=False)

        try:
            resp = tc.get(f"/books/{book.id}/export/download")
            assert resp.status_code == 200
            assert "audio/mp4" in resp.headers.get("content-type", "")
            assert "attachment" in resp.headers.get("content-disposition", "")
            assert "test.m4b" in resp.headers.get("content-disposition", "")
        finally:
            svc._export_cache.pop(book.id, None)


# ---------------------------------------------------------------------------
# Background task: SSE events published
# ---------------------------------------------------------------------------


class TestExportBackgroundTask:
    @pytest.mark.asyncio
    async def test_progress_events_published(self, tmp_path, engine_and_session):
        """run_export_task publishes export_progress and export_complete events."""
        _, TestSession = engine_and_session

        db = TestSession()
        book = Book(
            id=str(uuid.uuid4()),
            title="Test Book",
            source_format="epub",
            status="exporting",
        )
        db.add(book)
        db.flush()

        chapter = Chapter(
            id=str(uuid.uuid4()),
            book_id=book.id,
            number=1,
            title="Chapter 1",
            raw_text="Hello.",
            word_count=1,
        )
        db.add(chapter)
        db.flush()

        gen = Generation(
            id=str(uuid.uuid4()),
            profile_id="dummy",
            text="Hello.",
            audio_path="/fake/seg.wav",
            status="completed",
        )
        db.add(gen)
        db.flush()

        char = BookCharacter(
            id=str(uuid.uuid4()),
            book_id=book.id,
            name="Narrator",
            is_narrator=True,
        )
        db.add(char)
        db.flush()

        seg = BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=chapter.id,
            character_id=char.id,
            type="narration",
            order=0,
            text="Hello.",
            generation_id=gen.id,
            audio_status="completed",
        )
        db.add(seg)
        db.commit()

        published_events = []

        from backend.services import book_export_api

        fake_out = tmp_path / "test.m4b"
        fake_out.write_bytes(b"FAKE")

        with (
            patch.object(
                book_export_api.book_events,
                "publish",
                side_effect=lambda book_id, payload: published_events.append(payload),
            ),
            patch.object(
                book_export_api.audiobook_export,
                "export_book",
                return_value=(str(fake_out), "test.m4b"),
            ),
            patch(
                "backend.config.get_data_dir",
                return_value=tmp_path,
            ),
        ):
            await book_export_api.run_export_task(
                book_id=book.id,
                options={"format": "m4b", "title": "Test Book"},
                db=db,
            )

        db.close()

        # Verify at least one export_progress and one export_complete event
        progress_types = [e.get("type") for e in published_events]
        assert "export_progress" in progress_types, f"events: {progress_types}"
        assert "export_complete" in progress_types, f"events: {progress_types}"

        # export_complete should have download_path and filename
        complete_events = [e for e in published_events if e.get("type") == "export_complete"]
        assert len(complete_events) == 1
        assert "filename" in complete_events[0]

    @pytest.mark.asyncio
    async def test_status_reset_after_export(self, tmp_path, engine_and_session):
        """Book status is reset to 'ready' after successful export."""
        _, TestSession = engine_and_session

        db = TestSession()
        book = Book(
            id=str(uuid.uuid4()),
            title="Status Test",
            source_format="epub",
            status="exporting",
        )
        db.add(book)
        db.flush()

        chapter = Chapter(
            id=str(uuid.uuid4()),
            book_id=book.id,
            number=1,
            title="Ch1",
            raw_text="X",
            word_count=1,
        )
        db.add(chapter)
        db.flush()

        gen = Generation(
            id=str(uuid.uuid4()),
            profile_id="dummy",
            text="X",
            audio_path="/fake/x.wav",
            status="completed",
        )
        db.add(gen)
        db.flush()

        char = BookCharacter(
            id=str(uuid.uuid4()),
            book_id=book.id,
            name="Narrator",
            is_narrator=True,
        )
        db.add(char)
        db.flush()

        seg = BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=chapter.id,
            character_id=char.id,
            type="narration",
            order=0,
            text="X",
            generation_id=gen.id,
            audio_status="completed",
        )
        db.add(seg)
        db.commit()

        fake_out = tmp_path / "Status_Test.m4b"
        fake_out.write_bytes(b"FAKE")

        from backend.services import book_export_api

        with (
            patch.object(book_export_api.book_events, "publish"),
            patch.object(
                book_export_api.audiobook_export,
                "export_book",
                return_value=(str(fake_out), "Status_Test.m4b"),
            ),
        ):
            await book_export_api.run_export_task(
                book_id=book.id,
                options={"format": "m4b"},
                db=db,
            )

        db.expire_all()
        updated = db.query(Book).filter_by(id=book.id).first()
        assert updated.status == "ready"
        db.close()
