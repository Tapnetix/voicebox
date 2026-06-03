/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// ── AudioTrimmer stub ─────────────────────────────────────────────────────────
// Immediately offers a "Use this clip" button that calls onConfirm with a known
// trimmed file so we can assert the form submits the trimmed file, not the original.
vi.mock('@/components/AudioTrimmer/AudioTrimmer', () => ({
  AudioTrimmer: ({ onConfirm }: { file: File; onConfirm: (f: File, dur: number) => void }) => {
    const trimmedFile = new File(['trimmed-wav-data'], 'reference-trimmed.wav', {
      type: 'audio/wav',
    });
    return (
      <div data-testid="audio-trimmer">
        <button data-testid="trimmer-confirm" onClick={() => onConfirm(trimmedFile, 20)}>
          Use this clip
        </button>
      </div>
    );
  },
}));

// ── getAudioDuration mock ─────────────────────────────────────────────────────
// Use an object container to avoid the TDZ issue with hoisted vi.mock.
const audioDurationContainer = { value: 20 };
vi.mock('@/lib/utils/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/audio')>();
  return {
    ...actual,
    getAudioDuration: vi.fn(() => Promise.resolve(audioDurationContainer.value)),
    formatAudioDuration: actual.formatAudioDuration,
    convertToWav: vi.fn().mockResolvedValue(new Blob(['wav'], { type: 'audio/wav' })),
  };
});

// ── useReferenceTranscript mock ───────────────────────────────────────────────
// Single module-scope mock for the whole file.
const hookArgs: Array<{ file: File | null }> = [];
vi.mock('@/lib/hooks/useReferenceTranscript', () => ({
  useReferenceTranscript: (args: { file: File | null; setText: (v: string) => void }) => {
    hookArgs.push({ file: args.file });
    // NOTE: deliberately does NOT call args.setText — the field stays user-controlled,
    // so typed reference text is never overwritten by the mock.
    return {
      status: args.file ? 'filled' : 'idle',
      isTranscribing: false,
      regeneratePrompt: false,
      retranscribe: vi.fn(),
      acceptRegenerate: vi.fn(),
      keepEdits: vi.fn(),
    };
  },
}));

// ── Hooks mocks ───────────────────────────────────────────────────────────────
const createProfileMutateAsync = vi.fn().mockResolvedValue({ id: 'new-profile-1' });
const addSampleMutateAsync = vi.fn().mockResolvedValue({});

vi.mock('@/lib/hooks/useProfiles', () => ({
  useProfile: () => ({ data: undefined }),
  useCreateProfile: () => ({ mutateAsync: createProfileMutateAsync, isPending: false }),
  useUpdateProfile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useAddSample: () => ({ mutateAsync: addSampleMutateAsync, isPending: false }),
  useDeleteProfile: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadAvatar: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteAvatar: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

vi.mock('@/lib/hooks/useSystemAudioCapture', () => ({
  useSystemAudioCapture: () => ({
    isRecording: false,
    duration: 0,
    error: null,
    isSupported: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));

vi.mock('@/lib/hooks/useAudioPlayer', () => ({
  useAudioPlayer: () => ({
    isPlaying: false,
    playPause: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

// useTranscription is still needed by useReferenceTranscript internally,
// but ProfileForm no longer calls it directly.
vi.mock('@/lib/hooks/useTranscription', () => ({
  useTranscription: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

vi.mock('@tanstack/react-query', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-query')>();
  return {
    ...actual,
    useQuery: vi.fn().mockReturnValue({ data: undefined }),
  };
});

// ── Stores mocks ──────────────────────────────────────────────────────────────
vi.mock('@/stores/uiStore', () => ({
  useUIStore: (selector: any) =>
    selector({
      profileDialogOpen: true,
      setProfileDialogOpen: vi.fn(),
      editingProfileId: null,
      setEditingProfileId: vi.fn(),
      profileFormDraft: null,
      setProfileFormDraft: vi.fn(),
    }),
}));

vi.mock('@/stores/serverStore', () => ({
  useServerStore: (selector: any) => selector({ serverUrl: 'http://localhost:8000' }),
}));

// ── Platform mock ─────────────────────────────────────────────────────────────
vi.mock('@/platform/PlatformContext', () => ({
  usePlatform: () => ({
    metadata: { isTauri: false },
  }),
}));

// ── API client mock ───────────────────────────────────────────────────────────
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    listPresetVoices: vi.fn().mockResolvedValue({ voices: [] }),
  },
}));

// ── Effects mock ──────────────────────────────────────────────────────────────
vi.mock('@/components/Effects/EffectsChainEditor', () => ({
  EffectsChainEditor: () => <div data-testid="effects-chain-editor" />,
}));

// ── Toasts mock ───────────────────────────────────────────────────────────────
vi.mock('@/components/ui/use-toast', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

// ── SampleList mock ───────────────────────────────────────────────────────────
vi.mock('@/components/VoiceProfiles/SampleList', () => ({
  SampleList: () => <div data-testid="sample-list" />,
}));

// ── AudioSample* mocks ────────────────────────────────────────────────────────
vi.mock('@/components/VoiceProfiles/AudioSampleUpload', () => ({
  AudioSampleUpload: ({
    onFileChange,
  }: {
    file: File | undefined;
    onFileChange: (f: File) => void;
    onPlayPause: () => void;
    isPlaying: boolean;
    isValidating: boolean;
    isDisabled: boolean;
    fieldName: string;
  }) => (
    <div data-testid="audio-sample-upload">
      <input
        data-testid="upload-file-input"
        type="file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFileChange(file);
        }}
      />
    </div>
  ),
}));

vi.mock('@/components/VoiceProfiles/AudioSampleRecording', () => ({
  AudioSampleRecording: () => <div data-testid="audio-sample-recording" />,
}));

vi.mock('@/components/VoiceProfiles/AudioSampleSystem', () => ({
  AudioSampleSystem: () => <div data-testid="audio-sample-system" />,
}));

import { getAudioDuration } from '@/lib/utils/audio';
import { ProfileForm } from '@/components/VoiceProfiles/ProfileForm';

beforeEach(() => {
  vi.clearAllMocks();
  hookArgs.length = 0;
  audioDurationContainer.value = 20;
  createProfileMutateAsync.mockResolvedValue({ id: 'new-profile-1' });
  addSampleMutateAsync.mockResolvedValue({});
  (getAudioDuration as ReturnType<typeof vi.fn>).mockImplementation(() =>
    Promise.resolve(audioDurationContainer.value),
  );
});

describe('ProfileForm trim flow', () => {
  it('does NOT show audioTooLong error for >30s file — shows AudioTrimmer instead', async () => {
    // Given a file that decodes to 90s (well over the old 30s cap)
    audioDurationContainer.value = 90;
    (getAudioDuration as ReturnType<typeof vi.fn>).mockResolvedValue(90);

    render(<ProfileForm />);

    // Switch to Upload tab (dialog opens in "record" mode)
    const uploadTab = screen.getByRole('tab', { name: /upload/i });
    await userEvent.click(uploadTab);

    // Upload a file via the mocked AudioSampleUpload component
    const input = screen.getByTestId('upload-file-input');
    const longFile = new File(['audio-data-long'], 'long-interview.wav', { type: 'audio/wav' });
    await userEvent.upload(input, longFile);

    // AudioTrimmer should appear
    await waitFor(() => {
      expect(screen.getByTestId('audio-trimmer')).toBeInTheDocument();
    });

    // The old audioTooLong error message should NOT be present
    expect(screen.queryByText(/too long/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/maximum duration/i)).not.toBeInTheDocument();
  });

  it('uses the trimmed file when submitting (not the original uploaded file)', async () => {
    audioDurationContainer.value = 90;
    (getAudioDuration as ReturnType<typeof vi.fn>).mockResolvedValue(90);

    render(<ProfileForm />);

    // Switch to Upload tab
    const uploadTab = screen.getByRole('tab', { name: /upload/i });
    await userEvent.click(uploadTab);

    const input = screen.getByTestId('upload-file-input');
    const originalFile = new File(['original-data'], 'interview.wav', { type: 'audio/wav' });
    await userEvent.upload(input, originalFile);

    // AudioTrimmer appears — click confirm to set the trimmed file
    const confirmBtn = await screen.findByTestId('trimmer-confirm');
    await userEvent.click(confirmBtn);

    // Fill required fields to make the form submittable
    const nameInput = screen.getByPlaceholderText(/my voice/i);
    await userEvent.type(nameInput, 'Test Voice');

    const referenceTextArea = screen.getByTestId('transcript-input');
    await userEvent.type(referenceTextArea, 'This is the reference text');

    // Submit the form
    const submitBtn = screen.getByRole('button', { name: /create profile/i });
    await userEvent.click(submitBtn);

    // The addSample call should have received the TRIMMED file (not original)
    await waitFor(() => {
      expect(addSampleMutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          file: expect.objectContaining({ name: 'reference-trimmed.wav' }),
          referenceText: 'This is the reference text',
        }),
      );
    });

    // Sanity: original file should NOT have been submitted
    const callArg = addSampleMutateAsync.mock.calls[0]?.[0];
    expect(callArg?.file?.name).not.toBe('interview.wav');
    expect(callArg?.file?.name).toBe('reference-trimmed.wav');
  });

  it('passes the trimmed file to useReferenceTranscript after confirm', async () => {
    audioDurationContainer.value = 90;
    (getAudioDuration as ReturnType<typeof vi.fn>).mockResolvedValue(90);

    render(<ProfileForm />);

    // Switch to Upload tab
    const uploadTab = screen.getByRole('tab', { name: /upload/i });
    await userEvent.click(uploadTab);

    const input = screen.getByTestId('upload-file-input');
    const originalFile = new File(['original-data'], 'interview.wav', { type: 'audio/wav' });
    await userEvent.upload(input, originalFile);

    // AudioTrimmer appears — click confirm to set the trimmed file
    const confirmBtn = await screen.findByTestId('trimmer-confirm');
    await userEvent.click(confirmBtn);

    // After confirming, the hook should have received the trimmed file
    await waitFor(() =>
      expect(hookArgs.some((a) => a.file?.name === 'reference-trimmed.wav')).toBe(true),
    );
  });
});
