"""Segment split and merge endpoints (B9, contract 02).

Routes:
  POST /segments/{segment_id}/split
  POST /segments/merge

The router is registered centrally by the orchestrator; this module must NOT
import or modify routes/__init__.py.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import SegmentResponse, SegmentSplitRequest, SegmentsMergeRequest
from ..services.book_segment_structure import merge_segments, split_segment

router = APIRouter(tags=["book_segment_structure"])


@router.post(
    "/segments/{segment_id}/split",
    response_model=list[SegmentResponse],
)
def split_segment_endpoint(
    segment_id: str,
    payload: SegmentSplitRequest,
    db: Session = Depends(get_db),
) -> list[SegmentResponse]:
    """Split a segment into two at a character offset.

    - 400 if at_offset <= 0 or >= len(text).
    - 404 if the segment does not exist.
    - 409 if the owning book is currently generating.
    - Returns [first_segment, second_segment].
    """
    return split_segment(segment_id, payload.at_offset, db)


@router.post(
    "/segments/merge",
    response_model=SegmentResponse,
)
def merge_segments_endpoint(
    payload: SegmentsMergeRequest,
    db: Session = Depends(get_db),
) -> SegmentResponse:
    """Merge adjacent segments into one.

    - 400 if fewer than 2 segment_ids, non-adjacent, or mixed chapters.
    - 404 if any segment_id is unknown.
    - 409 if the owning book is currently generating.
    - Returns the merged segment.
    """
    return merge_segments(payload.segment_ids, db)
