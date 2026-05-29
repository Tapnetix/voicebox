"""Segment regeneration endpoint (D3).

Provides:
    POST /segments/{segment_id}/regenerate
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from .. import models
from ..database import get_db
from ..services import book_regenerate

router = APIRouter(prefix="/segments", tags=["books"])


@router.post(
    "/{segment_id}/regenerate",
    status_code=202,
    response_model=models.RegenerateResponse,
)
def regenerate_segment(
    segment_id: str,
    body: models.RegenerateRequest = models.RegenerateRequest(),
    db: Session = Depends(get_db),
) -> models.RegenerateResponse:
    """Re-render a single BookSegment as a new GenerationVersion.

    Creates a new ``GenerationVersion`` on the segment's existing ``Generation``
    — does NOT create a new Generation, StoryItem, or touch any sibling segment.

    - Returns **202** immediately with ``{segment_id, generation_id, version_id, status}``.
    - Returns **404** if the segment does not exist.
    - Returns **409** if the book is currently generating.

    The optional body may override ``emotion``, ``instruct``, and ``seed`` for
    this take; when omitted the segment's current settings are recomposed via
    ``compose_instruct(segment)``.
    """
    return book_regenerate.regenerate_segment(
        segment_id,
        emotion=body.emotion,
        instruct=body.instruct,
        seed=body.seed,
        db=db,
    )
