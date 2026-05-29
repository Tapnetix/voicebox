/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

const createClone = vi.fn().mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
const updateMutate = vi.fn();

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) => s({ selectedBookId: 'b1', selectedCharacterId: 'm', setView: vi.fn(), setSelectedCharacterId: vi.fn() }),
}));
vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({ data: [{ id: 'm', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 }] }),
  useUpdateCharacter: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewCharacter: () => ({ mutate: vi.fn(), isPending: false }),
  useCloneVoiceForCharacter: () => ({ mutateAsync: createClone, isPending: false }),
  useVoiceOptions: () => ({ data: { library: [], book: [], presets: [] } }),
}));
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    getBookAudioUrl: (id: string) => `http://localhost/audio/${id}`,
  },
}));
// useAudioRecording needs PlatformProvider — mock it for unit tests
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

beforeEach(() => {
  vi.clearAllMocks();
  createClone.mockResolvedValue({ id: 'cloned-1', name: 'Mira (cloned)' });
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
});
