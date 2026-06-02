import { Repeat, RotateCcw, SkipBack, Play, Pause, Wand2, ChevronDown } from 'lucide-react';
import { useEffect, useRef, useState, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.js';
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
  WINDOW_WARN,
} from '@/lib/utils/audio';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AudioTrimmerProps {
  file: File;
  onConfirm: (trimmed: File, durationSec: number) => void;
  collapsedByDefault?: boolean;
}

type Mode = 'loading' | 'whole-clip' | 'collapsed' | 'expanded';

interface Region {
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** Label text for the chip depending on classification. */
function chipLabel(classification: 'ideal' | 'neutral' | 'warn'): string {
  if (classification === 'ideal') return 'ideal';
  if (classification === 'neutral') return 'neutral';
  return 'longer than recommended';
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AudioTrimmer({ file, onConfirm, collapsedByDefault }: AudioTrimmerProps) {
  // ---- state ----
  const [mode, setMode] = useState<Mode>('loading');
  const [region, setRegion] = useState<Region>({ start: 0, end: WINDOW_DEFAULT });
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLooping, setIsLooping] = useState(false);
  const [duration, setDuration] = useState(0);

  // ---- refs ----
  const bufferRef = useRef<AudioBuffer | null>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurferRef = useRef<WaveSurfer | null>(null);
  const regionsPluginRef = useRef<ReturnType<typeof RegionsPlugin.create> | null>(null);
  const wsRegionRef = useRef<any>(null);
  const regionRef = useRef<Region>(region);
  const isLoopingRef = useRef(false);
  const objectUrlRef = useRef<string | null>(null);

  // Keep refs in sync with state
  regionRef.current = region;
  isLoopingRef.current = isLooping;

  // ---- decode on file change ----
  useEffect(() => {
    let cancelled = false;
    setMode('loading');

    decodeAudioFile(file).then((buffer) => {
      if (cancelled) return;
      bufferRef.current = buffer;
      const dur = buffer.duration;
      setDuration(dur);

      if (dur < WINDOW_MIN) {
        // Short clip — whole-clip passthrough
        setMode('whole-clip');
        setRegion({ start: 0, end: dur });
      } else if (dur <= WINDOW_MAX) {
        // In-range — collapsed (unless caller forces expand)
        setRegion({ start: 0, end: dur });
        setMode(collapsedByDefault === false ? 'expanded' : 'collapsed');
      } else {
        // Long source — auto-expand with suggested window
        const suggested = suggestWindow(buffer, WINDOW_DEFAULT);
        setRegion(suggested);
        setMode('expanded');
      }
    }).catch(() => {
      if (!cancelled) setMode('whole-clip');
    });

    return () => { cancelled = true; };
  }, [file, collapsedByDefault]);

  // ---- wavesurfer init / teardown when mode becomes expanded or whole-clip ----
  useEffect(() => {
    if (mode !== 'expanded' && mode !== 'whole-clip') return;
    const container = waveformRef.current;
    if (!container) return;

    // Clean up any previous instance
    if (wavesurferRef.current) {
      try { wavesurferRef.current.destroy(); } catch (_) { /* ignore */ }
      wavesurferRef.current = null;
      regionsPluginRef.current = null;
      wsRegionRef.current = null;
    }

    const root = document.documentElement;
    const getCSSVar = (v: string) => {
      const val = getComputedStyle(root).getPropertyValue(v).trim();
      return val ? `hsl(${val})` : '#888';
    };

    const regPlugin = RegionsPlugin.create();
    regionsPluginRef.current = regPlugin;

    const ws = WaveSurfer.create({
      container,
      waveColor: getCSSVar('--muted'),
      progressColor: getCSSVar('--accent'),
      cursorColor: getCSSVar('--accent'),
      barWidth: 2,
      barRadius: 2,
      height: 80,
      normalize: true,
      interact: true,
      backend: 'WebAudio',
    });

    ws.registerPlugin(regPlugin);
    wavesurferRef.current = ws;

    // When ready, add the region (only for expanded mode)
    ws.on('ready', () => {
      if (mode !== 'expanded') return;
      const reg = regionsPluginRef.current;
      if (!reg) return;
      const { start, end } = regionRef.current;
      const wsReg = reg.addRegion({
        start,
        end,
        drag: true,
        resize: true,
        color: 'rgba(212,175,55,0.25)',
      });
      wsRegionRef.current = wsReg;

      // Clamp region updates
      wsReg.on('update', () => {
        const r = wsRegionRef.current;
        if (!r) return;
        const rawLen = r.end - r.start;
        const maxEnd = bufferRef.current?.duration ?? WINDOW_MAX;
        if (rawLen < WINDOW_MIN) {
          const clamped = clamp(r.start, 0, maxEnd - WINDOW_MIN);
          r.setOptions({ start: clamped, end: clamped + WINDOW_MIN });
        } else if (rawLen > WINDOW_MAX) {
          r.setOptions({ end: r.start + WINDOW_MAX });
        }
        setRegion({ start: r.start, end: r.end });
      });
      wsReg.on('update-end', () => {
        const r = wsRegionRef.current;
        if (!r) return;
        setRegion({ start: r.start, end: r.end });
      });
    });

    // Time-update for region-scoped loop / auto-stop
    ws.on('timeupdate', (time: number) => {
      const { end } = regionRef.current;
      if (time >= end) {
        if (isLoopingRef.current) {
          ws.setTime(regionRef.current.start);
        } else {
          ws.pause();
          setIsPlaying(false);
        }
      }
    });

    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));

    // Load the file
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    ws.load(url).catch(() => { /* ignore in tests */ });

    return () => {
      try { ws.destroy(); } catch (_) { /* ignore */ }
      wavesurferRef.current = null;
      regionsPluginRef.current = null;
      wsRegionRef.current = null;
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
    const ws = wavesurferRef.current;
    if (!ws) return;
    ws.setTime(regionRef.current.start);
  }, []);

  const handleLoop = useCallback(() => {
    setIsLooping((prev) => !prev);
  }, []);

  // ---- length slider ----
  const handleLengthChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newLen = clamp(Number(e.target.value), WINDOW_MIN, WINDOW_MAX);
    const buffer = bufferRef.current;
    const maxEnd = buffer?.duration ?? WINDOW_MAX;
    let newEnd = regionRef.current.start + newLen;
    let newStart = regionRef.current.start;
    if (newEnd > maxEnd) {
      newEnd = maxEnd;
      newStart = Math.max(0, maxEnd - newLen);
    }
    const updated = { start: newStart, end: newEnd };
    setRegion(updated);
    // Sync wavesurfer region
    const wsReg = wsRegionRef.current;
    if (wsReg) {
      wsReg.setOptions(updated);
    }
  }, []);

  // ---- auto-suggest ----
  const handleAutoSuggest = useCallback(() => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    const len = Math.round(regionRef.current.end - regionRef.current.start);
    const suggested = suggestWindow(buffer, len);
    setRegion(suggested);
    const wsReg = wsRegionRef.current;
    if (wsReg) wsReg.setOptions(suggested);
  }, []);

  // ---- confirm ----
  const handleConfirm = useCallback(() => {
    const buffer = bufferRef.current;
    if (!buffer) return;
    let blob: Blob;
    let dur: number;
    if (mode === 'whole-clip') {
      blob = audioBufferToWav(buffer);
      dur = buffer.duration;
    } else {
      blob = sliceToWav(buffer, region.start, region.end);
      dur = region.end - region.start;
    }
    const trimmed = new File([blob], `reference-${Date.now()}.wav`, { type: 'audio/wav' });
    onConfirm(trimmed, dur);
  }, [mode, region, onConfirm]);

  // ---- derived display values ----
  const lengthSec = mode === 'whole-clip' ? duration : region.end - region.start;
  const classification = classifyWindowLength(lengthSec);
  const showWarning = classification === 'warn';

  // ---- render helpers ----

  if (mode === 'loading') {
    return (
      <div data-testid="audio-trimmer" data-state="loading" className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
        Loading audio…
      </div>
    );
  }

  // Collapsed variant (source 15-45s)
  if (mode === 'collapsed') {
    return (
      <div data-testid="audio-trimmer" data-state="collapsed" className="rounded-lg border border-border p-3">
        <div className="flex items-center gap-3">
          <span className="text-accent font-bold">✓</span>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium">Reference ready · {formatAudioDuration(duration)}</div>
            <div
              className="text-xs text-muted-foreground"
              data-testid="trimmer-collapsed-note"
            >
              In range — using the whole clip.
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
              Adjust window <ChevronDown className="h-3 w-3" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // Short-clip or expanded variant both show the waveform
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
            {mode === 'whole-clip' ? 'Reference' : 'Trim reference'}
          </span>
          <span className="text-xs text-muted-foreground ml-1">
            {mode === 'whole-clip' ? '— whole clip' : '— pick a clean window'}
          </span>
        </div>
        <div className="text-xs text-muted-foreground" data-testid="trimmer-source">
          {file.name} · {formatAudioDuration(duration)}
        </div>
      </div>

      {/* Body */}
      <div className="p-3 space-y-2">
        {/* Waveform */}
        <div
          ref={waveformRef}
          data-testid="trimmer-waveform"
          className="w-full min-h-[80px] rounded"
        >
          {/* wavesurfer mounts here; in expanded mode also renders the region overlay */}
          {mode === 'expanded' && (
            <div data-testid="trimmer-region" className="pointer-events-none" />
          )}
        </div>

        {/* Axis + selection */}
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>{formatAudioDuration(0)}</span>
          {mode === 'expanded' && (
            <span data-testid="trimmer-selection" className="text-accent font-mono">
              {formatAudioDuration(region.start)} – {formatAudioDuration(region.end)} · selection
            </span>
          )}
          <span>{formatAudioDuration(duration)}</span>
        </div>

        {/* Length slider (only in expanded mode) */}
        {mode === 'expanded' && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Window</span>
            <input
              type="range"
              min={WINDOW_MIN}
              max={WINDOW_MAX}
              value={Math.round(region.end - region.start)}
              onChange={handleLengthChange}
              data-testid="trimmer-length"
              className="flex-1 accent-amber-500"
            />
            <span className="text-xs text-muted-foreground">15s — 45s</span>
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
            <span className="text-xs text-muted-foreground">loop selection</span>
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
              ? `${Math.round(lengthSec)}s · whole clip`
              : `${Math.round(lengthSec)}s · ${chipLabel(classification)}`}
          </span>

          {mode === 'expanded' && (
            <Button
              variant="outline"
              size="sm"
              data-testid="trimmer-autosuggest"
              onClick={handleAutoSuggest}
            >
              <Wand2 className="h-3 w-3 mr-1" />
              Auto-suggest
            </Button>
          )}
        </div>

        {/* Warning (expanded, >30s) */}
        {mode === 'expanded' && showWarning && (
          <p
            data-testid="trimmer-warning"
            className="text-xs text-amber-400"
          >
            Clones best at ~15–20s of clean speech. Longer is allowed but rarely helps.
          </p>
        )}

        {/* Short-clip note */}
        {mode === 'whole-clip' && (
          <p
            data-testid="trimmer-shortnote"
            className="text-xs text-muted-foreground"
          >
            Under the 15s window — the whole clip is used (fine for cloning; ~10s+ recommended).
          </p>
        )}

        {/* Confirm */}
        <Button
          className="w-full mt-1"
          onClick={handleConfirm}
        >
          Use this clip
        </Button>
      </div>
    </div>
  );
}
