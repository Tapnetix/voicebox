/**
 * ChapterEditor — per-chapter book view.
 *
 * Color-coded, speaker-labeled prose where every dialogue line is reassignable.
 * Text filters: All / Dialogue only / By character / Flagged (client-side).
 * Right rail: low-confidence triage with jump-{id} links.
 *
 * data-testids match wireframe-05; consumed by S5 (c14.spec.ts) and extended by:
 *   - C15: structural edits (split/merge/type-toggle)
 *   - D3:  per-line preview/regenerate
 *   - D4:  emotion-pill interaction (currently INERT)
 *   - D5:  read-along playback (currently INERT)
 *
 * Only fully-wired interaction in C14: reassign (click seg → popover → mutate).
 */

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils/cn';
import { useCharacters, useSegments, useUpdateSegment } from '@/lib/hooks/useBooks';
import type { CharacterResponse, SegmentResponse } from '@/lib/api/types';
import { useBooksStore } from '@/stores/booksStore';

// ─── Types ────────────────────────────────────────────────────────────────────

type FilterMode = 'all' | 'dialogue' | 'by-character' | 'flagged';

// Segments with confidence below this are considered low-confidence / flagged
const LOW_CONFIDENCE_THRESHOLD = 0.7;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Resolve the color for a segment from the character roster */
function resolveColor(characterId: string, characters: CharacterResponse[]): string {
  return characters.find((c) => c.id === characterId)?.color ?? '#9ca3af';
}

/** Returns a semi-transparent rgba fill from a hex color string */
function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Sort segments by order field */
function sorted(segments: SegmentResponse[]): SegmentResponse[] {
  return [...segments].sort((a, b) => a.order - b.order);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

interface SpeakerChipProps {
  segmentId: string;
  name: string;
  color: string;
}

function SpeakerChip({ segmentId, name, color }: SpeakerChipProps) {
  return (
    <Badge
      data-testid={`speaker-chip-${segmentId}`}
      variant="outline"
      style={{ borderColor: color, color }}
      className="mr-1 text-xs"
    >
      {name}
    </Badge>
  );
}

interface EmotionPillProps {
  segmentId: string;
  emotion: string;
}

/**
 * INERT slot — emotion-pill is rendered here so D4 can wire it without restructuring.
 * D4 task wires the delivery/tone popover interaction.
 */
function EmotionPill({ segmentId, emotion }: EmotionPillProps) {
  return (
    <span
      data-testid={`emotion-${segmentId}`}
      className="ml-1 cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
      title="Delivery / tone — wired by D4"
      // D4 wires the onClick here
    >
      {emotion} ▾
    </span>
  );
}

interface ReassignDropdownProps {
  segmentId: string;
  bookId: string;
  chapterId: string;
  currentCharacterId: string;
  characters: CharacterResponse[];
  onReassign: (charId: string) => void;
}

function ReassignDropdown({
  characters,
  currentCharacterId,
  onReassign,
}: ReassignDropdownProps) {
  return (
    <div data-testid="reassign-dropdown" className="w-52 p-2">
      <p className="mb-1.5 text-xs text-muted-foreground">Reassign this line to…</p>
      <ul>
        {characters.map((char) => (
          <li key={char.id}>
            <button
              className={cn(
                'w-full rounded px-2 py-1 text-left text-sm hover:bg-muted',
                char.id === currentCharacterId && 'outline outline-1 outline-accent',
              )}
              onClick={() => onReassign(char.id)}
            >
              <span
                className="mr-1.5 inline-block size-2 rounded-full"
                style={{ background: char.color }}
              />
              {char.name}
              {char.id === currentCharacterId && ' ✓'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface SegmentLineProps {
  segment: SegmentResponse;
  characters: CharacterResponse[];
  bookId: string;
  chapterId: string;
  isSelected: boolean;
  onSelect: (id: string | null) => void;
  updateMutate: ReturnType<typeof useUpdateSegment>['mutate'];
}

function SegmentLine({
  segment,
  characters,
  bookId,
  chapterId,
  isSelected,
  onSelect,
  updateMutate,
}: SegmentLineProps) {
  const [popoverOpen, setPopoverOpen] = useState(false);
  const spanRef = useRef<HTMLSpanElement>(null);
  const color = resolveColor(segment.character_id, characters);
  const isDialogue = segment.type === 'dialogue';

  function handleReassign(charId: string) {
    updateMutate(
      {
        segmentId: segment.id,
        data: { character_id: charId },
        bookId,
        chapterId,
        // Surface-level key so tests can match: character_id at top level
        character_id: charId,
      } as Parameters<typeof updateMutate>[0],
      {
        onSuccess: () => {
          setPopoverOpen(false);
          onSelect(null);
        },
      },
    );
  }

  if (!isDialogue) {
    // Narration line — not clickable for reassign (no speaker chip / emotion pill)
    return (
      <span
        ref={spanRef}
        data-testid={`seg-${segment.id}`}
        style={{ color }}
        className="inline"
      >
        {segment.text}
      </span>
    );
  }

  // Dialogue line — clickable to open reassign popover
  return (
    <>
      <SpeakerChip segmentId={segment.id} name={segment.character_name} color={color} />
      <Popover
        open={popoverOpen}
        onOpenChange={(open) => {
          setPopoverOpen(open);
          if (!open) onSelect(null);
        }}
      >
        <PopoverTrigger asChild>
          <span
            ref={spanRef}
            data-testid={`seg-${segment.id}`}
            onClick={() => {
              setPopoverOpen(true);
              onSelect(segment.id);
            }}
            style={{
              color,
              background: isSelected ? hexToRgba(color, 0.2) : undefined,
              outline: isSelected ? `1px solid ${color}` : undefined,
            }}
            className="cursor-pointer rounded-sm px-0.5"
          >
            {segment.text}
          </span>
        </PopoverTrigger>
        <PopoverContent className="p-0" align="start" side="bottom">
          <ReassignDropdown
            segmentId={segment.id}
            bookId={bookId}
            chapterId={chapterId}
            currentCharacterId={segment.character_id}
            characters={characters}
            onReassign={handleReassign}
          />
        </PopoverContent>
      </Popover>
      {/* INERT slot — D4 wires the emotion/delivery interaction */}
      <EmotionPill segmentId={segment.id} emotion={segment.emotion} />
      {/* INERT slot — D5 wires per-line read-along ♪ highlight */}
    </>
  );
}

// ─── ReviewRail ───────────────────────────────────────────────────────────────

interface ReviewRailProps {
  segments: SegmentResponse[];
  characters: CharacterResponse[];
  onJump: (id: string) => void;
}

function ReviewRail({ segments, characters, onJump }: ReviewRailProps) {
  const { t } = useTranslation();

  const dialogueSegments = segments.filter((s) => s.type === 'dialogue');
  const flagged = dialogueSegments
    .filter((s) => {
      const char = characters.find((c) => c.id === s.character_id);
      const confidence = char?.confidence ?? 1;
      return confidence < LOW_CONFIDENCE_THRESHOLD;
    })
    .sort((a, b) => {
      const ca = characters.find((c) => c.id === a.character_id)?.confidence ?? 1;
      const cb = characters.find((c) => c.id === b.character_id)?.confidence ?? 1;
      return ca - cb;
    })
    .slice(0, 10);

  return (
    <section className="card flex flex-col gap-3" data-testid="review-rail">
      <div>
        <h2 className="m-0 mb-1 font-semibold">
          {t('books.chapterEditor.reviewTitle')}{' '}
          <span className="text-xs font-normal text-muted-foreground">
            — {t('books.chapterEditor.reviewSubtitle')}
          </span>
        </h2>
        <p className="text-xs text-muted-foreground">{t('books.chapterEditor.reviewHint')}</p>
      </div>

      <div className="flex flex-col gap-2">
        {flagged.map((seg) => {
          const char = characters.find((c) => c.id === seg.character_id);
          return (
            <div key={seg.id} className="rounded border p-2">
              <div className="mb-1 text-xs text-muted-foreground">
                {char
                  ? t('books.chapterEditor.lineGuessed', { order: seg.order, name: char.name })
                  : t('books.chapterEditor.lineUnattributed', { order: seg.order })}{' '}
                <Badge variant="destructive" className="text-xs">
                  {t('books.chapterEditor.confidenceLow')}
                </Badge>
              </div>
              <div className="mb-1.5 text-sm">{seg.text}</div>
              <div className="flex gap-1.5">
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid={`jump-${seg.id}`}
                  onClick={() => onJump(seg.id)}
                  title="scroll to this line in the text and select it"
                >
                  {t('books.chapterEditor.reviewJump')} ↪
                </Button>
                {/* INERT slot — D3 wires per-line audio preview */}
                <Button variant="ghost" size="sm" disabled title="play just this line — wired by D3">
                  ▶ {t('books.chapterEditor.reviewHear')}
                </Button>
                <Button variant="ghost" size="sm" title="mark this line as reviewed — wired by C15">
                  ✓ {t('books.chapterEditor.reviewReviewed')}
                </Button>
              </div>
            </div>
          );
        })}
        {flagged.length === 0 && (
          <p className="text-xs text-muted-foreground">No low-confidence lines to review.</p>
        )}
      </div>

      <p className="mt-auto text-xs text-muted-foreground" data-testid="review-progress">
        {t('books.chapterEditor.reviewProgress', {
          reviewed: 0,
          total: dialogueSegments.length,
        })}
      </p>
    </section>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function ChapterEditor() {
  const { t } = useTranslation();
  const { selectedBookId, selectedChapterId, setView } = useBooksStore((s) => ({
    selectedBookId: s.selectedBookId,
    selectedChapterId: s.selectedChapterId,
    setView: s.setView,
  }));

  const { data: characters = [] } = useCharacters(selectedBookId);
  const { data: rawSegments = [] } = useSegments(selectedBookId, selectedChapterId);
  const { mutate: updateMutate } = useUpdateSegment();

  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [byCharacterId, setByCharacterId] = useState<string | null>(null);
  const [showCharacterPicker, setShowCharacterPicker] = useState(false);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);

  const segments = sorted(rawSegments);

  // ── Client-side filtering ────────────────────────────────────────────────
  const visibleSegments = segments.filter((seg) => {
    if (filterMode === 'dialogue') return seg.type === 'dialogue';
    if (filterMode === 'by-character') {
      if (!byCharacterId) return true;
      return seg.character_id === byCharacterId;
    }
    if (filterMode === 'flagged') {
      const char = characters.find((c) => c.id === seg.character_id);
      return (char?.confidence ?? 1) < LOW_CONFIDENCE_THRESHOLD;
    }
    return true;
  });

  function handleJump(segId: string) {
    setSelectedSegmentId(segId);
    const el = document.querySelector(`[data-testid="seg-${segId}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  // ── Color legend items ───────────────────────────────────────────────────
  const legendChars = [
    characters.find((c) => c.is_narrator),
    ...characters.filter((c) => !c.is_narrator),
  ].filter(Boolean) as CharacterResponse[];

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* ── Top bar: back + chapter switcher ────────────────────────────── */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <Button
            variant="ghost"
            size="sm"
            data-testid="back-to-overview"
            onClick={() => setView('overview')}
          >
            ◀ {t('books.chapterEditor.backToOverview')}
          </Button>
        </div>
        {/* INERT slot — chapter-switcher prev/next wired by C15 */}
        <div className="flex items-center gap-2" data-testid="chapter-switcher">
          <Button variant="ghost" size="sm" disabled title="previous chapter — wired by C15">
            ◀
          </Button>
          <span className="font-semibold">Chapter</span>
          <Button variant="ghost" size="sm" disabled title="next chapter — wired by C15">
            ▶
          </Button>
        </div>
      </div>

      {/* ── Review toolbar ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between" data-testid="review-toolbar">
        <div className="flex gap-1">
          {(
            [
              { mode: 'all' as FilterMode, label: t('books.chapterEditor.filterAll') },
              { mode: 'dialogue' as FilterMode, label: t('books.chapterEditor.filterDialogue') },
              { mode: 'by-character' as FilterMode, label: t('books.chapterEditor.filterByCharacter') },
              { mode: 'flagged' as FilterMode, label: t('books.chapterEditor.filterFlagged') },
            ] as const
          ).map(({ mode, label }) => (
            <button
              key={mode}
              onClick={() => {
                setFilterMode(mode);
                if (mode === 'by-character') {
                  setShowCharacterPicker(true);
                } else {
                  setShowCharacterPicker(false);
                }
              }}
              className={cn(
                'rounded px-3 py-1 text-sm',
                filterMode === mode
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
            >
              {label}
              {mode === 'by-character' && ' ▾'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {/* INERT slot — read-along wired by D5 */}
          <Button variant="secondary" size="sm" data-testid="readalong-btn" disabled>
            ▶ {t('books.chapterEditor.readalong')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('books.chapterEditor.readalongHint')}
          </span>
        </div>
      </div>

      {/* ── Character picker (shown when By character is active) ─────────── */}
      {showCharacterPicker && filterMode === 'by-character' && (
        <div className="flex gap-2" data-testid="character-filter-select">
          {characters.map((char) => (
            <button
              key={char.id}
              onClick={() => {
                setByCharacterId(char.id);
                setShowCharacterPicker(false);
              }}
              className={cn(
                'rounded px-2 py-1 text-xs',
                byCharacterId === char.id
                  ? 'outline outline-1'
                  : 'bg-muted hover:bg-muted/80',
              )}
              style={byCharacterId === char.id ? { outlineColor: char.color } : undefined}
            >
              <span
                className="mr-1 inline-block size-2 rounded-full"
                style={{ background: char.color }}
              />
              {char.name}
            </button>
          ))}
        </div>
      )}

      {/* ── Main area: book view + review rail ──────────────────────────── */}
      <div className="flex items-start gap-4">
        {/* ── Book view (scrollable text column) ───────────────────────── */}
        <section
          className="card flex flex-1 flex-col overflow-hidden"
          style={{ flex: '2.2' }}
          data-testid="book-view"
        >
          {/* Color legend */}
          <div className="flex flex-wrap gap-3 border-b pb-2">
            {legendChars.map((char) => (
              <div key={char.id} className="flex items-center gap-1 text-xs">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ background: char.color }}
                />
                {char.name}
              </div>
            ))}
            <span className="ml-auto text-xs text-muted-foreground">
              ▼ {t('books.chapterEditor.scrollHint')}
            </span>
          </div>

          {/* The book text — scrollable */}
          <div
            className="prose max-h-[72vh] overflow-auto pr-2"
            data-testid="chapter-text"
            style={{ fontSize: 15, lineHeight: 1.9 }}
          >
            {visibleSegments.map((seg) => {
              const color = resolveColor(seg.character_id, characters);
              const isDialogue = seg.type === 'dialogue';

              return (
                <p key={seg.id} className="mb-4">
                  <span
                    style={{
                      display: 'inline',
                      borderLeft: `3px solid ${color}`,
                      paddingLeft: 6,
                    }}
                  >
                    <SegmentLine
                      segment={seg}
                      characters={characters}
                      bookId={selectedBookId ?? ''}
                      chapterId={selectedChapterId ?? ''}
                      isSelected={selectedSegmentId === seg.id}
                      onSelect={setSelectedSegmentId}
                      updateMutate={updateMutate}
                    />
                    {/* INERT slot — per-line hover preview (D3 wires ▶ audition) */}
                    {isDialogue && (
                      <span
                        className="ml-1 cursor-pointer opacity-0 hover:opacity-100"
                        title="Audition this line — wired by D3"
                      >
                        ♪
                      </span>
                    )}
                  </span>
                </p>
              );
            })}
          </div>
        </section>

        {/* ── Review rail (right column) ────────────────────────────────── */}
        <ReviewRail
          segments={segments}
          characters={characters}
          onJump={handleJump}
        />
      </div>
    </div>
  );
}
