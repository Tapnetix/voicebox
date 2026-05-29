"""Book generation endpoints (D1).

Provides:
    POST /books/{book_id}/chapters/{chapter_id}/generate
    POST /books/{book_id}/generate
    GET  /books/{book_id}/generation-status
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import database, models
from ..database import get_db
from ..services import book_generation
from ..services.book_overview import chapter_generation_state

router = APIRouter(prefix="/books", tags=["books"])


# ---------------------------------------------------------------------------
# Chapter generate
# ---------------------------------------------------------------------------


@router.post(
    "/{book_id}/chapters/{chapter_id}/generate",
    status_code=202,
    response_model=models.GenerateResponse,
)
def generate_chapter(
    book_id: str,
    chapter_id: str,
    body: models.GenerateRequest = models.GenerateRequest(),
    db: Session = Depends(get_db),
) -> models.GenerateResponse:
    """Lazily materialise and enqueue audio for all unrendered segments in a chapter.

    - Returns **202** immediately with ``queued_segments``.
    - Returns **404** if the book or chapter does not exist.
    - Returns **409** if the book is already generating.

    The 409 guard, status flip, and drain-reset are all handled inside
    ``enqueue_chapter_generation`` so the lifecycle lives in one place.
    """
    task_id, queued = book_generation.enqueue_chapter_generation(
        book_id,
        chapter_id,
        db,
        engine=body.engine,
        model_size=body.model_size,
        overwrite_errors=body.overwrite_errors,
    )

    return models.GenerateResponse(
        book_id=book_id,
        chapter_id=chapter_id,
        task_id=task_id,
        queued_segments=queued,
    )


# ---------------------------------------------------------------------------
# Book generate
# ---------------------------------------------------------------------------


@router.post(
    "/{book_id}/generate",
    status_code=202,
    response_model=models.GenerateResponse,
)
def generate_book(
    book_id: str,
    body: models.GenerateRequest = models.GenerateRequest(),
    db: Session = Depends(get_db),
) -> models.GenerateResponse:
    """Render the whole book (all chapters).

    - Returns **202** immediately with ``queued_segments`` (sum across all chapters).
    - Returns **404** if the book does not exist.
    - Returns **409** if the book is already generating.

    The 409 guard, status flip, and drain-reset are all handled inside
    ``enqueue_book_generation`` so the lifecycle lives in one place.
    """
    task_id, total = book_generation.enqueue_book_generation(
        book_id,
        db,
        engine=body.engine,
        model_size=body.model_size,
        overwrite_errors=body.overwrite_errors,
    )

    return models.GenerateResponse(
        book_id=book_id,
        chapter_id=None,
        task_id=task_id,
        queued_segments=total,
    )


# ---------------------------------------------------------------------------
# Generation status
# ---------------------------------------------------------------------------


@router.get(
    "/{book_id}/generation-status",
    response_model=models.GenerationStatusResponse,
)
def get_generation_status(
    book_id: str,
    db: Session = Depends(get_db),
) -> models.GenerationStatusResponse:
    """Return per-chapter generation counts and overall progress.

    Uses B5's ``chapter_generation_state`` rollup for the ``state`` field.
    """
    from fastapi import HTTPException

    book = db.query(database.Book).filter_by(id=book_id).first()
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")

    chapters = (
        db.query(database.Chapter)
        .filter_by(book_id=book_id)
        .order_by(database.Chapter.number)
        .all()
    )

    chapter_statuses: list[models.ChapterGenerationStatus] = []
    total_segments = 0
    total_completed = 0

    for chapter in chapters:
        segments = (
            db.query(database.BookSegment)
            .filter_by(chapter_id=chapter.id)
            .all()
        )

        total = len(segments)
        completed = sum(1 for s in segments if s.audio_status == "completed")
        errors = sum(1 for s in segments if s.audio_status == "error")
        state = chapter_generation_state(chapter.id, db)

        chapter_statuses.append(
            models.ChapterGenerationStatus(
                chapter_id=chapter.id,
                total=total,
                completed=completed,
                errors=errors,
                state=state,
            )
        )

        total_segments += total
        total_completed += completed

    overall_progress = (
        total_completed / total_segments if total_segments > 0 else 0.0
    )

    return models.GenerationStatusResponse(
        chapters=chapter_statuses,
        overall_progress=overall_progress,
    )
