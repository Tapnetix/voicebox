import '@/i18n';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// --- mocks ---
const fakeBuffer = (durationSec: number) => ({
  numberOfChannels: 1,
  sampleRate: 24000,
  length: durationSec * 24000,
  duration: durationSec,
  getChannelData: () => new Float32Array(durationSec * 24000),
});

vi.mock('@/lib/utils/audio', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/utils/audio')>();
  return {
    ...actual,
    decodeAudioFile: vi.fn(),
    sliceToWav: vi.fn(() => new Blob(['x'], { type: 'audio/wav' })),
    audioBufferToWav: vi.fn(() => new Blob(['x'], { type: 'audio/wav' })),
    suggestWindow: vi.fn((_buf, len) => ({ start: 42, end: 42 + Math.min(len, 45) })),
  };
});

// Shared container so the vi.mock factory (which is hoisted) can write the instance
// and tests (which run later) can read it. Using an object avoids the TDZ issue.
const mockWs = {
  instance: null as null | {
    play: ReturnType<typeof vi.fn>;
    setTime: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    seekTo: ReturnType<typeof vi.fn>;
    [key: string]: any;
  },
  // Invoke recorded wavesurfer event handlers (e.g. 'interaction') from tests.
  fire: undefined as undefined | ((event: string, ...args: any[]) => void),
};

// Minimal wavesurfer + regions mock — record handlers so tests can fire region updates.
vi.mock('wavesurfer.js', () => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const ws = {
    registerPlugin: (p: any) => p,
    on: (e: string, cb: any) => ((handlers[e] ??= []).push(cb)),
    play: vi.fn(), pause: vi.fn(), setTime: vi.fn(), getCurrentTime: () => 0,
    getDuration: () => 192, destroy: vi.fn(), seekTo: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    isPlaying: vi.fn(() => false),
  };
  return {
    default: {
      create: vi.fn(() => {
        mockWs.instance = ws;
        mockWs.fire = (event: string, ...args: any[]) => {
          for (const cb of handlers[event] ?? []) cb(...args);
        };
        return ws;
      }),
    },
  };
});
vi.mock('wavesurfer.js/dist/plugins/regions.js', () => {
  const region = { start: 42, end: 62, setOptions: vi.fn(), on: vi.fn(), remove: vi.fn() };
  const plugin = { on: vi.fn(), addRegion: vi.fn(() => region), getRegions: () => [region], clearRegions: vi.fn() };
  return { default: { create: vi.fn(() => plugin) } };
});

import { decodeAudioFile } from '@/lib/utils/audio';
import { AudioTrimmer, placeWindow } from '../AudioTrimmer';

describe('placeWindow (pure selection geometry)', () => {
  it('anchors a window at the given start, clamped to the clip end', () => {
    expect(placeWindow(0, 20, 192)).toEqual({ start: 0, end: 20 });
    expect(placeWindow(134.4, 20, 192)).toEqual({ start: 134.4, end: 154.4 });
    // Past the end → shifts back so the window still fits.
    expect(placeWindow(190, 20, 192)).toEqual({ start: 172, end: 192 });
    // Length clamped to [15,45].
    expect(placeWindow(0, 5, 192)).toEqual({ start: 0, end: 15 });
    expect(placeWindow(0, 60, 192)).toEqual({ start: 0, end: 45 });
  });
});

const makeFile = (name = 'interview.wav') => new File(['data'], name, { type: 'audio/wav' });

beforeEach(() => vi.clearAllMocks());

describe('AudioTrimmer', () => {
  it('S1: long source auto-expands with a ~20s window and "ideal" chip', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192)); // 3:12
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    const root = await screen.findByTestId('audio-trimmer');
    expect(root).toHaveAttribute('data-state', 'expanded');
    expect(screen.getByTestId('trimmer-length-chip')).toHaveTextContent(/20s.*ideal/i);
    expect(screen.getByTestId('trimmer-region')).toBeInTheDocument();
  });

  it('S2: changing the length control updates selection + chip, clamped to 15-45', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192));
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    const slider = await screen.findByTestId('trimmer-length');
    fireEvent.change(slider, { target: { value: '25' } });
    expect(screen.getByTestId('trimmer-length-chip')).toHaveTextContent(/25s/);
    expect(screen.getByTestId('trimmer-selection')).toHaveTextContent(/selection/i);
  });

  it('S3: a >30s window shows the warning and keeps confirm enabled', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192));
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    const slider = await screen.findByTestId('trimmer-length');
    fireEvent.change(slider, { target: { value: '38' } });
    expect(screen.getByTestId('trimmer-warning')).toBeInTheDocument();
    expect(screen.getByTestId('trimmer-length-chip')).toHaveTextContent(/longer than recommended/i);
    // Confirm button still enabled (find by role/name "Use this clip").
    expect(screen.getByRole('button', { name: /use this clip/i })).not.toBeDisabled();
  });

  it('S4: play scopes audition to the region (defaults to start; auto-suggest jumps to the energy window)', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192));
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    await screen.findByTestId('trimmer-play');
    mockWs.instance!.setTime.mockClear();
    mockWs.instance!.play.mockClear();
    // Long source now anchors the window at the START of the clip → play seeks to 0.
    fireEvent.click(screen.getByTestId('trimmer-play'));
    expect(mockWs.instance!.setTime).toHaveBeenCalledWith(0);
    expect(mockWs.instance!.play).toHaveBeenCalled();
    // Auto-suggest opt-in jumps the window to the highest-energy span (mock start=42).
    mockWs.instance!.setTime.mockClear();
    fireEvent.click(screen.getByTestId('trimmer-autosuggest'));
    fireEvent.click(screen.getByTestId('trimmer-play'));
    expect(mockWs.instance!.setTime).toHaveBeenCalledWith(42);
  });

  it('S4b: clicking the waveform moves the selection window to start at the clicked time', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192)); // 3:12
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    const track = await screen.findByTestId('trimmer-waveform');
    // jsdom has no layout — give the track a real rect so px↔time maths work.
    track.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 300, bottom: 80, width: 300, height: 80, x: 0, y: 0, toJSON() {} }) as DOMRect;
    // Click at 70% width → 0.7 * 192s ≈ 134s; a 20s window lands at ~2:14–2:34.
    fireEvent.click(track, { clientX: 210, clientY: 40 });
    await waitFor(() =>
      expect(screen.getByTestId('trimmer-selection')).toHaveTextContent(/2:14\s*–\s*2:34/),
    );
    // And the on-screen region BOX is positioned from the same state (left ≈ 70%).
    const box = screen.getByTestId('trimmer-region');
    const left = parseFloat((box as HTMLElement).style.left);
    expect(left).toBeGreaterThan(65);
    expect(left).toBeLessThan(75);
    // Play auditions from the (new) window start.
    mockWs.instance!.setTime.mockClear();
    fireEvent.click(screen.getByTestId('trimmer-play'));
    expect(mockWs.instance!.setTime).toHaveBeenCalledWith(expect.closeTo(134.4, 1));
  });

  it('S5: an in-range clip rests collapsed and expands on demand', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(18)); // 0:18
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    const root = await screen.findByTestId('audio-trimmer');
    expect(root).toHaveAttribute('data-state', 'collapsed');
    expect(screen.getByTestId('trimmer-collapsed-note')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('trimmer-expand'));
    await waitFor(() =>
      expect(screen.getByTestId('audio-trimmer')).toHaveAttribute('data-state', 'expanded'),
    );
  });

  it('S6: confirm sends only the sliced span', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192));
    const onConfirm = vi.fn();
    render(<AudioTrimmer file={makeFile()} onConfirm={onConfirm} />);
    await screen.findByTestId('audio-trimmer');
    fireEvent.click(screen.getByRole('button', { name: /use this clip/i }));
    expect(onConfirm).toHaveBeenCalledWith(expect.any(File), expect.any(Number));
    const [, dur] = onConfirm.mock.calls[0];
    expect(dur).toBeGreaterThanOrEqual(15);
    expect(dur).toBeLessThanOrEqual(45);
  });

  it('S7: a <15s source uses the whole clip with no region picker', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(9)); // 0:09
    render(<AudioTrimmer file={makeFile('memo.m4a')} onConfirm={vi.fn()} />);
    const root = await screen.findByTestId('audio-trimmer');
    expect(root).toHaveAttribute('data-state', 'whole-clip');
    expect(screen.getByTestId('trimmer-shortnote')).toBeInTheDocument();
    expect(screen.queryByTestId('trimmer-region')).not.toBeInTheDocument();
    expect(screen.getByTestId('trimmer-length-chip')).toHaveTextContent(/whole clip/i);
  });
});
