/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * ChapterEditorReadAlong.test.tsx
 *
 * Tests for D5 read-along mode in ChapterEditor.
 * Covers:
 *   - readalong-btn wires up, starts/stops read-along
 *   - currentTimeMs advances → currentSpokenSegmentId updates → highlight
 *   - high-confidence line stays reassignable during read-along
 */
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChapterEditor } from '@/components/BooksTab/ChapterEditor';

// ─── Mock state buckets ────────────────────────────────────────────────────────

let mockReadAlongPlaying = false;
let mockCurrentSpokenSegmentId: string | null = null;
const mockSetReadAlong = vi.fn((val: boolean) => {
  mockReadAlongPlaying = val;
});
const mockSetCurrentSpokenSegment = vi.fn((id: string | null) => {
  mockCurrentSpokenSegmentId = id;
});

// storyStore currentTimeMs — controllable from tests
let mockCurrentTimeMs = 0;
let mockIsPlaying = false;
const mockPlay = vi.fn();
const mockPause = vi.fn();
const mockStop = vi.fn();

const updateMutate = vi.fn();

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) =>
    s({
      selectedBookId: 'b1',
      selectedChapterId: 'c1',
      setView: vi.fn(),
      readAlongPlaying: mockReadAlongPlaying,
      currentSpokenSegmentId: mockCurrentSpokenSegmentId,
      setReadAlong: mockSetReadAlong,
      setCurrentSpokenSegment: mockSetCurrentSpokenSegment,
    }),
}));

vi.mock('@/stores/storyStore', () => ({
  useStoryStore: (s: any) =>
    s({
      isPlaying: mockIsPlaying,
      currentTimeMs: mockCurrentTimeMs,
      playbackStoryId: null,
      play: mockPlay,
      pause: mockPause,
      stop: mockStop,
      setActiveStory: vi.fn(),
    }),
}));

// Segments: two dialogue segments with known audio generation_ids & durations
// Seg 12: generation_id=g12, order 0  → story item at 0ms, duration 2.0s
// Seg 13: generation_id=g13, order 1  → story item at 2000ms, duration 2.5s
// Character 'm' has confidence=0.9 (high), 'h' has confidence=0.85 (high)
vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({
    data: {
      id: 'b1',
      title: 'Test Book',
      chapters: [
        { id: 'c1', number: 1, title: 'Chapter 1', story_id: 'story-1', word_count: 100, generation_state: 'completed' },
      ],
    },
  }),
  useCharacters: () => ({
    data: [
      { id: 'n', name: 'Narrator', is_narrator: true, color: '#6d8bff', confidence: 1 },
      { id: 'm', name: 'Mira', color: '#34d399', confidence: 0.9 },
      { id: 'h', name: 'Holt', color: '#fbbf24', confidence: 0.85 },
    ],
  }),
  useSegments: () => ({
    data: [
      {
        id: '12',
        order: 0,
        type: 'dialogue',
        text: '"We need to move fast,"',
        character_id: 'm',
        character_name: 'Mira',
        emotion: 'tense',
        emotion_intensity: 0.5,
        delivery: '',
        audio: { status: 'completed', generation_id: 'g12', duration_ms: 2000 },
      },
      {
        id: '13',
        order: 1,
        type: 'dialogue',
        text: '"I know," Holt replied.',
        character_id: 'h',
        character_name: 'Holt',
        emotion: 'calm',
        emotion_intensity: 0.4,
        delivery: '',
        audio: { status: 'completed', generation_id: 'g13', duration_ms: 2500 },
      },
    ],
  }),
  useUpdateSegment: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewSegment: () => ({ mutate: vi.fn(), isPending: false }),
  useSplitSegment: () => ({ mutateAsync: vi.fn().mockResolvedValue([]), isPending: false }),
  useMergeSegments: () => ({ mutate: vi.fn(), isPending: false }),
  useRegenerateSegment: () => ({ mutate: vi.fn(), isPending: false }),
}));

// useStoryPlayback is a side-effect hook — no-op in unit tests
vi.mock('@/lib/hooks/useStoryPlayback', () => ({
  useStoryPlayback: vi.fn(),
}));

// Mock useStory from useStories
vi.mock('@/lib/hooks/useStories', () => ({
  useStory: vi.fn(() => ({
    data: {
      id: 'story-1',
      name: 'Chapter 1',
      items: [
        {
          id: 'item-1',
          story_id: 'story-1',
          generation_id: 'g12',
          start_time_ms: 0,
          duration: 2.0,
          track: 0,
          trim_start_ms: 0,
          trim_end_ms: 0,
          volume: 1,
          profile_id: 'p1',
          profile_name: 'Mira',
          text: '"We need to move fast,"',
          language: 'en',
          audio_path: '/audio/g12.mp3',
          created_at: '2024-01-01T00:00:00Z',
          generation_created_at: '2024-01-01T00:00:00Z',
        },
        {
          id: 'item-2',
          story_id: 'story-1',
          generation_id: 'g13',
          start_time_ms: 2000,
          duration: 2.5,
          track: 0,
          trim_start_ms: 0,
          trim_end_ms: 0,
          volume: 1,
          profile_id: 'p2',
          profile_name: 'Holt',
          text: '"I know," Holt replied.',
          language: 'en',
          audio_path: '/audio/g13.mp3',
          created_at: '2024-01-01T00:00:00Z',
          generation_created_at: '2024-01-01T00:00:00Z',
        },
      ],
    },
  })),
}));

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('ChapterEditor — read-along D5', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadAlongPlaying = false;
    mockCurrentSpokenSegmentId = null;
    mockCurrentTimeMs = 0;
    mockIsPlaying = false;
  });

  it('readalong-btn is enabled and present', () => {
    render(<ChapterEditor />);
    const btn = screen.getByTestId('readalong-btn');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
  });

  it('clicking readalong-btn calls setReadAlong(true) to start read-along', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('readalong-btn'));
    expect(mockSetReadAlong).toHaveBeenCalledWith(true);
  });

  it('when readAlongPlaying=true, clicking readalong-btn calls setReadAlong(false)', async () => {
    mockReadAlongPlaying = true;
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('readalong-btn'));
    expect(mockSetReadAlong).toHaveBeenCalledWith(false);
  });

  it('when currentSpokenSegmentId=13, seg-13 has the read-along highlight', () => {
    mockCurrentSpokenSegmentId = '13';
    mockReadAlongPlaying = true;
    render(<ChapterEditor />);
    const seg13 = screen.getByTestId('seg-13');
    // Should have either a highlight class or data-active or aria-current
    const isHighlighted =
      seg13.classList.contains('readalong-active') ||
      seg13.getAttribute('data-active') === 'true' ||
      seg13.getAttribute('aria-current') === 'true' ||
      // Or a ♪ marker sibling
      seg13.closest('span')?.textContent?.includes('♪') ||
      seg13.textContent?.includes('♪');
    expect(isHighlighted).toBe(true);
  });

  it('when currentSpokenSegmentId=12, seg-12 is highlighted but seg-13 is not', () => {
    mockCurrentSpokenSegmentId = '12';
    mockReadAlongPlaying = true;
    render(<ChapterEditor />);
    const seg12 = screen.getByTestId('seg-12');
    const seg13 = screen.getByTestId('seg-13');

    const seg12Highlighted =
      seg12.classList.contains('readalong-active') ||
      seg12.getAttribute('data-active') === 'true' ||
      seg12.getAttribute('aria-current') === 'true';
    const seg13Highlighted =
      seg13.classList.contains('readalong-active') ||
      seg13.getAttribute('data-active') === 'true' ||
      seg13.getAttribute('aria-current') === 'true';

    expect(seg12Highlighted).toBe(true);
    expect(seg13Highlighted).toBe(false);
  });

  it('ChapterReadAlong calls setCurrentSpokenSegment when currentTimeMs is in second segment range', () => {
    // Render with ChapterReadAlong embedded, simulate time in 2nd segment's range
    // The mapping: seg 12 → item at 0..2000ms, seg 13 → item at 2000..4500ms
    // At t=2500ms, the active segment should be 13
    mockCurrentTimeMs = 2500;
    mockReadAlongPlaying = true;
    render(<ChapterEditor />);
    // ChapterReadAlong should have called setCurrentSpokenSegment with '13'
    expect(mockSetCurrentSpokenSegment).toHaveBeenCalledWith('13');
  });

  it('ChapterReadAlong calls setCurrentSpokenSegment with first segment when in its range', () => {
    mockCurrentTimeMs = 500;
    mockReadAlongPlaying = true;
    render(<ChapterEditor />);
    expect(mockSetCurrentSpokenSegment).toHaveBeenCalledWith('12');
  });

  it('high-confidence dialogue line (seg-13) is still clickable for reassignment during read-along', async () => {
    mockReadAlongPlaying = true;
    mockCurrentSpokenSegmentId = '12';
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // seg-13 is high-confidence (Holt, 0.85) — should still open reassign popover
    await u.click(screen.getByTestId('seg-13'));
    expect(screen.getByTestId('reassign-dropdown')).toBeInTheDocument();
  });

  it('reassigning seg-13 during read-along calls updateMutate with new character_id', async () => {
    mockReadAlongPlaying = true;
    mockCurrentSpokenSegmentId = '13';
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // Click seg-13 to open popover
    await u.click(screen.getByTestId('seg-13'));
    const dropdown = screen.getByTestId('reassign-dropdown');
    // Reassign to Mira
    await u.click(within(dropdown).getByText('Mira'));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentId: '13',
        data: expect.objectContaining({ character_id: 'm' }),
      }),
      expect.anything(),
    );
  });
});
