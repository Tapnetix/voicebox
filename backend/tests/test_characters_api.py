"""Tests for B6: character roster, voice-assignment, voice-options, preview endpoints.

Uses a minimal FastAPI app with a temp SQLite DB — no torch/TTS stack needed.
Characters are seeded directly; TTS/generation is mocked.
"""

import uuid
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database import (
    Base,
    Book,
    BookCharacter,
    Generation,
    VoiceProfile,
    get_db,
)
from backend.routes.book_characters import router as characters_router


# ---------------------------------------------------------------------------
# App fixture
# ---------------------------------------------------------------------------


def _make_app(tmp_path, monkeypatch):
    """Build minimal FastAPI app with temp SQLite DB and the characters router."""
    db_path = tmp_path / "test.db"
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    TestSession = sessionmaker(autocommit=False, autoflush=False, bind=engine)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    monkeypatch.setenv("VOICEBOX_DATA_DIR", str(tmp_path))
    import backend.config as _cfg
    _cfg._data_dir = tmp_path

    app = FastAPI()
    app.include_router(characters_router)
    app.dependency_overrides[get_db] = override_get_db
    return app, TestSession


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(scope="function")
def setup(tmp_path, monkeypatch):
    """Yields (client, db_session_factory, book_id, narrator_id, char_id, cast_char_id, uncast_char_id)."""
    app, TestSession = _make_app(tmp_path, monkeypatch)

    # Seed directly: book + characters
    db = TestSession()
    book = Book(
        id=str(uuid.uuid4()),
        title="Test Book",
        author="Author",
        source_format="txt",
        status="analyzed",
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(book)
    db.flush()

    # A preset profile already assigned (for cast character)
    cast_profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name="Narrator Voice",
        voice_type="preset",
        preset_engine="kokoro",
        preset_voice_id="af_heart",
        default_engine="kokoro",
        book_id=book.id,
        is_library=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(cast_profile)
    db.flush()

    narrator_char = BookCharacter(
        id=str(uuid.uuid4()),
        book_id=book.id,
        name="Narrator",
        is_narrator=True,
        profile_id=cast_profile.id,
        dialogue_count=50,
        role="major",
        created_at=datetime.utcnow(),
    )
    db.add(narrator_char)

    uncast_char = BookCharacter(
        id=str(uuid.uuid4()),
        book_id=book.id,
        name="Alice",
        is_narrator=False,
        profile_id=None,
        dialogue_count=10,
        role="minor",
        created_at=datetime.utcnow(),
    )
    db.add(uncast_char)

    # Another cast character (for save-to-library test)
    cast_char_profile = VoiceProfile(
        id=str(uuid.uuid4()),
        name="Alice Voice",
        voice_type="designed",
        design_prompt="A young woman's voice, warm and curious",
        book_id=book.id,
        is_library=False,
        created_at=datetime.utcnow(),
        updated_at=datetime.utcnow(),
    )
    db.add(cast_char_profile)
    db.flush()

    cast_char = BookCharacter(
        id=str(uuid.uuid4()),
        book_id=book.id,
        name="Bob",
        is_narrator=False,
        profile_id=cast_char_profile.id,
        dialogue_count=20,
        role="major",
        created_at=datetime.utcnow(),
    )
    db.add(cast_char)

    db.commit()
    # Capture IDs before closing session (avoid DetachedInstanceError)
    _book_id = book.id
    _narrator_id = narrator_char.id
    _uncast_char_id = uncast_char.id
    _cast_char_id = cast_char.id
    _cast_char_profile_id = cast_char_profile.id
    db.close()

    with TestClient(app) as client:
        yield {
            "client": client,
            "TestSession": TestSession,
            "book_id": _book_id,
            "narrator_id": _narrator_id,
            "uncast_char_id": _uncast_char_id,
            "cast_char_id": _cast_char_id,
            "cast_char_profile_id": _cast_char_profile_id,
        }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_get_roster(setup):
    """GET /books/{id}/characters returns all characters including narrator."""
    client = setup["client"]
    book_id = setup["book_id"]

    r = client.get(f"/books/{book_id}/characters")
    assert r.status_code == 200
    chars = r.json()
    assert isinstance(chars, list)
    assert len(chars) >= 2
    assert any(c["is_narrator"] for c in chars), "No narrator in roster"
    assert all("voice_type" in c for c in chars), "Missing voice_type in response"


def test_get_roster_assigned_has_voice_info(setup):
    """Characters with a profile have voice_type/voice_label populated."""
    client = setup["client"]
    book_id = setup["book_id"]

    chars = client.get(f"/books/{book_id}/characters").json()
    narrator = next(c for c in chars if c["is_narrator"])
    assert narrator["voice_type"] == "preset"
    assert narrator["voice_label"] is not None


def test_get_roster_unassigned_has_null_voice(setup):
    """Unassigned characters have voice_type=null and voice_label=null."""
    client = setup["client"]
    book_id = setup["book_id"]

    chars = client.get(f"/books/{book_id}/characters").json()
    uncast = next(c for c in chars if c["name"] == "Alice")
    assert uncast["voice_type"] is None
    assert uncast["voice_label"] is None


def test_get_roster_unknown_book_404(setup):
    """GET /books/{unknown}/characters returns 404."""
    client = setup["client"]
    r = client.get(f"/books/{uuid.uuid4()}/characters")
    assert r.status_code == 404


def test_assign_preset_voice(setup, monkeypatch):
    """PATCH with preset_voice_id creates+assigns a preset profile, returns voice_type=preset."""
    client = setup["client"]
    book_id = setup["book_id"]
    uncast_char_id = setup["uncast_char_id"]

    # Mock the kokoro voices so validation works without model
    import backend.services.book_characters as bc_svc
    monkeypatch.setattr(
        bc_svc,
        "_get_kokoro_voices",
        lambda: {("af_heart", "Heart", "female", "en")},
    )

    r = client.patch(
        f"/books/{book_id}/characters/{uncast_char_id}",
        json={"preset_voice_id": "af_heart"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["voice_type"] == "preset"
    assert body["voice_label"] is not None


def test_assign_preset_voice_unknown_char_404(setup):
    """PATCH with unknown char_id returns 404."""
    client = setup["client"]
    book_id = setup["book_id"]

    r = client.patch(
        f"/books/{book_id}/characters/{uuid.uuid4()}",
        json={"preset_voice_id": "af_heart"},
    )
    assert r.status_code == 404


def test_assign_profile_id(setup):
    """PATCH with profile_id assigns an existing profile directly."""
    client = setup["client"]
    book_id = setup["book_id"]
    uncast_char_id = setup["uncast_char_id"]
    cast_char_profile_id = setup["cast_char_profile_id"]

    r = client.patch(
        f"/books/{book_id}/characters/{uncast_char_id}",
        json={"profile_id": cast_char_profile_id},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["profile_id"] == cast_char_profile_id


def test_assign_design_prompt(setup):
    """PATCH with design_prompt creates+assigns a designed profile."""
    client = setup["client"]
    book_id = setup["book_id"]
    uncast_char_id = setup["uncast_char_id"]

    r = client.patch(
        f"/books/{book_id}/characters/{uncast_char_id}",
        json={"design_prompt": "A deep, commanding male voice"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["voice_type"] == "designed"
    assert body["voice_label"] is not None


def test_patch_rename_and_recolor(setup):
    """PATCH can update name/color without touching the profile."""
    client = setup["client"]
    book_id = setup["book_id"]
    uncast_char_id = setup["uncast_char_id"]

    r = client.patch(
        f"/books/{book_id}/characters/{uncast_char_id}",
        json={"name": "Alicia", "color": "#ff0000"},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["name"] == "Alicia"
    assert body["color"] == "#ff0000"


def test_voice_options_three_sections(setup):
    """GET /books/{id}/voice-options returns {library, book, presets} with presets non-empty."""
    client = setup["client"]
    book_id = setup["book_id"]

    r = client.get(f"/books/{book_id}/voice-options")
    assert r.status_code == 200, r.text
    opts = r.json()
    assert set(opts.keys()) == {"library", "book", "presets"}, f"Got keys: {set(opts.keys())}"
    assert isinstance(opts["library"], list)
    assert isinstance(opts["book"], list)
    assert isinstance(opts["presets"], list)
    assert len(opts["presets"]) > 0, "presets section must not be empty"


def test_voice_options_book_section_has_book_profiles(setup):
    """Voice-options book section includes profiles assigned to the book."""
    client = setup["client"]
    book_id = setup["book_id"]

    opts = client.get(f"/books/{book_id}/voice-options").json()
    # We seeded two profiles with book_id=book.id
    assert len(opts["book"]) >= 1


def test_voice_options_unknown_book_404(setup):
    """GET /books/{unknown}/voice-options returns 404."""
    client = setup["client"]
    r = client.get(f"/books/{uuid.uuid4()}/voice-options")
    assert r.status_code == 404


def test_save_to_library_promotes(setup):
    """POST /characters/{cid}/save-to-library flips is_library=True, book_id=None."""
    client = setup["client"]
    cast_char_id = setup["cast_char_id"]
    cast_char_profile_id = setup["cast_char_profile_id"]
    TestSession = setup["TestSession"]

    r = client.post(f"/characters/{cast_char_id}/save-to-library")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["is_library"] is True

    # Verify in DB
    db = TestSession()
    profile = db.query(VoiceProfile).filter_by(id=cast_char_profile_id).first()
    assert profile.is_library is True
    assert profile.book_id is None
    db.close()


def test_save_to_library_unassigned_char_400(setup):
    """POST /characters/{cid}/save-to-library for a character without a profile returns 400."""
    client = setup["client"]
    uncast_char_id = setup["uncast_char_id"]

    r = client.post(f"/characters/{uncast_char_id}/save-to-library")
    assert r.status_code == 400


def test_save_to_library_unknown_char_404(setup):
    """POST /characters/{unknown}/save-to-library returns 404."""
    client = setup["client"]
    r = client.post(f"/characters/{uuid.uuid4()}/save-to-library")
    assert r.status_code == 404


def test_preview_without_voice_is_400(setup):
    """POST /characters/{cid}/preview without a voice assigned returns 400."""
    client = setup["client"]
    uncast_char_id = setup["uncast_char_id"]

    r = client.post(f"/characters/{uncast_char_id}/preview", json={})
    assert r.status_code == 400


def test_preview_with_voice_queues(setup, monkeypatch):
    """POST /characters/{cid}/preview with a voice assigned creates a generation and queues it."""
    client = setup["client"]
    cast_char_id = setup["cast_char_id"]
    cast_char_profile_id = setup["cast_char_profile_id"]

    # Mock the TTS queue so no real synthesis runs
    enqueue_mock = MagicMock()
    monkeypatch.setattr(
        "backend.services.book_characters.enqueue_generation",
        enqueue_mock,
    )
    monkeypatch.setattr(
        "backend.services.book_characters.run_generation",
        MagicMock(return_value=AsyncMock()),
    )
    # Mock task_manager so it doesn't need event loops
    monkeypatch.setattr(
        "backend.services.book_characters.get_task_manager",
        MagicMock(return_value=MagicMock()),
    )

    r = client.post(f"/characters/{cast_char_id}/preview", json={"text": "Hello world."})
    assert r.status_code == 200, r.text
    body = r.json()
    assert "generation_id" in body
    assert "audio_path" in body
    assert enqueue_mock.called


def test_preview_unknown_char_404(setup):
    """POST /characters/{unknown}/preview returns 404."""
    client = setup["client"]
    r = client.post(f"/characters/{uuid.uuid4()}/preview", json={})
    assert r.status_code == 404
