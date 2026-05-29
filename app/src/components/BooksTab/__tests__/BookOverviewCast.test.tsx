/**
 * BookOverviewCast — focused interaction tests for merge/delete wiring.
 *
 * Renders C8's BookOverview with a fixture that has 1 narrator + 2 non-narrator
 * characters that represent the "same person" (Mira / Mira the woman). Asserts that:
 *   - Selecting 2 non-narrator checkboxes enables the merge-btn
 *   - Clicking merge-btn calls useMergeCharacter.mutateAsync with the correct
 *     { bookId, charId (survivor), data: { source_char_id } } payload
 *   - Selecting 1 non-narrator checkbox enables the delete-btn
 *   - Clicking delete-btn opens a confirm dialog; confirming calls
 *     useDeleteCharacter.mutateAsync with { bookId, charId }
 *
 * C8 wiring lives in BookOverview.tsx — this test only asserts it.
 */
/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { BookOverview } from '@/components/BooksTab/BookOverview';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mergeMutate = vi.fn().mockResolvedValue(undefined);
const deleteMutate = vi.fn().mockResolvedValue(undefined);

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: (state: Record<string, unknown>) => unknown) =>
    s({
      selectedBookId: 'b1',
      setView: vi.fn(),
      setSelectedChapterId: vi.fn(),
      setSelectedCharacterId: vi.fn(),
    }),
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({
    data: {
      id: 'b1',
      title: 'Silo 42',
      author: 'Zev Paiss',
      status: 'analyzed',
      source_format: 'epub',
      chapters: [],
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
        role: undefined,
        aliases: [],
      },
      {
        id: 'm1',
        name: 'Mira',
        is_narrator: false,
        color: '#34d399',
        dialogue_count: 80,
        confidence: 0.9,
        role: 'major',
        aliases: [],
      },
      {
        id: 'm2',
        name: 'Mira (the woman)',
        is_narrator: false,
        color: '#10b981',
        dialogue_count: 62,
        confidence: 0.5,
        role: 'major',
        aliases: [],
      },
    ],
    isLoading: false,
  }),
  useMergeCharacter: () => ({
    mutateAsync: mergeMutate,
    isPending: false,
  }),
  useDeleteCharacter: () => ({
    mutateAsync: deleteMutate,
    isPending: false,
  }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('BookOverview cast management', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders cast-roster with 2 non-narrator checkboxes (narrator has none)', () => {
    render(<BookOverview />);
    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    // Only non-narrator characters (m1, m2) get checkboxes; Narrator does not
    expect(checkboxes).toHaveLength(2);
  });

  it('merge-btn is disabled when fewer than 2 characters are selected', () => {
    render(<BookOverview />);
    expect(screen.getByTestId('merge-btn')).toBeDisabled();

    // Select only 1 → still disabled
    const roster = screen.getByTestId('cast-roster');
    const [first] = within(roster).getAllByRole('checkbox');
    fireEvent.click(first);
    expect(screen.getByTestId('merge-btn')).toBeDisabled();
  });

  it('merges two selected characters via the B8 endpoint (survivor = first selected)', async () => {
    const u = userEvent.setup();
    render(<BookOverview />);

    const roster = screen.getByTestId('cast-roster');
    const checkboxes = within(roster).getAllByRole('checkbox');
    // Select both non-narrator characters
    await u.click(checkboxes[0]); // m1 (Mira)
    await u.click(checkboxes[1]); // m2 (Mira the woman)

    // merge-btn should be enabled now
    const mergeBtn = screen.getByTestId('merge-btn');
    expect(mergeBtn).not.toBeDisabled();

    await u.click(mergeBtn);

    // useMergeCharacter.mutateAsync must be called with survivor=m1, source=m2
    await waitFor(() => {
      expect(mergeMutate).toHaveBeenCalledTimes(1);
      expect(mergeMutate).toHaveBeenCalledWith({
        bookId: 'b1',
        charId: 'm1',
        data: { source_char_id: 'm2' },
      });
    });
  });

  it('delete-btn is disabled when no character is selected', () => {
    render(<BookOverview />);
    expect(screen.getByTestId('delete-btn')).toBeDisabled();
  });

  it('delete-btn enables with exactly 1 selected and merge-btn stays disabled', () => {
    render(<BookOverview />);
    const roster = screen.getByTestId('cast-roster');
    const [first] = within(roster).getAllByRole('checkbox');
    fireEvent.click(first); // select m1 only

    expect(screen.getByTestId('delete-btn')).not.toBeDisabled();
    expect(screen.getByTestId('merge-btn')).toBeDisabled();
  });

  it('delete-btn opens confirm dialog and calls useDeleteCharacter on confirm', async () => {
    render(<BookOverview />);
    const roster = screen.getByTestId('cast-roster');
    const [first] = within(roster).getAllByRole('checkbox');
    fireEvent.click(first); // select m1

    const deleteBtn = screen.getByTestId('delete-btn');
    expect(deleteBtn).not.toBeDisabled();
    fireEvent.click(deleteBtn);

    // The confirm dialog should appear
    await screen.findByRole('alertdialog');

    // Click the confirm action inside the dialog
    const dialog = screen.getByRole('alertdialog');
    const confirmBtn = within(dialog).getByRole('button', { name: /delete|confirm/i });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(deleteMutate).toHaveBeenCalledTimes(1);
      expect(deleteMutate).toHaveBeenCalledWith({
        bookId: 'b1',
        charId: 'm1',
      });
    });
  });
});
