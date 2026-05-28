"""
Tests for book-domain Pydantic request/response shapes.
Validates example payloads from contracts 01-03.
"""

import pytest

from backend.models import (
    BookResponse,
    BookDetailResponse,
    ChapterSummary,
    CharacterResponse,
    SegmentResponse,
    VoiceOptionsResponse,
    AnalyzeRequest,
    ImportOptions,
    CharacterUpdate,
    SegmentUpdate,
    GenerateRequest,
    ExportRequest,
)


# ── Contract 01: Books ──────────────────────────────────────────────────────


def test_book_response_validates():
    payload = {
        "id": "b1",
        "title": "Silo",
        "author": "Hugh Howey",
        "source_format": "epub",
        "cover_path": None,
        "status": "imported",
        "chapter_count": 12,
        "created_at": "2026-05-28T00:00:00",
        "updated_at": "2026-05-28T00:00:00",
    }
    m = BookResponse.model_validate(payload)
    assert m.id == "b1"
    assert m.title == "Silo"
    assert m.chapter_count == 12
    assert m.cover_path is None


def test_book_response_optional_author():
    payload = {
        "id": "b2",
        "title": "Unknown",
        "source_format": "txt",
        "status": "imported",
        "chapter_count": 1,
        "created_at": "2026-05-28T00:00:00",
        "updated_at": "2026-05-28T00:00:00",
    }
    m = BookResponse.model_validate(payload)
    assert m.author is None


def test_chapter_summary_validates():
    payload = {
        "id": "c1",
        "number": 1,
        "title": "Holston",
        "word_count": 3200,
        "story_id": None,
        "generation_state": "none",
    }
    m = ChapterSummary.model_validate(payload)
    assert m.word_count == 3200
    assert m.generation_state == "none"
    assert m.story_id is None


def test_chapter_summary_optional_title():
    payload = {
        "id": "c2",
        "number": 2,
        "word_count": 1500,
        "generation_state": "ready",
    }
    m = ChapterSummary.model_validate(payload)
    assert m.title is None
    assert m.generation_state == "ready"


def test_book_detail_validates():
    payload = {
        "id": "b1",
        "title": "Silo",
        "author": "Hugh Howey",
        "source_format": "epub",
        "cover_path": None,
        "status": "imported",
        "chapter_count": 12,
        "created_at": "2026-05-28T00:00:00",
        "updated_at": "2026-05-28T00:00:00",
        "chapters": [
            {
                "id": "c1",
                "number": 1,
                "title": "Holston",
                "word_count": 3200,
                "story_id": None,
                "generation_state": "none",
            }
        ],
    }
    m = BookDetailResponse.model_validate(payload)
    assert m.chapters[0].word_count == 3200
    assert len(m.chapters) == 1


def test_book_detail_empty_chapters():
    payload = {
        "id": "b1",
        "title": "Silo",
        "source_format": "epub",
        "status": "imported",
        "chapter_count": 0,
        "created_at": "2026-05-28T00:00:00",
        "updated_at": "2026-05-28T00:00:00",
    }
    m = BookDetailResponse.model_validate(payload)
    assert m.chapters == []


def test_analyze_request_all_optional():
    m = AnalyzeRequest.model_validate({})
    assert m.model_size is None
    assert m.narrator_voice_id is None


def test_analyze_request_with_model_size():
    m = AnalyzeRequest.model_validate({"model_size": "1.7B", "narrator_voice_id": "auto"})
    assert m.model_size == "1.7B"
    assert m.narrator_voice_id == "auto"


def test_analyze_request_rejects_bad_model_size():
    with pytest.raises(Exception):
        AnalyzeRequest.model_validate({"model_size": "8B"})


def test_import_options_all_optional():
    m = ImportOptions.model_validate({})
    assert m.model_size is None
    assert m.narrator_voice_id is None


def test_import_options_with_values():
    m = ImportOptions.model_validate({"model_size": "4B", "narrator_voice_id": "prof-123"})
    assert m.model_size == "4B"


def test_analyze_response_validates():
    from backend.models import AnalyzeResponse
    m = AnalyzeResponse.model_validate({"book_id": "b1", "task_id": "t1", "status": "analyzing"})
    assert m.status == "analyzing"


# ── Contract 02: Characters & Segments ─────────────────────────────────────


def test_character_response_unassigned_voice():
    c = CharacterResponse.model_validate(
        {
            "id": "ch1",
            "name": "Holston",
            "color": "#3b82f6",
            "profile_id": None,
            "voice_type": None,
            "voice_label": None,
            "is_library": False,
            "is_narrator": False,
            "role": "major",
            "dialogue_count": 88,
            "confidence": 0.93,
            "aliases": ["Sheriff"],
        }
    )
    assert c.voice_type is None
    assert c.voice_label is None
    assert c.aliases == ["Sheriff"]


def test_character_response_all_optional_fields():
    c = CharacterResponse.model_validate(
        {
            "id": "ch2",
            "name": "Mayor",
            "dialogue_count": 10,
        }
    )
    assert c.gender is None
    assert c.age_range is None
    assert c.vocal_description is None
    assert c.archetype is None
    assert c.role is None
    assert c.confidence is None
    assert c.aliases == []
    assert c.is_library is False
    assert c.is_narrator is False


def test_character_update_all_optional():
    m = CharacterUpdate.model_validate({})
    assert m.name is None
    assert m.profile_id is None
    assert m.is_narrator is None


def test_character_update_with_values():
    m = CharacterUpdate.model_validate(
        {
            "name": "Sheriff Holston",
            "color": "#ff0000",
            "profile_id": "p-abc",
            "is_narrator": False,
        }
    )
    assert m.name == "Sheriff Holston"
    assert m.profile_id == "p-abc"


def test_segment_response_audio_nested():
    s = SegmentResponse.model_validate(
        {
            "id": "s1",
            "chapter_id": "c1",
            "character_id": "ch1",
            "character_name": "Holston",
            "type": "dialogue",
            "text": "We're cleaning.",
            "emotion": "resigned",
            "emotion_intensity": 0.6,
            "delivery": None,
            "order": 4,
            "audio": {
                "generation_id": None,
                "status": "none",
                "audio_path": None,
                "duration_ms": None,
            },
        }
    )
    assert s.audio.status == "none"
    assert s.audio.generation_id is None
    assert s.type == "dialogue"


def test_segment_response_narration_type():
    s = SegmentResponse.model_validate(
        {
            "id": "s2",
            "chapter_id": "c1",
            "character_id": None,
            "character_name": None,
            "type": "narration",
            "text": "The silo stretched downward.",
            "order": 1,
            "audio": {"status": "none"},
        }
    )
    assert s.type == "narration"
    assert s.character_id is None


def test_segment_response_rejects_bad_type():
    with pytest.raises(Exception):
        SegmentResponse.model_validate(
            {
                "id": "s3",
                "chapter_id": "c1",
                "type": "thoughts",
                "text": "...",
                "order": 2,
                "audio": {"status": "none"},
            }
        )


def test_segment_update_all_optional():
    m = SegmentUpdate.model_validate({})
    assert m.character_id is None
    assert m.emotion is None
    assert m.text is None
    assert m.type is None


def test_segment_update_type_validation():
    m = SegmentUpdate.model_validate({"type": "narration"})
    assert m.type == "narration"


def test_segment_update_rejects_bad_type():
    with pytest.raises(Exception):
        SegmentUpdate.model_validate({"type": "thoughts"})


def test_voice_options_response_empty():
    m = VoiceOptionsResponse.model_validate({})
    assert m.library == []
    assert m.book == []
    assert m.presets == []


def test_voice_options_response_with_data():
    m = VoiceOptionsResponse.model_validate(
        {
            "library": [
                {
                    "id": "p1",
                    "name": "Deep Male",
                    "voice_type": "cloned",
                    "is_library": True,
                    "book_id": None,
                }
            ],
            "book": [],
            "presets": [{"id": "preset1", "label": "Warm"}],
        }
    )
    assert len(m.library) == 1
    assert m.library[0].name == "Deep Male"
    assert len(m.presets) == 1


# ── Contract 03: Generation & Export ───────────────────────────────────────


def test_generate_request_defaults():
    m = GenerateRequest.model_validate({})
    assert m.engine is None
    assert m.model_size is None
    assert m.overwrite_errors is False


def test_generate_request_with_values():
    m = GenerateRequest.model_validate(
        {"engine": "kokoro", "model_size": "1.7B", "overwrite_errors": True}
    )
    assert m.engine == "kokoro"
    assert m.overwrite_errors is True


def test_export_request_valid_formats():
    for fmt in ["m4b", "mp3_single", "mp3_per_chapter"]:
        m = ExportRequest.model_validate({"format": fmt})
        assert m.format == fmt


def test_export_request_rejects_bad_format():
    with pytest.raises(Exception):
        ExportRequest.model_validate({"format": "ogg"})


def test_export_request_all_options():
    m = ExportRequest.model_validate(
        {
            "format": "m4b",
            "bitrate": "128k",
            "target_lufs": -18.0,
            "channels": "stereo",
            "title": "Silo",
            "author": "Hugh Howey",
            "cover_path": "/covers/silo.jpg",
        }
    )
    assert m.bitrate == "128k"
    assert m.target_lufs == -18.0
    assert m.channels == "stereo"


def test_export_request_rejects_bad_bitrate():
    with pytest.raises(Exception):
        ExportRequest.model_validate({"format": "m4b", "bitrate": "320k"})


def test_export_request_rejects_bad_channels():
    with pytest.raises(Exception):
        ExportRequest.model_validate({"format": "m4b", "channels": "surround"})


def test_generate_response_validates():
    from backend.models import GenerateResponse
    m = GenerateResponse.model_validate(
        {"book_id": "b1", "task_id": "t1", "queued_segments": 42}
    )
    assert m.queued_segments == 42
    assert m.chapter_id is None


def test_generate_response_with_chapter():
    from backend.models import GenerateResponse
    m = GenerateResponse.model_validate(
        {"book_id": "b1", "chapter_id": "c1", "task_id": "t1", "queued_segments": 5}
    )
    assert m.chapter_id == "c1"


def test_generation_status_response_validates():
    from backend.models import GenerationStatusResponse
    m = GenerationStatusResponse.model_validate(
        {
            "chapters": [
                {
                    "chapter_id": "c1",
                    "total": 10,
                    "completed": 8,
                    "errors": 1,
                    "state": "partial",
                }
            ],
            "overall_progress": 0.8,
        }
    )
    assert len(m.chapters) == 1
    assert m.chapters[0].total == 10
    assert m.overall_progress == 0.8


def test_export_response_validates():
    from backend.models import ExportResponse
    m = ExportResponse.model_validate(
        {"book_id": "b1", "task_id": "t2", "status": "exporting"}
    )
    assert m.status == "exporting"
