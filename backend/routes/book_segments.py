"""Segment listing and editing endpoints (B7, contract 02).

Routes:
  GET  /books/{book_id}/chapters/{chapter_id}/segments
  PATCH /segments/{segment_id}

The router is registered centrally by the orchestrator; this module must NOT
import or modify routes/__init__.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import BookSegment, get_db
from ..models import SegmentResponse, SegmentUpdate
from ..services.book_segments import segment_to_response, update_segment

router = APIRouter(tags=["book_segments"])


@router.get(
    "/books/{book_id}/chapters/{chapter_id}/segments",
    response_model=list[SegmentResponse],
)
def list_segments(
    book_id: str,
    chapter_id: str,
    db: Session = Depends(get_db),
) -> list[SegmentResponse]:
    """Return all segments for a chapter, ordered by `order` ascending."""
    segments = (
        db.query(BookSegment)
        .filter_by(chapter_id=chapter_id)
        .order_by(BookSegment.order)
        .all()
    )
    return [segment_to_response(seg, db) for seg in segments]


@router.patch(
    "/segments/{segment_id}",
    response_model=SegmentResponse,
)
def patch_segment(
    segment_id: str,
    payload: SegmentUpdate,
    db: Session = Depends(get_db),
) -> SegmentResponse:
    """Apply a partial update to a segment.

    - 404 if the segment does not exist.
    - 409 if the owning book is currently generating.
    - When any content field changes and the segment already has a generation_id,
      audio_status is set to "stale".
    """
    return update_segment(segment_id, payload, db)
