"""Book generation service (D1).

Lazily materialises audio for a chapter or an entire book by:
1. Creating a Story row (once per chapter) and linking it back on Chapter.story_id.
2. For each unrendered BookSegment, creating a Generation row and a StoryItem.
3. Enqueuing each Generation through the serial TTS queue.

The endpoint returns immediately (202); synthesis runs in the background.

Key helpers exposed for reuse by D3/D4:
    compose_instruct(segment) → str | None
"""

from __future__ import annotations

import logging
import uuid
from typing import TYPE_CHECKING, Optional

from sqlalchemy.orm import Session

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)

# Default TTS engine and model size used when not specified by the caller.
_DEFAULT_ENGINE = "kokoro"
_DEFAULT_MODEL_SIZE = "1.7B"


# ---------------------------------------------------------------------------
# Public helper: compose instruct string
# ---------------------------------------------------------------------------


def compose_instruct(segment) -> Optional[str]:
    """Fold emotion + emotion_intensity + delivery into a single instruct string.

    This mirrors how Voicebox's existing generation composes instruct/emotion
    so the TTS engine receives a consistent prompt regardless of whether audio
    is triggered manually or from the book pipeline.

    Args:
        segment: A BookSegment ORM row (or any object with .emotion,
                 .emotion_intensity, .delivery attributes).

    Returns:
        A composed instruct string, or ``None`` if all fields are blank.
    """
    parts: list[str] = []

    emotion = getattr(segment, "emotion", None)
    intensity = getattr(segment, "emotion_intensity", None)
    delivery = getattr(segment, "delivery", None)

    if emotion:
        if intensity is not None:
            # Express intensity as an adverb modifier
            if intensity >= 0.8:
                modifier = "very "
            elif intensity >= 0.5:
                modifier = ""
            else:
                modifier = "slightly "
            parts.append(f"{modifier}{emotion}")
        else:
            parts.append(emotion)

    if delivery:
        parts.append(delivery)

    if not parts:
        return None

    return ", ".join(parts)


# ---------------------------------------------------------------------------
# Fix 1: Completion hook — reset book.status when all segments settle
# ---------------------------------------------------------------------------


async def _generation_with_completion_hook(
    book_id: str,
    inner_coro,
) -> None:
    """Wrap *inner_coro* so that after it finishes (success or error) we check
    whether any BookSegment for *book_id* is still pending/generating.  If none
    remain, flip book.status back to 'analyzed' and publish progress/complete
    SSE events on the per-book channel.

    Args:
        book_id:    The Book primary key whose status we manage.
        inner_coro: The run_generation coroutine to await.

    ``database.get_db`` is resolved dynamically at call time so that tests can
    redirect it before the hook fires.
    """
    from .. import database
    from . import book_events

    try:
        await inner_coro
    except Exception:
        logger.exception("run_generation raised inside completion hook")
    finally:
        # Open a fresh session so we don't share state with the caller's session.
        # Resolve get_db dynamically — allows tests to redirect it.
        db: Session = next(database.get_db())
        try:
            # ── Compute per-chapter progress and publish events ────────────
            chapters = (
                db.query(database.Chapter)
                .filter_by(book_id=book_id)
                .order_by(database.Chapter.number)
                .all()
            )

            # Pre-compute book-wide totals so overall_progress is correct for
            # every chapter event (Fix 3: early complete chapter must not
            # report 1.0 when later chapters are unstarted).
            chapter_segments: dict[str, list] = {}
            book_total = 0
            book_completed = 0
            for chapter in chapters:
                segs = (
                    db.query(database.BookSegment)
                    .filter_by(chapter_id=chapter.id)
                    .all()
                )
                chapter_segments[chapter.id] = segs
                book_total += len(segs)
                book_completed += sum(1 for s in segs if s.audio_status == "completed")

            overall_progress = book_completed / book_total if book_total > 0 else 0.0

            # Track which chapters already had generation_complete published in
            # this invocation to avoid re-emitting for already-settled chapters
            # as other segments from other chapters finish (Fix 2).
            published_complete_ids: set[str] = set()

            for chapter in chapters:
                segments = chapter_segments[chapter.id]
                total = len(segments)
                completed = sum(1 for s in segments if s.audio_status == "completed")
                errors = sum(1 for s in segments if s.audio_status == "error")

                book_events.publish(
                    book_id,
                    {
                        "type": "generation_progress",
                        "chapter_id": chapter.id,
                        "completed": completed,
                        "errors": errors,
                        "total": total,
                        "overall_progress": overall_progress,
                    },
                )

                # Publish generation_complete once per chapter, only at the
                # moment that chapter's segments all settle (Fix 2).
                chapter_in_flight = sum(
                    1 for s in segments if s.audio_status in {"pending", "generating"}
                )
                if chapter_in_flight == 0 and chapter.id not in published_complete_ids:
                    published_complete_ids.add(chapter.id)
                    book_events.publish(
                        book_id,
                        {
                            "type": "generation_complete",
                            "chapter_id": chapter.id,
                        },
                    )

            # ── Reset book.status if all book segments have settled ────────
            in_flight = (
                db.query(database.BookSegment)
                .join(database.Chapter, database.BookSegment.chapter_id == database.Chapter.id)
                .filter(
                    database.Chapter.book_id == book_id,
                    database.BookSegment.audio_status.in_({"pending", "generating"}),
                )
                .count()
            )
            if in_flight == 0:
                book = db.query(database.Book).filter_by(id=book_id).first()
                if book is not None and book.status == "generating":
                    book.status = "analyzed"
                    db.commit()
                    logger.info(
                        "Book %s: all segments settled — status reset to 'analyzed'", book_id
                    )
        except Exception:
            logger.exception(
                "Completion hook failed to reset book.status for book %s", book_id
            )
        finally:
            db.close()


# ---------------------------------------------------------------------------
# Core materialization: generate a single chapter
# ---------------------------------------------------------------------------


def generate_chapter(
    chapter_id: str,
    *,
    engine: Optional[str] = None,
    model_size: Optional[str] = None,
    overwrite_errors: bool = False,
    db: Session,
) -> tuple[int, list[str]]:
    """Lazily materialise and enqueue audio for all unrendered segments in a chapter.

    Creates:
    - A ``Story`` row (if the chapter has none yet) and links it to the chapter.
    - A ``Generation`` row per unrendered segment (source="book_import").
    - A ``StoryItem`` row linking each generation into the chapter's story.

    Sets each segment's ``generation_id`` and flips ``audio_status`` to
    ``"pending"`` before returning.

    Args:
        chapter_id:       Primary key of the Chapter to render.
        engine:           TTS engine to use (defaults to character's profile engine
                          or ``_DEFAULT_ENGINE``).
        model_size:       Model size string (defaults to ``_DEFAULT_MODEL_SIZE``).
        overwrite_errors: When True, re-enqueue segments whose
                          ``audio_status`` is ``"error"``.
        db:               Active SQLAlchemy session.

    Returns:
        A tuple of ``(queued_count, generation_ids)`` — number of segments
        enqueued and the list of new Generation ids (so the caller can return
        a meaningful ``queued_segments`` count).
    """
    from .. import database
    from . import task_queue
    from .generation import run_generation

    chapter = db.query(database.Chapter).filter_by(id=chapter_id).first()
    if chapter is None:
        raise ValueError(f"Chapter {chapter_id!r} not found")

    # ── Lazy Story creation ───────────────────────────────────────────────
    if chapter.story_id is None:
        story = database.Story(
            id=str(uuid.uuid4()),
            name=chapter.title or f"Chapter {chapter.number}",
        )
        db.add(story)
        db.flush()
        chapter.story_id = story.id
        db.flush()
    else:
        story = db.query(database.Story).filter_by(id=chapter.story_id).first()

    # ── Fetch segments in reading order ──────────────────────────────────
    eligible_statuses = {"none"}
    if overwrite_errors:
        eligible_statuses.add("error")

    segments = (
        db.query(database.BookSegment)
        .filter(
            database.BookSegment.chapter_id == chapter_id,
            database.BookSegment.audio_status.in_(eligible_statuses),
        )
        .order_by(database.BookSegment.order)
        .all()
    )

    # Determine the next start_time_ms for story ordering.
    # We place each new item after the last existing one (gap = 0 since we
    # don't know durations yet; the export step will re-sequence).
    existing_item_count = (
        db.query(database.StoryItem).filter_by(story_id=story.id).count()
    )
    next_order = existing_item_count  # used as a proxy for start_time_ms ordering

    queued_count = 0
    generation_ids: list[str] = []

    for idx, segment in enumerate(segments):
        # Resolve character → profile_id
        profile_id = _resolve_profile_id(segment, db)
        if profile_id is None:
            logger.warning(
                "Segment %s has no resolvable profile_id; skipping", segment.id
            )
            continue

        # Compose TTS instruct from emotion + delivery
        instruct = compose_instruct(segment)

        # Resolve engine for this segment
        effective_engine = engine or _resolve_engine_for_profile(profile_id, db)
        effective_model_size = model_size or _DEFAULT_MODEL_SIZE

        # Create the Generation row (status starts as "pending" here; the
        # queue worker will flip it to "generating" / "completed" / "failed")
        gen_id = str(uuid.uuid4())
        generation = database.Generation(
            id=gen_id,
            profile_id=profile_id,
            text=segment.text,
            language="en",
            engine=effective_engine,
            model_size=effective_model_size,
            instruct=instruct,
            source="book_import",
            status="pending",
        )
        db.add(generation)
        db.flush()

        # Place the generation in the story at reading order position
        story_item = database.StoryItem(
            id=str(uuid.uuid4()),
            story_id=story.id,
            generation_id=gen_id,
            start_time_ms=next_order + idx,  # strictly increasing
            track=0,
        )
        db.add(story_item)

        # Link segment → generation and flip status to pending
        segment.generation_id = gen_id
        segment.audio_status = "pending"

        db.flush()

        generation_ids.append(gen_id)
        queued_count += 1

    db.commit()

    return queued_count, generation_ids


# ---------------------------------------------------------------------------
# Book-level generate: iterate chapters
# ---------------------------------------------------------------------------


def generate_book(
    book_id: str,
    *,
    engine: Optional[str] = None,
    model_size: Optional[str] = None,
    overwrite_errors: bool = False,
    db: Session,
) -> tuple[int, list[str]]:
    """Enqueue audio for every chapter in *book_id*, reusing generate_chapter.

    Args:
        book_id:          Primary key of the Book to render.
        engine:           TTS engine (passed through to each chapter).
        model_size:       Model size string (passed through).
        overwrite_errors: Re-enqueue error segments when True.
        db:               Active SQLAlchemy session.

    Returns:
        A tuple of ``(total_queued, all_generation_ids)`` across all chapters.
    """
    from .. import database

    chapters = (
        db.query(database.Chapter)
        .filter_by(book_id=book_id)
        .order_by(database.Chapter.number)
        .all()
    )

    total_queued = 0
    all_gen_ids: list[str] = []

    for chapter in chapters:
        count, gen_ids = generate_chapter(
            chapter.id,
            engine=engine,
            model_size=model_size,
            overwrite_errors=overwrite_errors,
            db=db,
        )
        total_queued += count
        all_gen_ids.extend(gen_ids)

    return total_queued, all_gen_ids


# ---------------------------------------------------------------------------
# Public enqueue entry-points: 409 guard + status flip + drain reset
# ---------------------------------------------------------------------------


def enqueue_chapter_generation(
    book_id: str,
    chapter_id: str,
    db: Session,
    *,
    engine: Optional[str] = None,
    model_size: Optional[str] = None,
    overwrite_errors: bool = False,
) -> tuple[str, int]:
    """409-guard, flip book status, materialise and enqueue a chapter.

    This is the single place that owns the book status lifecycle for
    chapter-level generation:
    1. Checks book.status != 'generating' (409 guard).
    2. Flips book.status = 'generating' synchronously (race-safe).
    3. Calls generate_chapter to materialise segments.
    4. Wraps each enqueued coroutine in the completion hook that resets
       book.status to 'analyzed' once all its segments settle.

    Args:
        book_id:          Book primary key.
        chapter_id:       Chapter primary key.
        db:               Caller-supplied session (managed by route via Depends).
        engine:           TTS engine override.
        model_size:       Model size override.
        overwrite_errors: Re-enqueue error segments when True.

    Returns:
        ``(task_id, queued_segments)``

    Raises:
        HTTPException 404 if book or chapter not found.
        HTTPException 409 if book is already generating.
    """
    from .. import database
    from . import task_queue
    from .generation import run_generation

    book = db.query(database.Book).filter_by(id=book_id).first()
    if book is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Book not found")

    if book.status == "generating":
        from fastapi import HTTPException
        raise HTTPException(status_code=409, detail="Book is already generating")

    chapter = db.query(database.Chapter).filter_by(id=chapter_id, book_id=book_id).first()
    if chapter is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Chapter not found")

    # Flip status synchronously — race-safe 409 guard
    book.status = "generating"
    db.commit()

    queued, generation_ids = generate_chapter(
        chapter_id,
        engine=engine,
        model_size=model_size,
        overwrite_errors=overwrite_errors,
        db=db,
    )

    # Enqueue each generation through the TTS queue, wrapped with the
    # completion hook so book.status resets when all segments settle.
    for gen_id in generation_ids:
        gen = db.query(database.Generation).filter_by(id=gen_id).first()
        if gen is None:
            continue

        inner = run_generation(
            generation_id=gen_id,
            profile_id=gen.profile_id,
            text=gen.text,
            language=gen.language,
            engine=gen.engine,
            model_size=gen.model_size or _DEFAULT_MODEL_SIZE,
            seed=None,
            instruct=gen.instruct,
            mode="generate",
        )

        wrapped = _generation_with_completion_hook(
            book_id,
            inner,
        )

        try:
            task_queue.enqueue_generation(gen_id, wrapped)
        except Exception:
            logger.exception("Failed to enqueue generation %s", gen_id)
            _mark_generation_error(gen_id, "Queue unavailable", db)

    # If nothing was queued (e.g. all segments already rendered) reset now.
    if not generation_ids:
        _reset_book_status_if_settled(book_id, db)

    task_id = str(uuid.uuid4())
    return task_id, queued


def enqueue_book_generation(
    book_id: str,
    db: Session,
    *,
    engine: Optional[str] = None,
    model_size: Optional[str] = None,
    overwrite_errors: bool = False,
) -> tuple[str, int]:
    """409-guard, flip book status, materialise and enqueue all chapters.

    Mirrors enqueue_chapter_generation but for whole-book generation.

    Args:
        book_id:          Book primary key.
        db:               Caller-supplied session (managed by route via Depends).
        engine:           TTS engine override.
        model_size:       Model size override.
        overwrite_errors: Re-enqueue error segments when True.

    Returns:
        ``(task_id, total_queued_segments)``

    Raises:
        HTTPException 404 if book not found.
        HTTPException 409 if book is already generating.
    """
    from .. import database
    from . import task_queue
    from .generation import run_generation

    book = db.query(database.Book).filter_by(id=book_id).first()
    if book is None:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Book not found")

    if book.status == "generating":
        from fastapi import HTTPException
        raise HTTPException(status_code=409, detail="Book is already generating")

    # Flip status synchronously — race-safe 409 guard
    book.status = "generating"
    db.commit()

    total, generation_ids = generate_book(
        book_id,
        engine=engine,
        model_size=model_size,
        overwrite_errors=overwrite_errors,
        db=db,
    )

    # Enqueue each generation through the TTS queue, wrapped with the
    # completion hook so book.status resets when all segments settle.
    for gen_id in generation_ids:
        gen = db.query(database.Generation).filter_by(id=gen_id).first()
        if gen is None:
            continue

        inner = run_generation(
            generation_id=gen_id,
            profile_id=gen.profile_id,
            text=gen.text,
            language=gen.language,
            engine=gen.engine,
            model_size=gen.model_size or _DEFAULT_MODEL_SIZE,
            seed=None,
            instruct=gen.instruct,
            mode="generate",
        )

        wrapped = _generation_with_completion_hook(
            book_id,
            inner,
        )

        try:
            task_queue.enqueue_generation(gen_id, wrapped)
        except Exception:
            logger.exception("Failed to enqueue generation %s", gen_id)
            _mark_generation_error(gen_id, "Queue unavailable", db)

    # If nothing was queued (e.g. all segments already rendered) reset now.
    if not generation_ids:
        _reset_book_status_if_settled(book_id, db)

    task_id = str(uuid.uuid4())
    return task_id, total


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _reset_book_status_if_settled(book_id: str, db: Session) -> None:
    """Synchronously reset book.status to 'analyzed' if no segments are in-flight.

    Used when no generations were enqueued (nothing to await), so the
    async completion hook would never fire.
    """
    from .. import database

    in_flight = (
        db.query(database.BookSegment)
        .join(database.Chapter, database.BookSegment.chapter_id == database.Chapter.id)
        .filter(
            database.Chapter.book_id == book_id,
            database.BookSegment.audio_status.in_({"pending", "generating"}),
        )
        .count()
    )
    if in_flight == 0:
        book = db.query(database.Book).filter_by(id=book_id).first()
        if book is not None and book.status == "generating":
            book.status = "analyzed"
            db.commit()


def _resolve_profile_id(segment, db) -> Optional[str]:
    """Return the VoiceProfile id for a segment's assigned character."""
    from .. import database

    if segment.character_id is None:
        return None

    char = db.query(database.BookCharacter).filter_by(id=segment.character_id).first()
    if char is None:
        return None

    return char.profile_id


def _resolve_engine_for_profile(profile_id: str, db) -> str:
    """Return the default engine for a profile, falling back to _DEFAULT_ENGINE."""
    from .. import database

    profile = db.query(database.VoiceProfile).filter_by(id=profile_id).first()
    if profile is None:
        return _DEFAULT_ENGINE

    return (
        getattr(profile, "default_engine", None)
        or getattr(profile, "preset_engine", None)
        or _DEFAULT_ENGINE
    )


def _mark_generation_error(generation_id: str, error: str, db) -> None:
    """Best-effort: flip a Generation row to error status."""
    from .. import database

    try:
        gen = db.query(database.Generation).filter_by(id=generation_id).first()
        if gen is not None:
            gen.status = "failed"
            gen.error = error
            db.commit()
    except Exception:
        logger.exception("Failed to mark generation %s as error", generation_id)
