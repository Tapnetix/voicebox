/**
 * SegmentDeliveryControl — emotion pill + delivery/tone popover (D4).
 *
 * Clicking the emotion pill opens a popover with:
 *   - A row of emotion preset buttons (controlled vocabulary)
 *   - An intensity slider (0..1)
 *   - A free-text delivery/instruction input
 *   - A per-segment preview button
 *
 * Changes are persisted via useUpdateSegment (B7 PATCH).
 * Preview synthesizes the segment via usePreviewSegment (non-destructive regenerate).
 *
 * data-testids:
 *   emotion-{segId}   — the pill trigger
 *   delivery-popover  — the open popover content
 *   preview-btn       — the preview play button inside the popover
 */

import { useState } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Slider } from '@/components/ui/slider';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import { useUpdateSegment, usePreviewSegment } from '@/lib/hooks/useBooks';

// ─── Shared emotion vocabulary (matches backend controlled vocabulary) ─────────

export const EMOTION_PRESETS = [
  'neutral',
  'happy',
  'sad',
  'angry',
  'tense',
  'afraid',
  'whisper',
  'urgent',
] as const;

export type EmotionPreset = (typeof EMOTION_PRESETS)[number];

// ─── Props ─────────────────────────────────────────────────────────────────────

interface SegmentDeliveryControlProps {
  segmentId: string;
  bookId: string;
  chapterId: string;
  /** Current emotion from the segment (may be any string including non-preset values) */
  emotion: string;
  emotionIntensity: number;
  delivery?: string;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export function SegmentDeliveryControl({
  segmentId,
  bookId,
  chapterId,
  emotion: initialEmotion,
  emotionIntensity: initialIntensity,
  delivery: initialDelivery = '',
}: SegmentDeliveryControlProps) {
  const [open, setOpen] = useState(false);
  const [localEmotion, setLocalEmotion] = useState(initialEmotion);
  const [localIntensity, setLocalIntensity] = useState(initialIntensity);
  const [localDelivery, setLocalDelivery] = useState(initialDelivery);

  const { mutate: updateMutate } = useUpdateSegment();
  const { mutate: previewMutate, isPending: isPreviewing } = usePreviewSegment();

  function handleEmotionSelect(emotion: string) {
    setLocalEmotion(emotion);
    updateMutate(
      {
        segmentId,
        bookId,
        chapterId,
        data: {
          emotion,
          emotion_intensity: localIntensity,
          delivery: localDelivery || undefined,
        },
      },
      {},
    );
  }

  function handleIntensityChange(values: number[]) {
    const intensity = values[0];
    setLocalIntensity(intensity);
    updateMutate(
      {
        segmentId,
        bookId,
        chapterId,
        data: {
          emotion: localEmotion,
          emotion_intensity: intensity,
          delivery: localDelivery || undefined,
        },
      },
      {},
    );
  }

  function handleDeliveryChange(value: string) {
    setLocalDelivery(value);
  }

  function handleDeliveryBlur() {
    updateMutate(
      {
        segmentId,
        bookId,
        chapterId,
        data: {
          emotion: localEmotion,
          emotion_intensity: localIntensity,
          delivery: localDelivery || undefined,
        },
      },
      {},
    );
  }

  function handlePreview() {
    // Send only the emotion override; emotion_intensity + delivery are already
    // persisted on the segment (PATCHed on change above), and the backend
    // composes the instruct via the same compose_instruct() generation uses, so
    // the auditioned clip matches what will be rendered. (Do NOT send the raw
    // delivery as `instruct` — that is a full verbatim override that would
    // bypass intensity/emotion composition.)
    previewMutate({
      segmentId,
      data: {
        emotion: localEmotion,
      },
    });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <span
          data-testid={`emotion-${segmentId}`}
          className="ml-1 cursor-pointer rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted"
          title="Delivery / tone for this line (not the voice)"
        >
          {localEmotion} ▾
        </span>
      </PopoverTrigger>
      <PopoverContent
        data-testid="delivery-popover"
        className="w-80 p-3"
        align="start"
        side="bottom"
      >
        {/* Header */}
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Delivery / tone for this line (not the voice)
        </p>

        {/* Emotion preset buttons */}
        <div className="mb-3 flex flex-wrap gap-1">
          {EMOTION_PRESETS.map((preset) => (
            <button
              key={preset}
              onClick={() => handleEmotionSelect(preset)}
              className={cn(
                'rounded px-2 py-0.5 text-xs capitalize transition-colors',
                localEmotion === preset
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80',
              )}
            >
              {preset}
            </button>
          ))}
        </div>

        {/* Intensity slider */}
        <div className="mb-3">
          <label className="mb-1 block text-xs text-muted-foreground">
            Intensity: {Math.round(localIntensity * 100)}%
          </label>
          <Slider
            min={0}
            max={1}
            step={0.05}
            value={[localIntensity]}
            onValueChange={handleIntensityChange}
            className="w-full"
          />
        </div>

        {/* Free-text delivery instruction */}
        <div className="mb-3">
          <label className="mb-1 block text-xs text-muted-foreground">
            Instruction (optional)
          </label>
          <Input
            value={localDelivery}
            onChange={(e) => handleDeliveryChange(e.target.value)}
            onBlur={handleDeliveryBlur}
            placeholder="e.g. speak with a trembling voice"
            className="text-xs"
          />
        </div>

        {/* Preview button */}
        <Button
          data-testid="preview-btn"
          variant="secondary"
          size="sm"
          onClick={handlePreview}
          disabled={isPreviewing}
          className="w-full"
        >
          {isPreviewing ? 'Previewing…' : '▶ Preview this line'}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
