"""
Audiobook export service.

Stitches a book's chapters (each described as an ordered list of audio segment
paths) with configurable inter-segment, scene, and chapter pauses, normalizes
the result to a target LUFS, then emits one of three formats:

  * ``m4b``            – single AAC-in-MP4 with FFmpeg chapter markers
  * ``mp3_single``     – single MP3 with ID3 tags (title/author/cover)
  * ``mp3_per_chapter``– ZIP archive containing one ID3-tagged MP3 per chapter

All heavy lifting (concatenation, encoding) is delegated to FFmpeg; Python only
drives the process and applies loudness normalization before encoding.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple, Union

import numpy as np
import soundfile as sf

from backend.utils.audio import load_audio, normalize_loudness

# ---------------------------------------------------------------------------
# Default pause durations
# ---------------------------------------------------------------------------

DEFAULT_INTER_SEGMENT_PAUSE_S: float = 0.3   # between adjacent segments
DEFAULT_SCENE_PAUSE_S: float = 0.8           # at detected scene/paragraph breaks
DEFAULT_CHAPTER_PAUSE_S: float = 1.5         # between chapters (appended at end)
DEFAULT_TARGET_LUFS: float = -18.0           # audiobook standard range −18 to −23
DEFAULT_BITRATE: str = "64k"
DEFAULT_SAMPLE_RATE: int = 24000
DEFAULT_CHANNELS: int = 1


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------


def _make_silence(duration_s: float, sample_rate: int = DEFAULT_SAMPLE_RATE) -> np.ndarray:
    """Return a mono float32 silence array of *duration_s* seconds."""
    n_samples = max(1, int(sample_rate * duration_s))
    return np.zeros(n_samples, dtype=np.float32)


def _stitch_chapter(
    segment_paths: List[Union[str, Dict[str, Any]]],
    sample_rate: int = DEFAULT_SAMPLE_RATE,
    inter_segment_pause_s: float = DEFAULT_INTER_SEGMENT_PAUSE_S,
    scene_pause_s: float = DEFAULT_SCENE_PAUSE_S,
) -> Optional[np.ndarray]:
    """Load and concatenate all segment WAV files for one chapter.

    Missing or unreadable files are skipped gracefully.  Returns ``None`` if
    *all* segments fail to load.

    Each entry in *segment_paths* may be either:

    * a plain ``str`` path to a WAV file, **or**
    * a ``dict`` with at least a ``"path"`` key and an optional boolean
      ``"is_scene_break"`` key.  When ``is_scene_break`` is ``True``, the
      pause inserted *before* this segment (if it is not the first loaded
      segment) will be *scene_pause_s* instead of *inter_segment_pause_s*,
      allowing scene/paragraph breaks to have noticeably longer gaps.

    Backward-compatible: if all entries are plain strings, behavior is
    identical to the original implementation (inter-segment pauses only).
    """
    parts: List[np.ndarray] = []
    inter_silence = _make_silence(inter_segment_pause_s, sample_rate)
    scene_silence = _make_silence(scene_pause_s, sample_rate)

    loaded_count = 0  # number of segments successfully loaded so far

    for entry in segment_paths:
        # Normalize entry to (path, is_scene_break)
        if isinstance(entry, dict):
            path = entry["path"]
            is_scene_break = bool(entry.get("is_scene_break", False))
        else:
            path = entry
            is_scene_break = False

        try:
            audio, _ = load_audio(path, sample_rate=sample_rate, mono=True)
        except Exception:
            continue  # skip bad segments

        # Insert the appropriate pause before this segment (not before the first loaded one)
        if loaded_count > 0:
            if is_scene_break:
                parts.append(scene_silence)
            else:
                parts.append(inter_silence)

        parts.append(audio)
        loaded_count += 1

    if not parts:
        return None

    return np.concatenate(parts, axis=0).astype(np.float32)


def _write_wav_to_tmp(audio: np.ndarray, sample_rate: int) -> str:
    """Write *audio* to a temp WAV file and return its path."""
    fd, path = tempfile.mkstemp(suffix=".wav")
    os.close(fd)
    sf.write(path, audio, sample_rate)
    return path


def _run_ffmpeg(cmd: List[str]) -> None:
    """Run an FFmpeg command; raise RuntimeError on failure."""
    result = subprocess.run(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        raise RuntimeError(
            f"FFmpeg failed (exit {result.returncode}):\n"
            f"{result.stderr.decode(errors='replace')}"
        )


def _encode_mp3(
    wav_path: str,
    out_path: str,
    bitrate: str = DEFAULT_BITRATE,
    channels: int = DEFAULT_CHANNELS,
) -> None:
    """Encode *wav_path* to MP3 at *out_path*."""
    cmd = [
        "ffmpeg", "-y",
        "-i", wav_path,
        "-codec:a", "libmp3lame",
        "-b:a", bitrate,
        "-ac", str(channels),
        out_path,
    ]
    _run_ffmpeg(cmd)


def _encode_aac_m4b(
    wav_path: str,
    out_path: str,
    chapters: List[Dict[str, Any]],
    chapter_starts_s: List[float],
    title: str = "",
    author: str = "",
    cover_path: Optional[str] = None,
    bitrate: str = DEFAULT_BITRATE,
    channels: int = DEFAULT_CHANNELS,
) -> None:
    """Encode *wav_path* → M4B with embedded chapter markers via FFmpeg metadata."""
    # Build FFmpeg chapter metadata
    metadata_lines = [
        ";FFMETADATA1",
        f"title={title}",
        f"artist={author}",
        "",
    ]
    # Calculate total duration from the wav to get end times
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            wav_path,
        ],
        capture_output=True,
        text=True,
    )
    total_duration_s = float(json.loads(result.stdout)["format"]["duration"])

    for i, (ch, start_s) in enumerate(zip(chapters, chapter_starts_s)):
        end_s = chapter_starts_s[i + 1] if i + 1 < len(chapter_starts_s) else total_duration_s
        start_ms = int(start_s * 1000)
        end_ms = int(end_s * 1000)
        ch_title = ch.get("title", f"Chapter {ch.get('number', i + 1)}")
        metadata_lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={start_ms}",
            f"END={end_ms}",
            f"title={ch_title}",
            "",
        ]

    fd, meta_path = tempfile.mkstemp(suffix=".txt")
    try:
        with os.fdopen(fd, "w") as f:
            f.write("\n".join(metadata_lines))

        cmd = [
            "ffmpeg", "-y",
            "-i", wav_path,
            "-i", meta_path,
            "-map_metadata", "1",
            "-codec:a", "aac",
            "-b:a", bitrate,
            "-ac", str(channels),
            "-f", "ipod",
        ]
        if cover_path and Path(cover_path).exists():
            cmd = [
                "ffmpeg", "-y",
                "-i", wav_path,
                "-i", meta_path,
                "-i", cover_path,
                "-map", "0:a",
                "-map", "2:v",
                "-map_metadata", "1",
                "-codec:a", "aac",
                "-b:a", bitrate,
                "-ac", str(channels),
                "-codec:v", "mjpeg",
                "-disposition:v", "attached_pic",
                "-f", "ipod",
            ]
        cmd.append(out_path)
        _run_ffmpeg(cmd)
    finally:
        Path(meta_path).unlink(missing_ok=True)


def _embed_mp3_tags(
    mp3_path: str,
    title: str = "",
    album: str = "",
    artist: str = "",
    track_num: Optional[int] = None,
    cover_path: Optional[str] = None,
) -> None:
    """Write ID3 tags (and optionally embed cover art) into an existing MP3."""
    from mutagen.id3 import (
        APIC,
        ID3,
        ID3NoHeaderError,
        TALB,
        TPE1,
        TRCK,
        TIT2,
    )
    import mimetypes

    try:
        tags = ID3(mp3_path)
    except ID3NoHeaderError:
        tags = ID3()

    if title:
        tags["TIT2"] = TIT2(encoding=3, text=title)
    if album:
        tags["TALB"] = TALB(encoding=3, text=album)
    if artist:
        tags["TPE1"] = TPE1(encoding=3, text=artist)
    if track_num is not None:
        tags["TRCK"] = TRCK(encoding=3, text=str(track_num))
    if cover_path and Path(cover_path).exists():
        mime = mimetypes.guess_type(cover_path)[0] or "image/jpeg"
        with open(cover_path, "rb") as img_f:
            tags["APIC:"] = APIC(
                encoding=3,
                mime=mime,
                type=3,   # Cover (front)
                desc="Cover",
                data=img_f.read(),
            )

    tags.save(mp3_path)


# ---------------------------------------------------------------------------
# Public: read_chapter_markers
# ---------------------------------------------------------------------------


def read_chapter_markers(file_path: str) -> List[Dict[str, Any]]:
    """Extract chapter markers from an M4B (or any container) via ffprobe.

    Returns a list of dicts with keys ``title`` (str) and ``start`` (float,
    seconds).  Returns an empty list if the file has no chapter metadata or
    ffprobe fails.
    """
    result = subprocess.run(
        [
            "ffprobe", "-v", "quiet",
            "-print_format", "json",
            "-show_chapters",
            file_path,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        return []

    data = json.loads(result.stdout)
    chapters = data.get("chapters", [])
    markers = []
    for ch in chapters:
        title = ch.get("tags", {}).get("title", "")
        start = float(ch.get("start_time", 0))
        markers.append({"title": title, "start": start})
    return markers


# ---------------------------------------------------------------------------
# Public: export_book
# ---------------------------------------------------------------------------


def export_book(
    chapters: List[Dict[str, Any]],
    output_dir: str,
    options: Optional[Dict[str, Any]] = None,
    progress_callback: Optional[Callable[[int, str], None]] = None,
) -> Tuple[str, str]:
    """Stitch, normalize, and encode an audiobook in the requested format.

    Parameters
    ----------
    chapters:
        Ordered list of chapter dicts, each with keys:
          * ``number``        – int, 1-based chapter number
          * ``title``         – str, chapter display title
          * ``segment_paths`` – list of segment entries; each entry is either a
            plain path ``str`` **or** a ``dict`` with ``"path"`` (str) and
            optional ``"is_scene_break"`` (bool).  When ``is_scene_break`` is
            ``True``, the pause before that segment uses ``scene_pause_s``
            instead of ``inter_segment_pause_s``.

    output_dir:
        Directory where the output file will be written (created if absent).

    options:
        Dict controlling export behaviour:
          * ``format``        – ``"m4b"`` | ``"mp3_single"`` | ``"mp3_per_chapter"``
          * ``title``         – book title (for tags)
          * ``author``        – book author (for tags)
          * ``cover_path``    – optional path to cover image
          * ``bitrate``       – audio bitrate string, e.g. ``"64k"`` (default)
          * ``target_lufs``   – float, default −18.0
          * ``channels``      – int, 1 (mono) or 2 (stereo)
          * ``inter_segment_pause_s`` – float
          * ``scene_pause_s`` – float
          * ``chapter_pause_s`` – float
          * ``sample_rate``   – int

    progress_callback:
        Optional callable ``(percent: int, message: str) -> None`` invoked at
        key milestones so the caller (D7 SSE route) can stream progress.

    Returns
    -------
    (output_file_path, filename)
        Absolute path to the produced file, and the bare filename.
    """
    if options is None:
        options = {}

    fmt = options.get("format", "m4b")
    title = options.get("title", "Audiobook")
    author = options.get("author", "")
    cover_path = options.get("cover_path", None)
    bitrate = options.get("bitrate", DEFAULT_BITRATE)
    target_lufs = float(options.get("target_lufs", DEFAULT_TARGET_LUFS))
    channels = int(options.get("channels", DEFAULT_CHANNELS))
    sample_rate = int(options.get("sample_rate", DEFAULT_SAMPLE_RATE))
    inter_seg_pause = float(options.get("inter_segment_pause_s", DEFAULT_INTER_SEGMENT_PAUSE_S))
    scene_pause = float(options.get("scene_pause_s", DEFAULT_SCENE_PAUSE_S))
    chapter_pause = float(options.get("chapter_pause_s", DEFAULT_CHAPTER_PAUSE_S))

    def _progress(pct: int, msg: str = "") -> None:
        if progress_callback:
            progress_callback(pct, msg)

    Path(output_dir).mkdir(parents=True, exist_ok=True)

    _progress(0, "Starting export")

    # ------------------------------------------------------------------
    # Step 1: Stitch each chapter into a WAV array
    # ------------------------------------------------------------------
    chapter_audios: List[np.ndarray] = []
    chapter_starts_s: List[float] = []
    # chapters_with_audio is aligned 1:1 with chapter_audios / chapter_starts_s;
    # chapters that produce no audio (all segments missing) are excluded so that
    # M4B chapter markers are never mis-paired with the wrong titles.
    chapters_with_audio: List[Dict[str, Any]] = []
    chapter_pause_silence = _make_silence(chapter_pause, sample_rate)

    n_chapters = len(chapters)
    total_audio_parts: List[np.ndarray] = []
    current_time_s: float = 0.0

    for idx, ch in enumerate(chapters):
        pct = int(5 + (idx / n_chapters) * 50)
        _progress(pct, f"Stitching chapter {ch.get('number', idx + 1)}")

        ch_audio = _stitch_chapter(
            ch.get("segment_paths", []),
            sample_rate=sample_rate,
            inter_segment_pause_s=inter_seg_pause,
            scene_pause_s=scene_pause,
        )
        if ch_audio is None:
            continue  # skip empty chapters

        chapter_starts_s.append(current_time_s)
        chapter_audios.append(ch_audio)
        chapters_with_audio.append(ch)
        total_audio_parts.append(ch_audio)
        current_time_s += len(ch_audio) / sample_rate

        # Add chapter pause between chapters (not after the last)
        if idx < n_chapters - 1:
            total_audio_parts.append(chapter_pause_silence)
            current_time_s += chapter_pause

    if not total_audio_parts:
        raise ValueError("No audio could be loaded from any segment in any chapter.")

    _progress(55, "Concatenating chapters")
    full_audio = np.concatenate(total_audio_parts, axis=0).astype(np.float32)

    # ------------------------------------------------------------------
    # Step 2: LUFS normalization
    # ------------------------------------------------------------------
    _progress(60, "Normalizing loudness")
    full_audio = normalize_loudness(full_audio, sample_rate=sample_rate, target_lufs=target_lufs)

    # ------------------------------------------------------------------
    # Step 3: Write master WAV to a temp file
    # ------------------------------------------------------------------
    _progress(65, "Writing master WAV")
    master_wav = _write_wav_to_tmp(full_audio, sample_rate)

    try:
        # Build safe base filename from title
        safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in title).strip() or "audiobook"

        # ------------------------------------------------------------------
        # Step 4: Encode to requested format
        # ------------------------------------------------------------------
        if fmt == "m4b":
            out_path = str(Path(output_dir) / f"{safe_title}.m4b")
            _progress(70, "Encoding M4B")
            _encode_aac_m4b(
                wav_path=master_wav,
                out_path=out_path,
                chapters=chapters_with_audio,
                chapter_starts_s=chapter_starts_s,
                title=title,
                author=author,
                cover_path=cover_path,
                bitrate=bitrate,
                channels=channels,
            )

        elif fmt == "mp3_single":
            out_path = str(Path(output_dir) / f"{safe_title}.mp3")
            _progress(70, "Encoding MP3")
            _encode_mp3(master_wav, out_path, bitrate=bitrate, channels=channels)
            _embed_mp3_tags(
                out_path,
                title=title,
                album=title,
                artist=author,
                cover_path=cover_path,
            )

        elif fmt == "mp3_per_chapter":
            zip_path = str(Path(output_dir) / f"{safe_title}.zip")
            _progress(70, "Encoding per-chapter MP3s")

            with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
                # We need per-chapter WAVs for individual MP3 encoding
                n_ch_audio = len(chapter_audios)
                for i, (ch, ch_audio) in enumerate(zip(chapters_with_audio, chapter_audios)):
                    ch_pct = int(70 + (i / max(n_ch_audio, 1)) * 25)
                    ch_num = ch.get("number", i + 1)
                    ch_title = ch.get("title", f"Chapter {ch_num}")
                    _progress(ch_pct, f"Encoding {ch_title}")

                    # Normalize per-chapter audio
                    ch_norm = normalize_loudness(ch_audio, sample_rate=sample_rate, target_lufs=target_lufs)

                    ch_wav = _write_wav_to_tmp(ch_norm, sample_rate)
                    fd, ch_mp3 = tempfile.mkstemp(suffix=".mp3")
                    os.close(fd)
                    try:
                        _encode_mp3(ch_wav, ch_mp3, bitrate=bitrate, channels=channels)
                        _embed_mp3_tags(
                            ch_mp3,
                            title=ch_title,
                            album=title,
                            artist=author,
                            track_num=ch_num,
                            cover_path=cover_path,
                        )
                        safe_ch_title = "".join(
                            c if c.isalnum() or c in " _-" else "_" for c in ch_title
                        ).strip()
                        mp3_name = f"{ch_num:02d}_{safe_ch_title}.mp3"
                        zf.write(ch_mp3, arcname=mp3_name)
                    finally:
                        Path(ch_wav).unlink(missing_ok=True)
                        Path(ch_mp3).unlink(missing_ok=True)

            out_path = zip_path

        else:
            raise ValueError(f"Unknown export format: {fmt!r}. Choose m4b, mp3_single, or mp3_per_chapter.")

    finally:
        Path(master_wav).unlink(missing_ok=True)

    _progress(100, "Export complete")

    return out_path, Path(out_path).name
