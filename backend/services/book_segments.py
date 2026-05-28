"""Service helpers for segment listing and editing (B7).

Provides:
- segment_to_response(seg, db) -> SegmentResponse
- update_segment(segment_id, payload, db) -> SegmentResponse
  - Sets audio_status="stale" when a segment that already has a generation_id
    has any field changed.
  - Raises 409 if the owning chapter's book is currently generating.
  - Raises 404 if the segment_id is unknown.
"""

from __future__ import annotations

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..database import Book, BookCharacter, BookSegment, Chapter, Generation
from ..models import SegmentAudio, SegmentResponse, SegmentUpdate


def segment_to_response(seg: BookSegment, db: Session) -> SegmentResponse:
    """Serialize a BookSegment ORM row to a SegmentResponse Pydantic model.

    Resolves:
    - character_name from the linked BookCharacter (None if no character)
    - audio sub-object: generation_id, status, audio_path, duration_ms
      (audio_path and duration_ms are resolved from the linked Generation if any)
    """
    # Resolve character name
    character_name: str | None = None
    if seg.character_id is not None:
        char = db.query(BookCharacter).filter_by(id=seg.character_id).first()
        if char is not None:
            character_name = char.name

    # Resolve audio info
    audio_path: str | None = None
    duration_ms: int | None = None
    if seg.generation_id is not None:
        gen = db.query(Generation).filter_by(id=seg.generation_id).first()
        if gen is not None:
            audio_path = gen.audio_path
            if gen.duration is not None:
                # Generation.duration is in seconds (float); convert to ms
                duration_ms = int(gen.duration * 1000)

    audio = SegmentAudio(
        generation_id=seg.generation_id,
        status=seg.audio_status,
        audio_path=audio_path,
        duration_ms=duration_ms,
    )

    return SegmentResponse(
        id=seg.id,
        chapter_id=seg.chapter_id,
        character_id=seg.character_id,
        character_name=character_name,
        type=seg.type,  # type: ignore[arg-type]
        text=seg.text,
        emotion=seg.emotion,
        emotion_intensity=seg.emotion_intensity,
        delivery=seg.delivery,
        order=seg.order,
        audio=audio,
    )


def update_segment(
    segment_id: str,
    payload: SegmentUpdate,
    db: Session,
) -> SegmentResponse:
    """Apply a SegmentUpdate diff to a BookSegment row.

    Business rules:
    - 404 if the segment does not exist.
    - 409 if the owning book is currently in "generating" status.
    - Any field change on a segment that already has a generation_id sets
      audio_status="stale" (the old Generation row is retained).

    Returns the updated SegmentResponse.
    """
    seg = db.query(BookSegment).filter_by(id=segment_id).first()
    if seg is None:
        raise HTTPException(status_code=404, detail="Segment not found")

    # 409 check: is the owning book currently generating?
    chapter = db.query(Chapter).filter_by(id=seg.chapter_id).first()
    if chapter is not None:
        book = db.query(Book).filter_by(id=chapter.book_id).first()
        if book is not None and book.status == "generating":
            raise HTTPException(
                status_code=409,
                detail="Chapter is currently generating; edits are locked",
            )

    # Determine which fields actually change
    changed = False

    if payload.character_id is not None and payload.character_id != seg.character_id:
        seg.character_id = payload.character_id
        changed = True

    if payload.emotion is not None and payload.emotion != seg.emotion:
        seg.emotion = payload.emotion
        changed = True

    if (
        payload.emotion_intensity is not None
        and payload.emotion_intensity != seg.emotion_intensity
    ):
        seg.emotion_intensity = payload.emotion_intensity
        changed = True

    if payload.delivery is not None and payload.delivery != seg.delivery:
        seg.delivery = payload.delivery
        changed = True

    if payload.text is not None and payload.text != seg.text:
        seg.text = payload.text
        changed = True

    if payload.type is not None and payload.type != seg.type:
        seg.type = payload.type
        changed = True

    # Invalidate audio when any content field changed and there is a linked generation
    if changed and seg.generation_id is not None:
        seg.audio_status = "stale"

    if changed:
        db.commit()
        db.refresh(seg)

    return segment_to_response(seg, db)
