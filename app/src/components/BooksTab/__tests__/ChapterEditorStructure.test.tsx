/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChapterEditor } from '@/components/BooksTab/ChapterEditor';

const splitMutate = vi.fn().mockResolvedValue([{ id: '18', order: 0 }, { id: '18b', order: 1 }]);
const updateMutate = vi.fn();
const mergeMutate = vi.fn();

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) => s({ selectedBookId: 'b1', selectedChapterId: 'c1', setView: vi.fn() }),
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({
    data: [
      { id: 'h', name: 'Holt', color: '#fbbf24' },
      { id: 'mayor', name: 'The Mayor', color: '#f87171' },
    ],
  }),
  useSegments: () => ({
    data: [
      {
        id: '18',
        order: 0,
        type: 'dialogue',
        character_id: 'h',
        character_name: 'Holt',
        text: "Hold the light steady. It's coming from the pump room, said the Mayor.",
        emotion: 'calm',
        audio: { status: 'none' },
      },
      {
        id: '19',
        order: 1,
        type: 'dialogue',
        character_id: 'mayor',
        character_name: 'The Mayor',
        text: 'We need to leave now.',
        emotion: 'urgent',
        audio: { status: 'none' },
      },
    ],
  }),
  useUpdateSegment: () => ({ mutate: updateMutate, isPending: false }),
  useSplitSegment: () => ({ mutateAsync: splitMutate, isPending: false }),
  useMergeSegments: () => ({ mutate: mergeMutate, isPending: false }),
}));

describe('ChapterEditor structural fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    splitMutate.mockResolvedValue([{ id: '18', order: 0 }, { id: '18b', order: 1 }]);
  });

  it('renders a ⋯ menu button for each segment', () => {
    render(<ChapterEditor />);
    // The ⋯ button should be near the segment
    const menuBtn = within(screen.getByTestId('seg-18').closest('p')!).getByRole('button', { name: /⋯/ });
    expect(menuBtn).toBeInTheDocument();
  });

  it('opens the selection-dialog when ⋯ button is clicked', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    const menuBtn = within(seg18Para).getByRole('button', { name: /⋯/ });
    await u.click(menuBtn);
    expect(screen.getByTestId('selection-dialog')).toBeInTheDocument();
  });

  it('splits a selection into its own line and assigns it to a different speaker', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // open the per-line ⋯ menu / selection dialog for seg 18
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    // click split
    await u.click(within(dialog).getByTestId('split-btn'));
    expect(splitMutate).toHaveBeenCalled();   // POST /segments/18/split { at_offset }
  });

  it('shows type-toggle with Narration and Dialogue options', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    const typeToggle = within(dialog).getByTestId('type-toggle');
    expect(typeToggle).toBeInTheDocument();
    expect(within(typeToggle).getByText('Narration')).toBeInTheDocument();
    expect(within(typeToggle).getByText('Dialogue')).toBeInTheDocument();
  });

  it('shows speaker-row when segment type is Dialogue', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    expect(within(dialog).getByTestId('speaker-row')).toBeInTheDocument();
  });

  it('shows merge-prev-btn and merge-next-btn in dialog', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    expect(within(dialog).getByTestId('merge-prev-btn')).toBeInTheDocument();
    expect(within(dialog).getByTestId('merge-next-btn')).toBeInTheDocument();
  });

  it('shows edit-text-btn, cancel-btn, apply-btn in dialog', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    expect(within(dialog).getByTestId('edit-text-btn')).toBeInTheDocument();
    expect(within(dialog).getByTestId('cancel-btn')).toBeInTheDocument();
    expect(within(dialog).getByTestId('apply-btn')).toBeInTheDocument();
  });

  it('closes the dialog when cancel-btn is clicked', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    expect(screen.getByTestId('selection-dialog')).toBeInTheDocument();
    await u.click(screen.getByTestId('cancel-btn'));
    expect(screen.queryByTestId('selection-dialog')).not.toBeInTheDocument();
  });

  it('calls updateMutate with type narration when toggling to Narration', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    // click Narration in the toggle
    await u.click(within(within(dialog).getByTestId('type-toggle')).getByText('Narration'));
    // speaker-row should disappear (toggled to narration)
    expect(within(dialog).queryByTestId('speaker-row')).not.toBeInTheDocument();
  });

  it('calls updateMutate with character_id when apply is clicked after type change', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    // Change type to narration
    await u.click(within(within(dialog).getByTestId('type-toggle')).getByText('Narration'));
    // Apply
    await u.click(within(dialog).getByTestId('apply-btn'));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'narration' }) }),
      expect.anything(),
    );
  });

  it('calls mergeMutate with [prevId, sid] when merge-prev is clicked', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // open seg-19 menu (it has a prev: seg-18)
    const seg19Para = screen.getByTestId('seg-19').closest('p')!;
    await u.click(within(seg19Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    await u.click(within(dialog).getByTestId('merge-prev-btn'));
    expect(mergeMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ segment_ids: ['18', '19'] }) }),
      expect.anything(),
    );
  });

  it('calls mergeMutate with [sid, nextId] when merge-next is clicked', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    // open seg-18 menu (it has a next: seg-19)
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    await u.click(within(dialog).getByTestId('merge-next-btn'));
    expect(mergeMutate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ segment_ids: ['18', '19'] }) }),
      expect.anything(),
    );
  });

  it('shows an edit textarea when edit-text-btn is clicked', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    const seg18Para = screen.getByTestId('seg-18').closest('p')!;
    await u.click(within(seg18Para).getByRole('button', { name: /⋯/ }));
    const dialog = screen.getByTestId('selection-dialog');
    await u.click(within(dialog).getByTestId('edit-text-btn'));
    expect(within(dialog).getByRole('textbox')).toBeInTheDocument();
  });
});
