"""Tests for the literary analysis pipeline (B2).

All LLM calls are mocked — this test suite never loads a model.
"""

import pytest

from backend.services import literary_analysis as la
from backend.services.llm_structured import StructuredOutputError


# ---------------------------------------------------------------------------
# Pure-function unit tests
# ---------------------------------------------------------------------------


def test_chunking_respects_budget():
    chunks = la.chunk_text("word " * 5000, max_tokens=512)
    assert len(chunks) > 1
    assert all(chunks)


def test_chunking_small_text_one_chunk():
    chunks = la.chunk_text("Short text.", max_tokens=2048)
    assert len(chunks) == 1
    assert chunks[0] == "Short text."


def test_reconcile_merges_aliases():
    per_chunk = [
        {"speaker": "Holston", "confidence": 0.9},
        {"speaker": "the sheriff", "confidence": 0.6},
        {"speaker": "Holston", "confidence": 0.8},
    ]
    roster = la.reconcile_characters(per_chunk, aliases={"the sheriff": "Holston"})
    names = {c["name"] for c in roster}
    assert "Holston" in names
    holston = next(c for c in roster if c["name"] == "Holston")
    assert holston["dialogue_count"] == 3


def test_reconcile_without_aliases():
    per_chunk = [
        {"speaker": "Alice", "confidence": 0.9},
        {"speaker": "Bob", "confidence": 0.7},
        {"speaker": "Alice", "confidence": 0.85},
    ]
    roster = la.reconcile_characters(per_chunk, aliases={})
    names = {c["name"] for c in roster}
    assert "Alice" in names
    assert "Bob" in names
    alice = next(c for c in roster if c["name"] == "Alice")
    assert alice["dialogue_count"] == 2
    assert alice["confidence"] == 0.9  # max confidence


def test_reconcile_confidence_is_max():
    per_chunk = [
        {"speaker": "Hero", "confidence": 0.5},
        {"speaker": "Hero", "confidence": 0.95},
        {"speaker": "Hero", "confidence": 0.3},
    ]
    roster = la.reconcile_characters(per_chunk, aliases={})
    hero = next(c for c in roster if c["name"] == "Hero")
    assert hero["confidence"] == 0.95


def test_interrupted_utterance_splits(monkeypatch):
    # '"We are leaving," she said, "tonight."' → dialogue / narration / dialogue
    segs = la.split_into_segments('"We are leaving," she said, "tonight."', speaker="Jules")
    types = [s["type"] for s in segs]
    assert types == ["dialogue", "narration", "dialogue"]


def test_split_order_is_sequential():
    segs = la.split_into_segments('"We are leaving," she said, "tonight."', speaker="Jules")
    orders = [s["order"] for s in segs]
    assert orders == sorted(orders)
    assert orders[0] == 0


def test_em_dash_dialogue_detected():
    segs = la.split_into_segments("— We are leaving, she said.", speaker="Jules")
    assert any(s["type"] == "dialogue" for s in segs)


def test_simple_quoted_dialogue():
    segs = la.split_into_segments('"Hello," she said.', speaker="Alice")
    types = [s["type"] for s in segs]
    # At minimum we should get dialogue detected
    assert "dialogue" in types


def test_pure_narration_text():
    segs = la.split_into_segments("He walked down the road.", speaker=None)
    assert all(s["type"] == "narration" for s in segs)


def test_split_segment_has_required_keys():
    segs = la.split_into_segments('"Hello."', speaker="Bob")
    for s in segs:
        assert "type" in s
        assert "text" in s
        assert "order" in s
        assert s["type"] in ("dialogue", "narration")


# ---------------------------------------------------------------------------
# Async orchestrator tests (mocked LLM)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_failed_chunk_degrades_to_narration(monkeypatch):
    async def boom(*a, **k):
        raise StructuredOutputError("bad")

    monkeypatch.setattr(la, "generate_structured", boom)
    result = await la.analyze_chapter("Some chapter text.", model_size="1.7B")
    assert result.segments  # produced something
    assert all(s["type"] == "narration" for s in result.segments)
    assert result.flagged is True


@pytest.mark.asyncio
async def test_analyze_chapter_returns_chapter_analysis(monkeypatch):
    import json
    from backend.services.literary_analysis import ChunkDetectSchema

    # Craft a canned response matching the schema
    canned = {
        "speakers": [
            {
                "speaker": "Alice",
                "text": "Hello there",
                "emotion": "happy",
                "intensity": 0.7,
                "type": "dialogue",
            }
        ]
    }

    async def fake_generate(prompt, schema, **kwargs):
        return schema.model_validate(canned)

    monkeypatch.setattr(la, "generate_structured", fake_generate)
    result = await la.analyze_chapter("\"Hello there,\" Alice said.", model_size="1.7B")
    assert hasattr(result, "segments")
    assert hasattr(result, "characters")
    assert hasattr(result, "flagged")


@pytest.mark.asyncio
async def test_analyze_chapter_flagged_false_on_success(monkeypatch):
    canned = {"speakers": []}

    async def fake_generate(prompt, schema, **kwargs):
        return schema.model_validate(canned)

    monkeypatch.setattr(la, "generate_structured", fake_generate)
    result = await la.analyze_chapter("Narration text only.", model_size="1.7B")
    assert result.flagged is False


@pytest.mark.asyncio
async def test_analyze_book_aggregates_chapters(monkeypatch):
    canned = {
        "speakers": [
            {
                "speaker": "Bob",
                "text": "Let's go",
                "emotion": "eager",
                "intensity": 0.8,
                "type": "dialogue",
            }
        ]
    }

    async def fake_generate(prompt, schema, **kwargs):
        return schema.model_validate(canned)

    monkeypatch.setattr(la, "generate_structured", fake_generate)
    chapters = ["Chapter one text.", "Chapter two text."]
    result = await la.analyze_book(chapters, model_size="1.7B")
    assert hasattr(result, "chapters")
    assert len(result.chapters) == 2
    assert hasattr(result, "characters")


@pytest.mark.asyncio
async def test_analyze_book_reports_progress(monkeypatch):
    """analyze_book must drive progress_cb through detection and enrichment.

    Regression guard for the "appears hung" UX: the long LLM passes have to
    emit monotonic, in-range progress with human-readable messages.
    """
    canned = {
        "speakers": [
            {
                "speaker": "Bob",
                "text": "Let's go",
                "emotion": "eager",
                "intensity": 0.8,
                "type": "dialogue",
            }
        ]
    }

    async def fake_generate(prompt, schema, **kwargs):
        return schema.model_validate(canned)

    monkeypatch.setattr(la, "generate_structured", fake_generate)

    events: list[tuple[float, str]] = []
    chapters = ["Chapter one text.", "Chapter two text.", "Chapter three text."]
    await la.analyze_book(
        chapters,
        model_size="1.7B",
        progress_cb=lambda frac, msg: events.append((frac, msg)),
    )

    assert events, "progress_cb was never called"
    fractions = [f for f, _ in events]
    # In range, monotonic non-decreasing, and reaches completion.
    assert all(0.0 <= f <= 1.0 for f in fractions)
    assert fractions == sorted(fractions)
    assert fractions[-1] == 1.0
    # Per-chapter detection messages are surfaced.
    assert any("chapter 1 of 3" in msg.lower() for _, msg in events)
    # Enrichment phase reports per-character work past the detect band.
    assert any(f > la._DETECT_SPAN for f in fractions)


@pytest.mark.asyncio
async def test_analyze_book_progress_callback_errors_are_swallowed(monkeypatch):
    """A throwing progress_cb must never abort the analysis."""
    canned = {"speakers": []}

    async def fake_generate(prompt, schema, **kwargs):
        return schema.model_validate(canned)

    monkeypatch.setattr(la, "generate_structured", fake_generate)

    def boom(_frac, _msg):
        raise RuntimeError("ui exploded")

    result = await la.analyze_book(["Chapter."], model_size="1.7B", progress_cb=boom)
    assert hasattr(result, "chapters")


@pytest.mark.asyncio
async def test_enrich_profiles_degrades_gracefully(monkeypatch):
    """enrich_profiles must not crash even if LLM fails."""
    async def boom(*a, **k):
        raise StructuredOutputError("no profiles today")

    monkeypatch.setattr(la, "generate_structured", boom)
    roster = [{"name": "Alice", "dialogue_count": 1, "confidence": 0.9}]
    result = await la.enrich_profiles(roster, samples={"Alice": ["sample"]}, model_size="1.7B")
    assert len(result) == 1
    # Fields may be None but should be present
    assert "name" in result[0]


def test_budget_by_size_has_required_keys():
    assert "0.6B" in la.BUDGET_BY_SIZE
    assert "1.7B" in la.BUDGET_BY_SIZE
    assert "4B" in la.BUDGET_BY_SIZE
    assert la.BUDGET_BY_SIZE["1.7B"] >= la.BUDGET_BY_SIZE["0.6B"]
    assert la.BUDGET_BY_SIZE["4B"] >= la.BUDGET_BY_SIZE["1.7B"]
