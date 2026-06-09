/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChapterEditor } from '@/components/BooksTab/ChapterEditor';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const updateMutate = vi.fn();
const regenerateMutate = vi.fn();

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) =>
    s({
      selectedBookId: 'b1',
      selectedChapterId: 'c1',
      setView: vi.fn(),
      readAlongPlaying: false,
      currentSpokenSegmentId: null,
      setReadAlong: vi.fn(),
      setCurrentSpokenSegment: vi.fn(),
    }),
}));

vi.mock('@/stores/storyStore', () => ({
  useStoryStore: (s: any) =>
    s({
      isPlaying: false,
      currentTimeMs: 0,
      playbackStoryId: null,
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      setActiveStory: vi.fn(),
    }),
}));

vi.mock('@/lib/hooks/useStories', () => ({
  useStory: () => ({ data: null }),
}));

vi.mock('@/lib/hooks/useStoryPlayback', () => ({
  useStoryPlayback: vi.fn(),
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({ data: null }),
  useCharacters: () => ({
    data: [
      { id: 'n', name: 'Narrator', is_narrator: true, color: '#6d8bff' },
      { id: 'm', name: 'Mira', color: '#34d399', confidence: 0.9 },
      { id: 'h', name: 'Holt', color: '#fbbf24', confidence: 0.8 },
      { id: 'lo', name: 'LowConf', color: '#ff0000', confidence: 0.5 },
    ],
  }),
  useSegments: () => ({
    data: [
      {
        id: '11',
        order: 0,
        type: 'narration',
        text: 'The corridor lights flickered.',
        character_id: 'n',
        character_name: 'Narrator',
        emotion: 'neutral',
        audio: { status: 'completed', generation_id: 'g11' },
      },
      {
        id: '12',
        order: 1,
        type: 'dialogue',
        text: `”We can't keep going down,”`,
        character_id: 'm',
        character_name: 'Mira',
        emotion: 'tense',
        audio: { status: 'completed', generation_id: 'g12' },
      },
      {
        id: '13',
        order: 2,
        type: 'dialogue',
        text: '”I agree,” said LowConf.',
        character_id: 'lo',
        character_name: 'LowConf',
        emotion: 'worried',
        audio: { status: 'none' },
      },
    ],
  }),
  useUpdateSegment: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewSegment: () => ({ mutate: vi.fn(), isPending: false }),
  useSplitSegment: () => ({ mutateAsync: vi.fn().mockResolvedValue([]), isPending: false }),
  useMergeSegments: () => ({ mutate: vi.fn(), isPending: false }),
  useRegenerateSegment: () => ({ mutate: regenerateMutate, isPending: false }),
}));

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('ChapterEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders book-view with color-coded, speaker-labeled lines', () => {
    render(<ChapterEditor />);
    const bookView = screen.getByTestId('book-view');
    expect(bookView).toBeInTheDocument();
    // Narration line is present
    expect(bookView).toHaveTextContent('The corridor lights flickered.');
    // Dialogue line is present
    expect(bookView).toHaveTextContent(`We can't keep going down`);
  });

  it('renders seg-{id} spans for each segment', () => {
    render(<ChapterEditor />);
    expect(screen.getByTestId('seg-11')).toBeInTheDocument();
    expect(screen.getByTestId('seg-12')).toBeInTheDocument();
  });

  it('renders speaker chip for dialogue lines', () => {
    render(<ChapterEditor />);
    // Mira chip should appear for dialogue line 12
    expect(screen.getByTestId('speaker-chip-12')).toBeInTheDocument();
    expect(screen.getByTestId('speaker-chip-12')).toHaveTextContent('Mira');
  });

  it('renders emotion-pill for dialogue lines (inert slot for D4)', () => {
    render(<ChapterEditor />);
    const pill = screen.getByTestId('emotion-12');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('tense');
  });

  it('renders review-toolbar with filter tabs', () => {
    render(<ChapterEditor />);
    const toolbar = screen.getByTestId('review-toolbar');
    expect(within(toolbar).getByText(/All/)).toBeInTheDocument();
    expect(within(toolbar).getByText(/Dialogue only/)).toBeInTheDocument();
    expect(within(toolbar).getByText(/By character/)).toBeInTheDocument();
    expect(within(toolbar).getByText(/Flagged/)).toBeInTheDocument();
  });

  it('readalong-btn stays clickable but marked aria-disabled when the chapter has no generated audio, and shows a guidance hint — D5', () => {
    // useStory/useBook are mocked to null here (no Story → no generated audio).
    // The button must NOT be a dead disabled control: it stays clickable (so a
    // click can explain what to do) but is marked aria-disabled, and a visible
    // amber hint tells the user to generate the chapter first.
    // (The enabled-with-audio path is covered in ChapterEditorReadAlong.test.tsx.)
    render(<ChapterEditor />);
    const btn = screen.getByTestId('readalong-btn');
    expect(btn).toBeInTheDocument();
    expect(btn).not.toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('readalong-hint')).toHaveTextContent(/generate/i);
  });

  it('renders review-rail with review-progress', () => {
    render(<ChapterEditor />);
    expect(screen.getByTestId('review-rail')).toBeInTheDocument();
    expect(screen.getByTestId('review-progress')).toBeInTheDocument();
  });

  it('renders back-to-overview and chapter-switcher', () => {
    render(<ChapterEditor />);
    expect(screen.getByTestId('back-to-overview')).toBeInTheDocument();
    expect(screen.getByTestId('chapter-switcher')).toBeInTheDocument();
  });

  it('Dialogue-only filter hides narration segments', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const toolbar = screen.getByTestId('review-toolbar');
    await u.click(within(toolbar).getByText(/Dialogue only/));
    // Narration line should be gone
    expect(screen.queryByTestId('seg-11')).not.toBeInTheDocument();
    // Dialogue line remains
    expect(screen.getByTestId('seg-12')).toBeInTheDocument();
  });

  it('reassigns a dialogue line when a character is chosen from the popover', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // Click the dialogue segment to open the reassign popover
    await u.click(screen.getByTestId('seg-12'));
    // The reassign dropdown should appear
    const dropdown = screen.getByTestId('reassign-dropdown');
    expect(dropdown).toBeInTheDocument();
    // Click Holt in the dropdown
    await u.click(within(dropdown).getByText('Holt'));
    // useUpdateSegment.mutate should be called with data.character_id: 'h'
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ character_id: 'h' }) }),
      expect.anything(),
    );
  });

  it('review-rail shows jump-{id} buttons for low-confidence lines', () => {
    render(<ChapterEditor />);
    // Segment 13 has character 'lo' with confidence 0.5, below the 0.7 threshold
    // The review rail should render a jump button for it
    expect(screen.getByTestId('jump-13')).toBeInTheDocument();
  });

  it('narration segment has no speaker chip', () => {
    render(<ChapterEditor />);
    // Segment 11 is narration — it should NOT have a speaker chip
    expect(screen.queryByTestId('speaker-chip-11')).not.toBeInTheDocument();
  });

  it('by-character filter shows only lines for a selected character', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const toolbar = screen.getByTestId('review-toolbar');
    // Click "By character" to open character picker
    await u.click(within(toolbar).getByText(/By character/));
    // Select Mira from the character selector
    const charSelect = screen.getByTestId('character-filter-select');
    await u.click(within(charSelect).getByText('Mira'));
    // Only Mira's dialogue should appear
    expect(screen.queryByTestId('seg-11')).not.toBeInTheDocument();
    expect(screen.getByTestId('seg-12')).toBeInTheDocument();
  });

  it('⋯ menu shows Regenerate button for a completed segment and calls useRegenerateSegment', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // Segment 11 has audio.status='completed' — open its ⋯ menu
    const chapterText = screen.getByTestId('chapter-text');
    const firstPara = within(chapterText).getAllByRole('paragraph')[0];
    const menuBtn = within(firstPara).getByRole('button', { name: '⋯' });
    await u.click(menuBtn);
    // The selection dialog should show the Regenerate button
    const dialog = screen.getByTestId('selection-dialog');
    const regenBtn = within(dialog).getByTestId('regenerate-btn-11');
    expect(regenBtn).toBeInTheDocument();
    expect(regenBtn).toHaveTextContent(/Regenerate/);
    // Clicking it calls regenerateMutate with the correct segmentId
    await u.click(regenBtn);
    expect(regenerateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ segmentId: '11' }),
      expect.anything(),
    );
  });

  it('⋯ menu does NOT show Regenerate for a segment with audio.status=none', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // Segment 13 has audio.status='none' — open its ⋯ menu
    const chapterText = screen.getByTestId('chapter-text');
    const seg13Para = within(chapterText)
      .getAllByRole('paragraph')
      .find((p) => p.querySelector('[data-testid="seg-13"]'));
    expect(seg13Para).toBeTruthy();
    const menuBtn = within(seg13Para!).getByRole('button', { name: '⋯' });
    await u.click(menuBtn);
    // The regenerate button should NOT appear for a never-generated segment
    const dialog = screen.getByTestId('selection-dialog');
    expect(within(dialog).queryByTestId('regenerate-btn-13')).not.toBeInTheDocument();
  });
});
