import { Loader2, Mic } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { ReferenceTranscriptStatus } from '@/lib/hooks/useReferenceTranscript';

export interface ReferenceTranscriptProps {
  value: string;
  onChange: (value: string) => void;
  status: ReferenceTranscriptStatus;
  isTranscribing: boolean;
  regeneratePrompt: boolean;
  onRetranscribe: () => void;
  onAcceptRegenerate: () => void;
  onKeepEdits: () => void;
  label?: string;
  /** Whether a trimmed clip has been confirmed. When false, Re-transcribe is
   *  disabled (there is nothing to transcribe yet) with a hint to confirm one. */
  hasClip?: boolean;
}

export function ReferenceTranscript({
  value,
  onChange,
  status,
  isTranscribing,
  regeneratePrompt,
  onRetranscribe,
  onAcceptRegenerate,
  onKeepEdits,
  label,
  hasClip = true,
}: ReferenceTranscriptProps) {
  const { t } = useTranslation();

  return (
    <div data-testid="reference-transcript" className="space-y-2">
      <div className="flex items-center justify-between">
        <label htmlFor="reference-transcript-input" className="text-sm font-medium leading-none">
          {label ?? t('referenceTranscript.label')}
        </label>
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="transcript-retranscribe"
          onClick={onRetranscribe}
          disabled={isTranscribing || !hasClip}
          title={!hasClip ? t('referenceTranscript.confirmClipHint') : undefined}
          className="flex items-center gap-1.5"
        >
          <Mic className="h-3.5 w-3.5" />
          {t('referenceTranscript.retranscribe')}
        </Button>
      </div>

      <Textarea
        id="reference-transcript-input"
        data-testid="transcript-input"
        className="min-h-[100px]"
        placeholder={t('profileForm.fields.referenceTextPlaceholder')}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />

      {!hasClip && status === 'idle' && (
        <p data-testid="transcript-need-clip" className="text-xs text-muted-foreground">
          {t('referenceTranscript.confirmClipHint')}
        </p>
      )}

      {status === 'transcribing' && (
        <p
          data-testid="transcript-transcribing"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('referenceTranscript.transcribing')}
        </p>
      )}

      {status === 'downloading' && (
        <p
          data-testid="transcript-downloading"
          className="flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t('referenceTranscript.downloadingModel')}
        </p>
      )}

      {status === 'filled' && (
        <p data-testid="transcript-autofilled-hint" className="text-sm text-muted-foreground">
          {t('referenceTranscript.autoFilledHint')}
        </p>
      )}

      {status === 'failed' && (
        <p data-testid="transcript-error" className="text-xs text-destructive">
          {t('referenceTranscript.errorNote')}
        </p>
      )}

      {regeneratePrompt && (
        <div
          data-testid="transcript-regenerate-prompt"
          role="alert"
          className="flex items-center justify-between gap-2 rounded border border-border bg-muted/40 px-3 py-2 text-xs"
        >
          <span>{t('referenceTranscript.regeneratePrompt')}</span>
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              data-testid="transcript-regenerate-keep"
              onClick={onKeepEdits}
            >
              {t('referenceTranscript.keepEdits')}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="transcript-regenerate-confirm"
              onClick={onAcceptRegenerate}
            >
              {t('referenceTranscript.regenerate')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
