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

from backend.database import Base, get_db
from backend.routes.books import router as books_router


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def client(tmp_path, monkeypatch):
    """Build a minimal app with a temp SQLite DB and the books router only."""
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

    # Point the data dir at tmp_path so cover files go somewhere writable
    monkeypatch.setenv("VOICEBOX_DATA_DIR", str(tmp_path))
    # Re-initialize config so it picks up the env var
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    app = FastAPI()
    app.include_router(books_router)
    app.dependency_overrides[get_db] = override_get_db

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


def test_analyze_stub_returns_202(client):
    """POST /books/{id}/analyze returns 202 with task_id and status=analyzing."""
    epub_data = _epub_bytes()
    files = {"file": ("silo.epub", epub_data, "application/epub+zip")}
    bid = client.post("/books/import", files=files).json()["id"]

    r = client.post(f"/books/{bid}/analyze")
    assert r.status_code == 202
    body = r.json()
    assert body["book_id"] == bid
    assert "task_id" in body
    assert body["status"] == "analyzing"


def test_analyze_unknown_book_404(client):
    """POST /books/{id}/analyze with unknown id returns 404."""
    r = client.post(f"/books/{uuid.uuid4()}/analyze")
    assert r.status_code == 404
