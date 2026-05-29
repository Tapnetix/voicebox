/**
 * BookOverview — post-analysis hub showing:
 *   - Book header (cover, title, status, summary stats)
 *   - Cast roster (book-wide character list with merge/delete management)
 *   - Chapter list (per-chapter word count, % dialogue, generation_state badge, Edit/Generate slots)
 *
 * Drill-in: char name → voice-editor; chapter Edit → chapter-editor.
 * Cast management (merge + delete) is wired here; split is chapter-editor only.
 * Generate / export / audio-settings are phase-D stubs — rendered but disabled.
 *
 * data-testids match wireframe-03 and are consumed by S3 (c8.spec.ts).
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  useMergeCharacter,
} from '@/lib/hooks/useBooks';
import { cn } from '@/lib/utils/cn';
import type { CharacterResponse, ChapterSummary } from '@/lib/api/types';
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

interface ChapterRowProps {
  chapter: ChapterSummary;
  index: number;
  onEdit: (id: string) => void;
}

function ChapterRow({ chapter, index, onEdit }: ChapterRowProps) {
  const { t } = useTranslation();
  const rowNum = index + 1;

  // NOTE: % dialogue column is intentionally deferred.
  // The B5 API type (ChapterSummary) has no `dialogue_pct` field — only
  // `dialogue_count` (a line count, not a word-level percentage). Rendering
  // a fake number here would be misleading. If a future B5 update adds
  // `dialogue_pct`, guard the cell as: `chapter.dialogue_pct != null && (…)`.

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
        {/* generation_state badge — from B5 rollup value, never recomputed */}
        <Badge
          variant="outline"
          className={genStateBadgeClass(chapter.generation_state)}
        >
          {chapter.generation_state}
        </Badge>
        {/* Phase-D slot: per-chapter generate button */}
        <Button
          variant="ghost"
          size="sm"
          disabled
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

  const selectedBookId = useBooksStore((s) => s.selectedBookId);
  const setView = useBooksStore((s) => s.setView);
  const setSelectedChapterId = useBooksStore((s) => s.setSelectedChapterId);
  const setSelectedCharacterId = useBooksStore((s) => s.setSelectedCharacterId);

  const { data: book, isLoading: bookLoading } = useBook(selectedBookId);
  const { data: characters = [], isLoading: charsLoading } = useCharacters(selectedBookId);

  const mergeCharacter = useMergeCharacter();
  const deleteCharacter = useDeleteCharacter();

  // Cast selection state (non-narrator ids)
  const [selectedCharIds, setSelectedCharIds] = useState<Set<string>>(new Set());
  // Delete confirm dialog
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

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
              <Button variant="outline" disabled data-testid="export-btn">
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
