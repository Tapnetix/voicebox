"""Character roster, voice-assignment, voice-options, and preview endpoints.

Contract 02 — routes that mix /books/{id}/... and /characters/{cid}/... paths.
Router prefix is "" so paths are declared with full explicit prefixes.

DO NOT edit routes/books.py, services/books.py, or routes/__init__.py.
The orchestrator registers this router centrally after merge.
"""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import (
    CharacterResponse,
    CharacterUpdate,
    PreviewRequest,
    PreviewResponse,
    VoiceOptionsResponse,
    VoiceProfileSummary,
)
from ..services import book_characters as svc

router = APIRouter()


# ---------------------------------------------------------------------------
# Roster
# ---------------------------------------------------------------------------


@router.get("/books/{book_id}/characters", response_model=list[CharacterResponse])
def list_characters(book_id: str, db: Session = Depends(get_db)):
    """Return the full character roster (incl. narrator) for a book."""
    try:
        return svc.get_character_roster(book_id, db)
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("404:"):
            raise HTTPException(status_code=404, detail=msg[4:])
        raise HTTPException(status_code=400, detail=msg)


# ---------------------------------------------------------------------------
# Update character
# ---------------------------------------------------------------------------


@router.patch(
    "/books/{book_id}/characters/{char_id}",
    response_model=CharacterResponse,
)
def patch_character(
    book_id: str,
    char_id: str,
    data: CharacterUpdate,
    db: Session = Depends(get_db),
):
    """Rename / recolor / assign voice (profile_id | design_prompt | preset_voice_id) / set narrator flag."""
    try:
        return svc.update_character(book_id, char_id, data, db)
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("404:"):
            raise HTTPException(status_code=404, detail=msg[4:])
        raise HTTPException(status_code=400, detail=msg)


# ---------------------------------------------------------------------------
# Voice options
# ---------------------------------------------------------------------------


@router.get("/books/{book_id}/voice-options", response_model=VoiceOptionsResponse)
def get_voice_options(book_id: str, db: Session = Depends(get_db)):
    """Return voice picker sources: library profiles, book profiles, and Kokoro presets."""
    try:
        return svc.get_voice_options(book_id, db)
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("404:"):
            raise HTTPException(status_code=404, detail=msg[4:])
        raise HTTPException(status_code=400, detail=msg)


# ---------------------------------------------------------------------------
# Save to library
# ---------------------------------------------------------------------------


@router.post("/characters/{char_id}/save-to-library", response_model=VoiceProfileSummary)
def save_to_library(char_id: str, db: Session = Depends(get_db)):
    """Promote the character's voice profile to the global library (is_library=True, book_id=None)."""
    try:
        return svc.save_character_to_library(char_id, db)
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("404:"):
            raise HTTPException(status_code=404, detail=msg[4:])
        raise HTTPException(status_code=400, detail=msg)


# ---------------------------------------------------------------------------
# Preview
# ---------------------------------------------------------------------------


@router.post("/characters/{char_id}/preview", response_model=PreviewResponse)
async def preview_character(
    char_id: str,
    data: PreviewRequest,
    db: Session = Depends(get_db),
):
    """Synthesize a short preview clip via the serial TTS queue.

    Returns {generation_id, audio_path}.
    400 if no voice is assigned; 404 if character not found.
    """
    try:
        result = await svc.preview_character_voice(
            char_id=char_id,
            text=data.text,
            db=db,
        )
        return PreviewResponse(**result)
    except ValueError as exc:
        msg = str(exc)
        if msg.startswith("404:"):
            raise HTTPException(status_code=404, detail=msg[4:])
        raise HTTPException(status_code=400, detail=msg)
