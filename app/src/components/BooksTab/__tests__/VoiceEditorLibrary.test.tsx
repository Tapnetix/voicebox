/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

const updateMutate = vi.fn();
vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) => s({ selectedBookId: 'b1', selectedCharacterId: 'm', setView: vi.fn(), setSelectedCharacterId: vi.fn() }),
}));
vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({ data: [{ id: 'm', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 }] }),
  useUpdateCharacter: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewCharacter: () => ({ mutate: vi.fn(), isPending: false }),
  useVoiceOptions: () => ({ data: {
    library: [{ id: 'lib1', name: 'Gravelly Narrator', voice_type: 'designed' }],
    book: [{ id: 'bk1', name: 'Holt (designed)', voice_type: 'designed' }],
    presets: [{ id: 'af_heart', name: 'Heart', engine: 'kokoro', gender: 'female' }],
  } }),
}));

describe('VoiceEditor (Library)', () => {
  it('lists the three sources and assigns a selected preset', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="library" />);
    expect(within(screen.getByTestId('library-voices')).getByText('Gravelly Narrator')).toBeInTheDocument();
    expect(within(screen.getByTestId('book-voices')).getByText(/Holt/)).toBeInTheDocument();
    const presets = screen.getByTestId('preset-voices');
    await u.click(within(presets).getByText('Heart'));
    await u.click(screen.getByTestId('assign-selected-btn'));
    expect(updateMutate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ preset_voice_id: 'af_heart' }) }), expect.anything());
  });
});
