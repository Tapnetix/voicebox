"""Tests for the /books router (A6).

Uses a minimal FastAPI app with a temp SQLite DB — no torch/TTS stack needed.
"""

import io
import uuid

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, Book, get_db
from backend.routes.books import router as books_router
from backend.routes.book_analysis import router as book_analysis_router


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _make_app(tmp_path, monkeypatch, include_analysis: bool = False):
    """Build a minimal app with a temp SQLite DB."""
    db_path = tmp_path / "test.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setenv("VOICEIT_DATA_DIR", str(tmp_path))
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    app = FastAPI()
    if include_analysis:
        # Mock enqueue_analysis so the test doesn't start a real pipeline
        import backend.services.book_analysis as ba_svc

        def mock_enqueue(book_id, model_size, narrator_voice_id):
            db = TestSession()
            try:
                book = db.query(Book).filter_by(id=book_id).first()
                if book is not None:
                    book.status = "analyzing"
                    db.commit()
            finally:
                db.close()
            return "mock-task-id"

        monkeypatch.setattr(ba_svc, "enqueue_analysis", mock_enqueue)
        app.include_router(book_analysis_router)
    app.include_router(books_router)
    app.dependency_overrides[get_db] = override_get_db
    return app, TestSession


@pytest.fixture(scope="function")
def client(tmp_path, monkeypatch):
    """Build a minimal app with a temp SQLite DB and the books router only."""
    app, _ = _make_app(tmp_path, monkeypatch, include_analysis=False)
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="function")
def client_with_analysis(tmp_path, monkeypatch):
    """Build a minimal app that includes both books_router and book_analysis_router."""
    app, _ = _make_app(tmp_path, monkeypatch, include_analysis=True)
    with TestClient(app) as c:
        yield c


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
    chapter.content = "<p>Dark night of the soul.</p>"
    b.add_item(chapter)

    b.spine = ["nav", chapter]
    b.add_item(epub.EpubNcx())
    b.add_item(epub.EpubNav())

    buf = io.BytesIO()
    epub.write_epub(buf, b)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Import tests
# ---------------------------------------------------------------------------


def test_import_creates_book_with_chapters(client):
    """POST /books/import returns 200 with status=imported and chapter list."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    r = client.post("/books/import", files=files)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "imported"
    assert body["title"] == "Silo"
    assert body["chapter_count"] >= 1
    assert isinstance(body["chapters"], list)
    assert len(body["chapters"]) >= 1


def test_import_rejects_unsupported_extension(client):
    """POST /books/import with .mobi returns 400."""
    files = {"file": ("book.mobi", b"junk", "application/octet-stream")}
    r = client.post("/books/import", files=files)
    assert r.status_code == 400


def test_import_rejects_corrupt_epub(client):
    """POST /books/import with corrupt epub returns 400."""
    files = {"file": ("bad.epub", b"not a zip", "application/epub+zip")}
    r = client.post("/books/import", files=files)
    assert r.status_code == 400


def test_import_rejects_oversized_file(client, monkeypatch):
    """POST /books/import with file > 200 MB returns 400."""
    import backend.routes.books as books_mod
    original_max = books_mod.MAX_BYTES
    # Temporarily lower the cap to 10 bytes for this test
    monkeypatch.setattr(books_mod, "MAX_BYTES", 10)
    files = {"file": ("big.epub", b"x" * 11, "application/epub+zip")}
    r = client.post("/books/import", files=files)
    assert r.status_code == 400


# ---------------------------------------------------------------------------
# CRUD tests
# ---------------------------------------------------------------------------


def test_get_unknown_book_404(client):
    """GET /books/{id} with unknown id returns 404."""
    r = client.get(f"/books/{uuid.uuid4()}")
    assert r.status_code == 404


def test_list_returns_empty_initially(client):
    """GET /books returns [] when no books exist."""
    r = client.get("/books")
    assert r.status_code == 200
    assert r.json() == []


def test_list_then_delete(client):
    """Import → list → delete → 404 cycle."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}

    # Import
    import_r = client.post("/books/import", files=files)
    assert import_r.status_code == 200
    bid = import_r.json()["id"]

    # List shows the book
    list_r = client.get("/books")
    assert list_r.status_code == 200
    assert any(b["id"] == bid for b in list_r.json())

    # Delete
    del_r = client.delete(f"/books/{bid}")
    assert del_r.status_code in (200, 204)

    # Now 404
    get_r = client.get(f"/books/{bid}")
    assert get_r.status_code == 404


def test_get_book_detail(client):
    """GET /books/{id} returns BookDetailResponse with chapters."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    bid = client.post("/books/import", files=files).json()["id"]

    r = client.get(f"/books/{bid}")
    assert r.status_code == 200
    body = r.json()
    assert body["id"] == bid
    assert "chapters" in body
    assert isinstance(body["chapters"], list)


def test_patch_book_updates_title(client):
    """PATCH /books/{id} can update title."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    bid = client.post("/books/import", files=files).json()["id"]

    r = client.patch(f"/books/{bid}", json={"title": "Silo: Updated"})
    assert r.status_code == 200
    assert r.json()["title"] == "Silo: Updated"


def test_patch_unknown_book_404(client):
    """PATCH /books/{id} with unknown id returns 404."""
    r = client.patch(f"/books/{uuid.uuid4()}", json={"title": "X"})
    assert r.status_code == 404


def test_delete_unknown_book_404(client):
    """DELETE /books/{id} with unknown id returns 404."""
    r = client.delete(f"/books/{uuid.uuid4()}")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Analyze stub
# ---------------------------------------------------------------------------


def test_analyze_returns_202(client_with_analysis):
    """POST /books/{id}/analyze returns 202 with task_id and status=analyzing.

    Uses a client that mounts both the books_router and book_analysis_router —
    the A6 stub was replaced by the real B4 endpoint in routes/book_analysis.py.
    """
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    bid = client_with_analysis.post("/books/import", files=files).json()["id"]

    r = client_with_analysis.post(f"/books/{bid}/analyze", json={})
    assert r.status_code == 202
    body = r.json()
    assert body["book_id"] == bid
    assert "task_id" in body
    assert body["status"] == "analyzing"


def test_analyze_unknown_book_404(client_with_analysis):
    """POST /books/{id}/analyze with unknown id returns 404.

    Uses client_with_analysis (which registers the real book_analysis_router) so
    the assertion exercises the handler's real 404, not a FastAPI route-not-found.
    """
    r = client_with_analysis.post(f"/books/{uuid.uuid4()}/analyze")
    assert r.status_code == 404


# ---------------------------------------------------------------------------
# Review-fix tests (A6 review fixes)
# ---------------------------------------------------------------------------


def test_delete_book_nulls_out_voice_profile_book_id(client, tmp_path, monkeypatch):
    """DELETE /books/{id} NULLs book_id on associated VoiceProfile rows (not deletes them)."""
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    from backend.database import Base, VoiceProfile

    # Use the same DB the client uses — rebuild via a direct engine on the same file
    db_path = tmp_path / "test.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from backend.database import get_db
    from backend.routes.books import router as books_router

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app = FastAPI()
    app.include_router(books_router)
    app.dependency_overrides[get_db] = override_get_db

    with TestClient(app) as c:
        # Import a book
        epub_data = _epub_bytes()
        files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
        bid = c.post("/books/import", files=files).json()["id"]

        # Attach a VoiceProfile with that book_id directly in the DB
        db = TestSession()
        profile = VoiceProfile(name="auto-cast-narrator", book_id=bid)
        db.add(profile)
        db.commit()
        profile_id = profile.id
        db.close()

        # Delete the book via API
        del_r = c.delete(f"/books/{bid}")
        assert del_r.status_code in (200, 204)

        # Profile must still exist, but book_id must be None
        db = TestSession()
        surviving = db.query(VoiceProfile).filter_by(id=profile_id).first()
        assert surviving is not None, "VoiceProfile was deleted instead of being kept"
        assert surviving.book_id is None, f"Expected book_id=None, got {surviving.book_id!r}"
        db.close()


def test_patch_ignores_non_whitelisted_fields(client):
    """PATCH /books/{id} must not mutate id or status (whitelist enforcement)."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    original = client.post("/books/import", files=files).json()
    bid = original["id"]
    original_status = original["status"]  # "imported"

    # Attempt to mutate non-whitelisted columns
    r = client.patch(f"/books/{bid}", json={"id": "hacked", "status": "ready"})
    assert r.status_code == 200

    # Fetch fresh from server
    get_r = client.get(f"/books/{bid}")
    assert get_r.status_code == 200
    body = get_r.json()
    assert body["id"] == bid, "id was mutated by PATCH"
    assert body["status"] == original_status, f"status was mutated: {body['status']!r}"


def test_import_rejects_no_extension(client):
    """POST /books/import with a filename containing no dot returns 400."""
    files = {"file": ("noextension", b"junk data", "application/octet-stream")}
    r = client.post("/books/import", files=files)
    assert r.status_code == 400
