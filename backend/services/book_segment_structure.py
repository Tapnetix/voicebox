"""Service helpers for segment split and merge operations (B9).

Provides:
- renumber_chapter_segments(chapter_id, db) — re-assign order=0..n-1
- split_segment(segment_id, at_offset, db) -> list[SegmentResponse]
- merge_segments(segment_ids, db) -> SegmentResponse
"""

from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..database import Book, BookSegment, Chapter
from ..models import SegmentResponse
from .book_segments import segment_to_response


def renumber_chapter_segments(chapter_id: str, db: Session) -> None:
    """Re-assign order=0..n-1 to all segments in chapter_id sorted by current order.

    This ensures ordering is always contiguous and unique after split or merge.
    """
    segments = (
        db.query(BookSegment)
        .filter_by(chapter_id=chapter_id)
        .order_by(BookSegment.order)
        .all()
    )
    for new_order, seg in enumerate(segments):
        seg.order = new_order
    db.flush()


def _check_chapter_not_generating(chapter_id: str, db: Session) -> None:
    """Raise 409 if the chapter's owning book is currently generating."""
    chapter = db.query(Chapter).filter_by(id=chapter_id).first()
    if chapter is not None:
        book = db.query(Book).filter_by(id=chapter.book_id).first()
        if book is not None and book.status == "generating":
            raise HTTPException(
                status_code=409,
                detail="Chapter is currently generating; edits are locked",
            )


def split_segment(
    segment_id: str,
    at_offset: int,
    db: Session,
) -> list[SegmentResponse]:
    """Split a segment into two at the given character offset.

    Business rules:
    - 404 if segment_id is unknown.
    - 409 if the owning book is currently generating.
    - 400 if at_offset <= 0 or >= len(text) (must produce two non-empty halves).
    - Original keeps text[:at_offset].rstrip().
    - New segment takes text[at_offset:].lstrip() and inherits character_id,
      type, emotion, emotion_intensity, delivery.
    - New segment order = original.order + 1; all later segments renumbered.
    - If the original had a generation_id, its audio_status becomes "stale".
    - Returns [original_updated, new_segment] as SegmentResponse list.
    """
    seg = db.query(BookSegment).filter_by(id=segment_id).first()
    if seg is None:
        raise HTTPException(status_code=404, detail="Segment not found")

    _check_chapter_not_generating(seg.chapter_id, db)

    text = seg.text
    if at_offset <= 0 or at_offset >= len(text):
        raise HTTPException(
            status_code=400,
            detail="at_offset must be > 0 and < len(text) to produce two non-empty halves",
        )

    first_text = text[:at_offset].rstrip()
    second_text = text[at_offset:].lstrip()

    if not first_text or not second_text:
        raise HTTPException(
            status_code=400,
            detail="Split produces an empty segment; choose a different offset",
        )

    # Make room for the new segment: bump orders of all segments after original
    later_segs = (
        db.query(BookSegment)
        .filter(
            BookSegment.chapter_id == seg.chapter_id,
            BookSegment.order > seg.order,
        )
        .all()
    )
    for later in later_segs:
        later.order += 1
    db.flush()

    # Update original segment
    original_order = seg.order
    seg.text = first_text
    if seg.generation_id is not None:
        seg.audio_status = "stale"
    db.flush()

    # Create new segment
    new_seg = BookSegment(
        id=str(uuid.uuid4()),
        chapter_id=seg.chapter_id,
        character_id=seg.character_id,
        type=seg.type,
        order=original_order + 1,
        text=second_text,
        emotion=seg.emotion,
        emotion_intensity=seg.emotion_intensity,
        delivery=seg.delivery,
        audio_status="none",
        generation_id=None,
    )
    db.add(new_seg)
    db.flush()

    # Renumber to ensure contiguity (covers edge cases)
    renumber_chapter_segments(seg.chapter_id, db)
    db.commit()

    db.refresh(seg)
    db.refresh(new_seg)

    return [segment_to_response(seg, db), segment_to_response(new_seg, db)]


def merge_segments(
    segment_ids: list[str],
    db: Session,
) -> SegmentResponse:
    """Merge a run of adjacent segments into one.

    Business rules:
    - 400 if fewer than 2 segment_ids.
    - 404 if any id is unknown.
    - 409 if the owning book is currently generating.
    - 400 if segments are not all in the same chapter.
    - 400 if segments are not consecutive in order (no gaps).
    - Concatenate text joined with a single space.
    - Keep first segment's character_id, type, emotion, emotion_intensity, delivery.
    - Delete the rest; renumber chapter.
    - If the surviving segment had a generation_id, set audio_status='stale'.
    - Returns the merged SegmentResponse.
    """
    if len(segment_ids) < 2:
        raise HTTPException(
            status_code=400,
            detail="merge requires at least 2 segment_ids",
        )

    # Fetch all segments
    segments = []
    for sid in segment_ids:
        seg = db.query(BookSegment).filter_by(id=sid).first()
        if seg is None:
            raise HTTPException(status_code=404, detail=f"Segment not found: {sid}")
        segments.append(seg)

    # All must share the same chapter
    chapter_ids = {seg.chapter_id for seg in segments}
    if len(chapter_ids) != 1:
        raise HTTPException(
            status_code=400,
            detail="All segments must belong to the same chapter",
        )
    chapter_id = chapter_ids.pop()

    _check_chapter_not_generating(chapter_id, db)

    # Sort by order and verify consecutive (no gaps)
    segments.sort(key=lambda s: s.order)
    for i in range(1, len(segments)):
        if segments[i].order != segments[i - 1].order + 1:
            raise HTTPException(
                status_code=400,
                detail="Segments must be adjacent (consecutive order) to merge",
            )

    # Concatenate text
    merged_text = " ".join(seg.text for seg in segments)

    # First segment survives; update it
    first = segments[0]
    first.text = merged_text
    if first.generation_id is not None:
        first.audio_status = "stale"
    db.flush()

    # Delete the rest
    for seg in segments[1:]:
        db.delete(seg)
    db.flush()

    # Renumber chapter
    renumber_chapter_segments(chapter_id, db)
    db.commit()

    db.refresh(first)
    return segment_to_response(first, db)
