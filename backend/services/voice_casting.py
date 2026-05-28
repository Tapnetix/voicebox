"""Hybrid voice casting — designed leads/narrator, preset minors, distinctiveness.

Assigns VoiceProfile rows to BookCharacter rows for a given book:
- Leads (major role) and narrators get a *designed* VoiceProfile whose
  design_prompt comes from the character's vocal_description.
- Minors get a *preset* VoiceProfile drawn from the Kokoro pool, provided
  the book language is in KOKORO_LANGS.  If the pool is exhausted or the
  language is not supported, minors also get a designed profile.

A **distinctiveness check** ensures co-occurring speakers never share the
same (voice_type, preset_voice_id, design_prompt) key.

All created profiles have book_id set and is_library=False.  Names are
collision-safe: "<character> — <title>" with " (2)", " (3)" … suffixes.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Callable

from sqlalchemy.orm import Session

from ..database import Book, BookCharacter, VoiceProfile

# Languages covered by the Kokoro preset pool
KOKORO_LANGS = {"en", "zh", "ja", "es", "fr", "hi", "it", "pt"}


# ---------------------------------------------------------------------------
# Internal helpers — replaceable in tests via monkeypatch
# ---------------------------------------------------------------------------

def _get_preset_ids(engine: str) -> list[str]:
    """Return sorted list of preset voice ids for *engine*.

    This thin wrapper is the single seam that tests can monkeypatch.
    Production code delegates to profiles._get_preset_voice_ids which reads
    the real backend — no hardcoded list here.
    """
    from . import profiles as profiles_service

    return sorted(profiles_service._get_preset_voice_ids(engine))


def _unique_name(base: str, db: Session) -> str:
    """Return *base* if available in the DB, else probe "<base> (2)", " (3)" …"""
    name = base
    n = 1
    while db.query(VoiceProfile).filter_by(name=name).first() is not None:
        n += 1
        name = f"{base} ({n})"
    return name


def _conflicts(
    cid: str,
    key: tuple,
    used_keys: dict[str, tuple],
    cooccurrence: set[tuple],
) -> bool:
    """Return True if assigning *key* to *cid* would collide with a co-occurring speaker."""
    for other_id, other_key in used_keys.items():
        if other_key == key:
            pair1 = (cid, other_id)
            pair2 = (other_id, cid)
            if pair1 in cooccurrence or pair2 in cooccurrence:
                return True
    return False


# ---------------------------------------------------------------------------
# Profile creation helpers (no async — no TTS)
# ---------------------------------------------------------------------------

def _create_designed_profile(
    character: BookCharacter,
    book: Book,
    prompt: str,
    db: Session,
) -> VoiceProfile:
    name = _unique_name(f"{character.name} — {book.title}", db)
    profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name=name,
        voice_type="designed",
        design_prompt=prompt,
        book_id=book.id,
        is_library=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(profile)
    db.flush()
    return profile


def _create_preset_profile(
    character: BookCharacter,
    book: Book,
    voice_id: str,
    db: Session,
) -> VoiceProfile:
    name = _unique_name(f"{character.name} — {book.title}", db)
    profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name=name,
        voice_type="preset",
        preset_engine="kokoro",
        preset_voice_id=voice_id,
        default_engine="kokoro",
        book_id=book.id,
        is_library=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(profile)
    db.flush()
    return profile


def _pick_preset(
    preset_pool: list[str],
    character: BookCharacter,
    cooccurrence: set[tuple],
    used_keys: dict[str, tuple],
) -> str | None:
    """Return the first preset voice not in conflict with co-occurring speakers.

    Returns None when the pool is exhausted (caller must fall back to designed).
    """
    for voice_id in preset_pool:
        key = ("preset", voice_id, None)
        if not _conflicts(character.id, key, used_keys, cooccurrence):
            return voice_id
    return None


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def cast_book(
    book_id: str,
    *,
    cooccurrence: set[tuple[str, str]],
    language: str,
    db: Session,
) -> None:
    """Assign VoiceProfiles to all uncast BookCharacters for *book_id*.

    Args:
        book_id:      The book's primary key.
        cooccurrence: Set of (char_id_a, char_id_b) pairs that appear in the
                      same scene/chapter.  Order within each pair is arbitrary.
        language:     ISO 639-1 language code of the book (e.g. "en", "sw").
        db:           SQLAlchemy session.
    """
    book = db.get(Book, book_id)
    if book is None:
        raise ValueError(f"Book {book_id!r} not found")

    chars = db.query(BookCharacter).filter_by(book_id=book_id).all()

    # Load preset pool once — sorted for determinism
    preset_pool = _get_preset_ids("kokoro")

    # Map char_id -> distinctiveness key (voice_type, preset_voice_id, design_prompt)
    used_keys: dict[str, tuple] = {}

    # Seed used_keys with already-cast characters so distinctiveness accounts
    # for profiles from a previous partial cast run.
    for c in chars:
        if c.profile_id:
            prof = db.get(VoiceProfile, c.profile_id)
            if prof is not None:
                used_keys[c.id] = (prof.voice_type, prof.preset_voice_id, prof.design_prompt)

    # Process characters from most-spoken to least so leads (high dialogue_count)
    # get first pick and their designed voices anchor the distinctiveness space.
    for c in sorted(chars, key=lambda x: -(x.dialogue_count or 0)):
        if c.profile_id:
            # Already cast (from a prior run or above seed) — keep it.
            continue

        is_lead = (c.role == "major") or bool(c.is_narrator)

        if is_lead or language not in KOKORO_LANGS:
            # --- Designed voice ---
            prompt = c.vocal_description or f"a distinctive voice for {c.name}"

            # If co-occurring lead shares the same raw prompt, append a nudge.
            base_key = ("designed", None, prompt)
            nudge = 0
            key = base_key
            while _conflicts(c.id, key, used_keys, cooccurrence):
                nudge += 1
                nudged_prompt = f"{prompt} [voice variant {nudge}]"
                key = ("designed", None, nudged_prompt)
            _, _, final_prompt = key

            prof = _create_designed_profile(c, book, final_prompt, db)

        else:
            # --- Preset voice ---
            voice_id = _pick_preset(preset_pool, c, cooccurrence, used_keys)

            if voice_id is None:
                # Pool exhausted for this co-occurrence group — fall back to designed.
                prompt = c.vocal_description or f"a distinctive voice for {c.name}"
                base_key = ("designed", None, prompt)
                nudge = 0
                key = base_key
                while _conflicts(c.id, key, used_keys, cooccurrence):
                    nudge += 1
                    nudged_prompt = f"{prompt} [voice variant {nudge}]"
                    key = ("designed", None, nudged_prompt)
                _, _, final_prompt = key
                prof = _create_designed_profile(c, book, final_prompt, db)
            else:
                key = ("preset", voice_id, None)
                prof = _create_preset_profile(c, book, voice_id, db)

        used_keys[c.id] = key
        c.profile_id = prof.id

    db.commit()
