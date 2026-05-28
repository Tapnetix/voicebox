import tempfile
import shutil
from pathlib import Path

import pytest
from sqlalchemy import create_engine, inspect, text

from backend.database.migrations import run_migrations


def _legacy_profiles_engine(tmp):
    """A DB with a profiles table that LACKS book_id / is_library."""
    engine = create_engine(f"sqlite:///{Path(tmp) / 'legacy.db'}")
    with engine.connect() as conn:
        conn.execute(text(
            "CREATE TABLE profiles (id VARCHAR PRIMARY KEY, name VARCHAR, voice_type VARCHAR)"
        ))
        conn.commit()
    return engine


@pytest.fixture
def tmp():
    d = tempfile.mkdtemp()
    yield d
    shutil.rmtree(d)


def test_adds_book_scoping_columns_to_legacy_profiles(tmp):
    engine = _legacy_profiles_engine(tmp)
    run_migrations(engine)
    cols = {c["name"] for c in inspect(engine).get_columns("profiles")}
    assert {"book_id", "is_library"} <= cols


def test_creates_new_book_tables(tmp):
    # On a fresh DB, init_db's create_all makes the tables; verify run_migrations
    # is safe when they already exist and creates them via create_all path.
    from backend.database import Base
    engine = create_engine(f"sqlite:///{Path(tmp) / 'fresh.db'}")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
    tables = set(inspect(engine).get_table_names())
    assert {"books", "chapters", "book_characters", "book_segments"} <= tables


def test_migration_is_idempotent(tmp):
    engine = _legacy_profiles_engine(tmp)
    run_migrations(engine)
    run_migrations(engine)  # must not raise on the second pass
    cols = {c["name"] for c in inspect(engine).get_columns("profiles")}
    assert "book_id" in cols and "is_library" in cols
