/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

// AudioTrimmer uses WaveSurfer / AudioContext — stub it out for this unit-test suite.
vi.mock('@/components/AudioTrimmer/AudioTrimmer', () => ({
  AudioTrimmer: ({ file }: { file: File }) => (
    <div data-testid="audio-trimmer">{file.name}</div>
  ),
}));

const createClone = vi.fn().mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
const updateMutate = vi.fn();
const previewMutate = vi.fn();

// Capture the onRecordingComplete callback so tests can invoke it with custom durations
let capturedOnRecordingComplete: ((blob: Blob, duration?: number) => void) | null = null;

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) => s({ selectedBookId: 'b1', selectedCharacterId: 'm', setView: vi.fn(), setSelectedCharacterId: vi.fn() }),
}));
vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({ data: [{ id: 'm', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 }] }),
  useUpdateCharacter: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewCharacter: () => ({ mutate: previewMutate, isPending: false }),
  useCloneVoiceForCharacter: () => ({ mutateAsync: createClone, isPending: false }),
  useVoiceOptions: () => ({ data: { library: [], book: [], presets: [] } }),
  useSaveVoiceToLibrary: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    getBookAudioUrl: (id: string) => `http://localhost/audio/${id}`,
  },
}));
// useAudioRecording needs PlatformProvider — mock it for unit tests.
// Captures onRecordingComplete so tests can simulate recording completion with
// custom durations to exercise the 3–30 s duration guard.
vi.mock('@/lib/hooks/useAudioRecording', () => ({
  useAudioRecording: (opts: { onRecordingComplete?: (blob: Blob, duration?: number) => void }) => {
    capturedOnRecordingComplete = opts.onRecordingComplete ?? null;
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
  capturedOnRecordingComplete = null;
  createClone.mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
  previewMutate.mockReset();
});

describe('VoiceEditor (Clone)', () => {
  it('renders the clone tab panel with dropzone and record-btn', () => {
    render(<VoiceEditor initialTab="clone" />);
    expect(screen.getByTestId('voice-panel-clone')).toBeInTheDocument();
    expect(screen.getByTestId('clone-dropzone')).toBeInTheDocument();
    expect(screen.getByTestId('record-btn')).toBeInTheDocument();
  });

  it('shows a voice-name input and create-clone-btn', () => {
    render(<VoiceEditor initialTab="clone" />);
    expect(screen.getByTestId('create-clone-btn')).toBeInTheDocument();
  });

  it('creates a cloned voice from a sample and exposes preview + assign', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);
    expect(screen.getByTestId('clone-dropzone')).toBeInTheDocument();
    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(input as HTMLElement, new File([new Uint8Array(16)], 'mira.wav', { type: 'audio/wav' }));
    await u.click(screen.getByTestId('create-clone-btn'));
    expect(createClone).toHaveBeenCalled();
    expect(screen.getByTestId('assign-clone-btn')).toBeInTheDocument();
  });

  it('calls createClone with bookId, charId, name, and file', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);
    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(input as HTMLElement, new File([new Uint8Array(16)], 'sample.wav', { type: 'audio/wav' }));
    await u.click(screen.getByTestId('create-clone-btn'));
    expect(createClone).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 'b1',
        charId: 'm',
        file: expect.any(File),
      }),
    );
  });

  it('shows inline error when clone fails', async () => {
    const u = userEvent.setup();
    createClone.mockRejectedValueOnce(new Error('Backend clone error'));
    render(<VoiceEditor initialTab="clone" />);
    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(input as HTMLElement, new File([new Uint8Array(16)], 'bad.wav', { type: 'audio/wav' }));
    await u.click(screen.getByTestId('create-clone-btn'));
    expect(await screen.findByRole('alert')).toHaveTextContent(/backend clone error/i);
  });

  it('shows preview-player and preview-voice-btn after clone created', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);
    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(input as HTMLElement, new File([new Uint8Array(16)], 'mira.wav', { type: 'audio/wav' }));
    await u.click(screen.getByTestId('create-clone-btn'));
    // preview-player is always shown; assign-clone-btn appears after clone
    expect(screen.getByTestId('preview-player')).toBeInTheDocument();
    expect(screen.getByTestId('assign-clone-btn')).toBeInTheDocument();
  });

  it('assign-clone-btn calls updateMutate with profile_id from the created clone', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);
    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(input as HTMLElement, new File([new Uint8Array(16)], 'mira.wav', { type: 'audio/wav' }));
    await u.click(screen.getByTestId('create-clone-btn'));
    const assignBtn = await screen.findByTestId('assign-clone-btn');
    await u.click(assignBtn);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        bookId: 'b1',
        charId: 'm',
        data: expect.objectContaining({ profile_id: 'cloned-1' }),
      }),
      expect.anything(),
    );
  });

  // ── Fix 2: preview-voice-btn re-triggers preview ──────────────────────────

  it('clicking preview-voice-btn after clone triggers the preview mutation', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);
    const input = screen.getByTestId('clone-dropzone').querySelector('input[type=file]')!;
    await u.upload(input as HTMLElement, new File([new Uint8Array(16)], 'mira.wav', { type: 'audio/wav' }));
    await u.click(screen.getByTestId('create-clone-btn'));

    // onCloned auto-triggers preview once; record the call count before the btn click
    const callsAfterAutoPreview = previewMutate.mock.calls.length;

    // preview-voice-btn in the clone action row appears after clone succeeds.
    // There are two buttons with this testid (clone row + design bottom row);
    // the first one belongs to the clone action row.
    const previewBtns = await screen.findAllByTestId('preview-voice-btn');
    const clonePreviewBtn = previewBtns[0];
    await u.click(clonePreviewBtn);

    // Should have been called at least once more than after the auto-preview
    expect(previewMutate.mock.calls.length).toBeGreaterThan(callsAfterAutoPreview);
    // The final call should use the cloned profile_id
    const calls = previewMutate.mock.calls;
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall).toMatchObject({
      charId: 'm',
      data: { profile_id: 'cloned-1' },
    });
  });

  // ── Fix 3: Duration guard (3–30 s) ───────────────────────────────────────

  it('shows cloneTooShort error when recorded sample is under 3 seconds', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);

    // Simulate a recording that completes with duration = 1 s (too short)
    act(() => {
      capturedOnRecordingComplete?.(new Blob(['audio'], { type: 'audio/wav' }), 1);
    });

    await u.click(screen.getByTestId('create-clone-btn'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/too short/i);
    expect(createClone).not.toHaveBeenCalled();
  });

  it('does NOT reject a >30s recorded sample — AudioTrimmer handles long samples', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor initialTab="clone" />);

    // Simulate a recording that completes with duration = 35 s (previously "too long")
    act(() => {
      capturedOnRecordingComplete?.(new Blob(['audio'], { type: 'audio/wav' }), 35);
    });

    await u.click(screen.getByTestId('create-clone-btn'));

    // No "too long" alert; clone proceeds (the trimmer mock auto-passes)
    const alert = screen.queryByRole('alert');
    if (alert) {
      expect(alert).not.toHaveTextContent(/too long/i);
    }
    expect(createClone).toHaveBeenCalled();
  });

  it('does not block upload when sample duration is exactly at boundaries (3 s and 30 s)', async () => {
    const u = userEvent.setup();
    // Test 3 s exactly (should pass)
    const { unmount } = render(<VoiceEditor initialTab="clone" />);
    act(() => {
      capturedOnRecordingComplete?.(new Blob(['audio'], { type: 'audio/wav' }), 3);
    });
    await u.click(screen.getByTestId('create-clone-btn'));
    expect(createClone).toHaveBeenCalled();
    unmount();

    // Test 30 s exactly (should pass)
    vi.clearAllMocks();
    createClone.mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
    render(<VoiceEditor initialTab="clone" />);
    act(() => {
      capturedOnRecordingComplete?.(new Blob(['audio'], { type: 'audio/wav' }), 30);
    });
    await u.click(screen.getByTestId('create-clone-btn'));
    expect(createClone).toHaveBeenCalled();
  });
});
