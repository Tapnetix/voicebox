"""Orchestration service for book analysis (B4).

Wires together literary analysis (B2) + voice casting (B3) into a single
background task that materialises BookCharacter, VoiceProfile, and BookSegment
rows and publishes SSE progress events on the per-book channel.

GPU coordination strategy (documented per task spec):
    Analysis runs the LLM (literary_analysis.analyze_book) which needs the
    GPU.  Before the LLM pass we defensively unload the TTS model so both
    pipelines never contend for the same VRAM at the same time.  The unload
    calls are wrapped in try/except so they are silent no-ops when no model
    is currently loaded (e.g. during tests) — the TTS backend reloads on
    demand the next time a generation is requested.
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import TYPE_CHECKING

from sqlalchemy.orm import Session

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _format_eta(seconds: float) -> str:
    """Human-readable time-remaining, e.g. '45s', '3m 20s', '1h 05m'."""
    secs = max(1, int(seconds))
    if secs < 60:
        return f"{secs}s"
    minutes, secs = divmod(secs, 60)
    if minutes < 60:
        return f"{minutes}m {secs:02d}s" if secs else f"{minutes}m"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h {minutes:02d}m"


def _unload_tts_for_analysis() -> None:
    """Unload the TTS model before the LLM pass to avoid GPU contention.

    Wrapped in a broad except so tests (which never load a model) and cold
    starts (where no backend has been initialised yet) are no-ops rather than
    errors.  The TTS backend reloads on demand when the next generation runs.
    """
    try:
        from . import tts as tts_service  # local import avoids circular deps

        tts_service.unload_tts_model()
    except Exception:
        pass  # nothing loaded — silently skip


def _unload_llm_after_analysis() -> None:
    """Optionally unload the LLM after analysis to free VRAM for TTS.

    Same defensive pattern as _unload_tts_for_analysis.
    """
    try:
        from .llm import unload_llm_model

        unload_llm_model()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------


async def run_analysis_task(
    book_id: str,
    *,
    model_size: str = "1.7B",
    narrator_voice_id: str = "auto",
    db: Session,
) -> None:
    """Full analysis pipeline: detect → cast → materialise → publish events.

    Args:
        book_id:           Primary key of the book to analyse.
        model_size:        LLM size to use for literary analysis ("0.6B","1.7B","4B").
        narrator_voice_id: Voice hint for the narrator ("auto" or a VoiceProfile id).
                           When a real profile id is given the narrator is pre-assigned
                           before casting so cast_book leaves it alone.
        db:                SQLAlchemy session — caller owns the lifecycle.

    Status transitions:
        analyzing → analyzed   on success
        analyzing → error      on any unhandled exception

    Events published on the book channel (contract-04):
        analysis_progress  (stage: detect|reconcile|profile|cast, progress 0-100)
        character_detected (incremental, with total)
        analysis_complete  (character_count, chapter_count)
        error              (on failure)
    """
    from .. import database
    from . import book_events, literary_analysis, voice_casting
    from .book_character_structure import _recount_dialogue

    def _pub(payload: dict) -> None:
        book_events.publish(book_id, payload)

    try:
        # ── Stage: detect ─────────────────────────────────────────────────
        # The first LLM call lazily loads a multi-GB model onto the GPU/CPU,
        # which is silent and CPU-heavy — say so, so it doesn't look hung.
        _pub(
            {
                "type": "analysis_progress",
                "stage": "detect",
                "progress": 0,
                "message": "Loading the language model into memory (first run can take a minute)…",
            }
        )

        # GPU coordination: unload TTS before the LLM analysis pass.
        # See module docstring for rationale.
        _unload_tts_for_analysis()

        # Fetch chapters in reading order
        chapters = (
            db.query(database.Chapter)
            .filter_by(book_id=book_id)
            .order_by(database.Chapter.number)
            .all()
        )
        chapter_texts = [ch.raw_text for ch in chapters]
        chapter_ids = [ch.id for ch in chapters]

        # Forward analyze_book's fine-grained progress to the book channel.
        # Its 0..1 fraction drives the (long-running) detect stage's bar 0→100;
        # once it returns, the fast reconcile/profile/cast events take over.
        # An ETA is appended once enough has run to extrapolate.
        _analysis_started = time.monotonic()

        def _on_analysis_progress(fraction: float, message: str) -> None:
            elapsed = time.monotonic() - _analysis_started
            if fraction >= 0.04 and elapsed >= 1.0:
                remaining = elapsed * (1.0 - fraction) / fraction
                message = f"{message}  ·  ~{_format_eta(remaining)} left"
            _pub(
                {
                    "type": "analysis_progress",
                    "stage": "detect",
                    "progress": int(round(fraction * 100)),
                    "message": message,
                }
            )

        analysis = await literary_analysis.analyze_book(
            chapter_texts,
            model_size=model_size,
            progress_cb=_on_analysis_progress,
        )

        _pub({"type": "analysis_progress", "stage": "detect", "progress": 100})

        # ── Stage: reconcile ──────────────────────────────────────────────
        _pub({"type": "analysis_progress", "stage": "reconcile", "progress": 45})

        global_chars = analysis.characters  # [{name, dialogue_count, confidence}, ...]

        # ── Stage: profile (materialise BookCharacter rows) ───────────────
        _pub({"type": "analysis_progress", "stage": "profile", "progress": 50})

        book = db.query(database.Book).filter_by(id=book_id).first()
        if book is None:
            raise ValueError(f"Book {book_id!r} disappeared during analysis")

        # Build character rows: detected characters + narrator
        char_rows: list[database.BookCharacter] = []
        total_chars = len(global_chars) + 1  # +1 for narrator

        # Narrator first
        narrator = database.BookCharacter(
            book_id=book_id,
            name="Narrator",
            is_narrator=True,
            dialogue_count=0,
            confidence=1.0,
        )
        db.add(narrator)
        db.flush()
        char_rows.append(narrator)

        _pub(
            {
                "type": "character_detected",
                "character": {
                    "id": narrator.id,
                    "name": narrator.name,
                    "color": narrator.color,
                    "dialogue_count": narrator.dialogue_count,
                    "confidence": narrator.confidence,
                },
                "total": total_chars,
            }
        )

        # Named characters
        for char_data in global_chars:
            char = database.BookCharacter(
                book_id=book_id,
                name=char_data["name"],
                is_narrator=False,
                dialogue_count=char_data.get("dialogue_count", 0),
                confidence=char_data.get("confidence"),
                color=char_data.get("color"),
                gender=char_data.get("gender"),
                age_range=char_data.get("age_estimate"),
                vocal_description=char_data.get("vocal_description"),
                archetype=char_data.get("archetype"),
                role=char_data.get("role"),  # "major" | "minor" | None
            )
            db.add(char)
            db.flush()
            char_rows.append(char)

            _pub(
                {
                    "type": "character_detected",
                    "character": {
                        "id": char.id,
                        "name": char.name,
                        "color": char.color,
                        "dialogue_count": char.dialogue_count,
                        "confidence": char.confidence,
                    },
                    "total": total_chars,
                }
            )

        db.commit()

        _pub({"type": "analysis_progress", "stage": "profile", "progress": 70})

        # ── Stage: cast (VoiceProfile rows via voice_casting) ─────────────
        _pub({"type": "analysis_progress", "stage": "cast", "progress": 75})

        # Fix 2: if narrator_voice_id is a real profile id, pre-assign the
        # narrator before calling cast_book so casting leaves it alone.
        if narrator_voice_id and narrator_voice_id not in ("auto", None):
            narrator_profile = db.get(database.VoiceProfile, narrator_voice_id)
            if narrator_profile is not None:
                narrator.profile_id = narrator_voice_id
                db.flush()

        # Build co-occurrence set from per-chapter character mentions
        cooccurrence: set[tuple[str, str]] = set()
        for ch_analysis in analysis.chapters:
            present = {c["name"] for c in ch_analysis.characters}
            # map name → char_id using the rows we just created
            name_to_id = {r.name: r.id for r in char_rows}
            ids_in_chapter = {name_to_id[n] for n in present if n in name_to_id}
            ids_list = sorted(ids_in_chapter)
            for i, a_id in enumerate(ids_list):
                for b_id in ids_list[i + 1 :]:
                    cooccurrence.add((a_id, b_id))

        voice_casting.cast_book(
            book_id,
            cooccurrence=cooccurrence,
            language="en",
            db=db,
        )

        _pub({"type": "analysis_progress", "stage": "cast", "progress": 90})

        # ── Materialise BookSegment rows ───────────────────────────────────
        name_to_id = {r.name: r.id for r in char_rows}

        for chapter_idx, (chapter_id, ch_analysis) in enumerate(
            zip(chapter_ids, analysis.chapters)
        ):
            for seg_data in ch_analysis.segments:
                speaker_name = seg_data.get("speaker")
                char_id: str | None = None
                if speaker_name and speaker_name.lower() != "narrator":
                    char_id = name_to_id.get(speaker_name)
                    if char_id is None:
                        # Fallback: use narrator for unresolved speakers
                        char_id = narrator.id
                else:
                    # Narration segments → narrator character
                    char_id = narrator.id

                segment = database.BookSegment(
                    chapter_id=chapter_id,
                    character_id=char_id,
                    type=seg_data.get("type", "narration"),
                    order=seg_data.get("order", 0),
                    text=seg_data.get("text", ""),
                    emotion=seg_data.get("emotion"),
                    emotion_intensity=seg_data.get("intensity"),
                    audio_status="none",
                )
                db.add(segment)

        db.commit()

        # Fix 4: recompute every character's dialogue_count from the materialized
        # BookSegment rows using the same rule as merge/split/delete operations.
        for row in char_rows:
            _recount_dialogue(row.id, db)
        db.commit()

        # Reload char_rows to get profile_ids populated by cast_book
        db.expire_all()
        char_rows = (
            db.query(database.BookCharacter).filter_by(book_id=book_id).all()
        )

        # Free LLM memory so TTS can use the GPU on the next generation
        _unload_llm_after_analysis()

        # ── Flip status + emit completion ──────────────────────────────────
        book = db.query(database.Book).filter_by(id=book_id).first()
        if book is not None:
            book.status = "analyzed"
            db.commit()

        chapter_count = len(chapters)
        character_count = len(char_rows)

        _pub(
            {
                "type": "analysis_complete",
                "character_count": character_count,
                "chapter_count": chapter_count,
            }
        )

    except Exception as exc:
        logger.exception("Analysis task failed for book %s", book_id)
        try:
            db_book = db.query(database.Book).filter_by(id=book_id).first()
            if db_book is not None:
                db_book.status = "error"
                db.commit()
        except Exception:
            pass

        try:
            book_events.publish(
                book_id,
                {
                    "type": "error",
                    "stage": "analyze",
                    "message": str(exc),
                },
            )
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Synchronous enqueue entry-point
# ---------------------------------------------------------------------------


def enqueue_analysis(
    book_id: str,
    model_size: str | None,
    narrator_voice_id: str | None,
) -> str:
    """Flip book status to 'analyzing' and enqueue the analysis background task.

    The status flip is synchronous and committed before this function returns
    so that concurrent requests see the 409 guard immediately.

    Args:
        book_id:           Book primary key.
        model_size:        LLM size string (e.g. "1.7B").  Defaults to "1.7B".
        narrator_voice_id: Voice hint for narrator; defaults to "auto".

    Returns:
        A task_id string (a fresh uuid4, opaque to clients).
    """
    from .. import database
    from . import task_queue

    effective_model_size = model_size or "1.7B"
    effective_narrator_voice_id = narrator_voice_id or "auto"

    # Flip status synchronously — race-safe guard
    db = next(database.get_db())
    try:
        book = db.query(database.Book).filter_by(id=book_id).first()
        if book is not None:
            book.status = "analyzing"
            db.commit()
    finally:
        db.close()

    # Launch the pipeline in the background with a fresh session
    async def _run():
        fresh_db = next(database.get_db())
        try:
            await run_analysis_task(
                book_id,
                model_size=effective_model_size,
                narrator_voice_id=effective_narrator_voice_id,
                db=fresh_db,
            )
        finally:
            fresh_db.close()

    task = task_queue.create_background_task(_run())
    task_id = str(uuid.uuid4())
    return task_id
