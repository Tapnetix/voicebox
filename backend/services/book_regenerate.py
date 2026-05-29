"""Book segment regeneration service (D3).

Provides ``regenerate_segment()`` — re-renders a single BookSegment as a new
GenerationVersion on its existing Generation row, leaving all sibling segments
completely untouched.

Key design decisions
====================
- Reuses the existing ``GenerationVersion`` mechanism (``services/versions.py``)
  that the timeline editor already uses — no new tables, no new storage layout.
- The new version is enqueued through the serial TTS queue
  (``task_queue.enqueue_generation``) so GPU contention is avoided.
- A placeholder version row is written *before* enqueueing so we can return a
  ``version_id`` in the 202 response.  The audio file does not exist yet; once
  the worker completes it will update the generation's ``audio_path`` and the
  version becomes playable.
- Uses ``compose_instruct(segment)`` from D1 as the default instruct; callers
  may override via the ``emotion``, ``instruct``, or ``seed`` parameters.
"""

from __future__ import annotations

import logging
import uuid
from typing import Optional

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def regenerate_segment(
    segment_id: str,
    *,
    emotion: Optional[str] = None,
    instruct: Optional[str] = None,
    seed: Optional[int] = None,
    db: Session,
):
    """Re-render a single BookSegment as a new GenerationVersion.

    Creates a placeholder ``GenerationVersion`` row immediately (status
    ``"pending"``) and enqueues the actual TTS render through the serial queue.
    The segment's ``audio_status`` is flipped to ``"pending"`` so the UI knows
    a re-render is in progress.

    Args:
        segment_id: Primary key of the BookSegment to regenerate.
        emotion:    Optional emotion override (applied on top of ``instruct``
                    when ``instruct`` is also given, otherwise replaces the
                    segment's current emotion).
        instruct:   Optional full instruct string override.  When omitted,
                    ``compose_instruct(segment)`` is called to recompose from
                    the segment's current emotion/delivery fields.
        seed:       Optional random seed override.  When omitted, a new seed
                    (``None``) lets the engine vary the take naturally.
        db:         Active SQLAlchemy session.

    Returns:
        A ``RegenerateResponse`` Pydantic model.

    Raises:
        HTTPException 404: if the segment does not exist.
        HTTPException 409: if the segment's book is currently generating.
    """
    from fastapi import HTTPException
    from .. import database
    from ..models import RegenerateResponse
    from . import task_queue
    from .generation import run_generation
    from .book_generation import compose_instruct, _DEFAULT_ENGINE, _DEFAULT_MODEL_SIZE

    # ── Look up segment ────────────────────────────────────────────────────
    segment = db.query(database.BookSegment).filter_by(id=segment_id).first()
    if segment is None:
        raise HTTPException(status_code=404, detail="Segment not found")

    # ── 409 guard: refuse if the book is currently being generated ─────────
    chapter = db.query(database.Chapter).filter_by(id=segment.chapter_id).first()
    if chapter is None:
        raise HTTPException(status_code=404, detail="Chapter not found")

    book = db.query(database.Book).filter_by(id=chapter.book_id).first()
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")

    if book.status == "generating":
        raise HTTPException(
            status_code=409,
            detail="Book is already generating — wait until it finishes before regenerating a segment",
        )

    # ── Ensure the segment has an existing Generation to attach the new
    #    version to.  If it does not (segment was never rendered), we refuse
    #    rather than silently creating a new Generation here — the caller
    #    should run the full chapter generate first.
    if segment.generation_id is None:
        raise HTTPException(
            status_code=409,
            detail="Segment has no prior generation — run chapter generate first",
        )

    generation_id = segment.generation_id
    gen = db.query(database.Generation).filter_by(id=generation_id).first()
    if gen is None:
        raise HTTPException(status_code=404, detail="Generation not found for segment")

    # ── Compose instruct ───────────────────────────────────────────────────
    # Caller may supply a full override; otherwise recompose from the segment.
    if instruct is not None:
        effective_instruct = instruct
    elif emotion is not None:
        # Partial override: swap the emotion field on a virtual segment object
        # and recompose.
        _mock = _SegmentProxy(segment, emotion_override=emotion)
        effective_instruct = compose_instruct(_mock)
    else:
        effective_instruct = compose_instruct(segment)

    # ── Create placeholder version row ────────────────────────────────────
    # We reserve a file path before the worker runs so we can hand back a
    # stable version_id in the 202 response.
    suffix = uuid.uuid4().hex[:8]
    placeholder_audio_path = f"generations/{generation_id}_{suffix}.wav"

    version = database.GenerationVersion(
        id=str(uuid.uuid4()),
        generation_id=generation_id,
        label=_next_take_label(generation_id, db),
        audio_path=placeholder_audio_path,
        is_default=False,  # becomes default once the worker completes
    )
    db.add(version)

    # Flip segment status to pending
    segment.audio_status = "pending"
    db.commit()
    db.refresh(version)

    version_id = version.id

    # ── Build and enqueue the run_generation coroutine ────────────────────
    engine = gen.engine or _DEFAULT_ENGINE
    model_size = gen.model_size or _DEFAULT_MODEL_SIZE
    profile_id = gen.profile_id

    inner = run_generation(
        generation_id=generation_id,
        profile_id=profile_id,
        text=gen.text,
        language=gen.language or "en",
        engine=engine,
        model_size=model_size,
        seed=seed,
        instruct=effective_instruct,
        mode="regenerate",
        version_id=version_id,
    )

    # Wrap with the segment-level completion hook so audio_status flips back
    # to "completed" (or "error") once the worker finishes.
    wrapped = _regenerate_with_completion_hook(
        segment_id=segment_id,
        version_id=version_id,
        inner_coro=inner,
    )

    try:
        task_queue.enqueue_generation(generation_id, wrapped)
    except Exception:
        logger.exception(
            "Failed to enqueue regeneration for segment %s / generation %s",
            segment_id,
            generation_id,
        )
        # Mark the segment as errored so the UI does not hang.
        segment.audio_status = "error"
        db.commit()
        raise HTTPException(status_code=503, detail="Queue unavailable")

    return RegenerateResponse(
        segment_id=segment_id,
        generation_id=generation_id,
        version_id=version_id,
        status="pending",
    )


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _next_take_label(generation_id: str, db: Session) -> str:
    """Return an auto-incremented "take-N" label for the next version."""
    from .. import database

    count = (
        db.query(database.GenerationVersion)
        .filter_by(generation_id=generation_id)
        .count()
    )
    return f"take-{count + 1}"


class _SegmentProxy:
    """Minimal proxy that overrides the emotion field for compose_instruct."""

    def __init__(self, segment, *, emotion_override: str):
        self._segment = segment
        self.emotion = emotion_override
        self.emotion_intensity = getattr(segment, "emotion_intensity", None)
        self.delivery = getattr(segment, "delivery", None)


async def _regenerate_with_completion_hook(
    segment_id: str,
    version_id: str,
    inner_coro,
) -> None:
    """Wrap *inner_coro* so that after it finishes we flip the segment's
    ``audio_status`` back to ``"completed"`` (or ``"error"`` on failure) and
    mark the new version as the default.

    Args:
        segment_id: The BookSegment whose status to update.
        version_id: The placeholder GenerationVersion to promote to default.
        inner_coro: The run_generation coroutine to await.
    """
    from .. import database

    success = False
    try:
        await inner_coro
        success = True
    except Exception:
        logger.exception(
            "run_generation raised inside regenerate completion hook (segment %s)",
            segment_id,
        )
    finally:
        db: Session = next(database.get_db())
        try:
            segment = db.query(database.BookSegment).filter_by(id=segment_id).first()
            if segment is not None:
                segment.audio_status = "completed" if success else "error"
                db.commit()

            if success:
                # Promote the new version to default
                from . import versions as versions_mod
                versions_mod.set_default_version(version_id, db)
        except Exception:
            logger.exception(
                "Completion hook failed for segment %s version %s",
                segment_id,
                version_id,
            )
        finally:
            db.close()
