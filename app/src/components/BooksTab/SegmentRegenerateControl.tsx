/**
 * SegmentRegenerateControl — per-line regenerate menu-item for ChapterEditor.
 *
 * Renders a single "Regenerate" button/item that calls the
 * useRegenerateSegment hook and shows a spinner on the target line while
 * re-rendering.  Sibling lines are NOT affected.
 *
 * Usage inside the ⋯ SelectionDialog:
 *   <SegmentRegenerateControl
 *     segmentId={segment.id}
 *     bookId={bookId}
 *     chapterId={chapterId}
 *     audioStatus={segment.audio_status}
 *     onDone={onClose}
 *   />
 */

import { useRegenerateSegment } from '@/lib/hooks/useBooks';

interface SegmentRegenerateControlProps {
  segmentId: string;
  bookId: string;
  chapterId: string;
  /** Current audio_status of the segment ('none'|'pending'|'generating'|'completed'|'error'|'stale') */
  audioStatus?: string;
  /** Called after a successful regenerate mutation is dispatched. */
  onDone?: () => void;
}

/**
 * Regenerate button for the per-line ⋯ menu.
 *
 * Shows a spinner/disabled state while the mutation is in-flight so the user
 * knows that *only this line* is being re-rendered.
 */
export function SegmentRegenerateControl({
  segmentId,
  bookId,
  chapterId,
  audioStatus,
  onDone,
}: SegmentRegenerateControlProps) {
  const { mutate: regenerate, isPending } = useRegenerateSegment();

  const isPendingOrGenerating =
    isPending ||
    audioStatus === 'pending' ||
    audioStatus === 'generating';

  function handleRegenerate() {
    regenerate(
      { segmentId, bookId, chapterId },
      {
        onSuccess: () => {
          if (onDone) onDone();
        },
      },
    );
  }

  return (
    <button
      data-testid={`regenerate-btn-${segmentId}`}
      className="flex w-full items-center gap-1.5 rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:opacity-50"
      onClick={handleRegenerate}
      disabled={isPendingOrGenerating}
      title={isPendingOrGenerating ? 'Re-rendering this line…' : 'Regenerate this line'}
    >
      {isPendingOrGenerating ? (
        <>
          <span
            data-testid={`regenerate-spinner-${segmentId}`}
            className="inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            aria-label="Re-rendering"
          />
          Re-rendering…
        </>
      ) : (
        <>↻ Regenerate</>
      )}
    </button>
  );
}
