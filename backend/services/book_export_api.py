"""Export service for audiobook export (D7).

Provides:
- enqueue_export(book_id, options) → task_id  (synchronous, flips status)
- run_export_task(book_id, options, db)        (async, runs in background)

Uses the audiobook_export service (D6) for the actual encoding.
Publishes export_progress / export_complete events on the per-book SSE channel.
"""

from __future__ import annotations

import logging
import uuid
from pathlib import Path
from typing import Any

from sqlalchemy.orm import Session

from ..config import get_data_dir, resolve_storage_path
from ..services import audiobook_export, book_events, task_queue

logger = logging.getLogger(__name__)

# In-memory download cache: book_id → {path, filename}
# Populated when export_complete fires; cleared when next export starts.
_export_cache: dict[str, dict[str, str]] = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _has_any_audio(book_id: str, db: Session) -> bool:
    """Return True if the book has at least one segment with audio_status='completed'."""
    from ..database import Book, BookSegment, Chapter

    completed = (
        db.query(BookSegment)
        .join(Chapter, Chapter.id == BookSegment.chapter_id)
        .filter(Chapter.book_id == book_id)
        .filter(BookSegment.audio_status == "completed")
        .first()
    )
    return completed is not None


def _collect_chapters(book_id: str, db: Session) -> list[dict[str, Any]]:
    """Collect ordered chapter dicts with segment audio paths for export.

    Each chapter dict has:
      number, title, segment_paths (list of plain str paths)
    Segments without completed audio are skipped.

    NOTE: ``_stitch_chapter`` in audiobook_export.py supports a richer
    ``{path, is_scene_break}`` entry format that inserts a longer scene-break
    pause between scene/paragraph breaks.  That feature is currently unused
    here because ``BookSegment`` has no scene/paragraph-break field — all
    entries are plain strings.  If a ``is_scene_break`` flag is added to the
    model in the future, emit ``{"path": ..., "is_scene_break": True}`` here
    for those segments to activate the pause.
    """
    from ..database import BookSegment, Chapter, Generation

    chapters_db = (
        db.query(Chapter)
        .filter_by(book_id=book_id)
        .order_by(Chapter.number)
        .all()
    )

    result = []
    for ch in chapters_db:
        segments = (
            db.query(BookSegment)
            .filter_by(chapter_id=ch.id)
            .filter(BookSegment.audio_status == "completed")
            .order_by(BookSegment.order)
            .all()
        )

        seg_paths: list[str] = []
        for seg in segments:
            if seg.generation_id is None:
                continue
            gen = db.query(Generation).filter_by(id=seg.generation_id).first()
            if gen is None or gen.audio_path is None:
                continue
            # Resolve DB-stored path to absolute filesystem path
            abs_path = resolve_storage_path(gen.audio_path)
            if abs_path is not None and abs_path.exists():
                seg_paths.append(str(abs_path))

        if seg_paths:
            result.append(
                {
                    "number": ch.number,
                    "title": ch.title or f"Chapter {ch.number}",
                    "segment_paths": seg_paths,
                }
            )

    return result


def _resolve_cover(cover_path: str | None) -> str | None:
    """Resolve a cover_path value (relative or absolute) to an absolute path string."""
    if not cover_path:
        return None
    resolved = resolve_storage_path(cover_path)
    if resolved and resolved.exists():
        return str(resolved)
    return None


# ---------------------------------------------------------------------------
# Async task
# ---------------------------------------------------------------------------


async def run_export_task(
    book_id: str,
    options: dict[str, Any],
    db: Session,
) -> None:
    """Full export pipeline: collect audio → encode → publish events.

    Status transitions:
        exporting → ready     on success
        exporting → error     on any unhandled exception

    Events published on the book channel:
        export_progress  ({progress, message?})
        export_complete  ({download_path, filename})   on success
        error            ({stage, message})            on failure
    """
    from ..database import Book

    def _pub(payload: dict) -> None:
        book_events.publish(book_id, payload)

    try:
        _pub({"type": "export_progress", "progress": 0, "message": "Starting export"})

        # Collect chapter audio paths
        chapters = _collect_chapters(book_id, db)

        def _progress(pct: int, msg: str = "") -> None:
            _pub({"type": "export_progress", "progress": pct, "message": msg})

        # Resolve cover path if provided
        raw_cover = options.get("cover_path")
        if raw_cover:
            options = dict(options)
            options["cover_path"] = _resolve_cover(raw_cover)

        # Set export output directory under data dir / exports / book_id
        output_dir = str(get_data_dir() / "exports" / book_id)

        out_path, filename = audiobook_export.export_book(
            chapters=chapters,
            output_dir=output_dir,
            options=options,
            progress_callback=_progress,
        )

        # Cache the result for the download endpoint
        _export_cache[book_id] = {"path": out_path, "filename": filename}

        # Flip book status back to ready
        book = db.query(Book).filter_by(id=book_id).first()
        if book is not None:
            book.status = "ready"
            db.commit()

        _pub(
            {
                "type": "export_complete",
                "download_path": out_path,
                "filename": filename,
            }
        )

    except Exception as exc:
        logger.exception("Export task failed for book %s", book_id)
        try:
            from ..database import Book as DBBook

            db_book = db.query(DBBook).filter_by(id=book_id).first()
            if db_book is not None:
                db_book.status = "error"
                db.commit()
        except Exception:
            pass

        try:
            _pub(
                {
                    "type": "error",
                    "stage": "export",
                    "message": str(exc),
                }
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Synchronous enqueue entry-point
# ---------------------------------------------------------------------------


def enqueue_export(
    book_id: str,
    options: dict[str, Any],
    db: Session,
) -> str:
    """Flip book status to 'exporting' and enqueue the export background task.

    Args:
        book_id: Book primary key.
        options: Export options dict (format, bitrate, etc.).
        db:      The caller's SQLAlchemy session (used for the synchronous status flip).

    Returns:
        A task_id string (opaque uuid4).
    """
    from .. import database

    # Clear any previous download cache entry
    _export_cache.pop(book_id, None)

    # Flip status synchronously — race-safe guard
    book = db.query(database.Book).filter_by(id=book_id).first()
    if book is not None:
        book.status = "exporting"
        db.commit()

    # Launch the pipeline in the background with a fresh session
    async def _run() -> None:
        fresh_db = next(database.get_db())
        try:
            await run_export_task(book_id, options, fresh_db)
        finally:
            fresh_db.close()

    task_queue.create_background_task(_run())
    return str(uuid.uuid4())
