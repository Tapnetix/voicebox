import { Repeat, SkipBack, Play, Pause, Wand2, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';
import { useTranslation } from 'react-i18next';
import WaveSurfer from 'wavesurfer.js';
import { Button } from '@/components/ui/button';
import {
  decodeAudioFile,
  suggestWindow,
  sliceToWav,
  audioBufferToWav,
  classifyWindowLength,
  formatAudioDuration,
  WINDOW_MIN,
  WINDOW_MAX,
  WINDOW_DEFAULT,
} from '@/lib/utils/audio';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioTrimmerProps {
  file: File;
  onConfirm: (trimmed: File, durationSec: number) => void;
  expandedByDefault?: boolean;
}

/** Imperative handle so a parent can grab the CURRENT selection on demand
 *  (e.g. to transcribe the selected window without a separate "Use this clip"). */
export interface AudioTrimmerHandle {
  getClip: () => { file: File; durationSec: number } | null;
}

type Mode = 'loading' | 'whole-clip' | 'collapsed' | 'expanded';

interface Region {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Helpers (pure — unit-tested without wavesurfer/DOM)
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** i18n key for the chip depending on classification. */
function chipLabelKey(classification: 'ideal' | 'neutral' | 'warn'): string {
  if (classification === 'ideal') return 'trimmer.chipIdeal';
  if (classification === 'neutral') return 'trimmer.chipNeutral';
  return 'trimmer.chipLonger';
}

/**
 * Place a window of `len` seconds anchored at `startTime`, clamped so it fits
 * inside [0, duration] and respects WINDOW_MIN/MAX. The selection is driven
 * entirely by React state through this function, so the on-screen box (rendered
 * from state) and the displayed selection can never disagree.
 */
export function placeWindow(startTime: number, len: number, duration: number): Region {
  const l = clamp(len, WINDOW_MIN, Math.max(WINDOW_MIN, Math.min(WINDOW_MAX, duration)));
  const start = clamp(startTime, 0, Math.max(0, duration - l));
  return { start, end: start + l };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const AudioTrimmer = forwardRef<AudioTrimmerHandle, AudioTrimmerProps>(function AudioTrimmer(
  { file, onConfirm, expandedByDefault },
  ref,
) {
  const { t } = useTranslation();

  // ---- state ----
  const [mode, setMode] = useState<Mode>('loading');
  const [region, setRegion] = useState<Region>({ start: 0, end: WINDOW_DEFAULT });
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [duration, setDuration] = useState(0);

  // ---- refs ----
  const bufferRef = useRef<AudioBuffer | null>(null);
  const waveformRef = useRef<HTMLDivElement>(null); // wavesurfer mounts here (display only)
  const trackRef = useRef<HTMLDivElement>(null); // positioning context for px<->time
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionRef = useRef<Region>(region);
  const isLoopingRef = useRef(false);
  const durationRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);

  // Keep refs in sync with state for use inside event callbacks.
  regionRef.current = region;
  isLoopingRef.current = isLooping;
  durationRef.current = duration;

  // ---- decode on file change ----
  useEffect(() => {
    let cancelled = false;
    setMode('loading');

    decodeAudioFile(file)
      .then((buffer) => {
        if (cancelled) return;
        bufferRef.current = buffer;
        const dur = buffer.duration;
        setDuration(dur);

        if (dur < WINDOW_MIN) {
          // Short clip — whole-clip passthrough
          setMode('whole-clip');
          setRegion({ start: 0, end: dur });
        } else if (dur <= WINDOW_MAX) {
          // In-range — collapsed by default, expanded if caller sets expandedByDefault
          setRegion({ start: 0, end: dur });
          setMode(expandedByDefault === true ? 'expanded' : 'collapsed');
        } else {
          // Long source — anchor the window at the START of the clip (predictable);
          // "Auto-suggest" is the opt-in to jump to the highest-energy span.
          setRegion({ start: 0, end: WINDOW_DEFAULT });
          setMode('expanded');
        }
      })
      .catch(() => {
        if (!cancelled) setMode('whole-clip');
      });

    return () => {
      cancelled = true;
    };
  }, [file, expandedByDefault]);

  // ---- wavesurfer init / teardown (waveform render + playback ONLY) ----
  useEffect(() => {
    if (mode !== 'expanded' && mode !== 'whole-clip') return;
    const container = waveformRef.current;
    if (!container) return;

    if (wavesurferRef.current) {
      try {
        wavesurferRef.current.destroy();
      } catch (_) {
        /* ignore */
      }
      wavesurferRef.current = null;
    }

    const root = document.documentElement;
    const getCSSVar = (v: string) => {
      const val = getComputedStyle(root).getPropertyValue(v).trim();
      return val ? `hsl(${val})` : '#888';
    };

    const ws = WaveSurfer.create({
      container,
      waveColor: getCSSVar('--muted'),
      progressColor: getCSSVar('--accent'),
      cursorColor: getCSSVar('--accent'),
      barWidth: 2,
      barRadius: 2,
      height: 80,
      normalize: true,
      interact: false, // selection is handled by our own overlay, not wavesurfer seeking
      backend: 'WebAudio',
    });
    wavesurferRef.current = ws;

    // Region-scoped loop / auto-stop at the selection end.
    ws.on('timeupdate', (time: number) => {
      const { start, end } = regionRef.current;
      if (time >= end) {
        if (isLoopingRef.current) {
          ws.setTime(start);
        } else {
          ws.pause();
          setIsPlaying(false);
        }
      }
    });
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));

    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    ws.load(url).catch(() => {
      /* ignore in tests */
    });

    return () => {
      try {
        ws.destroy();
      } catch (_) {
        /* ignore */
      }
      wavesurferRef.current = null;
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // ---- transport handlers ----
  const handlePlay = useCallback(() => {
    const ws = wavesurferRef.current;
    if (!ws) return;
    if (isPlaying) {
      ws.pause();
    } else {
      ws.setTime(regionRef.current.start);
      ws.play();
    }
  }, [isPlaying]);

  const handleRewind = useCallback(() => {
    wavesurferRef.current?.setTime(regionRef.current.start);
  }, []);

  const handleLoop = useCallback(() => setIsLooping((prev) => !prev), []);

  // ---- length slider (pure state; the box re-renders from state) ----
  const handleLengthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newLen = clamp(Number(e.target.value), WINDOW_MIN, WINDOW_MAX);
    setRegion(placeWindow(regionRef.current.start, newLen, durationRef.current));
  }, []);

  // ---- auto-suggest (opt-in: jump to the highest-energy span) ----
  const handleAutoSuggest = useCallback(() => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    const len = Math.round(regionRef.current.end - regionRef.current.start);
    setRegion(suggestWindow(buffer, len));
  }, []);

  // ---- pointer interaction on the track (state-driven selection) ----
  const timeFromClientX = useCallback((clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return 0;
    return clamp((clientX - r.left) / r.width, 0, 1) * durationRef.current;
  }, []);

  // Click on empty track → move the window to START at the clicked time.
  // Clicks that land on the region box/handles are ignored here (the box owns
  // its own drag), so a click inside the selection doesn't re-place it.
  const handleTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if ((e.target as HTMLElement).closest('[data-testid="trimmer-region"]')) return;
      const len = regionRef.current.end - regionRef.current.start;
      setRegion(placeWindow(timeFromClientX(e.clientX), len, durationRef.current));
    },
    [timeFromClientX],
  );

  // Keyboard accessibility: arrow keys nudge the window, Home/End jump to ends.
  const handleTrackKeyDown = useCallback((e: React.KeyboardEvent) => {
    const cur = regionRef.current;
    const dur = durationRef.current;
    const len = cur.end - cur.start;
    const step = e.shiftKey ? 5 : 1;
    let start: number | null = null;
    if (e.key === 'ArrowLeft') start = cur.start - step;
    else if (e.key === 'ArrowRight') start = cur.start + step;
    else if (e.key === 'Home') start = 0;
    else if (e.key === 'End') start = dur;
    if (start === null) return;
    e.preventDefault();
    setRegion(placeWindow(start, len, dur));
  }, []);

  // Drag the region body to move it, or its edges to resize it.
  const dragRef = useRef<{ kind: 'move' | 'start' | 'end'; originX: number; orig: Region } | null>(
    null,
  );
  const onPointerMove = useCallback((e: PointerEvent) => {
    const d = dragRef.current;
    const el = trackRef.current;
    if (!d || !el) return;
    const r = el.getBoundingClientRect();
    const dur = durationRef.current;
    if (r.width <= 0) return;
    const dt = ((e.clientX - d.originX) / r.width) * dur;
    if (d.kind === 'move') {
      const len = d.orig.end - d.orig.start;
      const start = clamp(d.orig.start + dt, 0, Math.max(0, dur - len));
      setRegion({ start, end: start + len });
    } else if (d.kind === 'start') {
      const lo = Math.max(0, d.orig.end - WINDOW_MAX);
      const hi = d.orig.end - WINDOW_MIN;
      setRegion({ start: clamp(d.orig.start + dt, lo, hi), end: d.orig.end });
    } else {
      const lo = d.orig.start + WINDOW_MIN;
      const hi = Math.min(dur, d.orig.start + WINDOW_MAX);
      setRegion({ start: d.orig.start, end: clamp(d.orig.end + dt, lo, hi) });
    }
  }, []);
  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);
  const startDrag = useCallback(
    (kind: 'move' | 'start' | 'end') => (e: React.PointerEvent) => {
      e.stopPropagation();
      dragRef.current = { kind, originX: e.clientX, orig: regionRef.current };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [onPointerMove, onPointerUp],
  );
  // Clean up any stray listeners on unmount.
  useEffect(() => () => {
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove, onPointerUp]);

  // ---- build the current clip (slice the selection, or the whole short clip) ----
  const buildClip = useCallback((): { file: File; durationSec: number } | null => {
    const buffer = bufferRef.current;
    if (!buffer) return null;
    let blob: Blob;
    let dur: number;
    if (mode === 'whole-clip') {
      blob = audioBufferToWav(buffer);
      dur = buffer.duration;
    } else {
      blob = sliceToWav(buffer, region.start, region.end);
      dur = region.end - region.start;
    }
    return {
      file: new File([blob], `reference-${Date.now()}.wav`, { type: 'audio/wav' }),
      durationSec: dur,
    };
  }, [mode, region]);

  const handleConfirm = useCallback(() => {
    const clip = buildClip();
    if (clip) onConfirm(clip.file, clip.durationSec);
  }, [buildClip, onConfirm]);

  // Expose the current selection to parents (used to transcribe the selected
  // window directly, without requiring a separate "Use this clip" click).
  useImperativeHandle(ref, () => ({ getClip: buildClip }), [buildClip]);

  // ---- derived display values ----
  const lengthSec = mode === 'whole-clip' ? duration : region.end - region.start;
  const classification = classifyWindowLength(lengthSec);
  const showWarning = classification === 'warn';
  const pct = (v: number) => (duration > 0 ? `${clamp((v / duration) * 100, 0, 100)}%` : '0%');

  // ---- render ----

  if (mode === 'loading') {
    return (
      <div
        data-testid="audio-trimmer"
        data-state="loading"
        className="rounded-lg border border-border p-4 text-sm text-muted-foreground"
      >
        {t('trimmer.loading')}
      </div>
    );
  }

  if (mode === 'collapsed') {
    return (
      <div
        data-testid="audio-trimmer"
        data-state="collapsed"
        className="rounded-lg border border-border p-3"
      >
        <div className="flex items-center gap-3">
          <span className="text-accent font-bold">✓</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">
              {t('trimmer.referenceReady')} · {formatAudioDuration(duration)}
            </div>
            <div className="text-xs text-muted-foreground" data-testid="trimmer-collapsed-note">
              {t('trimmer.inRange')}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              data-testid="trimmer-play"
              aria-label={isPlaying ? 'Pause' : 'Play'}
              onClick={handlePlay}
            >
              {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            </Button>
            <Button
              variant="outline"
              size="sm"
              data-testid="trimmer-expand"
              onClick={() => setMode('expanded')}
            >
              {t('trimmer.adjustWindow')} <ChevronDown className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // expanded / whole-clip — waveform + (expanded) state-driven selection overlay
  return (
    <div
      data-testid="audio-trimmer"
      data-state={mode}
      className="rounded-lg border border-border overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-border">
        <div>
          <span className="text-sm font-semibold">
            {mode === 'whole-clip' ? t('trimmer.reference') : t('trimmer.trimReference')}
          </span>
          <span className="text-xs text-muted-foreground ml-1">
            {mode === 'whole-clip' ? t('trimmer.wholeClipLabel') : t('trimmer.pickWindow')}
          </span>
        </div>
        <div className="text-xs text-muted-foreground" data-testid="trimmer-source">
          {file.name} · {formatAudioDuration(duration)}
        </div>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        {/* Waveform + selection overlay (the box is positioned from state). */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: custom waveform slider — role="slider", tabIndex, aria-value*, and onKeyDown (arrow keys) are provided when interactive; the conditional role confuses static analysis. */}
        {/* biome-ignore lint/a11y/useAriaPropsSupportedByRole: same — role is "slider" whenever the aria-value* props are present (expanded mode). */}
        <div
          ref={trackRef}
          data-testid="trimmer-waveform"
          className="relative w-full h-[80px] rounded select-none focus:outline-none focus:ring-1 focus:ring-accent"
          style={{ touchAction: 'none' }}
          role={mode === 'expanded' ? 'slider' : undefined}
          tabIndex={mode === 'expanded' ? 0 : undefined}
          aria-label={mode === 'expanded' ? t('trimmer.pickWindow') : undefined}
          aria-valuemin={mode === 'expanded' ? 0 : undefined}
          aria-valuemax={mode === 'expanded' ? Math.round(duration) : undefined}
          aria-valuenow={mode === 'expanded' ? Math.round(region.start) : undefined}
          onClick={mode === 'expanded' ? handleTrackClick : undefined}
          onKeyDown={mode === 'expanded' ? handleTrackKeyDown : undefined}
        >
          {/* wavesurfer paints here; pointer-events off so the track owns interaction */}
          <div ref={waveformRef} className="absolute inset-0 pointer-events-none" />

          {mode === 'expanded' && (
            <div
              data-testid="trimmer-region"
              className="absolute top-0 bottom-0 bg-accent/25 border-x-2 border-accent cursor-grab"
              style={{ left: pct(region.start), width: pct(region.end - region.start) }}
              onPointerDown={startDrag('move')}
            >
              <div
                data-testid="trimmer-handle-start"
                className="absolute left-0 top-0 bottom-0 w-2 -ml-1 cursor-ew-resize bg-accent rounded"
                onPointerDown={startDrag('start')}
              />
              <div
                data-testid="trimmer-handle-end"
                className="absolute right-0 top-0 bottom-0 w-2 -mr-1 cursor-ew-resize bg-accent rounded"
                onPointerDown={startDrag('end')}
              />
            </div>
          )}
        </div>

        {/* Axis + selection */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatAudioDuration(0)}</span>
          {mode === 'expanded' && (
            <span data-testid="trimmer-selection" className="text-accent font-mono">
              {formatAudioDuration(region.start)} – {formatAudioDuration(region.end)} ·{' '}
              {t('trimmer.selection')}
            </span>
          )}
          <span>{formatAudioDuration(duration)}</span>
        </div>

        {/* Length slider (expanded only) */}
        {mode === 'expanded' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t('trimmer.window')}</span>
            <input
              type="range"
              min={WINDOW_MIN}
              max={WINDOW_MAX}
              value={Math.round(region.end - region.start)}
              onChange={handleLengthChange}
              data-testid="trimmer-length"
              className="flex-1 accent-amber-500"
            />
            <span className="text-xs text-muted-foreground">{t('trimmer.windowRange')}</span>
          </div>
        )}

        {/* Transport row */}
        <div className="flex items-center gap-2">
          {mode === 'expanded' && (
            <Button
              variant="ghost"
              size="icon"
              data-testid="trimmer-rewind"
              aria-label="Rewind to start of selection"
              onClick={handleRewind}
            >
              <SkipBack className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            data-testid="trimmer-play"
            aria-label={isPlaying ? 'Pause' : 'Play selection'}
            onClick={handlePlay}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </Button>
          {mode === 'expanded' && (
            <Button
              variant="ghost"
              size="icon"
              data-testid="trimmer-loop"
              aria-label={isLooping ? 'Stop loop' : 'Loop selection'}
              onClick={handleLoop}
              className={isLooping ? 'bg-accent text-accent-foreground' : ''}
            >
              <Repeat className="h-4 w-4" />
            </Button>
          )}
          {mode === 'expanded' && (
            <span className="text-xs text-muted-foreground">{t('trimmer.loopSelection')}</span>
          )}

          <div className="flex-1" />

          {/* Length chip */}
          <span
            data-testid="trimmer-length-chip"
            className={[
              'px-2 py-0.5 rounded-full text-xs font-medium',
              classification === 'ideal' && 'bg-green-900/40 text-green-400 border border-green-700',
              classification === 'neutral' && 'bg-muted text-muted-foreground border border-border',
              classification === 'warn' && 'bg-amber-900/40 text-amber-400 border border-amber-700',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {mode === 'whole-clip'
              ? `${Math.round(lengthSec)}s · ${t('trimmer.wholeClip')}`
              : `${Math.round(lengthSec)}s · ${t(chipLabelKey(classification))}`}
          </span>

          {mode === 'expanded' && (
            <Button
              variant="outline"
              size="sm"
              data-testid="trimmer-autosuggest"
              onClick={handleAutoSuggest}
            >
              <Wand2 className="h-3 w-3 mr-1" />
              {t('trimmer.autoSuggest')}
            </Button>
          )}
        </div>

        {/* Warning (expanded, >30s) */}
        {mode === 'expanded' && showWarning && (
          <p data-testid="trimmer-warning" className="text-xs text-amber-400">
            {t('trimmer.warning')}
          </p>
        )}

        {/* Short-clip note */}
        {mode === 'whole-clip' && (
          <p data-testid="trimmer-shortnote" className="text-xs text-muted-foreground">
            {t('trimmer.shortNote')}
          </p>
        )}

        {/* Confirm */}
        <Button className="w-full mt-1" onClick={handleConfirm}>
          {t('trimmer.useThisClip')}
        </Button>
      </div>
    </div>
  );
});
