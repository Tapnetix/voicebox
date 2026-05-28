import tempfile
import shutil
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker

from backend.database import Base, Book, Chapter, BookCharacter, BookSegment, VoiceProfile  # noqa: E402


@pytest.fixture
def db():
    tmp = tempfile.mkdtemp()
    engine = create_engine(f"sqlite:///{Path(tmp) / 'test.db'}")
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session, engine
    session.close()
    shutil.rmtree(tmp)


def test_all_book_tables_created(db):
    _, engine = db
    tables = set(inspect(engine).get_table_names())
    assert {"books", "chapters", "book_characters", "book_segments"} <= tables


def test_profiles_has_book_scoping_columns(db):
    _, engine = db
    cols = {c["name"] for c in inspect(engine).get_columns("profiles")}
    assert {"book_id", "is_library"} <= cols


def test_book_chapter_segment_round_trip(db):
    session, _ = db
    book = Book(title="Silo", author="Hugh Howey", source_format="epub", status="imported")
    session.add(book)
    session.flush()
    ch = Chapter(book_id=book.id, number=1, title="Ch1", raw_text="Hello.", word_count=1)
    session.add(ch)
    session.flush()
    narrator = BookCharacter(book_id=book.id, name="Narrator", is_narrator=True, color="#888")
    session.add(narrator)
    session.flush()
    seg = BookSegment(chapter_id=ch.id, character_id=narrator.id, type="narration", order=0, text="Hello.")
    session.add(seg)
    session.commit()
    assert session.query(BookSegment).count() == 1


def test_booksegment_defaults(db):
    session, _ = db
    book = Book(title="B", source_format="txt", status="imported")
    session.add(book); session.flush()
    ch = Chapter(book_id=book.id, number=1, raw_text="x", word_count=1)
    session.add(ch); session.flush()
    seg = BookSegment(chapter_id=ch.id, type="dialogue", order=0, text="Hi")
    session.add(seg); session.commit()
    assert seg.audio_status == "none"
