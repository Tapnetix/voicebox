/**
 * VoiceEditor — focused per-character voice editor.
 *
 * Layout: two-column (character context left, voice-panel right).
 * Three-tab scaffold: Library | Clone | **Design** (active here).
 *   - Library tab body: wired in C11 — lists library/book/preset voices.
 *   - Clone tab body:   placeholder — C12 fills this.
 *   - Design tab body:  fully wired here.
 * Shared preview-player row rendered here; C11/C12 reuse it.
 * save-to-library-btn rendered here; C13 wires its action.
 *
 * Actions:
 *   - Generate preview → usePreviewCharacter → play via getBookAudioUrl(generation_id)
 *   - Assign & back    → useUpdateCharacter({ design_prompt }) → setView('overview')
 *
 * data-testids match wireframe-04/04a and are consumed by S4 (c10.spec.ts) and S11 (c11.spec.ts).
 */
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { useCharacters, usePreviewCharacter, useUpdateCharacter, useVoiceOptions, useCloneVoiceForCharacter, useSaveVoiceToLibrary } from '@/lib/hooks/useBooks';
import { useAudioRecording } from '@/lib/hooks/useAudioRecording';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';
import { useBooksStore } from '@/stores/booksStore';
import { toast } from '@/components/ui/use-toast';
import { AudioTrimmer } from '@/components/AudioTrimmer/AudioTrimmer';
import { useReferenceTranscript } from '@/lib/hooks/useReferenceTranscript';
import { ReferenceTranscript } from '@/components/VoiceProfiles/ReferenceTranscript';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Derive confidence label from numeric score */
function confidenceLabel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 0.8) return 'high';
  if (score >= 0.5) return 'medium';
  return 'low';
}

// ─── Types ─────────────────────────────────────────────────────────────────────

interface VoiceLibraryEntry {
  id: string;
  name: string;
  voice_type?: string;
  gender?: string;
  age_range?: string;
  engine?: string;
  accent?: string;
}

interface VoicePresetEntry {
  /** preset id (used in preset_voice_id) */
  id: string;
  name: string;
  engine?: string;
  gender?: string;
  accent?: string;
}

/** A selected candidate from the Library tab: either a library/book profile or a preset */
type LibraryCandidate =
  | { kind: 'profile'; id: string }
  | { kind: 'preset'; id: string };

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

// ─── VoiceCard ────────────────────────────────────────────────────────────────

interface VoiceCardProps {
  name: string;
  meta?: string;
  badge?: string;
  isSelected: boolean;
  onSelect: () => void;
  onPreview: () => void;
}

function VoiceCard({ name, meta, badge, isSelected, onSelect, onPreview }: VoiceCardProps) {
  const { t } = useTranslation();
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => e.key === 'Enter' && onSelect()}
      className={cn(
        'flex items-center justify-between rounded border bg-card px-3 py-2 cursor-pointer transition-colors',
        isSelected
          ? 'border-primary ring-1 ring-primary'
          : 'border-border hover:border-muted-foreground',
      )}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <strong className="text-sm">{name}</strong>
          {badge && <Badge variant="secondary" className="text-[10px] h-4">{badge}</Badge>}
        </div>
        {meta && <div className="text-xs text-muted-foreground mt-0.5">{meta}</div>}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 shrink-0 ml-2"
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
        aria-label={t('books.voiceEditor.previewVoice', { name })}
      >
        ▶
      </Button>
    </div>
  );
}

// ─── CloneTabBody ─────────────────────────────────────────────────────────────

interface CloneTabBodyProps {
  bookId: string | null;
  charId: string | null;
  charName: string;
  previewAudioSrc: string | null;
  onCloned: (profileId: string) => void;
  onAssign: (profileId: string) => void;
  isAssigning: boolean;
}

function CloneTabBody({
  bookId,
  charId,
  charName,
  previewAudioSrc,
  onCloned,
  onAssign,
  isAssigning,
}: CloneTabBodyProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const [sampleFile, setSampleFile] = useState<File | null>(null);
  const [sampleDuration, setSampleDuration] = useState<number | null>(null);
  // confirmedFile holds the trimmed File returned by AudioTrimmer onConfirm;
  // cleared whenever a new raw sample is loaded.
  const [confirmedFile, setConfirmedFile] = useState<File | null>(null);
  const [voiceName, setVoiceName] = useState(`${charName} (cloned)`);
  const [transcriptText, setTranscriptText] = useState('');
  const transcript = useReferenceTranscript({
    file: confirmedFile,
    text: transcriptText,
    setText: setTranscriptText,
    // No language — Whisper auto-detect (clone tab has no language picker).
  });
  const [cloneError, setCloneError] = useState<string | null>(null);
  const [clonedProfileId, setClonedProfileId] = useState<string | null>(null);

  const cloneVoice = useCloneVoiceForCharacter();

  // ── Audio recording ───────────────────────────────────────────────────────
  const recording = useAudioRecording({
    maxDurationSeconds: 120,
    onRecordingComplete: (blob, duration) => {
      const file = new File([blob], `${charName}-recording.wav`, { type: 'audio/wav' });
      setSampleFile(file);
      setSampleDuration(duration ?? null);
      setConfirmedFile(null);
      setTranscriptText('');
      setClonedProfileId(null);
      setCloneError(null);
    },
  });

  // ── Drag-and-drop helpers ─────────────────────────────────────────────────
  const [isDragOver, setIsDragOver] = useState(false);

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) loadFile(file);
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file) loadFile(file);
  }

  function loadFile(file: File) {
    setClonedProfileId(null);
    setCloneError(null);
    setConfirmedFile(null);
    setTranscriptText('');

    // Probe duration via AudioContext (async; we validate before upload)
    const url = URL.createObjectURL(file);
    const audio = new Audio(url);
    audio.addEventListener('loadedmetadata', () => {
      setSampleDuration(audio.duration);
      URL.revokeObjectURL(url);
    });
    audio.addEventListener('error', () => {
      setSampleDuration(null);
      URL.revokeObjectURL(url);
    });

    setSampleFile(file);
  }

  // ── Validation ────────────────────────────────────────────────────────────
  function validateDuration(): string | null {
    if (sampleDuration === null) return null; // unknown — allow upload
    if (sampleDuration < 3) return t('books.voiceEditor.cloneTooShort');
    // cloneTooLong (>30s) removed: AudioTrimmer now handles long samples
    return null;
  }

  // ── Create clone ──────────────────────────────────────────────────────────
  async function handleCreate() {
    if (!confirmedFile || !bookId || !charId) return;

    const validationError = validateDuration();
    if (validationError) {
      setCloneError(validationError);
      return;
    }

    setCloneError(null);

    // Always upload the trimmed clip the user confirmed — Create is gated on
    // confirmedFile, matching ProfileForm/SampleUpload (no raw-file fallback,
    // so a sample can never exceed the backend reference cap).
    const fileToUpload = confirmedFile;

    try {
      const profile = await cloneVoice.mutateAsync({
        bookId,
        charId,
        name: voiceName || `${charName} (cloned)`,
        file: fileToUpload,
        referenceText: transcriptText,
      });
      setClonedProfileId(profile.id);
      onCloned(profile.id);
    } catch (err) {
      setCloneError(err instanceof Error ? err.message : 'Clone failed');
    }
  }

  // ── Format duration display ───────────────────────────────────────────────
  function formatDuration(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m > 0 ? `${m}:${s.toString().padStart(2, '0')}` : `0:${s.toString().padStart(2, '0')}`;
  }

  return (
    <div data-testid="voice-panel-clone">
      {/* Description */}
      <p className="text-xs text-muted-foreground mb-3">
        {t('books.voiceEditor.cloneDescription')}
      </p>

      {/* Two-column layout: upload/record | name + create */}
      <div className="flex gap-3 items-start">
        {/* Left: dropzone + record */}
        <div className="flex flex-col gap-2 flex-1">
          {/* Dropzone */}
          <div
            data-testid="clone-dropzone"
            role="button"
            tabIndex={0}
            onClick={() => fileInputRef.current?.click()}
            onKeyDown={(e) => e.key === 'Enter' && fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
            onDragLeave={() => setIsDragOver(false)}
            onDrop={handleDrop}
            className={cn(
              'flex flex-col items-center justify-center rounded border-2 border-dashed text-xs text-muted-foreground cursor-pointer px-3 py-5 transition-colors',
              isDragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-muted-foreground',
              sampleFile && 'border-green-600 bg-green-900/10',
            )}
          >
            {sampleFile ? (
              <>
                <span className="text-green-400 font-medium">{sampleFile.name}</span>
                {sampleDuration !== null && (
                  <span className="text-muted-foreground mt-1">{formatDuration(sampleDuration)}</span>
                )}
              </>
            ) : (
              <>
                <span>{t('books.voiceEditor.cloneDropzoneLabel')}</span>
                <span className="text-[11px] mt-0.5">{t('books.voiceEditor.cloneDropzoneSub')}</span>
              </>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="audio/wav,audio/mp3,audio/mpeg,audio/flac,audio/*"
              className="sr-only"
              onChange={handleFileChange}
              tabIndex={-1}
            />
          </div>

          {/* Record from mic */}
          <Button
            data-testid="record-btn"
            variant="ghost"
            size="sm"
            onClick={recording.isRecording ? recording.stopRecording : recording.startRecording}
            className={cn(recording.isRecording && 'text-red-400 border-red-400')}
          >
            {recording.isRecording
              ? `${t('books.voiceEditor.cloneStopBtn')} (${Math.floor(recording.duration)}s)`
              : t('books.voiceEditor.cloneRecordBtn')}
          </Button>
          {recording.error && (
            <p className="text-xs text-red-400">{recording.error}</p>
          )}
        </div>

        {/* Right: voice name + create button */}
        <div className="flex flex-col gap-2 flex-1">
          <label className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              {t('books.voiceEditor.cloneVoiceNameLabel')}
            </span>
            <Input
              value={voiceName}
              onChange={(e) => setVoiceName(e.target.value)}
              placeholder={t('books.voiceEditor.cloneVoiceNamePlaceholder', { name: charName })}
              className="h-7 text-xs"
            />
          </label>

          <Button
            data-testid="create-clone-btn"
            onClick={handleCreate}
            disabled={!confirmedFile || cloneVoice.isPending}
            size="sm"
          >
            {cloneVoice.isPending
              ? t('books.voiceEditor.cloneCreating')
              : t('books.voiceEditor.cloneCreateBtn')}
          </Button>
        </div>
      </div>

      {/* AudioTrimmer — shown when a sample is loaded; onConfirm stores the trimmed file */}
      {sampleFile && (
        <div className="mt-3">
          <AudioTrimmer
            file={sampleFile}
            onConfirm={(trimmed, _durationSec) => {
              setConfirmedFile(trimmed);
              setCloneError(null);
            }}
          />
        </div>
      )}

      {/* Reference transcript — always visible; idle when no confirmed clip */}
      <div className="mt-3">
        <ReferenceTranscript
          value={transcriptText}
          onChange={setTranscriptText}
          status={transcript.status}
          isTranscribing={transcript.isTranscribing}
          regeneratePrompt={transcript.regeneratePrompt}
          onRetranscribe={transcript.retranscribe}
          onAcceptRegenerate={transcript.acceptRegenerate}
          onKeepEdits={transcript.keepEdits}
          hasClip={!!confirmedFile}
        />
      </div>

      {/* Inline error */}
      {cloneError && (
        <div role="alert" className="mt-2 text-xs text-red-400 rounded border border-red-800 bg-red-900/20 px-3 py-2">
          {cloneError}
        </div>
      )}

      {/* Preview player */}
      <PreviewPlayer audioSrc={previewAudioSrc} />

      {/* Action row — only visible after clone is created */}
      {clonedProfileId && (
        <div className="flex items-center justify-end gap-2 mt-3">
          <Button
            data-testid="preview-voice-btn"
            variant="secondary"
            size="sm"
            onClick={() => onCloned(clonedProfileId)}
          >
            {t('books.voiceEditor.generatePreview')}
          </Button>
          <Button
            data-testid="assign-clone-btn"
            size="sm"
            onClick={() => onAssign(clonedProfileId)}
            disabled={isAssigning}
          >
            {t('books.voiceEditor.cloneAssignBtn')}
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── LibraryTabBody ───────────────────────────────────────────────────────────

interface LibraryTabBodyProps {
  bookId: string | null;
  charId: string | null;
  previewAudioSrc: string | null;
  onPreviewCandidate: (candidate: LibraryCandidate) => void;
  onAssign: (candidate: LibraryCandidate) => void;
}

function LibraryTabBody({
  bookId,
  charId: _charId,
  previewAudioSrc,
  onPreviewCandidate,
  onAssign,
}: LibraryTabBodyProps) {
  const { t } = useTranslation();
  const { data: voiceOptions } = useVoiceOptions(bookId);
  const [search, setSearch] = useState('');
  const [genderFilter, setGenderFilter] = useState('any');
  const [accentFilter, setAccentFilter] = useState('any');
  const [selected, setSelected] = useState<LibraryCandidate | null>(null);

  const library: VoiceLibraryEntry[] = (voiceOptions?.library ?? []) as unknown as VoiceLibraryEntry[];
  const book: VoiceLibraryEntry[] = (voiceOptions?.book ?? []) as unknown as VoiceLibraryEntry[];
  // Map PresetVoice (voice_id field) to VoicePresetEntry (id field) for internal use
  const presets: VoicePresetEntry[] = (voiceOptions?.presets ?? []).map((p) => ({
    id: (p as unknown as { voice_id: string }).voice_id ?? (p as unknown as { id?: string }).id ?? '',
    name: p.name,
    gender: p.gender,
    engine: 'kokoro',
    accent: p.language,
  }));

  // Derive unique accent values from the preset list for the accent filter
  const accentOptions = Array.from(
    new Set(presets.map((p) => p.accent).filter((a): a is string => Boolean(a))),
  ).sort();

  // Client-side filter helper
  function filterVoices<T extends { name: string; gender?: string | null }>(voices: T[]): T[] {
    return voices.filter((v) => {
      const matchesSearch =
        !search || v.name.toLowerCase().includes(search.toLowerCase());
      const matchesGender =
        genderFilter === 'any' || !v.gender || v.gender.toLowerCase() === genderFilter.toLowerCase();
      return matchesSearch && matchesGender;
    });
  }

  function filterPresets(voices: VoicePresetEntry[]): VoicePresetEntry[] {
    return voices.filter((v) => {
      const matchesSearch =
        !search || v.name.toLowerCase().includes(search.toLowerCase());
      const matchesGender =
        genderFilter === 'any' || !v.gender || v.gender.toLowerCase() === genderFilter.toLowerCase();
      const matchesAccent =
        accentFilter === 'any' || !v.accent || v.accent.toLowerCase() === accentFilter.toLowerCase();
      return matchesSearch && matchesGender && matchesAccent;
    });
  }

  const filteredLibrary = filterVoices(library);
  const filteredBook = filterVoices(book);
  const filteredPresets = filterPresets(presets);

  function isSelected(candidate: LibraryCandidate) {
    if (!selected) return false;
    return selected.kind === candidate.kind && selected.id === candidate.id;
  }

  function handleSelect(candidate: LibraryCandidate) {
    setSelected(candidate);
  }

  function handlePreview(candidate: LibraryCandidate) {
    setSelected(candidate);
    onPreviewCandidate(candidate);
  }

  function handleAssign() {
    if (!selected) return;
    onAssign(selected);
  }

  // Derive selected label for status line
  function selectedLabel(): string | null {
    if (!selected) return null;
    if (selected.kind === 'preset') {
      const p = presets.find((v) => v.id === selected.id);
      return p ? `${p.name} (${p.engine ?? 'preset'})` : selected.id;
    }
    const all = [...library, ...book];
    const v = all.find((v) => v.id === selected.id);
    return v ? v.name : selected.id;
  }

  return (
    <div data-testid="voice-panel-library">
      {/* Description */}
      <p className="text-xs text-muted-foreground mb-2">
        {t('books.voiceEditor.libraryDescription')}
      </p>

      {/* Search + filters */}
      <div className="flex gap-2 mb-3">
        <Input
          className="flex-[2] h-7 text-xs"
          placeholder={t('books.voiceEditor.librarySearch')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <select
          className="flex-1 h-7 rounded border border-border bg-background text-xs px-1"
          value={genderFilter}
          onChange={(e) => setGenderFilter(e.target.value)}
          aria-label={t('books.voiceEditor.libraryGenderFilter')}
        >
          <option value="any">{t('books.voiceEditor.libraryGenderAny')}</option>
          <option value="female">{t('books.voiceEditor.libraryGenderFemale')}</option>
          <option value="male">{t('books.voiceEditor.libraryGenderMale')}</option>
        </select>
        <select
          className="flex-1 h-7 rounded border border-border bg-background text-xs px-1"
          value={accentFilter}
          onChange={(e) => setAccentFilter(e.target.value)}
          aria-label={t('books.voiceEditor.libraryAccentFilter')}
          data-testid="accent-filter"
        >
          <option value="any">{t('books.voiceEditor.libraryAccentAny')}</option>
          {accentOptions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>

      {/* Your library */}
      <h3 className="text-xs font-semibold mb-1">
        {t('books.voiceEditor.libraryYours')}{' '}
        <span className="text-muted-foreground font-normal">
          — {t('books.voiceEditor.libraryYoursSub')}
        </span>
      </h3>
      <div
        data-testid="library-voices"
        className="grid grid-cols-2 gap-2 mb-3"
      >
        {filteredLibrary.length === 0 ? (
          <p className="col-span-2 text-xs text-muted-foreground py-2 text-center">
            {t('books.voiceEditor.libraryEmpty')}
          </p>
        ) : (
          filteredLibrary.map((v) => {
            const candidate: LibraryCandidate = { kind: 'profile', id: v.id };
            const metaParts = [v.gender, v.age_range].filter(Boolean);
            return (
              <VoiceCard
                key={v.id}
                name={v.name}
                badge={v.voice_type}
                meta={metaParts.join(' · ')}
                isSelected={isSelected(candidate)}
                onSelect={() => handleSelect(candidate)}
                onPreview={() => handlePreview(candidate)}
              />
            );
          })
        )}
      </div>

      {/* This book's voices */}
      <h3 className="text-xs font-semibold mb-1">
        {t('books.voiceEditor.libraryBook')}{' '}
        <span className="text-muted-foreground font-normal">
          — {t('books.voiceEditor.libraryBookSub')}
        </span>
      </h3>
      <div
        data-testid="book-voices"
        className="grid grid-cols-2 gap-2 mb-3"
      >
        {filteredBook.length === 0 ? (
          <p className="col-span-2 text-xs text-muted-foreground py-2 text-center">
            {t('books.voiceEditor.libraryEmpty')}
          </p>
        ) : (
          filteredBook.map((v) => {
            const candidate: LibraryCandidate = { kind: 'profile', id: v.id };
            const metaParts = [v.gender, v.age_range].filter(Boolean);
            return (
              <VoiceCard
                key={v.id}
                name={v.name}
                badge={v.voice_type}
                meta={metaParts.join(' · ')}
                isSelected={isSelected(candidate)}
                onSelect={() => handleSelect(candidate)}
                onPreview={() => handlePreview(candidate)}
              />
            );
          })
        )}
      </div>

      {/* Presets */}
      <h3 className="text-xs font-semibold mb-1">
        {t('books.voiceEditor.libraryPresets')}{' '}
        <span className="text-muted-foreground font-normal">
          — {t('books.voiceEditor.libraryPresetsSub')}
        </span>
      </h3>
      <div
        data-testid="preset-voices"
        className="grid grid-cols-2 gap-2 mb-3"
      >
        {filteredPresets.length === 0 ? (
          <p className="col-span-2 text-xs text-muted-foreground py-2 text-center">
            {t('books.voiceEditor.libraryEmpty')}
          </p>
        ) : (
          filteredPresets.map((v) => {
            const candidate: LibraryCandidate = { kind: 'preset', id: v.id };
            const metaParts = [v.gender, v.accent].filter(Boolean);
            return (
              <VoiceCard
                key={v.id}
                name={v.name}
                badge={v.engine}
                meta={metaParts.join(' · ')}
                isSelected={isSelected(candidate)}
                onSelect={() => handleSelect(candidate)}
                onPreview={() => handlePreview(candidate)}
              />
            );
          })
        )}
      </div>

      {/* Preview player */}
      <PreviewPlayer audioSrc={previewAudioSrc} />

      {/* Selected + action row */}
      <div className="flex items-center justify-between mt-3">
        <span className="text-xs text-muted-foreground">
          {selected ? (
            <>
              {t('books.voiceEditor.librarySelected')}{' '}
              <strong>{selectedLabel()}</strong>
            </>
          ) : (
            t('books.voiceEditor.libraryNoneSelected')
          )}
        </span>
        <div className="flex items-center gap-2">
          <Button
            data-testid="preview-voice-btn"
            variant="secondary"
            size="sm"
            onClick={() => selected && onPreviewCandidate(selected)}
            disabled={!selected}
          >
            {t('books.voiceEditor.generatePreview')}
          </Button>
          <Button
            data-testid="assign-selected-btn"
            size="sm"
            onClick={handleAssign}
            disabled={!selected}
          >
            {t('books.voiceEditor.libraryAssignBack')}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ─── VoiceEditor ──────────────────────────────────────────────────────────────

interface VoiceEditorProps {
  /** Override the initially active tab (default: 'design') */
  initialTab?: 'library' | 'clone' | 'design';
}

export function VoiceEditor({ initialTab = 'design' }: VoiceEditorProps) {
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
  const saveToLibrary = useSaveVoiceToLibrary(selectedBookId);

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

  function handleSaveToLibrary() {
    if (!character) return;
    saveToLibrary.mutate(character.id, {
      onSuccess: () => {
        toast({
          title: t('books.voiceEditor.saveToLibrarySuccess'),
        });
      },
      onError: (err) => {
        toast({
          title: t('books.voiceEditor.saveToLibraryError'),
          description: err instanceof Error ? err.message : undefined,
          variant: 'destructive',
        });
      },
    });
  }

  // ── Clone tab actions ─────────────────────────────────────────────────────

  /** Called after clone profile is created — auto-preview a character line */
  function handleCloned(profileId: string) {
    if (!character) return;
    // Auto-preview in the cloned voice
    preview.mutate(
      {
        charId: character.id,
        data: { profile_id: profileId },
      },
    );
  }

  /** Assign the cloned profile to the character and go back to overview */
  function handleAssignClone(profileId: string) {
    if (!character || !selectedBookId) return;
    updateCharacter.mutate(
      {
        bookId: selectedBookId,
        charId: character.id,
        data: { profile_id: profileId },
      },
      {
        onSuccess: () => setView('overview'),
      },
    );
  }

  // ── Library tab actions ───────────────────────────────────────────────────
  function handlePreviewCandidate(candidate: LibraryCandidate) {
    if (!character) return;
    if (candidate.kind === 'preset') {
      preview.mutate({
        charId: character.id,
        data: { preset_voice_id: candidate.id },
      });
    } else {
      preview.mutate({
        charId: character.id,
        data: { profile_id: candidate.id },
      });
    }
  }

  function handleAssignCandidate(candidate: LibraryCandidate) {
    if (!character || !selectedBookId) return;
    if (candidate.kind === 'preset') {
      updateCharacter.mutate(
        {
          bookId: selectedBookId,
          charId: character.id,
          data: { preset_voice_id: candidate.id },
        },
        {
          onSuccess: () => setView('overview'),
        },
      );
    } else {
      updateCharacter.mutate(
        {
          bookId: selectedBookId,
          charId: character.id,
          data: { profile_id: candidate.id },
        },
        {
          onSuccess: () => setView('overview'),
        },
      );
    }
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
            <Tabs defaultValue={initialTab}>
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

              {/* Library tab — C11 */}
              <TabsContent value="library">
                <LibraryTabBody
                  bookId={selectedBookId}
                  charId={character.id}
                  previewAudioSrc={previewAudioSrc}
                  onPreviewCandidate={handlePreviewCandidate}
                  onAssign={handleAssignCandidate}
                />
              </TabsContent>

              {/* Clone tab — C12 */}
              <TabsContent value="clone">
                <CloneTabBody
                  bookId={selectedBookId}
                  charId={character.id}
                  charName={character.name}
                  previewAudioSrc={previewAudioSrc}
                  onCloned={handleCloned}
                  onAssign={handleAssignClone}
                  isAssigning={updateCharacter.isPending}
                />
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

                {/* Action row — save-to-library + preview + assign (Design tab only) */}
                <div className="flex items-center justify-between mt-3">
                  {/* save-to-library-btn — promotes the character's assigned voice to the global library */}
                  <Button
                    data-testid="save-to-library-btn"
                    variant="ghost"
                    size="sm"
                    title={
                      character.profile_id || character.voice_type
                        ? t('books.voiceEditor.saveToLibraryTitle')
                        : t('books.voiceEditor.saveToLibraryNoVoice')
                    }
                    disabled={!character.profile_id && !character.voice_type}
                    onClick={handleSaveToLibrary}
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
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
