"""Canonical chapter generation-state rollup helper (B5).

Provides ``chapter_generation_state`` — a reusable query that derives a
human-readable generation state string from a chapter's ``BookSegment``
``audio_status`` values.  C8 (audiobook export) will rely on this helper to
gate export readiness per chapter.

State semantics
---------------
none    — no segments exist, or all segments have audio_status='none'
partial — at least one segment has a non-'none' status but the set is not
          uniformly 'completed' and no segment has 'error'
ready   — every segment has audio_status='completed'
error   — at least one segment has audio_status='error' (trumps all others)
"""

from __future__ import annotations

from sqlalchemy.orm import Session

from ..database import BookSegment


def chapter_generation_state(chapter_id: str, db: Session) -> str:
    """Return a generation-state string for *chapter_id* based on its segments.

    Args:
        chapter_id: Primary key of the Chapter row to evaluate.
        db:         Active SQLAlchemy session.

    Returns:
        One of ``'none'``, ``'partial'``, ``'ready'``, or ``'error'``.
    """
    segments = (
        db.query(BookSegment)
        .filter_by(chapter_id=chapter_id)
        .all()
    )

    if not segments:
        return "none"

    statuses = {seg.audio_status for seg in segments}

    # Error takes highest priority
    if "error" in statuses:
        return "error"

    # All completed → ready
    if statuses <= {"completed"}:
        return "ready"

    # Any non-none status present (generating / pending / completed mixed with none)
    if statuses - {"none"}:
        return "partial"

    # All statuses are 'none'
    return "none"
