import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import React from 'react';

const createProfile = vi.fn();
const addProfileSample = vi.fn();
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    createProfile: (...a: unknown[]) => createProfile(...a),
    addProfileSample: (...a: unknown[]) => addProfileSample(...a),
  },
}));

import { useCloneVoiceForCharacter } from '@/lib/hooks/useBooks';

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return React.createElement(QueryClientProvider, { client }, children);
}

const file = new File(['x'], 'clip.wav', { type: 'audio/wav' });

beforeEach(() => {
  vi.clearAllMocks();
  createProfile.mockResolvedValue({ id: 'prof-1' });
  addProfileSample.mockResolvedValue({});
});

describe('useCloneVoiceForCharacter referenceText forwarding', () => {
  it('forwards the user transcript to addProfileSample (SC5)', async () => {
    const { result } = renderHook(() => useCloneVoiceForCharacter(), { wrapper });
    await result.current.mutateAsync({
      bookId: 'b1',
      charId: 'c1',
      name: 'Hero (cloned)',
      file,
      referenceText: 'the real spoken words',
    });
    await waitFor(() =>
      expect(addProfileSample).toHaveBeenCalledWith('prof-1', file, 'the real spoken words'),
    );
  });

  it('falls back to the placeholder when referenceText is blank (SC5)', async () => {
    const { result } = renderHook(() => useCloneVoiceForCharacter(), { wrapper });
    await result.current.mutateAsync({
      bookId: 'b1',
      charId: 'c1',
      name: 'Hero (cloned)',
      file,
      referenceText: '   ',
    });
    await waitFor(() =>
      expect(addProfileSample).toHaveBeenCalledWith(
        'prof-1',
        file,
        'Reference voice sample for cloning.',
      ),
    );
  });

  it('falls back to the placeholder when referenceText is omitted (SC5)', async () => {
    const { result } = renderHook(() => useCloneVoiceForCharacter(), { wrapper });
    await result.current.mutateAsync({
      bookId: 'b1',
      charId: 'c1',
      name: 'Hero (cloned)',
      file,
    });
    await waitFor(() =>
      expect(addProfileSample).toHaveBeenCalledWith(
        'prof-1',
        file,
        'Reference voice sample for cloning.',
      ),
    );
  });
});
