"""Character merge, split, and delete endpoints (B8).

Routes:
- POST /books/{book_id}/characters/{char_id}/merge
- POST /books/{book_id}/characters/{char_id}/split
- DELETE /books/{book_id}/characters/{char_id}

DO NOT edit routes/books.py, services/books.py, or routes/__init__.py.
The orchestrator registers this router centrally after merge.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database import get_db
from ..models import CharacterMergeRequest, CharacterResponse, CharacterSplitRequest
from ..services import book_character_structure as svc

router = APIRouter()


@router.post(
    "/books/{book_id}/characters/{char_id}/merge",
    response_model=list[CharacterResponse],
)
def merge_character(
    book_id: str,
    char_id: str,
    body: CharacterMergeRequest,
    db: Session = Depends(get_db),
):
    """Merge source_char_id into path char_id.

    All of source's segments are reassigned to the target character.
    Source's aliases are folded into the target's. Source row is deleted.
    Returns the updated roster.

    400 if source == target or source is the narrator.
    404 if book/character not found.
    409 if book is generating.
    """
    return svc.merge_characters(
        book_id=book_id,
        target_char_id=char_id,
        source_char_id=body.source_char_id,
        db=db,
    )


@router.post(
    "/books/{book_id}/characters/{char_id}/split",
    response_model=list[CharacterResponse],
)
def split_character(
    book_id: str,
    char_id: str,
    body: CharacterSplitRequest,
    db: Session = Depends(get_db),
):
    """Move selected segment_ids off char_id into a new BookCharacter.

    The new character is book-scoped with profile_id=None and a distinct color.
    Both dialogue_counts are recomputed.
    Returns the updated roster.

    400 on empty segment_ids, blank new_name, or segment not owned by char_id.
    404 if book/character not found.
    409 if book is generating.
    """
    return svc.split_character(
        book_id=book_id,
        char_id=char_id,
        new_name=body.new_name,
        segment_ids=body.segment_ids,
        db=db,
    )


@router.delete(
    "/books/{book_id}/characters/{char_id}",
    response_model=list[CharacterResponse],
)
def delete_character(
    book_id: str,
    char_id: str,
    db: Session = Depends(get_db),
):
    """Delete a character, reassigning its segments to the narrator.

    Reassigned segments get type='narration'. Narrator dialogue_count
    is recomputed. The character row is deleted.
    Returns the updated roster.

    400 if char_id is the narrator.
    404 if book/character not found.
    409 if book is generating.
    """
    return svc.delete_character(
        book_id=book_id,
        char_id=char_id,
        db=db,
    )
