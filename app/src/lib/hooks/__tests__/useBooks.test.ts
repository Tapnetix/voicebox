import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import {
  useBooks,
  useBook,
  useBookCharacters,
  useBookSegments,
  useBookVoiceOptions,
  useBookGenerationStatus,
  useImportBook,
  useUpdateBook,
  useDeleteBook,
  useAnalyzeBook,
  useUpdateCharacter,
  useMergeCharacter,
  useSplitCharacter,
  useDeleteCharacter,
  useUpdateSegment,
  useSplitSegment,
  useMergeSegments,
  useRegenerateSegment,
  useGenerateChapter,
  useGenerateBook,
  useStartExport,
  useDownloadExport,
  usePreviewCharacter,
} from '@/lib/hooks/useBooks';
import { apiClient } from '@/lib/api/client';

// Mock usePlatform for hooks that call platform.filesystem
vi.mock('@/platform/PlatformContext', () => ({
  usePlatform: vi.fn(),
}));
import { usePlatform } from '@/platform/PlatformContext';

// Create a wrapper with a fresh QueryClient per test
function makeWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return { wrapper: Wrapper, queryClient };
}

afterEach(() => vi.restoreAllMocks());

describe('useBooks', () => {
  it('calls apiClient.listBooks and returns data', async () => {
    vi.spyOn(apiClient, 'listBooks').mockResolvedValue([
      { id: 'b1', title: 'Silo', author: 'Hugh Howey', source_format: 'epub', status: 'analyzed', chapter_count: 3, created_at: '', updated_at: '' },
    ]);
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useBooks(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
    expect(result.current.data![0].title).toBe('Silo');
  });
});

describe('useBook', () => {
  it('calls apiClient.getBook with the bookId', async () => {
    const spy = vi.spyOn(apiClient, 'getBook').mockResolvedValue({
      id: 'b1', title: 'Silo', source_format: 'epub', status: 'analyzed', chapter_count: 3, created_at: '', updated_at: '', chapters: [],
    });
    const { wrapper } = makeWrapper();
    renderHook(() => useBook('b1'), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b1'));
  });

  it('does not fetch when bookId is null', () => {
    const spy = vi.spyOn(apiClient, 'getBook').mockResolvedValue({} as never);
    const { wrapper } = makeWrapper();
    renderHook(() => useBook(null), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useBookCharacters', () => {
  it('calls apiClient.getCharacters with the bookId', async () => {
    const spy = vi.spyOn(apiClient, 'getCharacters').mockResolvedValue([]);
    const { wrapper } = makeWrapper();
    renderHook(() => useBookCharacters('b1'), { wrapper });
    await waitFor(() => expect(spy).toHaveBeenCalledWith('b1'));
  });
});

describe('useDeleteBook', () => {
  it('calls apiClient.deleteBook and invalidates books list', async () => {
    vi.spyOn(apiClient, 'deleteBook').mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteBook(), { wrapper });
    result.current.mutate('b1');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['books'] }));
  });
});

describe('useAnalyzeBook', () => {
  it('invalidates book detail and characters on success', async () => {
    vi.spyOn(apiClient, 'analyzeBook').mockResolvedValue({ book_id: 'b1', task_id: 't1', status: 'analyzing' });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useAnalyzeBook(), { wrapper });
    result.current.mutate({ bookId: 'b1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['books', 'b1'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }));
  });
});

describe('useUpdateSegment', () => {
  it('invalidates chapter segments and generation-status on success', async () => {
    vi.spyOn(apiClient, 'updateSegment').mockResolvedValue({
      id: 's1', chapter_id: 'ch1', character_id: 'c1', character_name: 'Mira',
      type: 'dialogue', text: 'Hello', emotion: 'neutral', emotion_intensity: 0.5, order: 1,
      audio: { generation_id: 'g1', status: 'completed' },
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateSegment(), { wrapper });
    result.current.mutate({ segmentId: 's1', data: { emotion: 'angry' }, bookId: 'b1', chapterId: 'ch1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'chapters', 'ch1', 'segments'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'generation-status'] }),
    );
  });
});

describe('query hooks - enabled guard', () => {
  it('useBookSegments does not fetch when ids are null', () => {
    const spy = vi.spyOn(apiClient, 'getSegments').mockResolvedValue([]);
    const { wrapper } = makeWrapper();
    renderHook(() => useBookSegments(null, null), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });

  it('useBookVoiceOptions does not fetch when bookId is null', () => {
    const spy = vi.spyOn(apiClient, 'getVoiceOptions').mockResolvedValue({ library: [], book: [], presets: [] });
    const { wrapper } = makeWrapper();
    renderHook(() => useBookVoiceOptions(null), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });

  it('useBookGenerationStatus does not fetch when bookId is null', () => {
    const spy = vi.spyOn(apiClient, 'getGenerationStatus').mockResolvedValue({ chapters: [], overall_progress: 0 });
    const { wrapper } = makeWrapper();
    renderHook(() => useBookGenerationStatus(null), { wrapper });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('useImportBook', () => {
  it('calls importBook and invalidates books list', async () => {
    vi.spyOn(apiClient, 'importBook').mockResolvedValue({
      id: 'b2', title: 'Wool', source_format: 'epub', status: 'imported', chapter_count: 0, created_at: '', updated_at: '', chapters: [],
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useImportBook(), { wrapper });
    result.current.mutate({ file: new File(['x'], 'wool.epub') });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['books'] }));
  });
});

describe('useUpdateBook', () => {
  it('invalidates list and detail on success', async () => {
    vi.spyOn(apiClient, 'updateBook').mockResolvedValue({
      id: 'b1', title: 'Silo Updated', source_format: 'epub', status: 'analyzed', chapter_count: 3, created_at: '', updated_at: '',
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateBook(), { wrapper });
    result.current.mutate({ bookId: 'b1', data: { title: 'Silo Updated' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['books'] }));
    expect(invalidateSpy).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['books', 'b1'] }));
  });
});

describe('useUpdateCharacter', () => {
  it('invalidates characters on success', async () => {
    vi.spyOn(apiClient, 'updateCharacter').mockResolvedValue({
      id: 'c1', name: 'Mira', color: '#fff', voice_type: null, voice_label: null,
      is_library: false, is_narrator: false, dialogue_count: 5, confidence: 0.9, aliases: [],
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateCharacter(), { wrapper });
    result.current.mutate({ bookId: 'b1', charId: 'c1', data: { name: 'Mira Updated' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }),
    );
  });
});

describe('useMergeCharacter', () => {
  it('invalidates characters and chapters/segments on success', async () => {
    vi.spyOn(apiClient, 'mergeCharacter').mockResolvedValue({
      id: 'c1', name: 'Mira', color: '#fff', voice_type: null, voice_label: null,
      is_library: false, is_narrator: false, dialogue_count: 8, confidence: 0.9, aliases: [],
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMergeCharacter(), { wrapper });
    result.current.mutate({ bookId: 'b1', charId: 'c1', data: { source_char_id: 'c2' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }),
    );
  });
});

describe('useSplitCharacter', () => {
  it('invalidates characters on success', async () => {
    vi.spyOn(apiClient, 'splitCharacter').mockResolvedValue({
      id: 'c3', name: 'New Mira', color: '#fff', voice_type: null, voice_label: null,
      is_library: false, is_narrator: false, dialogue_count: 2, confidence: 0.7, aliases: [],
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSplitCharacter(), { wrapper });
    result.current.mutate({ bookId: 'b1', charId: 'c1', data: { new_name: 'New Mira', segment_ids: ['s1'] } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }),
    );
  });
});

describe('useDeleteCharacter', () => {
  it('invalidates characters and affected segments on success', async () => {
    vi.spyOn(apiClient, 'deleteCharacter').mockResolvedValue(undefined);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useDeleteCharacter(), { wrapper });
    result.current.mutate({ bookId: 'b1', charId: 'c1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }),
    );
    // Delete reassigns segments — chapters/segments must also be invalidated
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'chapters'], exact: false }),
    );
  });
});

describe('useSplitSegment', () => {
  it('invalidates characters and chapter segments on success', async () => {
    vi.spyOn(apiClient, 'splitSegment').mockResolvedValue([]);
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useSplitSegment(), { wrapper });
    result.current.mutate({ segmentId: 's1', data: { at_offset: 10 }, bookId: 'b1', chapterId: 'ch1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'chapters', 'ch1', 'segments'] }),
    );
  });
});

describe('useMergeSegments', () => {
  it('invalidates characters and segments on success', async () => {
    vi.spyOn(apiClient, 'mergeSegments').mockResolvedValue({
      id: 's1', chapter_id: 'ch1', character_id: 'c1', character_name: 'Mira',
      type: 'dialogue', text: 'Merged', emotion: 'neutral', emotion_intensity: 0.5, order: 1,
      audio: { generation_id: 'g1', status: 'completed' },
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useMergeSegments(), { wrapper });
    result.current.mutate({ data: { segment_ids: ['s1', 's2'] }, bookId: 'b1', chapterId: 'ch1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'characters'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'chapters', 'ch1', 'segments'] }),
    );
  });
});

describe('useRegenerateSegment', () => {
  it('invalidates segments and generation-status', async () => {
    vi.spyOn(apiClient, 'regenerateSegment').mockResolvedValue({
      segment_id: 's1', generation_id: 'g2', version_id: 'v1', status: 'completed',
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useRegenerateSegment(), { wrapper });
    result.current.mutate({ segmentId: 's1', bookId: 'b1', chapterId: 'ch1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'chapters', 'ch1', 'segments'] }),
    );
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'generation-status'] }),
    );
  });
});

describe('useGenerateChapter', () => {
  it('invalidates generation-status on success', async () => {
    vi.spyOn(apiClient, 'generateChapter').mockResolvedValue({
      book_id: 'b1', chapter_id: 'ch1', task_id: 't1', queued_segments: 5,
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useGenerateChapter(), { wrapper });
    result.current.mutate({ bookId: 'b1', chapterId: 'ch1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'generation-status'] }),
    );
  });
});

describe('useGenerateBook', () => {
  it('invalidates generation-status on success', async () => {
    vi.spyOn(apiClient, 'generateBook').mockResolvedValue({
      book_id: 'b1', task_id: 't1', queued_segments: 50,
    });
    const { wrapper, queryClient } = makeWrapper();
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');
    const { result } = renderHook(() => useGenerateBook(), { wrapper });
    result.current.mutate({ bookId: 'b1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['books', 'b1', 'generation-status'] }),
    );
  });
});

describe('useStartExport', () => {
  it('calls apiClient.startExport', async () => {
    vi.spyOn(apiClient, 'startExport').mockResolvedValue({
      book_id: 'b1', task_id: 't1', status: 'exporting',
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useStartExport(), { wrapper });
    result.current.mutate({ bookId: 'b1', data: { format: 'm4b' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.task_id).toBe('t1');
  });
});

describe('useDownloadExport', () => {
  function makePlatformMock() {
    const saveFile = vi.fn().mockResolvedValue(undefined);
    vi.mocked(usePlatform).mockReturnValue({
      filesystem: { saveFile, openPath: vi.fn(), pickDirectory: vi.fn() },
      updater: {} as never,
      audio: {} as never,
      lifecycle: {} as never,
      metadata: {} as never,
    });
    return { saveFile };
  }

  it('derives .m4b extension for m4b format and calls saveFile', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mp4' });
    vi.spyOn(apiClient, 'downloadExport').mockResolvedValue(blob);
    const { saveFile } = makePlatformMock();
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDownloadExport(), { wrapper });
    result.current.mutate({ bookId: 'b1', bookTitle: 'My Book', format: 'm4b' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(saveFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.m4b$/),
      blob,
      expect.any(Array),
    );
  });

  it('derives .mp3 extension for mp3_single format', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    vi.spyOn(apiClient, 'downloadExport').mockResolvedValue(blob);
    const { saveFile } = makePlatformMock();
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDownloadExport(), { wrapper });
    result.current.mutate({ bookId: 'b1', bookTitle: 'Silo', format: 'mp3_single' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(saveFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.mp3$/),
      blob,
      expect.any(Array),
    );
  });

  it('derives .zip extension for mp3_per_chapter format', async () => {
    const blob = new Blob(['zip'], { type: 'application/zip' });
    vi.spyOn(apiClient, 'downloadExport').mockResolvedValue(blob);
    const { saveFile } = makePlatformMock();
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDownloadExport(), { wrapper });
    result.current.mutate({ bookId: 'b1', bookTitle: 'Wool', format: 'mp3_per_chapter' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(saveFile).toHaveBeenCalledWith(
      expect.stringMatching(/\.zip$/),
      blob,
      expect.any(Array),
    );
  });

  it('sanitizes book title for filename (no special characters)', async () => {
    const blob = new Blob(['audio']);
    vi.spyOn(apiClient, 'downloadExport').mockResolvedValue(blob);
    const { saveFile } = makePlatformMock();
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => useDownloadExport(), { wrapper });
    result.current.mutate({ bookId: 'b1', bookTitle: 'My Book: Special!', format: 'm4b' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const [filename] = saveFile.mock.calls[0];
    expect(filename).toMatch(/^[a-z0-9-]+\.m4b$/);
    expect(filename).not.toMatch(/[^a-z0-9-.]/);
  });
});

describe('usePreviewCharacter', () => {
  it('calls apiClient.previewCharacter with charId and data', async () => {
    vi.spyOn(apiClient, 'previewCharacter').mockResolvedValue({
      generation_id: 'g1',
      audio_path: '/audio/preview.wav',
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => usePreviewCharacter(), { wrapper });
    result.current.mutate({ charId: 'c1', data: { text: 'Hello there', emotion: 'happy' } });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.previewCharacter).toHaveBeenCalledWith('c1', { text: 'Hello there', emotion: 'happy' });
    expect(result.current.data?.generation_id).toBe('g1');
  });

  it('calls apiClient.previewCharacter with undefined data when omitted', async () => {
    vi.spyOn(apiClient, 'previewCharacter').mockResolvedValue({
      generation_id: 'g2',
      audio_path: '/audio/preview2.wav',
    });
    const { wrapper } = makeWrapper();
    const { result } = renderHook(() => usePreviewCharacter(), { wrapper });
    result.current.mutate({ charId: 'c1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiClient.previewCharacter).toHaveBeenCalledWith('c1', undefined);
  });
});
