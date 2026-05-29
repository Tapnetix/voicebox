"""Segment regeneration and preview endpoints (D3 + Fix 3).

Provides:
    POST /segments/{segment_id}/regenerate  — create a new GenerationVersion (destructive)
    POST /segments/{segment_id}/preview     — synthesize a preview clip (non-destructive)
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


@router.post(
    "/{segment_id}/preview",
    status_code=202,
    response_model=models.PreviewResponse,
)
async def preview_segment(
    segment_id: str,
    body: models.RegenerateRequest = models.RegenerateRequest(),
    db: Session = Depends(get_db),
) -> models.PreviewResponse:
    """Synthesize a short preview clip for a segment — non-destructive.

    Unlike ``/regenerate``, this endpoint does **not** create a new
    ``GenerationVersion``, does **not** promote any version to default, and
    does **not** change ``BookSegment.audio_status``.  It is safe to call
    during emotion-preview UX flows (D4) without disturbing the stored take.

    - Returns **202** with ``{generation_id, audio_path}`` pointing at the
      temporary preview audio.
    - Returns **404** if the segment does not exist.
    - Returns **409** if the book is currently generating.

    The optional body accepts ``emotion`` and ``instruct`` overrides.
    ``seed`` is ignored for previews (variation is intentional).
    """
    result = await book_regenerate.preview_segment(
        segment_id,
        emotion=body.emotion,
        instruct=body.instruct,
        db=db,
    )
    return models.PreviewResponse(**result)
