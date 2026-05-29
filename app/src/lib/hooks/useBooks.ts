import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '@/lib/api/client';
import { usePlatform } from '@/platform/PlatformContext';
import type {
  BookUpdateRequest,
  CharacterMergeRequest,
  CharacterPreviewRequest,
  CharacterSplitRequest,
  CharacterUpdateRequest,
  ExportFormat,
  ExportRequest,
  GenerateBookRequest,
  GenerateChapterRequest,
  RegenerateSegmentRequest,
  SegmentMergeRequest,
  SegmentSplitRequest,
  SegmentUpdateRequest,
} from '@/lib/api/types';

// ─── Query keys ───────────────────────────────────────────────────────────────

const bookKeys = {
  list: ['books'] as const,
  detail: (bookId: string) => ['books', bookId] as const,
  characters: (bookId: string) => ['books', bookId, 'characters'] as const,
  segments: (bookId: string, chapterId: string) =>
    ['books', bookId, 'chapters', chapterId, 'segments'] as const,
  voiceOptions: (bookId: string) => ['books', bookId, 'voice-options'] as const,
  generationStatus: (bookId: string) => ['books', bookId, 'generation-status'] as const,
};

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useBooks() {
  return useQuery({
    queryKey: bookKeys.list,
    queryFn: () => apiClient.listBooks(),
  });
}

export function useBook(bookId: string | null) {
  return useQuery({
    queryKey: bookKeys.detail(bookId ?? ''),
    queryFn: () => apiClient.getBook(bookId!),
    enabled: !!bookId,
  });
}

export function useBookCharacters(bookId: string | null) {
  return useQuery({
    queryKey: bookKeys.characters(bookId ?? ''),
    queryFn: () => apiClient.getCharacters(bookId!),
    enabled: !!bookId,
  });
}

export function useBookSegments(bookId: string | null, chapterId: string | null) {
  return useQuery({
    queryKey: bookKeys.segments(bookId ?? '', chapterId ?? ''),
    queryFn: () => apiClient.getSegments(bookId!, chapterId!),
    enabled: !!bookId && !!chapterId,
  });
}

export function useBookVoiceOptions(bookId: string | null) {
  return useQuery({
    queryKey: bookKeys.voiceOptions(bookId ?? ''),
    queryFn: () => apiClient.getVoiceOptions(bookId!),
    enabled: !!bookId,
  });
}

export function useBookGenerationStatus(bookId: string | null) {
  return useQuery({
    queryKey: bookKeys.generationStatus(bookId ?? ''),
    queryFn: () => apiClient.getGenerationStatus(bookId!),
    enabled: !!bookId,
  });
}

// ─── Book mutations ───────────────────────────────────────────────────────────

export function useImportBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      file,
      opts,
    }: {
      file: File;
      opts?: { model_size?: string; narrator_voice_id?: string };
    }) => apiClient.importBook(file, opts),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookKeys.list });
    },
  });
}

export function useUpdateBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookId, data }: { bookId: string; data: BookUpdateRequest }) =>
      apiClient.updateBook(bookId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: bookKeys.list });
      queryClient.invalidateQueries({ queryKey: bookKeys.detail(variables.bookId) });
    },
  });
}

export function useDeleteBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (bookId: string) => apiClient.deleteBook(bookId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: bookKeys.list });
    },
  });
}

export function useAnalyzeBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      bookId,
      opts,
    }: {
      bookId: string;
      opts?: { model_size?: string; narrator_voice_id?: string };
    }) => apiClient.analyzeBook(bookId, opts),
    onSuccess: (_, variables) => {
      // Narrowly invalidate book detail + characters (analysis changes both)
      queryClient.invalidateQueries({ queryKey: bookKeys.detail(variables.bookId) });
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
    },
  });
}

// ─── Character mutations ──────────────────────────────────────────────────────

export function useUpdateCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      bookId,
      charId,
      data,
    }: {
      bookId: string;
      charId: string;
      data: CharacterUpdateRequest;
    }) => apiClient.updateCharacter(bookId, charId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
    },
  });
}

export function useMergeCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      bookId,
      charId,
      data,
    }: {
      bookId: string;
      charId: string;
      data: CharacterMergeRequest;
    }) => apiClient.mergeCharacter(bookId, charId, data),
    onSuccess: (_, variables) => {
      // Merge affects characters + all segments (character assignment changes)
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
      queryClient.invalidateQueries({
        queryKey: ['books', variables.bookId, 'chapters'],
        exact: false,
      });
    },
  });
}

export function useSplitCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      bookId,
      charId,
      data,
    }: {
      bookId: string;
      charId: string;
      data: CharacterSplitRequest;
    }) => apiClient.splitCharacter(bookId, charId, data),
    onSuccess: (_, variables) => {
      // Split affects characters + segments
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
      queryClient.invalidateQueries({
        queryKey: ['books', variables.bookId, 'chapters'],
        exact: false,
      });
    },
  });
}

export function useDeleteCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookId, charId }: { bookId: string; charId: string }) =>
      apiClient.deleteCharacter(bookId, charId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
    },
  });
}

// ─── Character preview ────────────────────────────────────────────────────────

export function usePreviewCharacter() {
  return useMutation({
    mutationFn: ({
      charId,
      data,
    }: {
      charId: string;
      data?: CharacterPreviewRequest;
    }) => apiClient.previewCharacter(charId, data),
  });
}

// ─── Segment mutations ────────────────────────────────────────────────────────

export function useUpdateSegment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      segmentId,
      data,
      bookId: _bookId,
      chapterId: _chapterId,
    }: {
      segmentId: string;
      data: SegmentUpdateRequest;
      bookId: string;
      chapterId: string;
    }) => apiClient.updateSegment(segmentId, data),
    onSuccess: (_, variables) => {
      // Narrowly invalidate the chapter's segments + generation-status (audio went stale)
      queryClient.invalidateQueries({
        queryKey: bookKeys.segments(variables.bookId, variables.chapterId),
      });
      queryClient.invalidateQueries({
        queryKey: bookKeys.generationStatus(variables.bookId),
      });
    },
  });
}

export function useSplitSegment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      segmentId,
      data,
      bookId: _bookId,
      chapterId: _chapterId,
    }: {
      segmentId: string;
      data: SegmentSplitRequest;
      bookId: string;
      chapterId: string;
    }) => apiClient.splitSegment(segmentId, data),
    onSuccess: (_, variables) => {
      // Split affects characters (possibly) + affected segments
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
      queryClient.invalidateQueries({
        queryKey: bookKeys.segments(variables.bookId, variables.chapterId),
      });
    },
  });
}

export function useMergeSegments() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      data,
      bookId: _bookId,
      chapterId: _chapterId,
    }: {
      data: SegmentMergeRequest;
      bookId: string;
      chapterId: string;
    }) => apiClient.mergeSegments(data),
    onSuccess: (_, variables) => {
      // Merge affects characters + segments
      queryClient.invalidateQueries({ queryKey: bookKeys.characters(variables.bookId) });
      queryClient.invalidateQueries({
        queryKey: bookKeys.segments(variables.bookId, variables.chapterId),
      });
    },
  });
}

export function useRegenerateSegment() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      segmentId,
      data,
      bookId: _bookId,
      chapterId: _chapterId,
    }: {
      segmentId: string;
      data?: RegenerateSegmentRequest;
      bookId: string;
      chapterId: string;
    }) => apiClient.regenerateSegment(segmentId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: bookKeys.segments(variables.bookId, variables.chapterId),
      });
      queryClient.invalidateQueries({
        queryKey: bookKeys.generationStatus(variables.bookId),
      });
    },
  });
}

// ─── Generation mutations ─────────────────────────────────────────────────────

export function useGenerateChapter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({
      bookId,
      chapterId,
      data,
    }: {
      bookId: string;
      chapterId: string;
      data?: GenerateChapterRequest;
    }) => apiClient.generateChapter(bookId, chapterId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: bookKeys.generationStatus(variables.bookId),
      });
    },
  });
}

export function useGenerateBook() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: ({ bookId, data }: { bookId: string; data?: GenerateBookRequest }) =>
      apiClient.generateBook(bookId, data),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({
        queryKey: bookKeys.generationStatus(variables.bookId),
      });
    },
  });
}

// ─── Export mutations ─────────────────────────────────────────────────────────

export function useStartExport() {
  return useMutation({
    mutationFn: ({ bookId, data }: { bookId: string; data: ExportRequest }) =>
      apiClient.startExport(bookId, data),
  });
}

/** Extension lookup for export formats */
const FORMAT_EXT: Record<ExportFormat, string> = {
  m4b: '.m4b',
  mp3_single: '.mp3',
  mp3_per_chapter: '.zip',
};

export function useDownloadExport() {
  const platform = usePlatform();

  return useMutation({
    mutationFn: async ({
      bookId,
      bookTitle,
      format,
    }: {
      bookId: string;
      bookTitle: string;
      format: ExportFormat;
    }) => {
      const blob = await apiClient.downloadExport(bookId);

      const safeName = bookTitle
        .substring(0, 50)
        .replace(/[^a-z0-9]/gi, '-')
        .toLowerCase();
      const ext = FORMAT_EXT[format];
      const filename = `${safeName || 'book'}${ext}`;

      await platform.filesystem.saveFile(filename, blob, [
        {
          name: 'Audio Export',
          extensions: [ext.replace('.', '')],
        },
      ]);

      return blob;
    },
  });
}
