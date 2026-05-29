/**
 * ChapterReadAlong — read-along layer for ChapterEditor.
 *
 * Observes storyStore.currentTimeMs and maps the current playback position
 * to the corresponding segment by looking up generation_id in the chapter
 * Story's items. Updates booksStore.setCurrentSpokenSegment so the matching
 * seg-{id} span can render its ♪ highlight.
 *
 * Does NOT own its own audio engine — the requestAnimationFrame clock that
 * advances storyStore.currentTimeMs is driven by useStoryPlayback, which is
 * mounted unconditionally at the top level of ChapterEditor.
 *
 * data-testid: none (headless observer — no DOM output)
 */
import { useEffect, useRef } from 'react';
import type { SegmentResponse } from '@/lib/api/types';
import type { StoryDetailResponse } from '@/lib/api/types';
import { useStoryStore } from '@/stores/storyStore';
import { useBooksStore } from '@/stores/booksStore';

interface ChapterReadAlongProps {
  /** The chapter's Story (fetched by parent). Null if no story yet. */
  story: StoryDetailResponse | null | undefined;
  /** Ordered segments for this chapter. */
  segments: SegmentResponse[];
}

/**
 * Maps a playback time (ms) to the segment whose story item covers that time.
 * Returns the segment id or null if no item covers the time.
 */
function findActiveSegmentId(
  currentTimeMs: number,
  story: StoryDetailResponse,
  segments: SegmentResponse[],
): string | null {
  const items = story.items;
  if (!items || items.length === 0) return null;

  // Find the story item that covers currentTimeMs
  for (const item of items) {
    const trimStart = item.trim_start_ms || 0;
    const trimEnd = item.trim_end_ms || 0;
    const effectiveDurationMs = item.duration * 1000 - trimStart - trimEnd;
    const itemStart = item.start_time_ms;
    const itemEnd = itemStart + effectiveDurationMs;

    if (currentTimeMs >= itemStart && currentTimeMs < itemEnd) {
      // Find the segment whose audio generation_id matches this item
      const seg = segments.find((s) => s.audio?.generation_id === item.generation_id);
      if (seg) return seg.id;
    }
  }
  return null;
}

export function ChapterReadAlong({ story, segments }: ChapterReadAlongProps) {
  const currentTimeMs = useStoryStore((s) => s.currentTimeMs);
  const setCurrentSpokenSegment = useBooksStore((s) => s.setCurrentSpokenSegment);
  const lastSegmentIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!story || segments.length === 0) {
      if (lastSegmentIdRef.current !== null) {
        setCurrentSpokenSegment(null);
        lastSegmentIdRef.current = null;
      }
      return;
    }

    const activeId = findActiveSegmentId(currentTimeMs, story, segments);

    // Only call setter when the value changes (avoid thrashing)
    if (activeId !== lastSegmentIdRef.current) {
      setCurrentSpokenSegment(activeId);
      lastSegmentIdRef.current = activeId;
    }
  }, [currentTimeMs, story, segments, setCurrentSpokenSegment]);

  // Scroll the active segment into view whenever the playback time changes.
  // NOTE: We key on currentTimeMs (a reactive value) rather than
  // lastSegmentIdRef.current (a ref) because React does not track ref
  // mutations — a dep on the ref value never re-triggers the effect.
  useEffect(() => {
    if (!lastSegmentIdRef.current) return;
    const el = document.querySelector(
      `[data-testid="seg-${lastSegmentIdRef.current}"]`,
    );
    if (el && typeof (el as HTMLElement).scrollIntoView === 'function') {
      (el as HTMLElement).scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentTimeMs]);

  // This component renders nothing — it is a headless observer
  return null;
}
