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
  return { default: { create: vi.fn(() => { mockWs.instance = ws; return ws; }) } };
});
vi.mock('wavesurfer.js/dist/plugins/regions.js', () => {
  const region = { start: 42, end: 62, setOptions: vi.fn(), on: vi.fn(), remove: vi.fn() };
  const plugin = { on: vi.fn(), addRegion: vi.fn(() => region), getRegions: () => [region], clearRegions: vi.fn() };
  return { default: { create: vi.fn(() => plugin) } };
});

import { decodeAudioFile } from '@/lib/utils/audio';
import { AudioTrimmer } from '../AudioTrimmer';

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

  it('S4: play scopes audition to the region', async () => {
    (decodeAudioFile as any).mockResolvedValue(fakeBuffer(192));
    render(<AudioTrimmer file={makeFile()} onConfirm={vi.fn()} />);
    // Wait for the component to load and enter expanded mode (long source = 192s)
    await screen.findByTestId('trimmer-play');
    // Clear any calls from initialization
    mockWs.instance!.setTime.mockClear();
    mockWs.instance!.play.mockClear();
    // Click play — must seek to region start then call play()
    fireEvent.click(screen.getByTestId('trimmer-play'));
    // Region start is set to 42 by suggestWindow mock
    expect(mockWs.instance!.setTime).toHaveBeenCalledWith(42);
    expect(mockWs.instance!.play).toHaveBeenCalled();
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
