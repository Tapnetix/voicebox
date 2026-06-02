"""
Boundary tests for reference-audio duration validation.

Verifies that :func:`backend.utils.audio.validate_and_load_reference_audio`
and :func:`backend.utils.audio.validate_reference_audio` enforce the 45s cap
(raised from 30s) while keeping the 2s floor.
"""

import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, str(Path(__file__).parent.parent))

from utils.audio import (  # noqa: E402
    validate_reference_audio,
    validate_and_load_reference_audio,
)

SR = 24000


def _tone(duration_s: float, amp: float = 0.3, freq: float = 220.0) -> np.ndarray:
    n = int(duration_s * SR)
    t = np.arange(n, dtype=np.float32) / SR
    return (amp * np.sin(2 * np.pi * freq * t)).astype(np.float32)


# ---------------------------------------------------------------------------
# validate_and_load_reference_audio boundary tests
# ---------------------------------------------------------------------------

def test_validate_accepts_40s_clip(tmp_path):
    """A ~40s clip should be accepted under the new 45s cap."""
    audio = _tone(40.0, amp=0.3)
    path = tmp_path / "40s_ok.wav"
    sf.write(str(path), audio, SR)
    ok, err, out_audio, out_sr = validate_and_load_reference_audio(str(path))
    assert ok, f"expected 40s to pass under the 45s cap, got: {err}"
    assert out_audio is not None
    assert out_sr == SR


def test_validate_rejects_50s_clip_as_too_long(tmp_path):
    """A ~50s clip exceeds the 45s cap and must be rejected with 'too long'."""
    audio = _tone(50.0, amp=0.3)
    path = tmp_path / "50s_too_long.wav"
    sf.write(str(path), audio, SR)
    ok, err, _, _ = validate_and_load_reference_audio(str(path))
    assert not ok
    assert "too long" in (err or "").lower(), f"expected 'too long' in error, got: {err}"


def test_validate_rejects_sub_2s_clip_as_too_short(tmp_path):
    """A clip shorter than 2s must still be rejected with 'too short'."""
    audio = _tone(0.5, amp=0.3)
    path = tmp_path / "0.5s_too_short.wav"
    sf.write(str(path), audio, SR)
    ok, err, _, _ = validate_and_load_reference_audio(str(path))
    assert not ok
    assert "too short" in (err or "").lower(), f"expected 'too short' in error, got: {err}"


# ---------------------------------------------------------------------------
# validate_reference_audio mirrors same cap
# ---------------------------------------------------------------------------

def test_validate_reference_audio_accepts_40s_clip(tmp_path):
    """validate_reference_audio (thin wrapper) also accepts 40s clips."""
    audio = _tone(40.0, amp=0.3)
    path = tmp_path / "40s_ok.wav"
    sf.write(str(path), audio, SR)
    ok, err = validate_reference_audio(str(path))
    assert ok, f"expected 40s to pass, got: {err}"


def test_validate_reference_audio_rejects_50s_clip(tmp_path):
    """validate_reference_audio (thin wrapper) also rejects 50s clips."""
    audio = _tone(50.0, amp=0.3)
    path = tmp_path / "50s_too_long.wav"
    sf.write(str(path), audio, SR)
    ok, err = validate_reference_audio(str(path))
    assert not ok
    assert "too long" in (err or "").lower(), f"expected 'too long' in error, got: {err}"


# ---------------------------------------------------------------------------
# Default parameter introspection
# ---------------------------------------------------------------------------

def test_default_max_duration_is_45():
    """Both functions must expose max_duration=45.0 as their default."""
    import inspect
    sig_vra = inspect.signature(validate_reference_audio)
    sig_valra = inspect.signature(validate_and_load_reference_audio)
    assert sig_vra.parameters["max_duration"].default == 45.0
    assert sig_valra.parameters["max_duration"].default == 45.0


def test_default_min_duration_is_2():
    """min_duration must remain 2.0 — unchanged by this task."""
    import inspect
    sig_vra = inspect.signature(validate_reference_audio)
    sig_valra = inspect.signature(validate_and_load_reference_audio)
    assert sig_vra.parameters["min_duration"].default == 2.0
    assert sig_valra.parameters["min_duration"].default == 2.0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
