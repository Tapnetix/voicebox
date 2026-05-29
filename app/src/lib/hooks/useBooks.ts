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

/** Alias for useBookCharacters — used by BookOverview and its tests. */
export function useCharacters(bookId: string | null) {
  return useBookCharacters(bookId);
}

export function useBookSegments(bookId: string | null, chapterId: string | null) {
  return useQuery({
    queryKey: bookKeys.segments(bookId ?? '', chapterId ?? ''),
    queryFn: () => apiClient.getSegments(bookId!, chapterId!),
    enabled: !!bookId && !!chapterId,
  });
}

/** Alias for useBookSegments — used by ChapterEditor and its tests. */
export function useSegments(bookId: string | null, chapterId: string | null) {
  return useBookSegments(bookId, chapterId);
}

export function useBookVoiceOptions(bookId: string | null) {
  return useQuery({
    queryKey: bookKeys.voiceOptions(bookId ?? ''),
    queryFn: () => apiClient.getVoiceOptions(bookId!),
    enabled: !!bookId,
  });
}

/** Alias for useBookVoiceOptions — used by VoiceEditor (Library tab) and its tests. */
export function useVoiceOptions(bookId: string | null) {
  return useBookVoiceOptions(bookId);
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
      // Delete reassigns segments to narrator — invalidate all chapter segments
      queryClient.invalidateQueries({
        queryKey: ['books', variables.bookId, 'chapters'],
        exact: false,
      });
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

/**
 * Preview a single segment by regenerating its audio on-the-fly (non-destructive).
 * Uses the regenerate endpoint — the caller should not overwrite the stored version.
 * The result's audio_path can be played directly; no query invalidation is needed.
 */
export function usePreviewSegment() {
  return useMutation({
    mutationFn: ({
      segmentId,
      data,
    }: {
      segmentId: string;
      data?: RegenerateSegmentRequest;
    }) => apiClient.regenerateSegment(segmentId, data),
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

// ─── Save voice to library ────────────────────────────────────────────────────

/**
 * Promotes the character's currently-assigned book voice to the global library
 * (sets is_library=true, book_id=null on the existing profile — not a copy).
 * On success invalidates voice-options for the book and the global profiles list.
 */
export function useSaveVoiceToLibrary(bookId: string | null) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (charId: string) => apiClient.saveVoiceToLibrary(charId),
    onSuccess: () => {
      // Refresh voice-options so promoted voice moves to "Your library" in Library tab
      if (bookId) {
        queryClient.invalidateQueries({
          queryKey: bookKeys.voiceOptions(bookId),
        });
      }
      // Refresh global profiles list
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
  });
}

// ─── Clone voice for character ────────────────────────────────────────────────

/**
 * Creates a cloned voice profile from an audio sample and uploads the sample.
 *
 * Flow: createProfile (voice_type: 'cloned') → addProfileSample → return profile { id, name }
 *
 * Note: the profile is NOT yet book-scoped because the backend POST /profiles
 * does not accept book_id / is_library on create. To make the clone
 * book-scoped (is_library=false, book_id=bookId) a backend change is needed.
 * The profile is assigned to the character via a separate updateCharacter call
 * (in handleAssignClone) which does set the association.
 *
 * TODO: book-scope requires create-profile to accept book_id (backend follow-up)
 */
export function useCloneVoiceForCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (vars: {
      bookId: string;
      charId: string;
      name: string;
      file: File;
    }) => {
      // bookId / charId are forwarded through `vars` so onSuccess can access
      // them via `variables.bookId` / `variables.charId` for cache invalidation
      // and future character assignment.
      //
      // NOTE: POST /profiles does not accept book_id/is_library — the profile
      // cannot be marked book-scoped at creation time.
      // TODO: book-scope requires create-profile to accept book_id (backend follow-up)

      // Step 1: create a cloned profile
      const profile = await apiClient.createProfile({
        name: vars.name,
        language: 'en',
        voice_type: 'cloned',
      });

      // Step 2: upload the sample file to the profile. The samples endpoint
      // requires a non-empty reference_text (the transcript of the sample);
      // an empty string is rejected with 422. Use a sensible default — the
      // user can refine the sample/transcript later in the profiles UI.
      await apiClient.addProfileSample(
        profile.id,
        vars.file,
        'Reference voice sample for cloning.',
      );

      return profile;
    },
    onSuccess: (_data, variables) => {
      // Invalidate book voice-options so the new clone appears in the list
      queryClient.invalidateQueries({
        queryKey: ['books', variables.bookId, 'voice-options'],
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
