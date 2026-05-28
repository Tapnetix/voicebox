"""Services for character roster, voice-assignment, voice-options, and preview.

Implements the business logic for Contract 02 character endpoints.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy.orm import Session

from ..database import Book, BookCharacter, Generation, VoiceProfile
from ..models import (
    CharacterResponse,
    CharacterUpdate,
    VoiceOptionsResponse,
    VoiceProfileSummary,
)
from ..services.task_queue import enqueue_generation
from ..services.generation import run_generation
from ..utils.tasks import get_task_manager


# ---------------------------------------------------------------------------
# Internal helpers (thin seams for test monkeypatching)
# ---------------------------------------------------------------------------


def _get_kokoro_voices() -> set[tuple]:
    """Return the set of Kokoro voice tuples (voice_id, name, gender, lang)."""
    from ..backends.kokoro_backend import KOKORO_VOICES
    return set(KOKORO_VOICES)


def _unique_profile_name(base: str, db: Session) -> str:
    """Return *base* if not taken in DB, else append (2), (3) …"""
    name = base
    n = 1
    while db.query(VoiceProfile).filter_by(name=name).first() is not None:
        n += 1
        name = f"{base} ({n})"
    return name


# ---------------------------------------------------------------------------
# Serializer
# ---------------------------------------------------------------------------


def character_to_response(char: BookCharacter, db: Session) -> CharacterResponse:
    """Convert a BookCharacter ORM row to a CharacterResponse pydantic model.

    voice_type / voice_label / is_library are derived from the assigned
    VoiceProfile when present; they are null / False when unassigned.
    """
    voice_type: str | None = None
    voice_label: str | None = None
    is_library: bool = False

    if char.profile_id:
        profile = db.get(VoiceProfile, char.profile_id)
        if profile is not None:
            voice_type = getattr(profile, "voice_type", None) or "cloned"
            voice_label = profile.name
            is_library = bool(profile.is_library)

    return CharacterResponse(
        id=char.id,
        name=char.name,
        color=char.color,
        profile_id=char.profile_id,
        voice_type=voice_type,
        voice_label=voice_label,
        is_library=is_library,
        is_narrator=bool(char.is_narrator),
        role=char.role,
        gender=char.gender,
        age_range=char.age_range,
        vocal_description=char.vocal_description,
        archetype=char.archetype,
        dialogue_count=char.dialogue_count or 0,
        confidence=char.confidence,
        aliases=char.aliases or [],
    )


# ---------------------------------------------------------------------------
# Roster
# ---------------------------------------------------------------------------


def get_character_roster(book_id: str, db: Session) -> list[CharacterResponse]:
    """Return CharacterResponse list for all characters in the book.

    Raises ValueError with a '404' sentinel if the book doesn't exist.
    """
    book = db.get(Book, book_id)
    if book is None:
        raise ValueError("404:book not found")

    chars = (
        db.query(BookCharacter)
        .filter_by(book_id=book_id)
        .order_by(BookCharacter.is_narrator.desc(), BookCharacter.dialogue_count.desc())
        .all()
    )
    return [character_to_response(c, db) for c in chars]


# ---------------------------------------------------------------------------
# Update character (rename / recolor / assign voice)
# ---------------------------------------------------------------------------


def update_character(
    book_id: str,
    char_id: str,
    data: CharacterUpdate,
    db: Session,
) -> CharacterResponse:
    """Apply a CharacterUpdate to the specified character.

    Assignment modes (mutually exclusive):
      - profile_id     → assign existing profile directly
      - design_prompt  → create a new designed profile and assign it
      - preset_voice_id → create a new preset (Kokoro) profile and assign it

    Other fields (name, color, is_narrator) may be updated independently.

    Raises ValueError with '404' sentinel for unknown book/char.
    """
    book = db.get(Book, book_id)
    if book is None:
        raise ValueError("404:book not found")

    char = db.get(BookCharacter, char_id)
    if char is None or char.book_id != book_id:
        raise ValueError("404:character not found")

    # Simple field updates
    if data.name is not None:
        char.name = data.name
    if data.color is not None:
        char.color = data.color
    if data.is_narrator is not None:
        char.is_narrator = data.is_narrator

    # Voice assignment — only one of profile_id / design_prompt / preset_voice_id
    if data.profile_id is not None:
        # Assign an existing profile directly
        existing = db.get(VoiceProfile, data.profile_id)
        if existing is None:
            raise ValueError("400:profile not found")
        char.profile_id = data.profile_id

    elif data.design_prompt is not None:
        # Create a new designed profile and assign it
        name = _unique_profile_name(f"{char.name} — {book.title}", db)
        new_profile = VoiceProfile(
            id=str(uuid.uuid4()),
            name=name,
            voice_type="designed",
            design_prompt=data.design_prompt,
            book_id=book.id,
            is_library=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(new_profile)
        db.flush()
        char.profile_id = new_profile.id

    elif data.preset_voice_id is not None:
        # Create a new Kokoro preset profile and assign it
        name = _unique_profile_name(f"{char.name} — {book.title}", db)
        new_profile = VoiceProfile(
            id=str(uuid.uuid4()),
            name=name,
            voice_type="preset",
            preset_engine="kokoro",
            preset_voice_id=data.preset_voice_id,
            default_engine="kokoro",
            book_id=book.id,
            is_library=False,
            created_at=datetime.utcnow(),
            updated_at=datetime.utcnow(),
        )
        db.add(new_profile)
        db.flush()
        char.profile_id = new_profile.id

    db.commit()
    db.refresh(char)
    return character_to_response(char, db)


# ---------------------------------------------------------------------------
# Voice options
# ---------------------------------------------------------------------------


def get_voice_options(book_id: str, db: Session) -> VoiceOptionsResponse:
    """Return three-section voice picker payload for a book.

    library  — profiles with is_library=True
    book     — profiles with book_id == this book
    presets  — all Kokoro preset voices (same shape as /profiles/presets/kokoro)

    Raises ValueError with '404' sentinel if book not found.
    """
    book = db.get(Book, book_id)
    if book is None:
        raise ValueError("404:book not found")

    library_profiles = (
        db.query(VoiceProfile)
        .filter(VoiceProfile.is_library == True)  # noqa: E712
        .all()
    )
    book_profiles = (
        db.query(VoiceProfile)
        .filter(VoiceProfile.book_id == book_id)
        .all()
    )

    # Kokoro presets — same shape the profiles route returns
    kokoro_presets = [
        {
            "voice_id": vid,
            "name": name,
            "gender": gender,
            "language": lang,
        }
        for vid, name, gender, lang in _get_kokoro_voices()
    ]

    return VoiceOptionsResponse(
        library=[VoiceProfileSummary.model_validate(p) for p in library_profiles],
        book=[VoiceProfileSummary.model_validate(p) for p in book_profiles],
        presets=kokoro_presets,
    )


# ---------------------------------------------------------------------------
# Save to library
# ---------------------------------------------------------------------------


def save_character_to_library(char_id: str, db: Session) -> VoiceProfileSummary:
    """Promote the character's assigned voice profile to the global library.

    Flips profile.is_library=True and profile.book_id=None on the *same*
    profile row (promotion, not copy).

    Raises ValueError with '404' sentinel if character not found.
    Raises ValueError with '400' sentinel if character has no profile.
    """
    char = db.get(BookCharacter, char_id)
    if char is None:
        raise ValueError("404:character not found")

    if not char.profile_id:
        raise ValueError("400:character has no voice profile assigned")

    profile = db.get(VoiceProfile, char.profile_id)
    if profile is None:
        raise ValueError("400:assigned profile not found")

    profile.is_library = True
    profile.book_id = None
    profile.updated_at = datetime.utcnow()

    db.commit()
    db.refresh(profile)
    return VoiceProfileSummary.model_validate(profile)


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------

_PREVIEW_TEXT = "This is a preview of the character's voice."


async def preview_character_voice(
    char_id: str,
    text: Optional[str],
    db: Session,
) -> dict:
    """Synthesize a short preview clip through the serial TTS queue.

    Returns {generation_id, audio_path}.

    Raises ValueError with '404' sentinel if character not found.
    Raises ValueError with '400' sentinel if no voice is assigned.
    """
    char = db.get(BookCharacter, char_id)
    if char is None:
        raise ValueError("404:character not found")

    if not char.profile_id:
        raise ValueError("400:character has no voice profile assigned")

    profile = db.get(VoiceProfile, char.profile_id)
    if profile is None:
        raise ValueError("400:assigned profile not found")

    preview_text = text or _PREVIEW_TEXT
    generation_id = str(uuid.uuid4())

    # Resolve engine
    engine = (
        getattr(profile, "default_engine", None)
        or getattr(profile, "preset_engine", None)
        or "kokoro"
    )
    voice_type = getattr(profile, "voice_type", None) or "cloned"
    if voice_type == "preset":
        engine = getattr(profile, "preset_engine", None) or "kokoro"

    # Create a pending generation row
    from ..database import Generation as DBGeneration
    gen_row = DBGeneration(
        id=generation_id,
        profile_id=profile.id,
        text=preview_text,
        language="en",
        audio_path="",
        duration=0,
        status="generating",
        source="book_preview",
        created_at=datetime.utcnow(),
    )
    db.add(gen_row)
    db.commit()

    # Register in task manager
    task_manager = get_task_manager()
    task_manager.start_generation(
        task_id=generation_id,
        profile_id=profile.id,
        text=preview_text,
    )

    # Enqueue via the serial TTS queue
    enqueue_generation(
        generation_id,
        run_generation(
            generation_id=generation_id,
            profile_id=profile.id,
            text=preview_text,
            language="en",
            engine=engine,
            model_size=None,
            seed=None,
            normalize=True,
            instruct=None,
            mode="generate",
        ),
    )

    return {
        "generation_id": generation_id,
        "audio_path": "",
    }
