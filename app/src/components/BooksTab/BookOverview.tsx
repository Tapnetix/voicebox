/**
 * BookOverview — post-analysis hub showing:
 *   - Book header (cover, title, status, summary stats)
 *   - Cast roster (book-wide character list with merge/delete management)
 *   - Chapter list (per-chapter word count, % dialogue, generation_state badge, Edit/Generate slots)
 *
 * Drill-in: char name → voice-editor; chapter Edit → chapter-editor.
 * Cast management (merge + delete) is wired here; split is chapter-editor only.
 * Generate button wired in D2: calls chapter-generate endpoint + streams progress via SSE.
 *
 * data-testids match wireframe-03 and are consumed by S3 (c8.spec.ts) and S8 (d2.spec.ts).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  useBook,
  useCharacters,
  useDeleteCharacter,
  useGenerateChapter,
  useMergeCharacter,
} from '@/lib/hooks/useBooks';
import { useBookProgress } from '@/lib/hooks/useBookProgress';
import { cn } from '@/lib/utils/cn';
import type {
  CharacterResponse,
  ChapterSummary,
  GenerationProgressEvent,
  GenerationCompleteEvent,
} from '@/lib/api/types';
import { useBooksStore } from '@/stores/booksStore';
import { toast } from '@/components/ui/use-toast';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format large numbers with locale-appropriate separators (3,410 / 4.002) */
function fmtNumber(n: number): string {
  return n.toLocaleString();
}

/** Estimate runtime in hours+minutes assuming ~150 wpm narration */
function estimateRuntime(totalWords: number): { h: number; m: number } {
  const minutes = Math.round(totalWords / 150);
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}

/** Derive confidence label from numeric score */
function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

/** Badge variant for generation state */
function genStateBadgeClass(state: string): string {
  switch (state) {
    case 'done':
      return 'border-green-700 text-green-400';
    case 'generating':
      return 'border-yellow-600 text-yellow-400';
    case 'error':
      return 'border-red-600 text-red-400';
    default:
      return '';
  }
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface CharCardProps {
  char: CharacterResponse;
  selected: boolean;
  onToggle: (id: string) => void;
  onDrillIn: (id: string) => void;
}

function CharCard({ char, selected, onToggle, onDrillIn }: CharCardProps) {
  const { t } = useTranslation();
  const confLabel = confidenceLabel(char.confidence);

  return (
    <div
      data-testid={`char-card-${char.id}`}
      className="flex items-start gap-2 py-2 px-1 rounded hover:bg-accent/40 transition-colors"
    >
      {/* Checkbox — narrator is never selectable */}
      {!char.is_narrator && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(char.id)}
          className="mt-0.5 shrink-0"
        />
      )}
      {/* Color dot */}
      <span
        className="w-3 h-3 rounded-full shrink-0 mt-1"
        style={{ background: char.color }}
        aria-hidden
      />
      {/* Name + badges */}
      <div className="flex-1 min-w-0">
        {/* Clickable name → voice-editor */}
        <button
          data-testid={`char-link-${char.id}`}
          className="text-sm font-medium hover:underline text-left"
          onClick={() => onDrillIn(char.id)}
          type="button"
        >
          {char.name}
        </button>
        <div className="flex flex-wrap gap-1 mt-0.5">
          {char.is_narrator && <Badge variant="secondary">narration</Badge>}
          {char.role && !char.is_narrator && (
            <Badge variant="secondary">{char.role}</Badge>
          )}
          {char.voice_type && (
            <Badge variant="outline">
              {char.voice_type === 'designed' ? '🎙 designed' : char.voice_type}
            </Badge>
          )}
          {!char.is_narrator && char.dialogue_count > 0 && (
            <Badge variant="outline">{char.dialogue_count} lines</Badge>
          )}
          {!char.is_narrator && (
            <Badge
              variant="outline"
              className={cn(
                confLabel === 'high' && 'border-green-700 text-green-400',
                confLabel === 'medium' && 'border-yellow-600 text-yellow-400',
                confLabel === 'low' && 'border-red-600 text-red-400',
              )}
            >
              {t(`books.overview.confidence.${confLabel}`)}
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}

/** Per-chapter progress state derived from SSE events. */
interface ChapterProgress {
  /** 'generating' while in-flight; 'done' when complete; undefined otherwise. */
  status?: 'generating' | 'done';
  completed: number;
  total: number;
  errors: number;
}

interface ChapterRowProps {
  chapter: ChapterSummary;
  index: number;
  onEdit: (id: string) => void;
  onGenerate: (chapterId: string) => void;
  progress?: ChapterProgress;
  isGenerating?: boolean;
}

function ChapterRow({ chapter, index, onEdit, onGenerate, progress, isGenerating }: ChapterRowProps) {
  const { t } = useTranslation();
  const rowNum = index + 1;

  // NOTE: % dialogue column is intentionally deferred.
  // The B5 API type (ChapterSummary) has no `dialogue_pct` field — only
  // `dialogue_count` (a line count, not a word-level percentage). Rendering
  // a fake number here would be misleading. If a future B5 update adds
  // `dialogue_pct`, guard the cell as: `chapter.dialogue_pct != null && (…)`.

  // Derive the effective badge state:
  // - SSE 'done' overrides stored generation_state → show 'done'
  // - SSE 'generating' progress → show 'generating n/m'
  // - Otherwise fall back to stored generation_state
  const effectiveBadgeState =
    progress?.status === 'done' ? 'done' :
    progress?.status === 'generating' ? 'generating' :
    chapter.generation_state;

  // Badge label including progress counts while in-flight
  const badgeLabel =
    progress?.status === 'generating'
      ? `generating ${progress.completed}/${progress.total}`
      : effectiveBadgeState;

  // Playable indicator: show play control when done
  const isDone = effectiveBadgeState === 'done' || chapter.generation_state === 'ready';

  // Show retry affordance when errors exist (non-crash)
  const hasErrors = (progress?.errors ?? 0) > 0;

  return (
    <div className="flex items-center justify-between py-2 px-1 rounded hover:bg-accent/40 transition-colors">
      <div>
        <div className="font-medium text-sm">
          {chapter.number} · {chapter.title}
        </div>
        <div className="text-xs text-muted-foreground">
          {fmtNumber(chapter.word_count)} words
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        {/* generation_state badge — SSE-updated or from B5 rollup */}
        <Badge
          variant="outline"
          className={genStateBadgeClass(effectiveBadgeState)}
        >
          {badgeLabel}
        </Badge>
        {/* Play control: shown when chapter is playable (done/ready) */}
        {isDone && (
          <span
            aria-label={`play-chapter-${rowNum}`}
            className="text-green-400 text-sm select-none"
          >
            ▶
          </span>
        )}
        {/* Retry affordance on errors — non-crash indicator */}
        {hasErrors && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onGenerate(chapter.id)}
            data-testid={`retry-chapter-${rowNum}`}
            className="text-red-400"
          >
            {t('books.overview.retryChapter', { defaultValue: 'Retry' })}
          </Button>
        )}
        {/* Generate button — disabled while this chapter is in-flight */}
        <Button
          variant="ghost"
          size="sm"
          disabled={isGenerating}
          onClick={() => onGenerate(chapter.id)}
          data-testid={`generate-chapter-${rowNum}`}
        >
          {t('books.overview.generateChapter')}
        </Button>
        {/* Edit → chapter-editor drill-in */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onEdit(chapter.id)}
          data-testid={`edit-chapter-${chapter.id}`}
        >
          {t('books.overview.editChapter')}
        </Button>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function BookOverview() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const selectedBookId = useBooksStore((s) => s.selectedBookId);
  const setView = useBooksStore((s) => s.setView);
  const setSelectedChapterId = useBooksStore((s) => s.setSelectedChapterId);
  const setSelectedCharacterId = useBooksStore((s) => s.setSelectedCharacterId);

  const { data: book, isLoading: bookLoading } = useBook(selectedBookId);
  const { data: characters = [], isLoading: charsLoading } = useCharacters(selectedBookId);

  const mergeCharacter = useMergeCharacter();
  const deleteCharacter = useDeleteCharacter();
  const generateChapter = useGenerateChapter();

  // Cast selection state (non-narrator ids)
  const [selectedCharIds, setSelectedCharIds] = useState<Set<string>>(new Set());
  // Delete confirm dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  // Per-chapter progress from SSE events: chapterId → ChapterProgress
  const [chapterProgress, setChapterProgress] = useState<Record<string, ChapterProgress>>({});
  // Set of chapter IDs currently being generated (for disabling the button)
  const [generatingChapterIds, setGeneratingChapterIds] = useState<Set<string>>(new Set());

  // ── Subscribe to per-book SSE for generation events ──────────────────────
  useBookProgress(selectedBookId ?? '', {
    onGenerationProgress: (event: GenerationProgressEvent) => {
      const { chapter_id, completed, errors, total, overall_progress } = event;
      setChapterProgress((prev) => ({
        ...prev,
        [chapter_id]: { status: 'generating', completed, errors, total },
      }));
      // overall_progress available if callers need it in future
      void overall_progress;
    },
    onGenerationComplete: (event: GenerationCompleteEvent) => {
      const chapter_id = event.chapter_id;
      if (!chapter_id) return;
      // Flip row to 'done' playable state
      setChapterProgress((prev) => ({
        ...prev,
        [chapter_id]: { ...(prev[chapter_id] ?? { completed: 0, errors: 0, total: 0 }), status: 'done' },
      }));
      // Remove from in-flight set
      setGeneratingChapterIds((prev) => {
        const next = new Set(prev);
        next.delete(chapter_id);
        return next;
      });
      // Invalidate queries so book status + generation-status refresh
      if (selectedBookId) {
        queryClient.invalidateQueries({ queryKey: ['books', selectedBookId, 'generation-status'] });
        queryClient.invalidateQueries({ queryKey: ['books', selectedBookId] });
      }
    },
  });

  // ── Derived summary ──────────────────────────────────────────────────────
  const chapters = book?.chapters ?? [];
  const totalWords = chapters.reduce((acc, c) => acc + (c.word_count ?? 0), 0);
  const runtime = estimateRuntime(totalWords);
  const chapterCount = chapters.length;
  const characterCount = characters.length;

  // ── Handlers ─────────────────────────────────────────────────────────────

  function handleToggleChar(id: string) {
    setSelectedCharIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  function handleDrillInChar(id: string) {
    setSelectedCharacterId(id);
    setView('voice-editor');
  }

  function handleEditChapter(id: string) {
    setSelectedChapterId(id);
    setView('chapter-editor');
  }

  async function handleGenerateChapter(chapterId: string) {
    if (!selectedBookId) return;
    // Mark as in-flight to disable the button
    setGeneratingChapterIds((prev) => new Set([...prev, chapterId]));
    try {
      await generateChapter.mutateAsync({ bookId: selectedBookId, chapterId });
    } catch (err: unknown) {
      // Surface 409 gracefully — book already generating.
      // apiClient throws plain Error with message like "HTTP error! status: 409",
      // so we parse the status code out of the message text.
      const message = err instanceof Error ? err.message : String(err);
      const statusMatch = message.match(/status:\s*(\d+)/);
      const status = statusMatch ? parseInt(statusMatch[1], 10) : undefined;
      if (status === 409) {
        toast({
          title: t('books.overview.toast.alreadyGenerating', { defaultValue: 'Already generating' }),
          description: t('books.overview.toast.alreadyGeneratingDesc', {
            defaultValue: 'This book is already being generated. Please wait.',
          }),
          variant: 'destructive',
        });
      } else {
        toast({
          title: t('books.overview.toast.generateFailed', { defaultValue: 'Generate failed' }),
          description: message,
          variant: 'destructive',
        });
      }
      // On error, remove from in-flight so button re-enables
      setGeneratingChapterIds((prev) => {
        const next = new Set(prev);
        next.delete(chapterId);
        return next;
      });
    }
  }

  async function handleMerge() {
    if (!selectedBookId || selectedCharIds.size < 2) return;
    const [survivor, ...sources] = Array.from(selectedCharIds);
    try {
      for (const sourceId of sources) {
        await mergeCharacter.mutateAsync({
          bookId: selectedBookId,
          charId: survivor,
          data: { source_char_id: sourceId },
        });
      }
      setSelectedCharIds(new Set());
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('books.overview.toast.mergeFailed');
      toast({
        title: t('books.overview.toast.mergeFailed'),
        description: message,
        variant: 'destructive',
      });
    }
  }

  function handleDeleteClick() {
    if (selectedCharIds.size !== 1) return;
    setDeleteDialogOpen(true);
  }

  async function handleDeleteConfirm() {
    if (!selectedBookId || selectedCharIds.size !== 1) return;
    const [charId] = Array.from(selectedCharIds);
    try {
      await deleteCharacter.mutateAsync({ bookId: selectedBookId, charId });
      setSelectedCharIds(new Set());
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : t('books.overview.toast.deleteFailed');
      toast({
        title: t('books.overview.toast.deleteFailed'),
        description: message,
        variant: 'destructive',
      });
    }
    setDeleteDialogOpen(false);
  }

  // ── Loading ───────────────────────────────────────────────────────────────

  if (bookLoading || charsLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  if (!book) {
    return null;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col gap-4">
      {/* ── Book header ────────────────────────────────────────────────── */}
      <Card data-testid="book-header">
        <CardContent className="p-4">
          <div className="flex items-start gap-4">
            {/* Cover placeholder */}
            <div
              className="w-[72px] h-[104px] rounded-md shrink-0 bg-muted border border-border"
              aria-hidden
            />
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <h1 className="text-2xl font-bold truncate">{book.title}</h1>
                <Badge
                  data-testid="book-status"
                  variant="default"
                  className="shrink-0"
                >
                  {t(`books.status.${book.status}`, { defaultValue: book.status })}
                </Badge>
              </div>
              {book.author && (
                <div className="text-sm text-muted-foreground mt-0.5">
                  {book.author} · {book.source_format?.toUpperCase()}
                </div>
              )}
              <div className="flex flex-wrap gap-1.5 mt-2" data-testid="book-summary">
                <Badge variant="secondary">
                  {t('books.overview.summary.chapters', {
                    count: chapterCount,
                    defaultValue: `${chapterCount} chapters`,
                  })}
                </Badge>
                <Badge variant="secondary">
                  {t('books.overview.summary.characters', {
                    count: characterCount,
                    defaultValue: `${characterCount} characters`,
                  })}
                </Badge>
                {runtime.h > 0 || runtime.m > 0 ? (
                  <Badge variant="secondary">
                    {t('books.overview.summary.runtime', {
                      h: runtime.h,
                      m: runtime.m,
                      defaultValue: `est. ${runtime.h}h ${runtime.m}m`,
                    })}
                  </Badge>
                ) : null}
              </div>
            </div>
            {/* Phase-D action slots */}
            <div className="flex flex-col items-end gap-1.5 shrink-0">
              <Button disabled data-testid="generate-all-btn">
                {t('books.overview.generateAll')}
              </Button>
              <Button
                variant="outline"
                data-testid="export-btn"
                onClick={() => setView('export')}
              >
                {t('books.overview.export')}
              </Button>
              <Button variant="ghost" disabled data-testid="audio-settings-btn">
                {t('books.overview.audioSettings')} ▾
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Two-column layout: cast + chapters ─────────────────────────── */}
      <div className="flex gap-4 items-start">
        {/* Cast panel */}
        <Card className="flex-1" data-testid="cast-summary">
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-lg font-semibold">{t('books.overview.cast')}</h2>
              <div className="flex gap-1.5" data-testid="cast-actions">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="merge-btn"
                  disabled={selectedCharIds.size < 2}
                  onClick={handleMerge}
                >
                  {t('books.overview.merge')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="delete-btn"
                  disabled={selectedCharIds.size !== 1}
                  onClick={handleDeleteClick}
                >
                  {t('books.overview.delete')}
                </Button>
              </div>
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              {t('books.overview.castHint')}
            </p>
            <div className="flex flex-col" data-testid="cast-roster">
              {characters.map((char) => (
                <CharCard
                  key={char.id}
                  char={char}
                  selected={selectedCharIds.has(char.id)}
                  onToggle={handleToggleChar}
                  onDrillIn={handleDrillInChar}
                />
              ))}
            </div>
          </CardContent>
        </Card>

        {/* Chapter list panel */}
        <Card className="flex-[1.3]" data-testid="chapter-list">
          <CardContent className="p-4">
            <h2 className="text-lg font-semibold mb-3">
              {t('books.overview.chapters')}
            </h2>
            <div className="flex flex-col">
              {chapters.map((chapter, index) => (
                <ChapterRow
                  key={chapter.id}
                  chapter={chapter}
                  index={index}
                  onEdit={handleEditChapter}
                  onGenerate={handleGenerateChapter}
                  progress={chapterProgress[chapter.id]}
                  isGenerating={generatingChapterIds.has(chapter.id)}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* ── Delete character confirm dialog ────────────────────────────── */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('books.overview.deleteDialog.title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('books.overview.deleteDialog.description')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('books.overview.deleteDialog.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
