/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BookOverview } from '@/components/BooksTab/BookOverview';

// ─── Store mock ───────────────────────────────────────────────────────────────
const mockSetView = vi.fn();
const mockSetSelectedChapterId = vi.fn();
const mockSetSelectedCharacterId = vi.fn();

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (sel: (s: Record<string, unknown>) => unknown) =>
    sel({
      selectedBookId: 'b1',
      setView: mockSetView,
      setSelectedChapterId: mockSetSelectedChapterId,
      setSelectedCharacterId: mockSetSelectedCharacterId,
    }),
}));

// ─── Hook mocks ───────────────────────────────────────────────────────────────
const mockMerge = vi.fn().mockResolvedValue(undefined);
const mockDelete = vi.fn().mockResolvedValue(undefined);

// Mutable character list — tests can swap this to control what useCharacters returns
let mockCharacters = [
  {
    id: 'n',
    name: 'Narrator',
    is_narrator: true,
    color: '#6d8bff',
    dialogue_count: 0,
    confidence: 1,
    voice_type: 'designed',
    role: undefined,
    aliases: [],
  },
  {
    id: 'm',
    name: 'Mira',
    is_narrator: false,
    role: 'major',
    color: '#34d399',
    dialogue_count: 142,
    confidence: 0.9,
    voice_type: 'designed',
    aliases: [],
  },
];

const mockGenerateChapter = vi.fn().mockResolvedValue({ task_id: 't1', queued_segments: 2 });

vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({
    data: {
      id: 'b1',
      title: 'Silo 42',
      author: 'Zev Paiss',
      status: 'analyzed',
      source_format: 'epub',
      chapter_count: 2,
      created_at: '2025-01-01T00:00:00Z',
      updated_at: '2025-01-01T00:00:00Z',
      chapters: [
        { id: 'c1', number: 1, title: 'Descent', word_count: 3410, generation_state: 'none' },
        { id: 'c2', number: 2, title: 'The Lower Levels', word_count: 4002, generation_state: 'none' },
      ],
    },
    isLoading: false,
  }),
  useCharacters: () => ({
    data: mockCharacters,
    isLoading: false,
  }),
  useMergeCharacter: () => ({
    mutateAsync: mockMerge,
    isPending: false,
  }),
  useDeleteCharacter: () => ({
    mutateAsync: mockDelete,
    isPending: false,
  }),
  useGenerateChapter: () => ({
    mutateAsync: mockGenerateChapter,
    isPending: false,
  }),
}));

// useBookProgress mock — by default a no-op; tests can replace mockProgressHandlers
let mockProgressHandlers: Record<string, ((ev: unknown) => void) | undefined> = {};
vi.mock('@/lib/hooks/useBookProgress', () => ({
  useBookProgress: (_bookId: string, handlers: Record<string, ((ev: unknown) => void) | undefined>) => {
    mockProgressHandlers = handlers;
  },
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

// Default character list (1 narrator + 1 non-narrator)
const defaultCharacters = [
  {
    id: 'n',
    name: 'Narrator',
    is_narrator: true,
    color: '#6d8bff',
    dialogue_count: 0,
    confidence: 1,
    voice_type: 'designed',
    role: undefined,
    aliases: [],
  },
  {
    id: 'm',
    name: 'Mira',
    is_narrator: false,
    role: 'major',
    color: '#34d399',
    dialogue_count: 142,
    confidence: 0.9,
    voice_type: 'designed',
    aliases: [],
  },
];

describe('BookOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset to default fixture (1 narrator + 1 non-narrator)
    mockCharacters = [...defaultCharacters];
    mockProgressHandlers = {};
  });

  // ── Book header ──────────────────────────────────────────────────────────
  it('renders book-header with title, status badge, and summary meta', () => {
    render(wrap(<BookOverview />));
    const header = screen.getByTestId('book-header');
    expect(within(header).getByText('Silo 42')).toBeInTheDocument();
    expect(within(header).getByTestId('book-status')).toBeInTheDocument();
    expect(within(header).getByTestId('book-summary')).toBeInTheDocument();
  });

  it('renders the book-wide cast and per-chapter list (from spec)', () => {
    render(wrap(<BookOverview />));
    const cast = screen.getByTestId('cast-roster');
    expect(within(cast).getByText('Narrator')).toBeInTheDocument();
    expect(within(cast).getByText('Mira')).toBeInTheDocument();
    const chapters = screen.getByTestId('chapter-list');
    expect(within(chapters).getByText(/Descent/)).toBeInTheDocument();
    expect(within(chapters).getByText(/The Lower Levels/)).toBeInTheDocument();
    expect(within(chapters).getByText(/3[,.]?410/)).toBeInTheDocument();
  });

  // ── Cast roster ──────────────────────────────────────────────────────────
  it('renders cast-summary with cast-roster and cast-actions', () => {
    render(wrap(<BookOverview />));
    expect(screen.getByTestId('cast-summary')).toBeInTheDocument();
    expect(screen.getByTestId('cast-roster')).toBeInTheDocument();
    expect(screen.getByTestId('cast-actions')).toBeInTheDocument();
    expect(screen.getByTestId('merge-btn')).toBeInTheDocument();
    expect(screen.getByTestId('delete-btn')).toBeInTheDocument();
  });

  it('renders one char-card per character', () => {
    render(wrap(<BookOverview />));
    const roster = screen.getByTestId('cast-roster');
    const cards = within(roster).getAllByTestId(/^char-card/);
    expect(cards).toHaveLength(2);
  });

  it('narrator has no checkbox (not selectable)', () => {
    render(wrap(<BookOverview />));
    const roster = screen.getByTestId('cast-roster');
    // Only non-narrator characters get a checkbox
    const checkboxes = within(roster).getAllByRole('checkbox');
    // Only Mira (non-narrator) gets a checkbox, not Narrator
    expect(checkboxes).toHaveLength(1);
  });

  it('non-narrator character has a selectable checkbox', () => {
    render(wrap(<BookOverview />));
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    expect(checkboxes).toHaveLength(1);
  });

  // ── Chapter list ─────────────────────────────────────────────────────────
  it('renders chapter-list with word count and generation_state badge', () => {
    render(wrap(<BookOverview />));
    const chapterList = screen.getByTestId('chapter-list');
    expect(within(chapterList).getByText(/Descent/)).toBeInTheDocument();
    expect(within(chapterList).getByText(/The Lower Levels/)).toBeInTheDocument();
    // generation_state badges — both are 'none' in the fixture
    const noneBadges = within(chapterList).getAllByText('none');
    expect(noneBadges).toHaveLength(2);
  });

  it('chapter list has Edit links', () => {
    render(wrap(<BookOverview />));
    const chapterList = screen.getByTestId('chapter-list');
    const editBtns = within(chapterList).getAllByText(/edit/i);
    expect(editBtns.length).toBeGreaterThanOrEqual(2);
  });

  // ── Header action slots ──────────────────────────────────────────────────
  it('renders generate-all-btn, export-btn, and audio-settings-btn', () => {
    render(wrap(<BookOverview />));
    expect(screen.getByTestId('generate-all-btn')).toBeInTheDocument();
    expect(screen.getByTestId('export-btn')).toBeInTheDocument();
    expect(screen.getByTestId('audio-settings-btn')).toBeInTheDocument();
  });

  it('renders per-chapter generate buttons', () => {
    render(wrap(<BookOverview />));
    // Chapter 1 has generate-chapter-1, chapter 2 has generate-chapter-2
    expect(screen.getByTestId('generate-chapter-1')).toBeInTheDocument();
    expect(screen.getByTestId('generate-chapter-2')).toBeInTheDocument();
  });

  // ── Drill-in navigation ──────────────────────────────────────────────────
  it('clicking a character name sets selectedCharacterId and navigates to voice-editor', () => {
    render(wrap(<BookOverview />));
    fireEvent.click(screen.getByTestId('char-link-m'));
    expect(mockSetSelectedCharacterId).toHaveBeenCalledWith('m');
    expect(mockSetView).toHaveBeenCalledWith('voice-editor');
  });

  it('clicking a chapter Edit sets selectedChapterId and navigates to chapter-editor', () => {
    render(wrap(<BookOverview />));
    const chapterList = screen.getByTestId('chapter-list');
    const editBtns = within(chapterList).getAllByText(/edit/i);
    fireEvent.click(editBtns[0]);
    expect(mockSetSelectedChapterId).toHaveBeenCalledWith('c1');
    expect(mockSetView).toHaveBeenCalledWith('chapter-editor');
  });

  // ── Cast merge/delete wiring ─────────────────────────────────────────────
  it('merge-btn is disabled when fewer than 2 characters selected', () => {
    render(wrap(<BookOverview />));
    const mergeBtn = screen.getByTestId('merge-btn');
    expect(mergeBtn).toBeDisabled();
  });

  it('delete-btn is disabled when no character selected', () => {
    render(wrap(<BookOverview />));
    const deleteBtn = screen.getByTestId('delete-btn');
    expect(deleteBtn).toBeDisabled();
  });

  it('merge-btn disabled with only 1 selected', () => {
    render(wrap(<BookOverview />));
    // Select Mira (only non-narrator in default fixture)
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(checkboxes[0]);
    // With only 1 selected, merge should still be disabled
    expect(screen.getByTestId('merge-btn')).toBeDisabled();
  });

  it('merge-btn enables when 2+ non-narrator characters are selected, and calls useMergeCharacter with correct survivor + source args', async () => {
    // Override fixture to have 2 non-narrator characters
    mockCharacters = [
      {
        id: 'n',
        name: 'Narrator',
        is_narrator: true,
        color: '#6d8bff',
        dialogue_count: 0,
        confidence: 1,
        voice_type: 'designed',
        role: undefined,
        aliases: [],
      },
      {
        id: 'm',
        name: 'Mira',
        is_narrator: false,
        role: 'major',
        color: '#34d399',
        dialogue_count: 142,
        confidence: 0.9,
        voice_type: 'designed',
        aliases: [],
      },
      {
        id: 'j',
        name: 'Juliette',
        is_narrator: false,
        role: 'major',
        color: '#f59e0b',
        dialogue_count: 98,
        confidence: 0.85,
        voice_type: 'designed',
        aliases: [],
      },
    ];

    render(wrap(<BookOverview />));
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    // Should have 2 checkboxes (Mira + Juliette); Narrator has none
    expect(checkboxes).toHaveLength(2);

    // Select both non-narrator characters
    fireEvent.click(checkboxes[0]); // Mira (id: 'm')
    fireEvent.click(checkboxes[1]); // Juliette (id: 'j')

    // merge-btn should now be enabled
    const mergeBtn = screen.getByTestId('merge-btn');
    expect(mergeBtn).not.toBeDisabled();

    // Click merge
    fireEvent.click(mergeBtn);

    // useMergeCharacter.mutateAsync should be called once (1 source merging into survivor)
    // Survivor is the first selected (m), source is the second (j)
    await waitFor(() => {
      expect(mockMerge).toHaveBeenCalledTimes(1);
      expect(mockMerge).toHaveBeenCalledWith({
        bookId: 'b1',
        charId: 'm',
        data: { source_char_id: 'j' },
      });
    });
  });

  it('delete-btn enables when exactly 1 non-narrator character is selected', () => {
    render(wrap(<BookOverview />));
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]);
    expect(screen.getByTestId('delete-btn')).not.toBeDisabled();
  });

  it('delete-btn shows confirm dialog and calls useDeleteCharacter on confirm', async () => {
    render(wrap(<BookOverview />));
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    fireEvent.click(checkboxes[0]); // select Mira
    const deleteBtn = screen.getByTestId('delete-btn');
    expect(deleteBtn).not.toBeDisabled();
    fireEvent.click(deleteBtn);
    // Alert dialog should appear — wait for it
    await screen.findByRole('button', { name: /delete/i });
    // Find the confirmation dialog confirm button (not the cast-actions delete-btn)
    const confirmBtns = screen.getAllByRole('button', { name: /delete/i });
    // The confirm button in dialog is the one that fires the mutation
    // Click the last one (dialog confirm)
    fireEvent.click(confirmBtns[confirmBtns.length - 1]);
    await waitFor(() => {
      expect(mockDelete).toHaveBeenCalled();
    });
  });

  // ── Summary derivation ───────────────────────────────────────────────────
  it('derives summary stats (chapter count, character count) from queries', () => {
    render(wrap(<BookOverview />));
    const summary = screen.getByTestId('book-summary');
    expect(within(summary).getByText(/2 chapter/i)).toBeInTheDocument();
    expect(within(summary).getByText(/2 character/i)).toBeInTheDocument();
  });

  // ── Generate chapter wiring (D2) ─────────────────────────────────────────

  it('generate-chapter buttons are rendered for each chapter', () => {
    render(wrap(<BookOverview />));
    const btn1 = screen.getByTestId('generate-chapter-1');
    const btn2 = screen.getByTestId('generate-chapter-2');
    expect(btn1).toBeInTheDocument();
    expect(btn2).toBeInTheDocument();
  });

  it('generate-chapter button is enabled when chapter is not generating', () => {
    render(wrap(<BookOverview />));
    const btn1 = screen.getByTestId('generate-chapter-1');
    expect(btn1).not.toBeDisabled();
  });

  it('clicking generate-chapter-1 calls useGenerateChapter with correct ids', async () => {
    render(wrap(<BookOverview />));
    const btn1 = screen.getByTestId('generate-chapter-1');
    fireEvent.click(btn1);
    await waitFor(() => {
      expect(mockGenerateChapter).toHaveBeenCalledWith(
        expect.objectContaining({ bookId: 'b1', chapterId: 'c1' })
      );
    });
  });

  it('generation_progress event updates chapter row to show "generating n/m"', async () => {
    render(wrap(<BookOverview />));
    // Simulate useBookProgress firing a generation_progress event
    act(() => {
      mockProgressHandlers.onGenerationProgress?.({
        type: 'generation_progress',
        chapter_id: 'c1',
        completed: 1,
        errors: 0,
        total: 3,
        overall_progress: 0.33,
      });
    });
    // Chapter row should show progress indicator
    await waitFor(() => {
      const chapterList = screen.getByTestId('chapter-list');
      expect(within(chapterList).getByText(/generating 1\/3/i)).toBeInTheDocument();
    });
  });

  it('generation_complete event flips chapter row to done badge', async () => {
    render(wrap(<BookOverview />));
    // First simulate a progress event to get into generating state
    act(() => {
      mockProgressHandlers.onGenerationProgress?.({
        type: 'generation_progress',
        chapter_id: 'c1',
        completed: 2,
        errors: 0,
        total: 2,
        overall_progress: 1.0,
      });
    });
    // Then complete
    act(() => {
      mockProgressHandlers.onGenerationComplete?.({
        type: 'generation_complete',
        chapter_id: 'c1',
      });
    });
    await waitFor(() => {
      const chapterList = screen.getByTestId('chapter-list');
      expect(within(chapterList).getByText('done')).toBeInTheDocument();
    });
  });

  it('generate-chapter button is disabled while that chapter is generating', async () => {
    // Keep the generate mutation pending so the chapter stays in the in-flight
    // set (the finally-clause that re-enables the button never runs).
    mockGenerateChapter.mockReturnValueOnce(new Promise(() => {}));
    render(wrap(<BookOverview />));
    const btn1 = screen.getByTestId('generate-chapter-1');
    expect(btn1).not.toBeDisabled();
    // Click to trigger generation — the row is marked in-flight synchronously.
    fireEvent.click(btn1);
    // While the mutation is pending the button must be disabled.
    await waitFor(() => {
      expect(btn1).toBeDisabled();
    });
  });
});
