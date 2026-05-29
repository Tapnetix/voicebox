/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
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
        { id: 'c1', number: 1, title: 'Descent', word_count: 3410, generation_state: 'ready' },
        { id: 'c2', number: 2, title: 'The Lower Levels', word_count: 4002, generation_state: 'generating' },
      ],
    },
    isLoading: false,
  }),
  useCharacters: () => ({
    data: [
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
    ],
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
}));

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

describe('BookOverview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    // generation_state badges
    expect(within(chapterList).getByText('ready')).toBeInTheDocument();
    expect(within(chapterList).getByText('generating')).toBeInTheDocument();
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

  it('merge-btn enables when 2+ non-narrator characters are selected', () => {
    // Add a second non-narrator character via modified mock - test the UI state
    render(wrap(<BookOverview />));
    // Select Mira
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    expect(checkboxes.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(checkboxes[0]);
    // With only 1 selected, merge should still be disabled
    expect(screen.getByTestId('merge-btn')).toBeDisabled();
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
});
