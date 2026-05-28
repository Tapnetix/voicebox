"""Services for character merge, split, and delete operations (B8).

Provides:
- merge_characters(book_id, target_char_id, source_char_id, db) -> list[CharacterResponse]
  Reassigns all BookSegment rows from source -> target, folds aliases,
  recomputes both dialogue_counts, deletes the source row.

- split_character(book_id, char_id, new_name, segment_ids, db) -> list[CharacterResponse]
  Creates a new BookCharacter and moves the listed segment_ids onto it.
  Recomputes both dialogue_counts.

- delete_character(book_id, char_id, db) -> list[CharacterResponse]
  Reassigns the character's segments to the narrator (type="narration"),
  recomputes narrator dialogue_count, deletes the row.

All three:
- 409 if any affected chapter's book is "generating".
- Set audio_status="stale" on moved segments that have a generation_id.
- Recompute dialogue_count from live segment rows (no incremental counters).
"""

from __future__ import annotations

import uuid
from typing import List

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..database import Book, BookCharacter, BookSegment, Chapter
from ..models import CharacterResponse
from .book_characters import character_to_response


# ---------------------------------------------------------------------------
# Color palette for new split characters
# ---------------------------------------------------------------------------

# A palette of distinct hex colors for new split characters.
# We pick the first color not already in use by any character in the book.
_COLOR_PALETTE = [
    "#e6194b",  # red
    "#3cb44b",  # green
    "#4363d8",  # blue
    "#f58231",  # orange
    "#911eb4",  # purple
    "#42d4f4",  # cyan
    "#f032e6",  # magenta
    "#bfef45",  # lime
    "#fabed4",  # pink
    "#469990",  # teal
    "#dcbeff",  # lavender
    "#9a6324",  # brown
    "#fffac8",  # beige
    "#800000",  # maroon
    "#aaffc3",  # mint
    "#808000",  # olive
    "#ffd8b1",  # apricot
    "#000075",  # navy
    "#a9a9a9",  # grey
]


def _pick_color(book_id: str, db: Session) -> str:
    """Pick a color not yet used by any BookCharacter in the book.

    Falls back to a deterministic UUID-based hex color if the palette is
    exhausted.
    """
    existing_colors = {
        c.color
        for c in db.query(BookCharacter).filter_by(book_id=book_id).all()
        if c.color is not None
    }
    for color in _COLOR_PALETTE:
        if color not in existing_colors:
            return color
    # Palette exhausted: generate a deterministic-ish unique color
    return "#" + uuid.uuid4().hex[:6]


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _assert_book_exists(book_id: str, db: Session) -> Book:
    """Return Book row or raise 404 HTTPException."""
    book = db.get(Book, book_id)
    if book is None:
        raise HTTPException(status_code=404, detail="Book not found")
    return book


def _assert_char_exists(char_id: str, book_id: str, db: Session) -> BookCharacter:
    """Return BookCharacter row or raise 404 HTTPException."""
    char = db.get(BookCharacter, char_id)
    if char is None or char.book_id != book_id:
        raise HTTPException(status_code=404, detail="Character not found")
    return char


def _assert_not_generating(book_id: str, db: Session) -> None:
    """Raise 409 HTTPException if the book status is 'generating'."""
    book = db.get(Book, book_id)
    if book is not None and book.status == "generating":
        raise HTTPException(
            status_code=409,
            detail="Book is currently generating; character edits are locked",
        )


def _invalidate_audio(segments: list[BookSegment]) -> None:
    """Set audio_status='stale' on segments that have a generation_id."""
    for seg in segments:
        if seg.generation_id is not None:
            seg.audio_status = "stale"


def _recount_dialogue(char_id: str, db: Session) -> int:
    """Count live dialogue segments for a character and update the row.

    For regular characters, count only type='dialogue' segments.
    For the narrator, count ALL segments (the narrator reads both narration
    and dialogue lines; its dialogue_count represents total segments).

    Returns the new count.
    """
    char = db.get(BookCharacter, char_id)
    if char is None:
        return 0

    if char.is_narrator:
        # Narrator's count reflects all segments assigned to it
        count = (
            db.query(BookSegment)
            .filter(BookSegment.character_id == char_id)
            .count()
        )
    else:
        # Regular characters: only count dialogue type segments
        count = (
            db.query(BookSegment)
            .filter(
                BookSegment.character_id == char_id,
                BookSegment.type == "dialogue",
            )
            .count()
        )

    char.dialogue_count = count
    return count


def _get_roster(book_id: str, db: Session) -> list[CharacterResponse]:
    """Return the full roster for a book, sorted narrator-first then by count."""
    chars = (
        db.query(BookCharacter)
        .filter_by(book_id=book_id)
        .order_by(BookCharacter.is_narrator.desc(), BookCharacter.dialogue_count.desc())
        .all()
    )
    return [character_to_response(c, db) for c in chars]


# ---------------------------------------------------------------------------
# Public service functions
# ---------------------------------------------------------------------------


def merge_characters(
    book_id: str,
    target_char_id: str,
    source_char_id: str,
    db: Session,
) -> list[CharacterResponse]:
    """Merge source_char_id into target_char_id.

    - All BookSegment rows are reassigned from source → target.
    - Source's aliases are folded into target's aliases.
    - Both dialogue_counts are recomputed from live rows.
    - Source BookCharacter row is deleted.
    - Returns the updated roster.

    Raises:
        400 if source == target or source is the narrator.
        404 if book, target, or source don't exist.
        409 if book is generating.
    """
    _assert_book_exists(book_id, db)
    _assert_not_generating(book_id, db)

    target = _assert_char_exists(target_char_id, book_id, db)
    source = _assert_char_exists(source_char_id, book_id, db)

    # Validation
    if source_char_id == target_char_id:
        raise HTTPException(status_code=400, detail="source_char_id must differ from target char_id")
    if source.is_narrator:
        raise HTTPException(status_code=400, detail="Cannot merge the narrator into another character")

    # Fetch all of source's segments
    source_segments = (
        db.query(BookSegment)
        .filter(BookSegment.character_id == source_char_id)
        .all()
    )

    # Invalidate stale audio on moved segments
    _invalidate_audio(source_segments)

    # Reassign all source segments to target
    for seg in source_segments:
        seg.character_id = target_char_id

    # Fold source's aliases into target's aliases (deduplicate)
    source_aliases: list[str] = source.aliases or []
    target_aliases: list[str] = list(target.aliases or [])
    for alias in source_aliases:
        if alias not in target_aliases:
            target_aliases.append(alias)
    target.aliases = target_aliases

    db.flush()

    # Recompute dialogue counts
    _recount_dialogue(target_char_id, db)
    # Source is about to be deleted; its count becomes 0 implicitly

    # Delete the source row
    db.delete(source)
    db.commit()

    return _get_roster(book_id, db)


def split_character(
    book_id: str,
    char_id: str,
    new_name: str,
    segment_ids: list[str],
    db: Session,
) -> list[CharacterResponse]:
    """Split selected segments off char_id into a new BookCharacter.

    - A new BookCharacter is created (book-scoped, profile_id=None).
    - Listed segment_ids (which must currently belong to char_id) are moved.
    - Both dialogue_counts are recomputed from live rows.
    - Returns the updated roster.

    Raises:
        400 on empty segment_ids, blank new_name, or segment not owned by char_id.
        404 if book or char doesn't exist.
        409 if book is generating.
    """
    _assert_book_exists(book_id, db)
    _assert_not_generating(book_id, db)

    char = _assert_char_exists(char_id, book_id, db)

    # Validation
    if not new_name or not new_name.strip():
        raise HTTPException(status_code=400, detail="new_name must not be blank")
    if not segment_ids:
        raise HTTPException(status_code=400, detail="segment_ids must not be empty")

    # Verify all segment_ids belong to char_id
    for sid in segment_ids:
        seg = db.get(BookSegment, sid)
        if seg is None or seg.character_id != char_id:
            raise HTTPException(
                status_code=400,
                detail=f"Segment '{sid}' does not belong to character '{char_id}'",
            )

    # Fetch the segments to move
    segments_to_move = (
        db.query(BookSegment)
        .filter(BookSegment.id.in_(segment_ids))
        .all()
    )

    # Invalidate stale audio on moved segments
    _invalidate_audio(segments_to_move)

    # Create the new character
    new_color = _pick_color(book_id, db)
    new_char = BookCharacter(
        book_id=book_id,
        name=new_name.strip(),
        is_narrator=False,
        profile_id=None,
        dialogue_count=0,
        color=new_color,
        aliases=[],
    )
    db.add(new_char)
    db.flush()

    # Reassign segments to new character
    for seg in segments_to_move:
        seg.character_id = new_char.id

    db.flush()

    # Recompute dialogue counts for both characters
    _recount_dialogue(char_id, db)
    _recount_dialogue(new_char.id, db)

    db.commit()

    return _get_roster(book_id, db)


def delete_character(
    book_id: str,
    char_id: str,
    db: Session,
) -> list[CharacterResponse]:
    """Delete a character, reassigning its segments to the narrator.

    - Segments are reassigned to the narrator (is_narrator=True) for this book.
    - Reassigned segments get type='narration'.
    - Narrator's dialogue_count is recomputed.
    - The character row is deleted.
    - Returns the updated roster.

    Raises:
        400 if char_id is the narrator.
        404 if book or char doesn't exist.
        409 if book is generating.
    """
    _assert_book_exists(book_id, db)
    _assert_not_generating(book_id, db)

    char = _assert_char_exists(char_id, book_id, db)

    if char.is_narrator:
        raise HTTPException(status_code=400, detail="Cannot delete the narrator character")

    # Find the narrator for this book
    narrator = (
        db.query(BookCharacter)
        .filter_by(book_id=book_id, is_narrator=True)
        .first()
    )
    if narrator is None:
        raise HTTPException(
            status_code=500,
            detail="Narrator not found for this book",
        )

    # Fetch all of the character's segments
    char_segments = (
        db.query(BookSegment)
        .filter(BookSegment.character_id == char_id)
        .all()
    )

    # Invalidate stale audio on moved segments
    _invalidate_audio(char_segments)

    # Reassign to narrator and retype as narration
    for seg in char_segments:
        seg.character_id = narrator.id
        seg.type = "narration"

    db.flush()

    # Recompute narrator dialogue_count (narration type segments don't count as "dialogue")
    # But narrator_count should include both narration and dialogue for narrator
    # Per spec: "recomputes the narrator's dialogue_count" — we count DIALOGUE type only
    # (per the spec's recount rule: count live dialogue segments)
    _recount_dialogue(narrator.id, db)

    # Delete the character
    db.delete(char)
    db.commit()

    return _get_roster(book_id, db)
