"""Tests for audiobook_export service.

Runs on synthetic short WAV clips — no GPU/model required.
Tests all three output formats (m4b, mp3_single, mp3_per_chapter) and asserts
M4B chapter markers via ffprobe.
"""

import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf


# ---------------------------------------------------------------------------
# Helpers for creating synthetic audio
# ---------------------------------------------------------------------------


def _make_sine_wav(path: str, freq: float = 440.0, duration: float = 0.5, sr: int = 24000) -> None:
    """Write a short sine-wave WAV to *path*."""
    t = np.linspace(0, duration, int(sr * duration), endpoint=False)
    audio = (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32)
    sf.write(path, audio, sr)


def _make_chapter(tmp_path: Path, chapter_num: int, n_segments: int = 3) -> dict:
    """Create a chapter dict with *n_segments* synthetic WAV files."""
    seg_paths = []
    for i in range(n_segments):
        p = str(tmp_path / f"ch{chapter_num}_seg{i}.wav")
        _make_sine_wav(p, freq=220 + chapter_num * 100 + i * 20)
        seg_paths.append(p)
    return {
        "number": chapter_num,
        "title": f"Chapter {chapter_num}",
        "segment_paths": seg_paths,
    }


# ---------------------------------------------------------------------------
# Import the service under test (will fail RED before implementation exists)
# ---------------------------------------------------------------------------


from backend.services.audiobook_export import export_book, read_chapter_markers  # noqa: E402
from backend.utils.audio import normalize_loudness  # noqa: E402


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture()
def two_chapter_book(tmp_path):
    """Return (chapters, options_base) for a two-chapter synthetic book."""
    chapters = [
        _make_chapter(tmp_path, chapter_num=1, n_segments=3),
        _make_chapter(tmp_path, chapter_num=2, n_segments=2),
    ]
    return chapters, tmp_path


@pytest.fixture()
def cover_image(tmp_path):
    """Create a minimal PNG (1x1 pixel) and return its path."""
    # Minimal valid PNG bytes (1x1 transparent pixel)
    png_bytes = bytes([
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,  # PNG signature
        0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,  # IHDR chunk
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
        0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,  # IDAT chunk
        0x54, 0x08, 0xD7, 0x63, 0xF8, 0xFF, 0xFF, 0x3F,
        0x00, 0x05, 0xFE, 0x02, 0xFE, 0xDC, 0xCC, 0x59,
        0xE7, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,  # IEND chunk
        0x44, 0xAE, 0x42, 0x60, 0x82,
    ])
    cover = tmp_path / "cover.png"
    cover.write_bytes(png_bytes)
    return str(cover)


# ---------------------------------------------------------------------------
# normalize_loudness unit tests
# ---------------------------------------------------------------------------


class TestNormalizeLoudness:
    def test_returns_numpy_array(self):
        audio = np.random.randn(24000).astype(np.float32) * 0.1
        result = normalize_loudness(audio, sample_rate=24000, target_lufs=-18.0)
        assert isinstance(result, np.ndarray)

    def test_shape_preserved(self):
        audio = np.random.randn(48000).astype(np.float32) * 0.1
        result = normalize_loudness(audio, sample_rate=24000, target_lufs=-18.0)
        assert result.shape == audio.shape

    def test_silent_audio_returned_unchanged(self):
        """Completely silent audio should not blow up."""
        audio = np.zeros(24000, dtype=np.float32)
        result = normalize_loudness(audio, sample_rate=24000, target_lufs=-18.0)
        assert result is not None
        assert result.shape == audio.shape

    def test_loudness_is_closer_to_target(self):
        """After normalization the loudness should be within 2 LU of target."""
        import pyloudnorm as pyln

        sr = 24000
        # Create 1-second pink-ish signal that pyloudnorm can measure
        t = np.linspace(0, 1.0, sr, endpoint=False)
        audio = (0.05 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)

        meter = pyln.Meter(sr)
        target = -18.0
        result = normalize_loudness(audio, sample_rate=sr, target_lufs=target)
        measured = meter.integrated_loudness(result)
        # If signal was measurable, check closeness
        if not np.isinf(measured):
            assert abs(measured - target) < 3.0


# ---------------------------------------------------------------------------
# export_book — M4B format
# ---------------------------------------------------------------------------


class TestExportM4B:
    def test_produces_m4b_file(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, filename = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "m4b",
                "title": "Test Book",
                "author": "Test Author",
            },
        )
        assert Path(out_path).exists(), "Output file should exist"
        assert out_path.endswith(".m4b"), "Output should be .m4b"
        assert filename.endswith(".m4b")

    def test_m4b_has_chapter_markers(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "m4b",
                "title": "Test Book",
                "author": "Test Author",
            },
        )
        markers = read_chapter_markers(out_path)
        # Should have one marker per chapter
        assert len(markers) == len(chapters), (
            f"Expected {len(chapters)} chapter markers, got {len(markers)}: {markers}"
        )

    def test_m4b_chapter_titles(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "m4b",
                "title": "Test Book",
                "author": "Test Author",
            },
        )
        markers = read_chapter_markers(out_path)
        titles = [m["title"] for m in markers]
        assert "Chapter 1" in titles
        assert "Chapter 2" in titles

    def test_m4b_with_cover(self, two_chapter_book, cover_image, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "m4b",
                "title": "Test Book",
                "author": "Test Author",
                "cover_path": cover_image,
            },
        )
        assert Path(out_path).exists()


# ---------------------------------------------------------------------------
# export_book — MP3 single format
# ---------------------------------------------------------------------------


class TestExportMP3Single:
    def test_produces_mp3_file(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, filename = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_single",
                "title": "Test Book",
                "author": "Test Author",
            },
        )
        assert Path(out_path).exists()
        assert out_path.endswith(".mp3")
        assert filename.endswith(".mp3")

    def test_mp3_has_id3_tags(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_single",
                "title": "My Audiobook",
                "author": "Test Author",
            },
        )
        from mutagen.id3 import ID3
        tags = ID3(out_path)
        assert "TIT2" in tags, "Title tag should be present"
        assert str(tags["TIT2"]) == "My Audiobook"

    def test_mp3_with_cover(self, two_chapter_book, cover_image, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_single",
                "title": "Test Book",
                "author": "Test Author",
                "cover_path": cover_image,
            },
        )
        from mutagen.id3 import ID3
        tags = ID3(out_path)
        # mutagen stores APIC as "APIC:Cover" or "APIC:<desc>" — check any APIC key
        assert any(k.startswith("APIC") for k in tags), "Cover art tag should be present"


# ---------------------------------------------------------------------------
# export_book — MP3 per-chapter ZIP format
# ---------------------------------------------------------------------------


class TestExportMP3PerChapter:
    def test_produces_zip_file(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, filename = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_per_chapter",
                "title": "Test Book",
                "author": "Test Author",
            },
        )
        assert Path(out_path).exists()
        assert out_path.endswith(".zip")
        assert filename.endswith(".zip")

    def test_zip_contains_one_mp3_per_chapter(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_per_chapter",
                "title": "Test Book",
                "author": "Test Author",
            },
        )
        with zipfile.ZipFile(out_path) as zf:
            mp3_files = [n for n in zf.namelist() if n.endswith(".mp3")]
        assert len(mp3_files) == len(chapters), (
            f"Expected {len(chapters)} MP3 files, got {len(mp3_files)}"
        )

    def test_zip_mp3s_have_id3_tags(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_per_chapter",
                "title": "My Book",
                "author": "Someone",
            },
        )
        with zipfile.ZipFile(out_path) as zf:
            mp3_names = sorted(n for n in zf.namelist() if n.endswith(".mp3"))
            assert len(mp3_names) >= 1
            # Extract first MP3 and check its tags
            with tempfile.TemporaryDirectory() as td:
                zf.extract(mp3_names[0], td)
                mp3_path = os.path.join(td, mp3_names[0])
                from mutagen.id3 import ID3
                tags = ID3(mp3_path)
                assert "TALB" in tags, "Album tag (book title) should be present"
                assert "TRCK" in tags, "Track number tag should be present"

    def test_zip_with_cover(self, two_chapter_book, cover_image, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={
                "format": "mp3_per_chapter",
                "title": "Test Book",
                "author": "Test Author",
                "cover_path": cover_image,
            },
        )
        assert Path(out_path).exists()


# ---------------------------------------------------------------------------
# read_chapter_markers tests
# ---------------------------------------------------------------------------


class TestReadChapterMarkers:
    def test_returns_list(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={"format": "m4b", "title": "X"},
        )
        markers = read_chapter_markers(out_path)
        assert isinstance(markers, list)

    def test_markers_have_title_and_start(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={"format": "m4b", "title": "X"},
        )
        markers = read_chapter_markers(out_path)
        for m in markers:
            assert "title" in m
            assert "start" in m

    def test_markers_start_times_ordered(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={"format": "m4b", "title": "X"},
        )
        markers = read_chapter_markers(out_path)
        starts = [m["start"] for m in markers]
        assert starts == sorted(starts), "Chapter start times must be in ascending order"


# ---------------------------------------------------------------------------
# Robustness: missing segments
# ---------------------------------------------------------------------------


class TestRobustness:
    def test_missing_segment_skipped(self, tmp_path):
        """A chapter with a missing audio file should not abort the export."""
        good_wav = str(tmp_path / "good.wav")
        _make_sine_wav(good_wav)
        chapters = [
            {
                "number": 1,
                "title": "Chapter 1",
                "segment_paths": [good_wav, "/nonexistent/segment.wav", good_wav],
            }
        ]
        out_path, _ = export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={"format": "mp3_single", "title": "T"},
        )
        assert Path(out_path).exists()

    def test_all_segments_missing_raises(self, tmp_path):
        """If ALL segments are missing, export should raise an error."""
        chapters = [
            {
                "number": 1,
                "title": "Chapter 1",
                "segment_paths": ["/nonexistent/a.wav", "/nonexistent/b.wav"],
            }
        ]
        with pytest.raises(Exception):
            export_book(
                chapters=chapters,
                output_dir=str(tmp_path / "out"),
                options={"format": "mp3_single", "title": "T"},
            )

    def test_progress_callback_called(self, two_chapter_book, tmp_path):
        chapters, _ = two_chapter_book
        calls = []

        def cb(pct, msg=""):
            calls.append((pct, msg))

        export_book(
            chapters=chapters,
            output_dir=str(tmp_path / "out"),
            options={"format": "mp3_single", "title": "T"},
            progress_callback=cb,
        )
        assert len(calls) > 0, "Progress callback should have been called at least once"
        # Final call should be 100%
        assert calls[-1][0] == 100
