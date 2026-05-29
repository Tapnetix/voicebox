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

    # ── Enqueue each generation through the serial TTS queue ─────────────
    for gen_id in generation_ids:
        # We need the generation row's details to pass to run_generation
        gen = db.query(database.Generation).filter_by(id=gen_id).first()
        if gen is None:
            continue  # shouldn't happen but be defensive

        coro = run_generation(
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

        try:
            task_queue.enqueue_generation(gen_id, coro)
        except Exception:
            # Queue unavailable (e.g. in tests or during startup) — mark as
            # error instead of crashing the whole chapter.
            logger.exception("Failed to enqueue generation %s", gen_id)
            _mark_generation_error(gen_id, "Queue unavailable", db)

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
# Synchronous enqueue entry-point: flip book status + dispatch
# ---------------------------------------------------------------------------


def enqueue_chapter_generation(
    book_id: str,
    chapter_id: str,
    *,
    engine: Optional[str] = None,
    model_size: Optional[str] = None,
    overwrite_errors: bool = False,
) -> tuple[str, int]:
    """Flip book status to 'generating', materialise and enqueue a chapter.

    The status flip is synchronous so concurrent requests see the 409 guard.

    Returns:
        ``(task_id, queued_segments)``
    """
    from .. import database

    db = next(database.get_db())
    try:
        book = db.query(database.Book).filter_by(id=book_id).first()
        if book is not None:
            book.status = "generating"
            db.commit()

        queued, _ = generate_chapter(
            chapter_id,
            engine=engine,
            model_size=model_size,
            overwrite_errors=overwrite_errors,
            db=db,
        )
    finally:
        db.close()

    task_id = str(uuid.uuid4())
    return task_id, queued


def enqueue_book_generation(
    book_id: str,
    *,
    engine: Optional[str] = None,
    model_size: Optional[str] = None,
    overwrite_errors: bool = False,
) -> tuple[str, int]:
    """Flip book status to 'generating', materialise and enqueue all chapters.

    Returns:
        ``(task_id, total_queued_segments)``
    """
    from .. import database

    db = next(database.get_db())
    try:
        book = db.query(database.Book).filter_by(id=book_id).first()
        if book is not None:
            book.status = "generating"
            db.commit()

        total, _ = generate_book(
            book_id,
            engine=engine,
            model_size=model_size,
            overwrite_errors=overwrite_errors,
            db=db,
        )
    finally:
        db.close()

    task_id = str(uuid.uuid4())
    return task_id, total


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


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
