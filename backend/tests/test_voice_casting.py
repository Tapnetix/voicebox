"""Tests for the hybrid voice-casting service (B3).

Uses a temp SQLite fixture — no TTS stack needed.
"""

import tempfile
import shutil
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import Base, Book, BookCharacter, VoiceProfile
from backend.services import voice_casting


@pytest.fixture
def db():
    tmp = tempfile.mkdtemp()
    engine = create_engine(f"sqlite:///{Path(tmp) / 't.db'}")
    Base.metadata.create_all(bind=engine)
    s = sessionmaker(bind=engine)()
    yield s
    s.close()
    shutil.rmtree(tmp)


def _book_with_chars(db, n_leads, n_minors, language="en"):
    book = Book(title="Silo", source_format="epub", status="analyzed")
    db.add(book)
    db.flush()
    chars = []
    for i in range(n_leads):
        chars.append(
            BookCharacter(
                book_id=book.id,
                name=f"Lead{i}",
                role="major",
                vocal_description=f"gravelly voice {i}",
                dialogue_count=100,
            )
        )
    for i in range(n_minors):
        chars.append(
            BookCharacter(
                book_id=book.id,
                name=f"Minor{i}",
                role="minor",
                dialogue_count=2,
            )
        )
    db.add_all(chars)
    db.commit()
    return book, chars


def test_leads_get_designed_voices(db):
    book, chars = _book_with_chars(db, n_leads=2, n_minors=0)
    cooccur = {(chars[0].id, chars[1].id)}
    voice_casting.cast_book(book.id, cooccurrence=cooccur, language="en", db=db)
    for c in chars:
        db.refresh(c)
        prof = db.query(VoiceProfile).filter_by(id=c.profile_id).first()
        assert prof.voice_type == "designed"
        assert prof.book_id == book.id and prof.is_library is False


def test_minors_get_preset_voices(db):
    """Minor characters in a supported language should get preset voices."""
    book, chars = _book_with_chars(db, n_leads=0, n_minors=2, language="en")
    cooccur = set()
    voice_casting.cast_book(book.id, cooccurrence=cooccur, language="en", db=db)
    for c in chars:
        db.refresh(c)
        prof = db.query(VoiceProfile).filter_by(id=c.profile_id).first()
        assert prof.voice_type == "preset"
        assert prof.book_id == book.id and prof.is_library is False


def test_cooccurring_speakers_differ(db):
    book, chars = _book_with_chars(db, n_leads=3, n_minors=4, language="en")
    ids = [c.id for c in chars]
    cooccur = {(ids[i], ids[j]) for i in range(len(ids)) for j in range(i + 1, len(ids))}
    voice_casting.cast_book(book.id, cooccurrence=cooccur, language="en", db=db)
    profiles = [
        db.get(VoiceProfile, c.profile_id)
        for c in db.query(BookCharacter).filter_by(book_id=book.id)
    ]
    keys = [(p.voice_type, p.preset_voice_id, p.design_prompt) for p in profiles]
    assert len(keys) == len(set(keys))  # all distinct among co-occurring cast


def test_minor_unknown_language_falls_back_to_designed(db):
    book, chars = _book_with_chars(db, n_leads=0, n_minors=1, language="sw")  # Swahili: no preset
    voice_casting.cast_book(book.id, cooccurrence=set(), language="sw", db=db)
    db.refresh(chars[0])
    prof = db.get(VoiceProfile, chars[0].profile_id)
    assert prof.voice_type == "designed"


def test_collision_safe_name_on_reanalysis(db):
    book, chars = _book_with_chars(db, n_leads=1, n_minors=0)
    voice_casting.cast_book(book.id, cooccurrence=set(), language="en", db=db)
    # Reset profile_id to simulate re-analysis
    for c in chars:
        c.profile_id = None
    db.commit()
    # cast again — must not raise on the UNIQUE name constraint
    voice_casting.cast_book(book.id, cooccurrence=set(), language="en", db=db)


def test_profile_has_book_id_and_not_library(db):
    """All auto-cast profiles have book_id set and is_library=False."""
    book, chars = _book_with_chars(db, n_leads=1, n_minors=2, language="en")
    voice_casting.cast_book(book.id, cooccurrence=set(), language="en", db=db)
    profiles = db.query(VoiceProfile).filter_by(book_id=book.id).all()
    assert len(profiles) == 3
    for p in profiles:
        assert p.book_id == book.id
        assert p.is_library is False


def test_already_cast_characters_skipped(db):
    """Characters with an existing profile_id are not re-cast."""
    book, chars = _book_with_chars(db, n_leads=1, n_minors=0)
    voice_casting.cast_book(book.id, cooccurrence=set(), language="en", db=db)
    db.refresh(chars[0])
    original_profile_id = chars[0].profile_id
    # cast again without resetting profile_id
    voice_casting.cast_book(book.id, cooccurrence=set(), language="en", db=db)
    db.refresh(chars[0])
    assert chars[0].profile_id == original_profile_id


def test_narrator_gets_designed_voice(db):
    """A character with is_narrator=True receives a designed profile regardless of role."""
    book = Book(title="Narrator Test", source_format="epub", status="analyzed")
    db.add(book)
    db.flush()
    narrator = BookCharacter(
        book_id=book.id,
        name="Narrator",
        role="minor",
        is_narrator=True,
        dialogue_count=0,
    )
    db.add(narrator)
    db.commit()
    voice_casting.cast_book(book.id, cooccurrence=set(), language="en", db=db)
    db.refresh(narrator)
    prof = db.get(VoiceProfile, narrator.profile_id)
    assert prof.voice_type == "designed"


def test_invalid_book_id_raises_value_error(db):
    """cast_book raises ValueError when the book_id does not exist."""
    with pytest.raises(ValueError):
        voice_casting.cast_book("nonexistent-id", cooccurrence=set(), language="en", db=db)


def test_preset_pool_exhaustion_falls_back_to_designed(db, monkeypatch):
    """When preset pool is exhausted for co-occurring speakers, fall back to designed."""
    # Make only 1 preset available but need 2 non-colliding minors co-occurring
    monkeypatch.setattr(
        voice_casting,
        "_get_preset_ids",
        lambda engine: ["af_heart"],
    )
    book, chars = _book_with_chars(db, n_leads=0, n_minors=2, language="en")
    ids = [c.id for c in chars]
    cooccur = {(ids[0], ids[1])}
    voice_casting.cast_book(book.id, cooccurrence=cooccur, language="en", db=db)
    profiles = [db.get(VoiceProfile, c.profile_id) for c in chars]
    keys = [(p.voice_type, p.preset_voice_id, p.design_prompt) for p in profiles]
    assert len(keys) == len(set(keys))  # still distinct
