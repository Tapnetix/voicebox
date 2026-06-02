import { describe, expect, it, vi } from 'vitest';
import {
  WINDOW_MIN,
  WINDOW_MAX,
  WINDOW_DEFAULT,
  WINDOW_WARN,
  IDEAL_MIN,
  IDEAL_MAX,
  decodeAudioFile,
  suggestWindow,
  sliceToWav,
  classifyWindowLength,
  audioBufferToWav,
} from '../audio';

// Minimal AudioBuffer stand-in. getChannelData returns the backing Float32Array.
function fakeBuffer(samples: Float32Array, sampleRate = 24000): AudioBuffer {
  return {
    numberOfChannels: 1,
    sampleRate,
    length: samples.length,
    duration: samples.length / sampleRate,
    getChannelData: () => samples,
  } as unknown as AudioBuffer;
}

// 60s buffer: silence everywhere except a loud band at 30s-50s.
function buildBuffer(): AudioBuffer {
  const sr = 24000;
  const total = 60 * sr;
  const s = new Float32Array(total);
  for (let i = 30 * sr; i < 50 * sr; i++) s[i] = 0.8;
  return fakeBuffer(s, sr);
}

describe('window constants', () => {
  it('are the documented values', () => {
    expect(WINDOW_MIN).toBe(15);
    expect(WINDOW_MAX).toBe(45);
    expect(WINDOW_DEFAULT).toBe(20);
    expect(WINDOW_WARN).toBe(30);
    expect(IDEAL_MIN).toBe(15);
    expect(IDEAL_MAX).toBe(20);
  });
});

describe('suggestWindow', () => {
  it('picks the highest-energy contiguous window', () => {
    const { start, end } = suggestWindow(buildBuffer(), WINDOW_DEFAULT);
    expect(end - start).toBeCloseTo(WINDOW_DEFAULT, 1);
    // The 20s default window should sit inside the loud 30-50s band.
    expect(start).toBeGreaterThanOrEqual(30 - 1);
    expect(end).toBeLessThanOrEqual(50 + 1);
  });

  it('clamps the requested length into 15-45', () => {
    const big = suggestWindow(buildBuffer(), 999);
    expect(big.end - big.start).toBeCloseTo(WINDOW_MAX, 1);
    const small = suggestWindow(buildBuffer(), 1);
    expect(small.end - small.start).toBeCloseTo(WINDOW_MIN, 1);
  });

  it('returns the whole clip when the source is shorter than WINDOW_MIN', () => {
    const sr = 24000;
    const short = fakeBuffer(new Float32Array(9 * sr).fill(0.5), sr); // 9s
    const { start, end } = suggestWindow(short, WINDOW_DEFAULT);
    expect(start).toBe(0);
    expect(end).toBeCloseTo(9, 2);
  });
});

describe('classifyWindowLength', () => {
  it('labels ideal / neutral / warn bands', () => {
    expect(classifyWindowLength(15)).toBe('ideal');
    expect(classifyWindowLength(20)).toBe('ideal'); // inclusive top of ideal band
    expect(classifyWindowLength(25)).toBe('neutral');
    expect(classifyWindowLength(31)).toBe('warn');
  });
});

describe('sliceToWav', () => {
  it('encodes ~N seconds of the buffer into a WAV blob', () => {
    const sr = 24000;
    const buf = fakeBuffer(new Float32Array(60 * sr).fill(0.3), sr);
    const wav = sliceToWav(buf, 30, 50); // 20s slice
    expect(wav.type).toBe('audio/wav');
    // 20s mono 16-bit @24k = 20*24000*2 bytes + 44 header.
    const expectedData = 20 * sr * 2;
    expect(wav.size).toBeCloseTo(44 + expectedData, -2);
  });
});

describe('audioBufferToWav (now exported)', () => {
  it('produces a RIFF/WAVE header', async () => {
    const sr = 24000;
    const buf = fakeBuffer(new Float32Array(sr).fill(0.1), sr);
    const blob = audioBufferToWav(buf);
    // jsdom's Blob does not expose .arrayBuffer() directly; use FileReader.
    const ab = await new Promise<ArrayBuffer>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(blob);
    });
    const head = new TextDecoder().decode(ab.slice(0, 4));
    expect(head).toBe('RIFF');
  });
});

describe('decodeAudioFile', () => {
  it('decodes the file via AudioContext and closes the context', async () => {
    const fake = { numberOfChannels: 1, sampleRate: 24000, length: 3, duration: 3 / 24000 } as unknown as AudioBuffer;
    const decodeAudioData = vi.fn().mockResolvedValue(fake);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        close = close;
      },
    );
    const file = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(8)) } as unknown as File;

    const result = await decodeAudioFile(file);

    expect(result).toBe(fake);
    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1); // closed in finally
    vi.unstubAllGlobals();
  });
});
