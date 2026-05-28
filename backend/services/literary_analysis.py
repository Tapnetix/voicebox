"""Literary-analysis pipeline: chunk → detect → reconcile → profile → segments.

Pure functions (chunk_text, split_into_segments, reconcile_characters) are
unit-testable without an LLM.  The async orchestrators (analyze_chapter,
analyze_book, enrich_profiles) call `generate_structured` which is exposed as
a module-level name so tests can monkeypatch it easily.

Usage (monkeypatching in tests)::

    monkeypatch.setattr(la, "generate_structured", fake_fn)
"""

from __future__ import annotations

import logging
import re
import warnings
from dataclasses import dataclass, field
from typing import Optional

from pydantic import BaseModel, Field

from .llm_structured import generate_structured as _generate_structured
from .llm_structured import StructuredOutputError  # re-exported for callers

# ---------------------------------------------------------------------------
# Monkeypatch seam — tests replace this name to intercept LLM calls.
# ---------------------------------------------------------------------------
generate_structured = _generate_structured

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Context budgets (conservative, in tokens)
# ---------------------------------------------------------------------------
BUDGET_BY_SIZE: dict[str, int] = {
    "0.6B": 384,
    "1.7B": 1024,
    "4B": 2048,
}

_CHARS_PER_TOKEN = 4  # rough approximation


# ---------------------------------------------------------------------------
# Pydantic schemas for LLM passes
# ---------------------------------------------------------------------------


class SpeakerEntry(BaseModel):
    speaker: str = Field(description="Character name or 'narrator'")
    text: str = Field(description="The text of this segment")
    emotion: Optional[str] = Field(default=None, description="Detected emotion")
    intensity: Optional[float] = Field(default=None, description="Emotion intensity 0-1")
    type: str = Field(default="narration", description="'dialogue' or 'narration'")


class ChunkDetectSchema(BaseModel):
    speakers: list[SpeakerEntry] = Field(default_factory=list)


class ProfileSchema(BaseModel):
    gender: Optional[str] = None
    age_estimate: Optional[str] = None
    traits: list[str] = Field(default_factory=list)
    vocal_description: Optional[str] = None
    archetype: Optional[str] = None
    color: Optional[str] = None


# ---------------------------------------------------------------------------
# Result dataclasses
# ---------------------------------------------------------------------------


@dataclass
class ChapterAnalysis:
    segments: list[dict]
    characters: list[dict]
    flagged: bool = False


@dataclass
class BookAnalysis:
    chapters: list[ChapterAnalysis]
    characters: list[dict]


# ---------------------------------------------------------------------------
# Pure functions
# ---------------------------------------------------------------------------


def chunk_text(text: str, max_tokens: int) -> list[str]:
    """Split *text* into chunks that fit within *max_tokens*.

    Splitting is paragraph-aware: paragraphs are packed greedily until the
    token budget would be exceeded, then a new chunk starts.
    """
    max_chars = max_tokens * _CHARS_PER_TOKEN
    # Split on blank lines (paragraph boundaries) first, then on newlines
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    if not paragraphs:
        return [text.strip()] if text.strip() else []

    chunks: list[str] = []
    current_parts: list[str] = []
    current_len = 0

    for para in paragraphs:
        para_len = len(para)
        # If a single paragraph exceeds the budget, hard-split it by sentence
        if para_len > max_chars:
            if current_parts:
                chunks.append("\n\n".join(current_parts))
                current_parts = []
                current_len = 0
            # Hard-split long paragraph into sentence-sized pieces
            sentences = re.split(r"(?<=[.!?])\s+", para)
            # If splitting on sentences didn't help (e.g. no punctuation),
            # fall back to word-boundary splits sized to the budget.
            if len(sentences) == 1 and len(sentences[0]) > max_chars:
                words = para.split()
                sub_buf_w: list[str] = []
                sub_len_w = 0
                for word in words:
                    w_len = len(word) + 1  # +1 for space
                    if sub_len_w + w_len > max_chars and sub_buf_w:
                        chunks.append(" ".join(sub_buf_w))
                        sub_buf_w = []
                        sub_len_w = 0
                    sub_buf_w.append(word)
                    sub_len_w += w_len
                if sub_buf_w:
                    chunks.append(" ".join(sub_buf_w))
                continue
            sub_buf: list[str] = []
            sub_len = 0
            for sent in sentences:
                sent_len = len(sent)
                if sub_len + sent_len > max_chars and sub_buf:
                    chunks.append(" ".join(sub_buf))
                    sub_buf = []
                    sub_len = 0
                sub_buf.append(sent)
                sub_len += sent_len + 1
            if sub_buf:
                chunks.append(" ".join(sub_buf))
            continue

        # Would adding this paragraph overflow the current chunk?
        join_len = len("\n\n") if current_parts else 0
        if current_parts and (current_len + join_len + para_len > max_chars):
            chunks.append("\n\n".join(current_parts))
            current_parts = [para]
            current_len = para_len
        else:
            current_parts.append(para)
            current_len += join_len + para_len

    if current_parts:
        chunks.append("\n\n".join(current_parts))

    return chunks


def split_into_segments(text: str, speaker: Optional[str]) -> list[dict]:
    """Split *text* into ordered narration/dialogue segments.

    Handles:
    - Double-quote-delimited dialogue: ``"Hello," she said.``
    - Interrupted utterances: ``"Hello," she said, "goodbye."`` → 3 segments
    - Em-dash dialogue (common in translated fiction): ``— Hello, she said.``
    """
    segments: list[dict] = []
    order = 0

    def _add(seg_type: str, seg_text: str) -> None:
        nonlocal order
        t = seg_text.strip()
        if t:
            segments.append({"type": seg_type, "text": t, "order": order})
            order += 1

    # --- Handle em-dash-led dialogue (must come before the quote parser) ----
    # Detect if the text *starts* with an em-dash (possibly with leading space)
    em_dash_pattern = re.compile(r"^[\s]*[—–]\s*(.+)$", re.DOTALL)
    em_match = em_dash_pattern.match(text)
    if em_match:
        # The whole line is an em-dash utterance
        _add("dialogue", em_match.group(1))
        return segments

    # --- Quote-delimited dialogue + narration interleave -------------------
    # This regex finds all quoted substrings and the gaps between them.
    quote_re = re.compile(r'"([^"]*)"')

    pos = 0
    prev_quote_end = None
    prev_narration_start = None
    prev_narration_end = None
    matches = list(quote_re.finditer(text))

    if not matches:
        # No quotes at all — pure narration
        _add("narration", text)
        return segments

    for m in matches:
        narration_text = text[pos : m.start()]
        # Check if the narration between two quotes is just a dialogue tag
        # (e.g. ' she said, ') — if so, don't split: emit narration between
        # the two quotes so the interrupted pattern emerges naturally.
        if narration_text.strip():
            _add("narration", narration_text)
        quote_content = m.group(1)
        _add("dialogue", quote_content)
        pos = m.end()

    # Trailing narration after last quote
    trailing = text[pos:]
    if trailing.strip():
        _add("narration", trailing)

    # --- Post-process: collapse adjacent same-type segments ----------------
    # (not needed for correctness but keeps output clean)
    merged: list[dict] = []
    for seg in segments:
        if merged and merged[-1]["type"] == seg["type"]:
            merged[-1]["text"] += " " + seg["text"]
        else:
            merged.append(seg)

    # Reassign order after merge
    for i, seg in enumerate(merged):
        seg["order"] = i

    return merged


def reconcile_characters(
    per_chunk_speakers: list[dict],
    aliases: dict[str, str],
) -> list[dict]:
    """Merge per-chunk speaker records into a unified roster.

    Args:
        per_chunk_speakers: list of ``{speaker, confidence}`` dicts.
        aliases: mapping from alias → canonical name (e.g.
            ``{"the sheriff": "Holston"}``).

    Returns:
        list of ``{name, dialogue_count, confidence}`` sorted by
        dialogue_count descending.
    """
    roster: dict[str, dict] = {}  # canonical_name → aggregate

    for entry in per_chunk_speakers:
        raw_name = entry.get("speaker", "")
        confidence = entry.get("confidence", 0.0)

        # Resolve alias
        canonical = aliases.get(raw_name, raw_name)

        if canonical not in roster:
            roster[canonical] = {
                "name": canonical,
                "dialogue_count": 0,
                "confidence": 0.0,
            }

        roster[canonical]["dialogue_count"] += 1
        roster[canonical]["confidence"] = max(
            roster[canonical]["confidence"], confidence
        )

    return sorted(roster.values(), key=lambda c: c["dialogue_count"], reverse=True)


# ---------------------------------------------------------------------------
# LLM-backed functions
# ---------------------------------------------------------------------------


async def detect_chunk(chunk: str, model_size: str) -> tuple[ChunkDetectSchema, bool]:
    """Run per-chunk dialogue/emotion detection.

    Returns ``(result, flagged)`` where *flagged* is ``True`` if the LLM
    call failed and we fell back to all-narration.
    """
    budget = BUDGET_BY_SIZE.get(model_size, BUDGET_BY_SIZE["1.7B"])
    prompt = (
        "Analyse the following fiction excerpt. "
        "Identify each dialogue or narration segment. "
        "For dialogue, extract the speaker name, the spoken text, the emotion, "
        "and its intensity (0-1). Return a JSON object matching the schema.\n\n"
        f"TEXT:\n{chunk}"
    )
    try:
        result = await generate_structured(
            prompt,
            ChunkDetectSchema,
            max_tokens=budget,
            model_size=model_size,
        )
        return result, False
    except StructuredOutputError as exc:
        logger.warning("detect_chunk failed for window (flagged): %s", exc)
        # Degrade: treat the whole chunk as narration
        fallback = ChunkDetectSchema(
            speakers=[
                SpeakerEntry(
                    speaker="narrator",
                    text=chunk,
                    type="narration",
                )
            ]
        )
        return fallback, True


async def enrich_profiles(
    roster: list[dict],
    samples: dict[str, list[str]],
    model_size: str,
) -> list[dict]:
    """Enrich each character with gender/age/traits/vocal_description/archetype/color.

    Degrades gracefully: if the LLM call fails for a character the entry is
    returned with profile fields set to ``None`` rather than crashing.
    """
    enriched: list[dict] = []
    for char in roster:
        name = char["name"]
        char_samples = samples.get(name, [])
        sample_text = "\n".join(char_samples[:5])
        prompt = (
            f"Character: {name}\n"
            f"Sample dialogue:\n{sample_text}\n\n"
            "Return a JSON profile with: gender, age_estimate, traits (list), "
            "vocal_description, archetype, color."
        )
        profile_fields: dict = {
            "gender": None,
            "age_estimate": None,
            "traits": [],
            "vocal_description": None,
            "archetype": None,
            "color": None,
        }
        try:
            profile = await generate_structured(
                prompt,
                ProfileSchema,
                max_tokens=256,
                model_size=model_size,
            )
            profile_fields = {
                "gender": profile.gender,
                "age_estimate": profile.age_estimate,
                "traits": profile.traits,
                "vocal_description": profile.vocal_description,
                "archetype": profile.archetype,
                "color": profile.color,
            }
        except StructuredOutputError as exc:
            logger.warning("enrich_profiles failed for %s: %s", name, exc)

        enriched.append({**char, **profile_fields})

    return enriched


# ---------------------------------------------------------------------------
# Orchestrators
# ---------------------------------------------------------------------------


async def analyze_chapter(text: str, model_size: str = "1.7B") -> ChapterAnalysis:
    """Analyse a single chapter.

    Steps:
    1. Chunk the text to the model's context budget.
    2. Detect dialogue/speakers/emotions per chunk.
    3. Split detected utterances into ordered BookSegment-shaped records.
    4. Collect speaker mentions for reconciliation.

    Returns a :class:`ChapterAnalysis` with ``segments``, ``characters``, and
    ``flagged`` (``True`` if any chunk degraded to all-narration).
    """
    if model_size == "0.6B":
        warnings.warn(
            "0.6B model has a very small context — recommend 1.7B or 4B for "
            "literary analysis.",
            UserWarning,
            stacklevel=2,
        )

    budget = BUDGET_BY_SIZE.get(model_size, BUDGET_BY_SIZE["1.7B"])
    chunks = chunk_text(text, max_tokens=budget)

    all_segments: list[dict] = []
    per_chunk_speakers: list[dict] = []
    any_flagged = False
    global_order = 0

    for chunk in chunks:
        detect_result, flagged = await detect_chunk(chunk, model_size=model_size)
        if flagged:
            any_flagged = True

        for entry in detect_result.speakers:
            speaker = entry.speaker if entry.type == "dialogue" else None
            segs = split_into_segments(entry.text, speaker=speaker)
            for seg in segs:
                seg = dict(seg)
                seg["order"] = global_order
                seg["speaker"] = speaker if seg["type"] == "dialogue" else None
                seg["emotion"] = entry.emotion
                seg["intensity"] = entry.intensity
                all_segments.append(seg)
                global_order += 1

            if entry.type == "dialogue" and entry.speaker != "narrator":
                per_chunk_speakers.append(
                    {"speaker": entry.speaker, "confidence": 0.8}
                )

    # Reconcile into a roster (no aliases at this stage)
    characters = reconcile_characters(per_chunk_speakers, aliases={})

    return ChapterAnalysis(
        segments=all_segments,
        characters=characters,
        flagged=any_flagged,
    )


async def analyze_book(
    chapters: list[str],
    model_size: str = "1.7B",
) -> BookAnalysis:
    """Analyse all chapters of a book.

    Returns a :class:`BookAnalysis` with per-chapter
    :class:`ChapterAnalysis` objects and a global character roster.
    """
    chapter_analyses: list[ChapterAnalysis] = []
    all_speakers: list[dict] = []

    for chapter_text in chapters:
        ca = await analyze_chapter(chapter_text, model_size=model_size)
        chapter_analyses.append(ca)
        all_speakers.extend(ca.characters)

    # Global reconciliation (flatten counts from all chapters)
    global_per_chunk: list[dict] = []
    for c in all_speakers:
        for _ in range(c["dialogue_count"]):
            global_per_chunk.append(
                {"speaker": c["name"], "confidence": c["confidence"]}
            )

    global_characters = reconcile_characters(global_per_chunk, aliases={})

    return BookAnalysis(
        chapters=chapter_analyses,
        characters=global_characters,
    )
