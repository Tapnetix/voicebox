"""Book CRUD, import, and analyze endpoints (contract 01).

Wires: POST /books/import, GET /books, GET /books/{id},
       PATCH /books/{id}, DELETE /books/{id},
       POST /books/{id}/analyze (202 stub — B4 fills the real body).
"""

from __future__ import annotations

import tempfile
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from .. import database, models
from ..config import get_data_dir, to_storage_path
from ..database import get_db
from ..services import ingestion

router = APIRouter(prefix="/books", tags=["books"])

ALLOWED = {"epub", "fb2", "txt", "pdf"}
MAX_BYTES = 200 * 1024 * 1024  # 200 MB


# ---------------------------------------------------------------------------
# Internal helpers (inline per task spec; B4 moves persistence to books.py)
# ---------------------------------------------------------------------------


def _get_book_or_404(book_id: str, db: Session) -> database.Book:
    """Return a Book row or raise 404."""
    book = db.query(database.Book).filter_by(id=book_id).first()
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _chapter_count(book_id: str, db: Session) -> int:
    return db.query(database.Chapter).filter_by(book_id=book_id).count()


def _chapter_generation_state(chapter: database.Chapter, db: Session) -> str:
    """Derive a generation_state string from the chapter's BookSegments.

    Returns: 'none' | 'partial' | 'ready' | 'error'
    """
    segments = (
        db.query(database.BookSegment)
        .filter_by(chapter_id=chapter.id)
        .all()
    )
    if not segments:
        return "none"
    statuses = {s.audio_status for s in segments}
    if statuses <= {"completed"}:
        return "ready"
    if "error" in statuses:
        return "error"
    if "completed" in statuses or "generating" in statuses or "pending" in statuses:
        return "partial"
    return "none"


def _chapter_to_summary(chapter: database.Chapter, db: Session) -> models.ChapterSummary:
    return models.ChapterSummary(
        id=chapter.id,
        number=chapter.number,
        title=chapter.title,
        word_count=chapter.word_count,
        story_id=chapter.story_id,
        generation_state=_chapter_generation_state(chapter, db),
    )


def _book_to_response(book: database.Book, db: Session) -> models.BookResponse:
    return models.BookResponse(
        id=book.id,
        title=book.title,
        author=book.author,
        source_format=book.source_format,
        cover_path=book.cover_path,
        status=book.status,
        chapter_count=_chapter_count(book.id, db),
        created_at=book.created_at,
        updated_at=book.updated_at,
    )


def _book_to_detail(book: database.Book, db: Session) -> models.BookDetailResponse:
    chapters = (
        db.query(database.Chapter)
        .filter_by(book_id=book.id)
        .order_by(database.Chapter.number)
        .all()
    )
    chapter_summaries = [_chapter_to_summary(ch, db) for ch in chapters]
    return models.BookDetailResponse(
        id=book.id,
        title=book.title,
        author=book.author,
        source_format=book.source_format,
        cover_path=book.cover_path,
        status=book.status,
        chapter_count=len(chapters),
        created_at=book.created_at,
        updated_at=book.updated_at,
        chapters=chapter_summaries,
    )


def _persist_parsed_book(
    parsed: ingestion.ParsedBook,
    db: Session,
) -> database.Book:
    """Persist a ParsedBook (book + chapters + cover) and return the ORM Book."""
    # Persist cover bytes if present
    cover_path: str | None = None
    if parsed.cover_bytes:
        data_dir = get_data_dir()
        covers_dir = data_dir / "covers"
        covers_dir.mkdir(parents=True, exist_ok=True)
        cover_file = covers_dir / f"{uuid.uuid4()}.jpg"
        cover_file.write_bytes(parsed.cover_bytes)
        cover_path = to_storage_path(cover_file)

    book = database.Book(
        title=parsed.title,
        author=parsed.author,
        source_format=parsed.source_format,
        cover_path=cover_path,
        status="imported",
    )
    db.add(book)
    db.flush()  # populate book.id before child inserts

    for ch in parsed.chapters:
        chapter = database.Chapter(
            book_id=book.id,
            number=ch.number,
            title=ch.title,
            raw_text=ch.text,
            word_count=ch.word_count,
        )
        db.add(chapter)

    db.commit()
    db.refresh(book)
    return book


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/import", response_model=models.BookDetailResponse)
async def import_book(
    file: UploadFile = File(...),
    model_size: str | None = Form(None),
    narrator_voice_id: str | None = Form(None),
    db: Session = Depends(get_db),
) -> models.BookDetailResponse:
    """Upload an ebook, parse it, create Book + Chapters, return BookDetailResponse."""
    # Validate extension
    filename = file.filename or ""
    if "." not in filename:
        raise HTTPException(status_code=400, detail="No file extension provided")
    ext = filename.rsplit(".", 1)[-1].lower()
    if ext not in ALLOWED:
        raise HTTPException(status_code=400, detail=f"Unsupported file type: .{ext}")

    # Read and size-check
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(status_code=400, detail="File exceeds 200 MB limit")

    # Write to temp file, parse, clean up
    suffix = f".{ext}"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp_path = tmp.name
        tmp.write(data)

    try:
        parsed = ingestion.parse_book(tmp_path, ext)
    except ingestion.IngestionError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    finally:
        Path(tmp_path).unlink(missing_ok=True)

    book = _persist_parsed_book(parsed, db)
    return _book_to_detail(book, db)


@router.get("", response_model=list[models.BookResponse])
async def list_books(db: Session = Depends(get_db)) -> list[models.BookResponse]:
    """List all books, newest first."""
    books = (
        db.query(database.Book)
        .order_by(database.Book.created_at.desc())
        .all()
    )
    return [_book_to_response(b, db) for b in books]


@router.get("/{book_id}", response_model=models.BookDetailResponse)
async def get_book(
    book_id: str,
    db: Session = Depends(get_db),
) -> models.BookDetailResponse:
    """Return book detail (metadata + chapters)."""
    book = _get_book_or_404(book_id, db)
    return _book_to_detail(book, db)


@router.patch("/{book_id}", response_model=models.BookDetailResponse)
async def patch_book(
    book_id: str,
    data: dict[str, Any],
    db: Session = Depends(get_db),
) -> models.BookDetailResponse:
    """Update book metadata (title, author, cover_path)."""
    book = _get_book_or_404(book_id, db)

    allowed_fields = {"title", "author", "cover_path"}
    for field_name, value in data.items():
        if field_name in allowed_fields:
            setattr(book, field_name, value)

    db.commit()
    db.refresh(book)
    return _book_to_detail(book, db)


@router.delete("/{book_id}")
async def delete_book(
    book_id: str,
    db: Session = Depends(get_db),
) -> dict[str, str]:
    """Delete a book and all its related rows (cascade)."""
    book = _get_book_or_404(book_id, db)

    # Cascade-delete child rows manually (SQLite FK may not be enforced)
    chapters = db.query(database.Chapter).filter_by(book_id=book_id).all()
    for chapter in chapters:
        db.query(database.BookSegment).filter_by(chapter_id=chapter.id).delete()
    db.query(database.Chapter).filter_by(book_id=book_id).delete()
    db.query(database.BookCharacter).filter_by(book_id=book_id).delete()
    db.delete(book)
    db.commit()

    return {"message": "Book deleted"}


@router.post("/{book_id}/analyze")
async def analyze_book(
    book_id: str,
    db: Session = Depends(get_db),
) -> JSONResponse:
    """202 stub — B4 fills in the real enqueue logic and 409 guard."""
    _get_book_or_404(book_id, db)  # raises 404 if not found
    task_id = str(uuid.uuid4())
    return JSONResponse(
        status_code=202,
        content={
            "book_id": book_id,
            "task_id": task_id,
            "status": "analyzing",
        },
    )
