/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/components/AudioTrimmer/AudioTrimmer', async () => {
  const { forwardRef } = await import('react');
  return {
    AudioTrimmer: forwardRef(
      ({ onConfirm }: { onConfirm: (f: File, d: number) => void }, _ref) => (
        <button
          data-testid="trimmer-confirm"
          onClick={() =>
            onConfirm(new File(['t'], 'reference-trimmed.wav', { type: 'audio/wav' }), 20)
          }
        >
          confirm
        </button>
      ),
    ),
  };
});

const cloneMutateAsync = vi.fn().mockResolvedValue({ id: 'prof-1' });
vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({
    data: [{ id: 'c1', name: 'Hero', color: '#fff', confidence: 0.9, dialogue_count: 3 }],
  }),
  usePreviewCharacter: () => ({ mutate: vi.fn(), data: undefined, isPending: false }),
  useUpdateCharacter: () => ({ mutate: vi.fn(), isPending: false }),
  useVoiceOptions: () => ({ data: undefined }),
  useCloneVoiceForCharacter: () => ({ mutateAsync: cloneMutateAsync, isPending: false }),
  useSaveVoiceToLibrary: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/lib/hooks/useAudioRecording', () => ({
  useAudioRecording: () => ({
    isRecording: false,
    duration: 0,
    error: null,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
  }),
}));

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (sel: any) =>
    sel({
      selectedBookId: 'b1',
      selectedCharacterId: 'c1',
      setSelectedCharacterId: vi.fn(),
      setView: vi.fn(),
    }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { getBookAudioUrl: () => 'blob:audio' },
}));

vi.mock('@/components/ui/use-toast', () => ({ toast: vi.fn() }));

// Real-ish hook that writes a transcript when given a file.
// IMPORTANT: write via useEffect, NOT during render. Calling setText synchronously in the hook
// body would update VoiceEditor's state while CloneTabBody is rendering, triggering React 18's
// "Cannot update a component while rendering a different component" warning / act() violations.
// The real A1 hook also drives setText from an effect, so this mirrors real behavior.
import { useEffect } from 'react';

vi.mock('@/lib/hooks/useReferenceTranscript', () => ({
  useReferenceTranscript: ({
    file,
    setText,
  }: {
    file: File | null;
    setText: (v: string) => void;
  }) => {
    useEffect(() => {
      if (file) setText('the real spoken words');
    }, [file, setText]);
    return {
      status: file ? 'filled' : 'idle',
      isTranscribing: false,
      regeneratePrompt: false,
      retranscribe: vi.fn(),
      acceptRegenerate: vi.fn(),
      keepEdits: vi.fn(),
    };
  },
}));

import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

beforeEach(() => vi.clearAllMocks());

describe('VoiceEditor clone transcript (S8, SC5)', () => {
  it('submits the field transcript to the clone mutation, not the placeholder', async () => {
    render(<VoiceEditor initialTab="clone" />);

    // Load a file into the dropzone to reveal the trimmer.
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await userEvent.upload(
      fileInput,
      new File(['raw'], 'raw.wav', { type: 'audio/wav' }),
    );

    // Confirm the trim → sets confirmedFile → hook writes transcript text.
    await userEvent.click(await screen.findByTestId('trimmer-confirm'));

    // Click Create clone.
    await userEvent.click(screen.getByTestId('create-clone-btn'));

    await waitFor(() =>
      expect(cloneMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ name: 'reference-trimmed.wav' }),
          referenceText: 'the real spoken words',
        }),
      ),
    );
  });

  it('renders the reference-transcript field in the clone tab', () => {
    render(<VoiceEditor initialTab="clone" />);
    expect(screen.getByTestId('reference-transcript')).toBeInTheDocument();
  });
});
