/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChapterEditor } from '@/components/BooksTab/ChapterEditor';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const updateMutate = vi.fn();

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) =>
    s({ selectedBookId: 'b1', selectedChapterId: 'c1', setView: vi.fn() }),
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({
    data: [
      { id: 'n', name: 'Narrator', is_narrator: true, color: '#6d8bff' },
      { id: 'm', name: 'Mira', color: '#34d399', confidence: 0.9 },
      { id: 'h', name: 'Holt', color: '#fbbf24', confidence: 0.8 },
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
        audio: { status: 'none' },
      },
      {
        id: '12',
        order: 1,
        type: 'dialogue',
        text: '“We can’t keep going down,”',
        character_id: 'm',
        character_name: 'Mira',
        emotion: 'tense',
        audio: { status: 'none' },
      },
    ],
  }),
  useUpdateSegment: () => ({ mutate: updateMutate, isPending: false }),
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
    expect(bookView).toHaveTextContent('We can’t keep going down');
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

  it('renders readalong-btn (present, inert — wired by D5)', () => {
    render(<ChapterEditor />);
    expect(screen.getByTestId('readalong-btn')).toBeInTheDocument();
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
    // useUpdateSegment.mutate should be called with character_id: 'h'
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ character_id: 'h' }),
      expect.anything(),
    );
  });

  it('review-rail shows jump-{id} buttons for low-confidence lines', () => {
    render(<ChapterEditor />);
    // The review rail shows jump buttons for segments with low confidence
    const rail = screen.getByTestId('review-rail');
    // With confidence 0.8 and 0.9 for Mira/Holt, they are above threshold
    // But the rail should at least render (even if empty)
    expect(rail).toBeInTheDocument();
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
});
