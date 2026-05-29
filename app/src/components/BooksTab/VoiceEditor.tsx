/**
 * VoiceEditor — focused per-character voice editor.
 *
 * Layout: two-column (character context left, voice-panel right).
 * Three-tab scaffold: Library | Clone | **Design** (active here).
 *   - Library tab body: placeholder — C11 fills this.
 *   - Clone tab body:   placeholder — C12 fills this.
 *   - Design tab body:  fully wired here.
 * Shared preview-player row rendered here; C11/C12 reuse it.
 * save-to-library-btn rendered here; C13 wires its action.
 *
 * Actions:
 *   - Generate preview → usePreviewCharacter → play via getBookAudioUrl(generation_id)
 *   - Assign & back    → useUpdateCharacter({ design_prompt }) → setView('overview')
 *
 * data-testids match wireframe-04 and are consumed by S4 (c10.spec.ts).
 */
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useCharacters, usePreviewCharacter, useUpdateCharacter } from '@/lib/hooks/useBooks';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';
import { useBooksStore } from '@/stores/booksStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive confidence label from numeric score */
function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

// ─── Shared preview-player row ─────────────────────────────────────────────────
// C11/C12 reuse this row within their respective tab bodies.

interface PreviewPlayerProps {
  audioSrc: string | null;
  label?: string;
}

function PreviewPlayer({ audioSrc, label }: PreviewPlayerProps) {
  const { t } = useTranslation();
  const [isPlaying, setIsPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Keep audio element in sync with src changes
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
    };
  }, []);

  function handlePlayPause() {
    if (!audioSrc) return;

    if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
        setIsPlaying(false);
      } else {
        audioRef.current.play();
        setIsPlaying(true);
      }
      return;
    }

    const audio = new Audio(audioSrc);
    audioRef.current = audio;
    audio.addEventListener('ended', () => {
      setIsPlaying(false);
      audioRef.current = null;
    });
    audio.addEventListener('error', () => {
      setIsPlaying(false);
      audioRef.current = null;
    });
    audio.play();
    setIsPlaying(true);
  }

  return (
    <div
      data-testid="preview-player"
      className="flex items-center justify-between rounded border border-border bg-muted/40 px-3 py-2 mt-3"
    >
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={handlePlayPause}
          disabled={!audioSrc}
          aria-label={isPlaying ? t('books.voiceEditor.pausePreview') : t('books.voiceEditor.playPreview')}
        >
          {isPlaying ? '⏸' : '▶'}
        </Button>
        <span className="text-xs text-muted-foreground">
          {label ?? t('books.voiceEditor.previewLabel')}
        </span>
      </div>
      <span className="text-xs text-muted-foreground">
        {audioSrc ? t('books.voiceEditor.previewReady') : t('books.voiceEditor.previewEmpty')}
      </span>
    </div>
  );
}

// ─── VoiceEditor ──────────────────────────────────────────────────────────────

export function VoiceEditor() {
  const { t } = useTranslation();

  // ── Store ─────────────────────────────────────────────────────────────────
  const { selectedBookId, selectedCharacterId, setSelectedCharacterId, setView } = useBooksStore(
    (s) => ({
      selectedBookId: s.selectedBookId,
      selectedCharacterId: s.selectedCharacterId,
      setSelectedCharacterId: s.setSelectedCharacterId,
      setView: s.setView,
    }),
  );

  // ── Data ──────────────────────────────────────────────────────────────────
  const { data: characters = [] } = useCharacters(selectedBookId);

  const charIndex = characters.findIndex((c) => c.id === selectedCharacterId);
  const character = charIndex >= 0 ? characters[charIndex] : characters[0] ?? null;

  // ── Mutations ─────────────────────────────────────────────────────────────
  const preview = usePreviewCharacter();
  const updateCharacter = useUpdateCharacter();

  // ── Local state ───────────────────────────────────────────────────────────
  const [designPrompt, setDesignPrompt] = useState(character?.vocal_description ?? '');

  // Sync design prompt when character changes
  useEffect(() => {
    setDesignPrompt(character?.vocal_description ?? '');
  }, [character?.id, character?.vocal_description]);

  // Derive audio URL from preview result
  const previewAudioSrc = preview.data?.generation_id
    ? apiClient.getBookAudioUrl(preview.data.generation_id)
    : null;

  // ── Character switcher ────────────────────────────────────────────────────
  const total = characters.length;
  const currentIdx = charIndex >= 0 ? charIndex : 0;

  function switchPrev() {
    if (total === 0) return;
    const nextIdx = (currentIdx - 1 + total) % total;
    setSelectedCharacterId(characters[nextIdx].id);
  }

  function switchNext() {
    if (total === 0) return;
    const nextIdx = (currentIdx + 1) % total;
    setSelectedCharacterId(characters[nextIdx].id);
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function handlePreview() {
    if (!character) return;
    preview.mutate({
      charId: character.id,
      data: { design_prompt: designPrompt || undefined },
    });
  }

  function handleAssign() {
    if (!character || !selectedBookId) return;
    updateCharacter.mutate(
      {
        bookId: selectedBookId,
        charId: character.id,
        data: { design_prompt: designPrompt || undefined },
      },
      {
        onSuccess: () => setView('overview'),
      },
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────
  if (!character) {
    return (
      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
        {t('books.voiceEditor.noCharacter')}
      </div>
    );
  }

  const confLabel = confidenceLabel(character.confidence);
  // Sample lines from vocal_description hint — in C10 we show a static placeholder
  // since segments are not loaded here (chapter-editor scope).
  const sampleLines: string[] = [];

  return (
    <div className="flex flex-col gap-3 p-4 h-full overflow-auto">
      {/* ── Top bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between">
        {/* Back + breadcrumb */}
        <div className="flex items-center gap-2">
          <Button
            data-testid="back-to-overview"
            variant="ghost"
            size="sm"
            onClick={() => setView('overview')}
          >
            ◀ {t('books.voiceEditor.backToOverview')}
          </Button>
          <span className="text-xs text-muted-foreground">
            {t('books.voiceEditor.breadcrumb')}
          </span>
        </div>

        {/* Character switcher */}
        <div data-testid="character-switcher" className="flex items-center gap-2">
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={switchPrev}>
            ◀
          </Button>
          <span className="flex items-center gap-1.5 text-sm">
            <span
              className="w-2.5 h-2.5 rounded-full"
              style={{ background: character.color }}
              aria-hidden
            />
            <strong>{character.name}</strong>
            <span className="text-muted-foreground">
              {currentIdx + 1} {t('books.voiceEditor.of')} {total}
            </span>
          </span>
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={switchNext}>
            ▶
          </Button>
        </div>
      </div>

      {/* ── Main two-column layout ───────────────────────────────────────── */}
      <div className="flex gap-4 items-start flex-1 min-h-0">
        {/* LEFT: character context */}
        <Card className="flex-1" data-testid="character-context">
          <CardContent className="pt-4">
            {/* Name + dot */}
            <div className="flex items-center gap-2 mb-2">
              <span
                className="w-3 h-3 rounded-full shrink-0"
                style={{ background: character.color }}
                aria-hidden
              />
              <h2 className="text-base font-semibold">{character.name}</h2>
            </div>

            {/* Meta badges */}
            <div className="flex flex-wrap gap-1 mb-3">
              {character.gender && character.age_range && (
                <Badge variant="secondary">
                  {character.gender} · {character.age_range}
                </Badge>
              )}
              <Badge variant="secondary">{character.dialogue_count} lines</Badge>
              <Badge
                variant="outline"
                className={cn(
                  confLabel === 'high' && 'border-green-600 text-green-400',
                  confLabel === 'medium' && 'border-yellow-600 text-yellow-400',
                  confLabel === 'low' && 'border-red-600 text-red-400',
                )}
              >
                {t(`books.overview.confidence.${confLabel}`)} {t('books.voiceEditor.confidence')}
              </Badge>
            </div>

            {/* Suggested / traits */}
            <dl className="text-xs space-y-1 mb-3">
              {character.vocal_description && (
                <>
                  <div className="flex gap-2">
                    <dt className="text-muted-foreground shrink-0 w-16">
                      {t('books.voiceEditor.suggested')}
                    </dt>
                    <dd>{character.vocal_description}</dd>
                  </div>
                </>
              )}
              {character.archetype && (
                <div className="flex gap-2">
                  <dt className="text-muted-foreground shrink-0 w-16">
                    {t('books.voiceEditor.traits')}
                  </dt>
                  <dd>{character.archetype}</dd>
                </div>
              )}
            </dl>

            {/* Sample lines — audition with current voice */}
            <div>
              <h3 className="text-xs font-medium mb-1">
                {t('books.voiceEditor.sampleLines')}{' '}
                <span className="text-muted-foreground font-normal">
                  — {t('books.voiceEditor.auditionHint')}
                </span>
              </h3>
              {sampleLines.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t('books.voiceEditor.noSampleLines')}
                </p>
              ) : (
                <ul className="space-y-1">
                  {sampleLines.slice(0, 3).map((line, i) => (
                    <li
                      key={i}
                      className="flex items-center justify-between rounded bg-muted/30 px-2 py-1"
                    >
                      <span className="text-xs text-muted-foreground truncate mr-2">
                        &ldquo;{line}&rdquo;
                      </span>
                      <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0">
                        ▶
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </CardContent>
        </Card>

        {/* RIGHT: voice panel */}
        <Card className="flex-[1.4]" data-testid="voice-panel">
          <CardContent className="pt-4">
            {/* Header: title + current-voice badge */}
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-base font-semibold">{t('books.voiceEditor.voiceTitle')}</h2>
              <Badge data-testid="current-voice" variant="outline">
                {t('books.voiceEditor.currentVoice')}{' '}
                {character.voice_type ?? t('books.voiceEditor.noVoice')}
              </Badge>
            </div>

            {/* Three-tab scaffold */}
            <Tabs defaultValue="design">
              <TabsList className="mb-3">
                <TabsTrigger value="library">
                  {t('books.voiceEditor.tabLibrary')}
                </TabsTrigger>
                <TabsTrigger value="clone">
                  {t('books.voiceEditor.tabClone')}
                </TabsTrigger>
                <TabsTrigger value="design">
                  {t('books.voiceEditor.tabDesign')}
                </TabsTrigger>
              </TabsList>

              {/* Library tab — C11 fills the body here */}
              <TabsContent value="library">
                <p className="text-xs text-muted-foreground py-4 text-center">
                  {t('books.voiceEditor.libraryPlaceholder')}
                </p>
                {/* Shared preview-player row (C11/C12 reuse this) */}
                <PreviewPlayer audioSrc={previewAudioSrc} />
              </TabsContent>

              {/* Clone tab — C12 fills the body here */}
              <TabsContent value="clone">
                <p className="text-xs text-muted-foreground py-4 text-center">
                  {t('books.voiceEditor.clonePlaceholder')}
                </p>
                {/* Shared preview-player row (C11/C12 reuse this) */}
                <PreviewPlayer audioSrc={previewAudioSrc} />
              </TabsContent>

              {/* Design tab — fully wired in C10 */}
              <TabsContent value="design">
                {/* Design prompt textarea */}
                <div className="mb-3">
                  <label className="text-xs text-muted-foreground mb-1 block">
                    {t('books.voiceEditor.describeVoice')}
                  </label>
                  <Textarea
                    data-testid="design-prompt"
                    rows={3}
                    value={designPrompt}
                    onChange={(e) => setDesignPrompt(e.target.value)}
                    placeholder={t('books.voiceEditor.designPromptPlaceholder')}
                  />
                </div>

                {/* Shared preview-player row */}
                <PreviewPlayer audioSrc={previewAudioSrc} />
              </TabsContent>
            </Tabs>

            {/* Action row — save-to-library + preview + assign */}
            <div className="flex items-center justify-between mt-3">
              {/* save-to-library-btn — C13 wires the action */}
              <Button
                data-testid="save-to-library-btn"
                variant="ghost"
                size="sm"
                title={t('books.voiceEditor.saveToLibraryTitle')}
              >
                ★ {t('books.voiceEditor.saveToLibrary')}
              </Button>
              <div className="flex items-center gap-2">
                <Button
                  data-testid="preview-voice-btn"
                  variant="secondary"
                  size="sm"
                  onClick={handlePreview}
                  disabled={preview.isPending}
                >
                  {preview.isPending
                    ? t('books.voiceEditor.generating')
                    : t('books.voiceEditor.generatePreview')}
                </Button>
                <Button
                  data-testid="assign-voice-btn"
                  size="sm"
                  onClick={handleAssign}
                  disabled={updateCharacter.isPending}
                >
                  {t('books.voiceEditor.assignBack')}
                </Button>
              </div>
            </div>

            {/* Explainer note */}
            <p className="text-xs text-muted-foreground mt-2" data-testid="assign-explainer">
              <strong>{t('books.voiceEditor.assignExplainerAssign')}</strong>{' '}
              {t('books.voiceEditor.assignExplainerAssignNote')}{' '}
              <strong>{t('books.voiceEditor.assignExplainerPreview')}</strong>{' '}
              {t('books.voiceEditor.assignExplainerPreviewNote')}{' '}
              <strong>{t('books.voiceEditor.assignExplainerSave')}</strong>{' '}
              {t('books.voiceEditor.assignExplainerSaveNote')}
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
