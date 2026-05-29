#!/usr/bin/env python3
"""
Deterministic E2E seed script for "Silo 42" book fixture.

Run from the worktree root:
    backend/venv/bin/python backend/tests/e2e_seed.py

Idempotent: deletes any existing "Silo 42" book + children before inserting.

Cast inserted:
  - Narrator          (is_narrator=True,  assigned designed VoiceProfile)
  - Juliette          (major, with voice assignment → "designed")
  - Bernard           (major, no voice assignment)
  - Mira              (minor, for merge test — same person as "Mira (the woman)")
  - Mira (the woman)  (minor, for merge test)
  - Knox              (minor, for delete test)

Chapters:
  - Chapter 1: "Descent"     — all segments audio_status="none"
  - Chapter 2: "The Silo"    — mixed segments

Segments in Chapter 1 include:
  - Narration runs (narration type, no character)
  - Dialogue for Juliette and Bernard
  - One LOW-confidence dialogue seg (confidence < 0.7) → flagged=True → review-rail jump
"""

import sys
import os
import uuid
from pathlib import Path

# Resolve worktree root and add to sys.path
WORKTREE_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(WORKTREE_ROOT))

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.database.models import (
    Base,
    Book,
    BookCharacter,
    BookSegment,
    Chapter,
    VoiceProfile,
)
from backend import config as cfg


# ── DB Setup ──────────────────────────────────────────────────────────────────

DB_PATH = cfg.get_db_path()
engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
)
Session = sessionmaker(bind=engine)


# ── Cleanup helper ────────────────────────────────────────────────────────────

def _cleanup(db):
    """Delete any existing 'Silo 42' book and all its children + book-scoped profiles."""
    existing_books = db.query(Book).filter_by(title="Silo 42").all()
    for book in existing_books:
        book_id = book.id
        # Segments → Characters → Chapters → VoiceProfiles → Book
        chapters = db.query(Chapter).filter_by(book_id=book_id).all()
        for ch in chapters:
            db.query(BookSegment).filter_by(chapter_id=ch.id).delete()
        db.query(Chapter).filter_by(book_id=book_id).delete()
        db.query(BookCharacter).filter_by(book_id=book_id).delete()
        db.query(VoiceProfile).filter_by(book_id=book_id).delete()
        db.delete(book)
    db.commit()


# ── Seed ──────────────────────────────────────────────────────────────────────

def seed():
    db = Session()
    try:
        _cleanup(db)

        # ── 1. Book ───────────────────────────────────────────────────────────
        book_id = str(uuid.uuid4())
        book = Book(
            id=book_id,
            title="Silo 42",
            author="Hugh Howey",
            source_format="epub",
            status="analyzed",
        )
        db.add(book)
        db.flush()

        # ── 2. VoiceProfiles (book-scoped, not global library) ────────────────
        narrator_profile_id = str(uuid.uuid4())
        narrator_profile = VoiceProfile(
            id=narrator_profile_id,
            name=f"Silo42-Narrator-{book_id[:8]}",
            voice_type="designed",
            design_prompt="Calm, measured narration voice with a hint of wonder.",
            book_id=book_id,
            is_library=False,
        )
        db.add(narrator_profile)

        juliette_profile_id = str(uuid.uuid4())
        juliette_profile = VoiceProfile(
            id=juliette_profile_id,
            name=f"Silo42-Juliette-{book_id[:8]}",
            voice_type="designed",
            design_prompt="Determined female voice, mid-30s, slight roughness.",
            book_id=book_id,
            is_library=False,
        )
        db.add(juliette_profile)
        db.flush()

        # ── 3. Characters ─────────────────────────────────────────────────────
        narrator_id = str(uuid.uuid4())
        narrator = BookCharacter(
            id=narrator_id,
            book_id=book_id,
            profile_id=narrator_profile_id,
            name="Narrator",
            is_narrator=True,
            color="#94a3b8",
            dialogue_count=0,
            confidence=1.0,
            aliases=[],
            role=None,
            gender=None,
            age_range=None,
            vocal_description="Third-person omniscient narrator",
            archetype="narrator",
        )
        db.add(narrator)

        juliette_id = str(uuid.uuid4())
        juliette = BookCharacter(
            id=juliette_id,
            book_id=book_id,
            profile_id=juliette_profile_id,  # HAS assigned voice
            name="Juliette",
            is_narrator=False,
            color="#f59e0b",
            dialogue_count=3,  # matches actual seeded dialogue segments (ch1: 2, ch2: 1)
            confidence=0.92,
            aliases=["Jules"],
            role="major",
            gender="female",
            age_range="adult",
            vocal_description="Determined, clear, mechanical engineer's precision",
            archetype="protagonist",
        )
        db.add(juliette)

        bernard_id = str(uuid.uuid4())
        bernard = BookCharacter(
            id=bernard_id,
            book_id=book_id,
            profile_id=None,  # NO assigned voice → save-to-library disabled
            name="Bernard",
            is_narrator=False,
            color="#3b82f6",
            dialogue_count=1,  # matches actual seeded dialogue segments (ch1: 1)
            confidence=0.85,
            aliases=[],
            role="major",
            gender="male",
            age_range="adult",
            vocal_description="Cold, commanding, bureaucratic",
            archetype="antagonist",
        )
        db.add(bernard)

        # Two same-person chars for merge test
        mira_id = str(uuid.uuid4())
        mira = BookCharacter(
            id=mira_id,
            book_id=book_id,
            profile_id=None,
            name="Mira",
            is_narrator=False,
            color="#10b981",
            dialogue_count=1,  # matches actual seeded dialogue segments (ch1: 1)
            confidence=0.78,
            aliases=[],
            role="minor",
            gender="female",
            age_range="adult",
            vocal_description="Soft, hesitant",
            archetype="supporting",
        )
        db.add(mira)

        mira_alt_id = str(uuid.uuid4())
        mira_alt = BookCharacter(
            id=mira_alt_id,
            book_id=book_id,
            profile_id=None,
            name="Mira (the woman)",
            is_narrator=False,
            color="#6ee7b7",
            dialogue_count=1,  # matches actual seeded dialogue segments (ch2: 1)
            confidence=0.65,  # LOW confidence
            aliases=["the woman"],
            role="minor",
            gender="female",
            age_range="adult",
            vocal_description="Soft, hesitant — same person as Mira",
            archetype="supporting",
        )
        db.add(mira_alt)

        # Character for delete test — has segments
        knox_id = str(uuid.uuid4())
        knox = BookCharacter(
            id=knox_id,
            book_id=book_id,
            profile_id=None,
            name="Knox",
            is_narrator=False,
            color="#a855f7",
            dialogue_count=1,  # matches actual seeded dialogue segments (ch1: 1)
            confidence=0.80,
            aliases=[],
            role="minor",
            gender="male",
            age_range="adult",
            vocal_description="Gruff, working-class, loyal",
            archetype="ally",
        )
        db.add(knox)
        db.flush()

        # ── 4. Chapters ───────────────────────────────────────────────────────
        ch1_id = str(uuid.uuid4())
        ch1 = Chapter(
            id=ch1_id,
            book_id=book_id,
            number=1,
            title="Descent",
            raw_text="",
            word_count=1240,
        )
        db.add(ch1)

        ch2_id = str(uuid.uuid4())
        ch2 = Chapter(
            id=ch2_id,
            book_id=book_id,
            number=2,
            title="The Silo",
            raw_text="",
            word_count=980,
        )
        db.add(ch2)
        db.flush()

        # ── 5. Segments for Chapter 1 "Descent" ──────────────────────────────
        # Order 0: narration
        db.add(BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=ch1_id,
            character_id=narrator_id,
            type="narration",
            order=0,
            text="The silo stretched downward into the earth, level upon level, a world unto itself.",
            emotion=None,
            emotion_intensity=None,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        # Order 1: Juliette dialogue (high confidence)
        seg1_id = str(uuid.uuid4())
        db.add(BookSegment(
            id=seg1_id,
            chapter_id=ch1_id,
            character_id=juliette_id,
            type="dialogue",
            order=1,
            text="It never ends, does it?",
            emotion="sad",
            emotion_intensity=0.6,
            delivery="softly, looking down",
            flagged=False,
            audio_status="none",
        ))

        # Order 2: narration
        db.add(BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=ch1_id,
            character_id=narrator_id,
            type="narration",
            order=2,
            text="Juliette gripped the railing and peered into the depths below.",
            emotion=None,
            emotion_intensity=None,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        # Order 3: Bernard dialogue (high confidence)
        seg3_id = str(uuid.uuid4())
        db.add(BookSegment(
            id=seg3_id,
            chapter_id=ch1_id,
            character_id=bernard_id,
            type="dialogue",
            order=3,
            text="Nothing ends. That is the point.",
            emotion="neutral",
            emotion_intensity=0.3,
            delivery="cold, deliberate",
            flagged=False,
            audio_status="none",
        ))

        # Order 4: Juliette dialogue — second line
        seg4_id = str(uuid.uuid4())
        db.add(BookSegment(
            id=seg4_id,
            chapter_id=ch1_id,
            character_id=juliette_id,
            type="dialogue",
            order=4,
            text="Then what are we doing here?",
            emotion="angry",
            emotion_intensity=0.7,
            delivery="through gritted teeth",
            flagged=False,
            audio_status="none",
        ))

        # Order 5: LOW-confidence Mira segment → flagged → review-rail jump
        seg5_id = str(uuid.uuid4())
        db.add(BookSegment(
            id=seg5_id,
            chapter_id=ch1_id,
            character_id=mira_id,
            type="dialogue",
            order=5,
            text="Please. I don't want to go.",
            emotion="fearful",
            emotion_intensity=0.8,
            delivery=None,
            flagged=True,  # low-confidence → flagged
            audio_status="none",
        ))

        # Order 6: Knox dialogue
        seg6_id = str(uuid.uuid4())
        db.add(BookSegment(
            id=seg6_id,
            chapter_id=ch1_id,
            character_id=knox_id,
            type="dialogue",
            order=6,
            text="We don't have a choice, Mira.",
            emotion="resigned",
            emotion_intensity=0.5,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        # Order 7: narration outro
        db.add(BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=ch1_id,
            character_id=narrator_id,
            type="narration",
            order=7,
            text="The doors sealed behind them with a heavy thud.",
            emotion=None,
            emotion_intensity=None,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        # ── 6. Segments for Chapter 2 "The Silo" ─────────────────────────────
        # Mix of narration + dialogue, some completed
        db.add(BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=ch2_id,
            character_id=narrator_id,
            type="narration",
            order=0,
            text="Level thirty-two was machinery and grease and the smell of oil.",
            emotion=None,
            emotion_intensity=None,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        seg_ch2_1_id = str(uuid.uuid4())
        db.add(BookSegment(
            id=seg_ch2_1_id,
            chapter_id=ch2_id,
            character_id=juliette_id,
            type="dialogue",
            order=1,
            text="Show me where it broke.",
            emotion="determined",
            emotion_intensity=0.6,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        db.add(BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=ch2_id,
            character_id=mira_alt_id,
            type="dialogue",
            order=2,
            text="Right here. The coupling sheared clean through.",
            emotion="neutral",
            emotion_intensity=0.4,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        db.add(BookSegment(
            id=str(uuid.uuid4()),
            chapter_id=ch2_id,
            character_id=narrator_id,
            type="narration",
            order=3,
            text="Juliette crouched and examined the broken part.",
            emotion=None,
            emotion_intensity=None,
            delivery=None,
            flagged=False,
            audio_status="none",
        ))

        db.commit()

        # ── Report ─────────────────────────────────────────────────────────────
        print(f"Seeded book id:   {book_id}")
        print(f"  Narrator id:    {narrator_id}")
        print(f"  Juliette id:    {juliette_id}  (has voice: designed)")
        print(f"  Bernard id:     {bernard_id}  (no voice)")
        print(f"  Mira id:        {mira_id}  (for merge)")
        print(f"  Mira(alt) id:   {mira_alt_id}  (for merge; low-conf)")
        print(f"  Knox id:        {knox_id}  (for delete)")
        print(f"  Chapter 1 id:   {ch1_id}")
        print(f"  Chapter 2 id:   {ch2_id}")
        print("Seed complete.")

    finally:
        db.close()


if __name__ == "__main__":
    seed()
