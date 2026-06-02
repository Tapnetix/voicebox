/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SampleUpload } from '@/components/VoiceProfiles/SampleUpload';

// ---- mocks ----

// Mock AudioTrimmer as a stub exposing a confirm button that fires onConfirm
vi.mock('@/components/AudioTrimmer/AudioTrimmer', () => ({
  AudioTrimmer: ({ file, onConfirm }: { file: File; onConfirm: (f: File, d: number) => void }) => {
    return (
      <div data-testid="audio-trimmer">
        <span data-testid="trimmer-file-name">{file.name}</span>
        <button
          data-testid="trimmer-confirm"
          onClick={() => {
            const trimmed = new File(['trimmed-wav-data'], 'reference-trimmed.wav', {
              type: 'audio/wav',
            });
            onConfirm(trimmed, 20);
          }}
        >
          Use this clip
        </button>
      </div>
    );
  },
}));

// Mock hooks that SampleUpload uses
const addSampleMutateAsync = vi.fn().mockResolvedValue({});

vi.mock('@/lib/hooks/useProfiles', () => ({
  useAddSample: () => ({ mutateAsync: addSampleMutateAsync, isPending: false }),
  useProfile: () => ({ data: { id: 'p1', name: 'Test Profile', language: 'en' } }),
}));

vi.mock('@/lib/hooks/useTranscription', () => ({
  useTranscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/hooks/useAudioPlayer', () => ({
  useAudioPlayer: () => ({
    isPlaying: false,
    playPause: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('@/lib/hooks/useAudioRecording', () => ({
  useAudioRecording: (opts: { onRecordingComplete?: (blob: Blob, duration?: number) => void; maxDurationSeconds?: number }) => {
    // Expose maxDurationSeconds for test inspection
    (useAudioRecording as any)._lastMaxDuration = opts.maxDurationSeconds;
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

vi.mock('@/lib/hooks/useSystemAudioCapture', () => ({
  useSystemAudioCapture: (opts: { maxDurationSeconds?: number }) => {
    (useSystemAudioCapture as any)._lastMaxDuration = opts.maxDurationSeconds;
    return {
      isRecording: false,
      duration: 0,
      error: null,
      isSupported: false,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    };
  },
}));

vi.mock('@/platform/PlatformContext', () => ({
  usePlatform: () => ({
    metadata: { isTauri: false },
  }),
}));

vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// Import hooks for introspection
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import { useSystemAudioCapture } from '@/lib/hooks/useSystemAudioCapture';

// ---- helpers ----

function renderSampleUpload(open = true) {
  return render(
    <SampleUpload profileId="p1" open={open} onOpenChange={vi.fn()} />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  addSampleMutateAsync.mockResolvedValue({});
});

// ---- tests ----

describe('SampleUpload — AudioTrimmer integration', () => {
  it('T1: selecting a file mounts AudioTrimmer instead of showing a too-long error', async () => {
    const u = userEvent.setup();
    renderSampleUpload();

    // Find the file input inside upload tab
    const fileInput = document.querySelector('input[type=file]') as HTMLInputElement;
    expect(fileInput).toBeTruthy();

    // Upload a long file (200s) — should NOT be rejected, should go to trimmer
    const longFile = new File(['audio-data'.repeat(1000)], 'interview.wav', {
      type: 'audio/wav',
    });
    await u.upload(fileInput, longFile);

    // AudioTrimmer should be shown, not a duration error
    expect(await screen.findByTestId('audio-trimmer')).toBeInTheDocument();
    expect(screen.queryByText(/too long/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/duration/i)).not.toBeInTheDocument();
  });

  it('T2: after trimmer confirms, submit sends the trimmed file (not the raw file)', async () => {
    const u = userEvent.setup();
    renderSampleUpload();

    // Select a file
    const fileInput = document.querySelector('input[type=file]') as HTMLInputElement;
    const rawFile = new File(['raw-audio-data'], 'long-recording.wav', { type: 'audio/wav' });
    await u.upload(fileInput, rawFile);

    // Trimmer appears
    await screen.findByTestId('audio-trimmer');

    // Fill in reference text (required by the form schema)
    const referenceTextarea = screen.getByPlaceholderText(/enter the exact text/i);
    await u.type(referenceTextarea, 'Hello world this is my reference text');

    // Confirm the trim
    await u.click(screen.getByTestId('trimmer-confirm'));

    // Submit the form
    await u.click(screen.getByRole('button', { name: /add sample/i }));

    // Should have called addSample with the TRIMMED file (reference-trimmed.wav)
    await waitFor(() => {
      expect(addSampleMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          profileId: 'p1',
          file: expect.objectContaining({ name: 'reference-trimmed.wav' }),
        }),
      );
    });
  });

  it('T3: re-selecting a file re-opens the trimmer (trimmer replaces previous selection)', async () => {
    const u = userEvent.setup();
    renderSampleUpload();

    const fileInput = document.querySelector('input[type=file]') as HTMLInputElement;

    // First file
    const file1 = new File(['data1'], 'first.wav', { type: 'audio/wav' });
    await u.upload(fileInput, file1);
    expect(await screen.findByTestId('trimmer-file-name')).toHaveTextContent('first.wav');

    // Second file (re-select)
    const file2 = new File(['data2'], 'second.wav', { type: 'audio/wav' });
    await u.upload(fileInput, file2);
    await waitFor(() => {
      expect(screen.getByTestId('trimmer-file-name')).toHaveTextContent('second.wav');
    });
  });

  it('T4: maxDurationSeconds is 120 on both recorders', () => {
    renderSampleUpload();

    // Check useAudioRecording was called with 120
    expect((useAudioRecording as any)._lastMaxDuration).toBe(120);
    // Check useSystemAudioCapture was called with 120
    expect((useSystemAudioCapture as any)._lastMaxDuration).toBe(120);
  });
});
