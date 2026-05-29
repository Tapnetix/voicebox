import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { useBookProgress } from '@/lib/hooks/useBookProgress';
import { useBook } from '@/lib/hooks/useBooks';
import { cn } from '@/lib/utils/cn';
import type {
  AnalysisCompleteEvent,
  AnalysisProgressEvent,
  BookErrorEvent,
  CharacterDetectedEvent,
} from '@/lib/api/types';
import { useBooksStore } from '@/stores/booksStore';

// ─── Types ────────────────────────────────────────────────────────────────────

type AnalysisStage = 'detect' | 'reconcile' | 'profile' | 'cast';
type StageStatus = 'done' | 'active' | 'pending';

interface StageState {
  key: AnalysisStage;
  status: StageStatus;
  progress: number;
}

interface LiveCharacter {
  id: string;
  name: string;
  color: string;
  dialogue_count: number;
  confidence: number;
}

// Ordered list of stages
const STAGES: AnalysisStage[] = ['detect', 'reconcile', 'profile', 'cast'];

function initialStages(): StageState[] {
  return STAGES.map((key) => ({ key, status: 'pending' as StageStatus, progress: 0 }));
}

// ─── Helper: confidence label ─────────────────────────────────────────────────

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.85) return 'high';
  if (confidence >= 0.6) return 'medium';
  return 'low';
}

function confidenceVariant(confidence: number): 'default' | 'secondary' | 'outline' | 'destructive' {
  if (confidence >= 0.85) return 'default';
  if (confidence >= 0.6) return 'secondary';
  return 'outline';
}

// ─── Stage labels (use i18n keys) ─────────────────────────────────────────────

const STAGE_LABEL_KEYS: Record<AnalysisStage, string> = {
  detect: 'books.analysis.stageDetect',
  reconcile: 'books.analysis.stageReconcile',
  profile: 'books.analysis.stageProfile',
  cast: 'books.analysis.stageCast',
};

// ─── Component ────────────────────────────────────────────────────────────────

export function AnalysisProgress() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  const { selectedBookId, setView } = useBooksStore((s) => ({
    selectedBookId: s.selectedBookId,
    setView: s.setView,
  }));

  // Resume-on-mount: if already analyzed skip to overview
  const { data: book } = useBook(selectedBookId);
  const didResume = useRef(false);
  useEffect(() => {
    if (!didResume.current && book?.status === 'analyzed') {
      didResume.current = true;
      setView('overview');
    }
  }, [book?.status, setView]);

  // ─── Local state ────────────────────────────────────────────────────────────
  const [stages, setStages] = useState<StageState[]>(initialStages);
  const [detailMessage, setDetailMessage] = useState<string>('');
  const [liveCharacters, setLiveCharacters] = useState<LiveCharacter[]>([]);
  const [error, setError] = useState<string | null>(null);

  // ─── SSE handlers ───────────────────────────────────────────────────────────

  const onAnalysisProgress = useCallback((event: AnalysisProgressEvent) => {
    const { stage, progress, message } = event;
    if (message) setDetailMessage(message);

    setStages((prev) => {
      const stageIdx = STAGES.indexOf(stage);
      return prev.map((s, i) => {
        if (i < stageIdx) return { ...s, status: 'done', progress: 100 };
        if (i === stageIdx) return { ...s, status: 'active', progress };
        return { ...s, status: 'pending' };
      });
    });
  }, []);

  const onCharacterDetected = useCallback((event: CharacterDetectedEvent) => {
    const { character } = event;
    const char: LiveCharacter = {
      id: character.id,
      name: character.name,
      color: (character.color as string) ?? '#888888',
      dialogue_count: (character.dialogue_count as number) ?? 0,
      confidence: (character.confidence as number) ?? 0,
    };
    setLiveCharacters((prev) => {
      // Dedupe by id
      if (prev.some((c) => c.id === char.id)) {
        return prev;
      }
      return [...prev, char];
    });
  }, []);

  const onAnalysisComplete = useCallback(
    (_event: AnalysisCompleteEvent) => {
      if (selectedBookId) {
        void queryClient.invalidateQueries({ queryKey: ['books', selectedBookId] });
        void queryClient.invalidateQueries({ queryKey: ['books', selectedBookId, 'characters'] });
      }
      setView('overview');
    },
    [selectedBookId, queryClient, setView],
  );

  const onError = useCallback((event: BookErrorEvent) => {
    setError(event.message);
  }, []);

  useBookProgress(selectedBookId ?? '', {
    onAnalysisProgress,
    onCharacterDetected,
    onAnalysisComplete,
    onError,
  });

  // ─── Retry ──────────────────────────────────────────────────────────────────
  function handleRetry() {
    setError(null);
    setStages(initialStages());
    setDetailMessage('');
    setLiveCharacters([]);
  }

  // ─── Overall progress (average of active/done stages) ───────────────────────
  const overallProgress =
    stages.reduce((sum, s) => sum + (s.status === 'done' ? 100 : s.status === 'active' ? s.progress : 0), 0) /
    stages.length;

  // ─── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-2xl font-bold">
          {book?.title
            ? t('books.analysis.title', { title: book.title })
            : t('books.analysis.titleGeneric')}
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t('books.analysis.subtitle')}</p>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-4 flex items-center justify-between gap-4">
          <p className="text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={handleRetry}>
            {t('books.analysis.retry')}
          </Button>
        </div>
      )}

      <div className="flex gap-4 items-start">
        {/* Stage feed */}
        <Card className="flex-[2]" data-testid="analysis-steps">
          <CardContent className="p-4">
            <h2 className="text-lg font-semibold mb-3">{t('books.analysis.progressTitle')}</h2>

            <Progress value={overallProgress} className="mb-2 h-2" />

            {detailMessage && (
              <p
                className="text-sm text-muted-foreground mb-3"
                data-testid="analysis-detail"
              >
                {detailMessage}
              </p>
            )}
            {!detailMessage && (
              <p
                className="text-sm text-muted-foreground mb-3"
                data-testid="analysis-detail"
              >
                {t('books.analysis.waiting')}
              </p>
            )}

            <div className="flex flex-col gap-2">
              {stages.map((stage) => (
                <StageRow key={stage.key} stage={stage} t={t} />
              ))}
            </div>

            <p className="text-xs text-muted-foreground mt-4">
              {t('books.analysis.chaptersNote')}
            </p>
          </CardContent>
        </Card>

        {/* Live characters */}
        <Card className="flex-1" data-testid="live-characters">
          <CardContent className="p-4">
            <h2 className="text-lg font-semibold mb-3">
              {t('books.analysis.charactersTitle')}{' '}
              <span className="text-muted-foreground text-sm font-normal">
                {t('books.analysis.liveLabel')}
              </span>
            </h2>

            {liveCharacters.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {t('books.analysis.noCharactersYet')}
              </p>
            ) : (
              <div className="flex flex-col gap-2">
                {liveCharacters.map((char) => (
                  <CharacterRow key={char.id} character={char} t={t} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

interface StageRowProps {
  stage: StageState;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function StageRow({ stage, t }: StageRowProps) {
  const { key, status, progress } = stage;

  const icon =
    status === 'done' ? '✓' : status === 'active' ? '●' : '·';

  return (
    <div
      className={cn(
        'flex items-center gap-3 p-2 rounded-md text-sm',
        status === 'done' && 'text-muted-foreground',
        status === 'active' && 'font-medium',
        status === 'pending' && 'text-muted-foreground opacity-60',
      )}
      data-stage={key}
      data-status={status}
    >
      <span className="w-4 text-center shrink-0">{icon}</span>
      <span className="flex-1">{t(STAGE_LABEL_KEYS[key])}</span>
      <Badge variant={status === 'done' ? 'default' : status === 'active' ? 'secondary' : 'outline'}>
        {status === 'done'
          ? t('books.analysis.stageDone')
          : status === 'active'
            ? progress > 0
              ? `${Math.round(progress)}%`
              : t('books.analysis.stageRunning')
            : t('books.analysis.stagePending')}
      </Badge>
    </div>
  );
}

interface CharacterRowProps {
  character: LiveCharacter;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

function CharacterRow({ character, t }: CharacterRowProps) {
  const { name, color, dialogue_count, confidence } = character;
  const confLabel = confidenceLabel(confidence);
  const confVariant = confidenceVariant(confidence);

  return (
    <div className="flex items-center gap-2" data-name={name}>
      {/* Color dot */}
      <span
        className="w-3 h-3 rounded-full shrink-0"
        style={{ backgroundColor: color }}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{name}</div>
        <div className="flex gap-1 mt-0.5 flex-wrap">
          <Badge variant="outline" className="text-xs">
            {dialogue_count} {t('books.analysis.linesLabel')}
          </Badge>
          <Badge variant={confVariant} className="text-xs">
            {confLabel}
          </Badge>
        </div>
      </div>
    </div>
  );
}
