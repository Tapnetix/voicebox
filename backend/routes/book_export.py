"""Book export endpoints (D7).

Provides:
  POST /books/{book_id}/export          → 202 {book_id, task_id, status="exporting"}
  GET  /books/{book_id}/export/download → FileResponse with correct content-type
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from .. import database, models
from ..database import get_db
from ..services import book_export_api

router = APIRouter(prefix="/books", tags=["books"])

# MIME types keyed by file extension
_CONTENT_TYPES: dict[str, str] = {
    ".m4b": "audio/mp4",
    ".mp3": "audio/mpeg",
    ".zip": "application/zip",
}


def _get_book_or_404(book_id: str, db: Session) -> database.Book:
    """Return a Book row or raise 404."""
    book = db.query(database.Book).filter_by(id=book_id).first()
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


@router.post(
    "/{book_id}/export",
    status_code=202,
    response_model=models.ExportResponse,
)
async def start_export(
    book_id: str,
    body: models.ExportRequest,
    db: Session = Depends(get_db),
) -> models.ExportResponse:
    """Enqueue audiobook export for a book.

    - Returns **202** immediately with ``status="exporting"`` and a ``task_id``.
    - Returns **404** if the book does not exist.
    - Returns **409** if the book is currently ``generating``.
    - Returns **422** if no audio has been rendered yet (zero completed segments),
      or if the format is invalid.
    """
    book = _get_book_or_404(book_id, db)

    if book.status == "generating":
        raise HTTPException(
            status_code=409,
            detail="Book is currently generating audio; export is not allowed",
        )

    # Guard: at least one rendered segment must exist
    if not book_export_api._has_any_audio(book_id, db):
        raise HTTPException(
            status_code=422,
            detail="No rendered audio found; generate audio for at least one segment first",
        )

    # Build options dict from request
    options: dict = {"format": body.format}
    if body.bitrate is not None:
        # Map "mono"/"stereo" → 1/2 channels, or pass as-is for bitrate
        options["bitrate"] = body.bitrate
    if body.target_lufs is not None:
        options["target_lufs"] = body.target_lufs
    if body.channels is not None:
        options["channels"] = 1 if body.channels == "mono" else 2
    if body.title is not None:
        options["title"] = body.title
    if body.author is not None:
        options["author"] = body.author
    if body.cover_path is not None:
        options["cover_path"] = body.cover_path

    task_id = book_export_api.enqueue_export(book_id, options, db)

    return models.ExportResponse(
        book_id=book_id,
        task_id=task_id,
        status="exporting",
    )


@router.get("/{book_id}/export/download")
async def download_export(
    book_id: str,
    db: Session = Depends(get_db),
) -> FileResponse:
    """Download the exported audiobook file.

    - Returns the file with correct ``Content-Type`` and ``Content-Disposition`` headers.
    - Returns **404** if the book does not exist or if export has not completed yet.
    """
    _get_book_or_404(book_id, db)

    entry = book_export_api._export_cache.get(book_id)
    if entry is None:
        raise HTTPException(
            status_code=404,
            detail="Export not ready; start an export first",
        )

    file_path = Path(entry["path"])
    if not file_path.exists():
        raise HTTPException(
            status_code=404,
            detail="Export file not found on disk",
        )

    filename = entry["filename"]
    ext = file_path.suffix.lower()
    media_type = _CONTENT_TYPES.get(ext, "application/octet-stream")

    return FileResponse(
        path=str(file_path),
        media_type=media_type,
        filename=filename,
    )
