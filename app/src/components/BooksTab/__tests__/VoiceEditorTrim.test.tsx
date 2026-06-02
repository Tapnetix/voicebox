/// <reference types="@testing-library/jest-dom/vitest" />
/**
 * VoiceEditorTrim.test.tsx
 *
 * Verifies that VoiceEditor's Clone tab:
 *   - mounts AudioTrimmer when a sample is selected
 *   - no longer shows cloneTooLong for >30s samples
 *   - passes the trimmed File (from onConfirm) to the clone-create path
 *   - still rejects <3s samples via cloneTooShort
 */
import '@/i18n';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

// ── Trimmer confirm stub ────────────────────────────────────────────────────
// Captures onConfirm so tests can call it with a trimmed file
let capturedTrimmerOnConfirm: ((trimmed: File, durationSec: number) => void) | null = null;

vi.mock('@/components/AudioTrimmer/AudioTrimmer', () => ({
  AudioTrimmer: ({ file: _file, onConfirm }: { file: File; onConfirm: (f: File, d: number) => void }) => {
    capturedTrimmerOnConfirm = onConfirm;
    return <div data-testid="audio-trimmer">AudioTrimmer stub</div>;
  },
}));

// ── Recording callback ──────────────────────────────────────────────────────
let capturedOnRecordingComplete: ((blob: Blob, duration?: number) => void) | null = null;
let capturedMaxDurationSeconds: number | undefined;

// ── Hook / store mocks ──────────────────────────────────────────────────────
const createClone = vi.fn().mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
const updateMutate = vi.fn();
const previewMutate = vi.fn();

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
  useCharacters: () => ({
    data: [{ id: 'm', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 }],
  }),
  useUpdateCharacter: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewCharacter: () => ({ mutate: previewMutate, isPending: false }),
  useCloneVoiceForCharacter: () => ({ mutateAsync: createClone, isPending: false }),
  useVoiceOptions: () => ({ data: { library: [], book: [], presets: [] } }),
  useSaveVoiceToLibrary: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/api/client', () => ({
  apiClient: { getBookAudioUrl: (id: string) => `http://localhost/audio/${id}` },
}));

vi.mock('@/lib/hooks/useAudioRecording', () => ({
  useAudioRecording: (opts: { maxDurationSeconds?: number; onRecordingComplete?: (blob: Blob, duration?: number) => void }) => {
    capturedOnRecordingComplete = opts.onRecordingComplete ?? null;
    capturedMaxDurationSeconds = opts.maxDurationSeconds;
    return {
      isRecording: false,
      duration: 0,
      error: null,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    };
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  capturedTrimmerOnConfirm = null;
  capturedOnRecordingComplete = null;
  capturedMaxDurationSeconds = undefined;
  createClone.mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
});

describe('VoiceEditor Clone tab — AudioTrimmer integration', () => {
  it('mounts AudioTrimmer after a file is uploaded', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);

    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(
      input as HTMLElement,
      new File([new Uint8Array(16)], 'mira.wav', { type: 'audio/wav' }),
    );

    expect(screen.getByTestId('audio-trimmer')).toBeInTheDocument();
  });

  it('does NOT show cloneTooLong error for a >30s sample — trimmer handles it instead', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);

    // Simulate a recording that completes with duration = 35s (previously too long)
    act(() => {
      capturedOnRecordingComplete?.(new Blob(['audio'], { type: 'audio/wav' }), 35);
    });

    // The trimmer should be visible, NOT cloneTooLong error
    expect(screen.getByTestId('audio-trimmer')).toBeInTheDocument();

    // Clicking Create should NOT show 'too long' error
    await u.click(screen.getByTestId('create-clone-btn'));
    // The alert (if any) must not contain 'too long'
    const alert = screen.queryByRole('alert');
    if (alert) {
      expect(alert).not.toHaveTextContent(/too long/i);
    }
  });

  it('passes the trimmed file to cloneVoice.mutateAsync, not the raw file', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);

    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(
      input as HTMLElement,
      new File([new Uint8Array(16)], 'raw.wav', { type: 'audio/wav' }),
    );

    // AudioTrimmer is mounted; confirm with a trimmed file
    const trimmedFile = new File([new Uint8Array(4)], 'reference-123.wav', { type: 'audio/wav' });
    act(() => {
      capturedTrimmerOnConfirm?.(trimmedFile, 20);
    });

    // Now click create
    await u.click(screen.getByTestId('create-clone-btn'));
    expect(createClone).toHaveBeenCalledWith(
      expect.objectContaining({
        file: trimmedFile,
      }),
    );
  });

  it('still shows cloneTooShort for a recorded sample under 3 seconds', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);

    // Simulate a very short recording (1s — still too short)
    act(() => {
      capturedOnRecordingComplete?.(new Blob(['audio'], { type: 'audio/wav' }), 1);
    });

    await u.click(screen.getByTestId('create-clone-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/too short/i);
    expect(createClone).not.toHaveBeenCalled();
  });

  it('recorder maxDurationSeconds is 120 (not 29)', () => {
    render(<VoiceEditor initialTab="clone" />);
    expect(capturedMaxDurationSeconds).toBe(120);
  });
});
