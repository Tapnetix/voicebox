/// <reference types="@testing-library/jest-dom/vitest" />
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const transcribeMutateAsync = vi.fn();
vi.mock('@/lib/hooks/useTranscription', () => ({
  useTranscription: () => ({ mutateAsync: transcribeMutateAsync }),
}));

import { useReferenceTranscript } from '@/lib/hooks/useReferenceTranscript';

const fileA = new File(['a'], 'reference-trimmed.wav', { type: 'audio/wav' });
const fileB = new File(['b'], 'reference-trimmed.wav', { type: 'audio/wav' });

/** Helper: render the hook with controllable text + file via a wrapper props object. */
function setup(initial: { file: File | null; text?: string; language?: string }) {
  let text = initial.text ?? '';
  const setText = vi.fn((v: string) => {
    text = v;
  });
  const { result, rerender } = renderHook(
    (props: { file: File | null }) =>
      useReferenceTranscript({
        file: props.file,
        text,
        setText,
        language: initial.language as never,
      }),
    { initialProps: { file: initial.file } },
  );
  return {
    result,
    setText,
    getText: () => text,
    rerenderWith: (file: File | null) => rerender({ file }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  transcribeMutateAsync.mockResolvedValue({ text: 'detected words' });
});

describe('useReferenceTranscript', () => {
  it('auto-transcribes on a new confirmed file and writes the result (SC1)', async () => {
    const h = setup({ file: fileA });
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(1));
    expect(transcribeMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ file: fileA }),
    );
    await waitFor(() => expect(h.setText).toHaveBeenCalledWith('detected words'));
    await waitFor(() => expect(h.result.current.status).toBe('filled'));
  });

  it('does not auto-transcribe again and preserves edits when the user edits (S3, SC2)', async () => {
    const h = setup({ file: fileA });
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(1));
    // Simulate user edit: text diverges from the auto-filled value.
    h.setText('my hand-typed transcript');
    h.rerenderWith(fileA); // same file identity → no re-transcribe
    expect(transcribeMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.result.current.regeneratePrompt).toBe(false);
  });

  it('re-transcribes silently on a new window when unedited (S6, SC4)', async () => {
    const h = setup({ file: fileA });
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(1));
    // No edit; new file identity arrives.
    h.rerenderWith(fileB);
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(2));
    expect(h.result.current.regeneratePrompt).toBe(false);
  });

  it('raises a regenerate prompt on a new window when edited; Keep preserves, Regenerate re-transcribes (S5, SC4)', async () => {
    const h = setup({ file: fileA });
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(1));
    h.setText('my hand-typed transcript');
    h.rerenderWith(fileB); // new window WHILE edited
    await waitFor(() => expect(h.result.current.regeneratePrompt).toBe(true));
    // Keep edits: no new transcribe, prompt clears.
    act(() => h.result.current.keepEdits());
    expect(transcribeMutateAsync).toHaveBeenCalledTimes(1);
    expect(h.result.current.regeneratePrompt).toBe(false);
    // Now trigger another edited window and accept regenerate.
    h.setText('edited again');
    h.rerenderWith(fileA);
    await waitFor(() => expect(h.result.current.regeneratePrompt).toBe(true));
    act(() => h.result.current.acceptRegenerate());
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(2));
    expect(h.result.current.regeneratePrompt).toBe(false);
  });

  it('sets status failed when STT rejects (SC3)', async () => {
    transcribeMutateAsync.mockRejectedValueOnce(new Error('stt down'));
    const h = setup({ file: fileA });
    await waitFor(() => expect(h.result.current.status).toBe('failed'));
  });

  it('sets status failed when STT returns empty text (SC3)', async () => {
    transcribeMutateAsync.mockResolvedValueOnce({ text: '   ' });
    const h = setup({ file: fileA });
    await waitFor(() => expect(h.result.current.status).toBe('failed'));
  });

  it('retranscribe re-runs STT on the current file (SC6)', async () => {
    const h = setup({ file: fileA });
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(1));
    act(() => h.result.current.retranscribe());
    await waitFor(() => expect(transcribeMutateAsync).toHaveBeenCalledTimes(2));
  });
});
