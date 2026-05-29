/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

// ─── Mutable character fixture ────────────────────────────────────────────────

let characterData = [
  {
    id: 'm',
    name: 'Mira',
    color: '#34d399',
    profile_id: 'p1',
    voice_type: 'designed',
    voice_label: 'designed',
    dialogue_count: 142,
    confidence: 0.9,
  },
];

const saveMutate = vi.fn();

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) =>
    s({
      selectedBookId: 'b1',
      selectedCharacterId: 'm',
      setView: vi.fn(),
      setSelectedCharacterId: vi.fn(),
    }),
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({ data: characterData }),
  useUpdateCharacter: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewCharacter: () => ({ mutate: vi.fn(), isPending: false }),
  useVoiceOptions: () => ({ data: { library: [], book: [], presets: [] } }),
  useCloneVoiceForCharacter: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useSaveVoiceToLibrary: () => ({ mutate: saveMutate, isPending: false }),
}));

vi.mock('@/lib/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({
    isRecording: false,
    duration: 0,
    error: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    getBookAudioUrl: (id: string) => `http://localhost/audio/${id}`,
  },
}));

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn(), toasts: [] }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VoiceEditor save-to-library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    characterData = [
      {
        id: 'm',
        name: 'Mira',
        color: '#34d399',
        profile_id: 'p1',
        voice_type: 'designed',
        voice_label: 'designed',
        dialogue_count: 142,
        confidence: 0.9,
      },
    ];
  });

  it('promotes the assigned voice to the library', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByTestId('save-to-library-btn'));
    expect(saveMutate).toHaveBeenCalled(); // POST /characters/m/save-to-library
  });

  it('save-to-library-btn is disabled when character has no assigned voice', () => {
    characterData = [
      {
        id: 'm',
        name: 'Mira',
        color: '#34d399',
        profile_id: null as any,
        voice_type: null as any,
        voice_label: null as any,
        dialogue_count: 142,
        confidence: 0.9,
      },
    ];
    render(<VoiceEditor />);
    expect(screen.getByTestId('save-to-library-btn')).toBeDisabled();
  });

  it('save-to-library-btn is enabled when character has voice_type set', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('save-to-library-btn')).not.toBeDisabled();
  });

  it('calls saveMutate with character id', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByTestId('save-to-library-btn'));
    expect(saveMutate).toHaveBeenCalledWith('m', expect.any(Object));
  });
});
