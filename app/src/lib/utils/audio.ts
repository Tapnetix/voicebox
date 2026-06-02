// ---------------------------------------------------------------------------
// Voice-clone trimmer — window constants
// ---------------------------------------------------------------------------

export const WINDOW_MIN = 15;
export const WINDOW_MAX = 45;
export const WINDOW_DEFAULT = 20;
export const WINDOW_WARN = 30;
export const IDEAL_MIN = 15;
export const IDEAL_MAX = 20;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 'ideal' for 15-20s, 'neutral' for 20<len<=30, 'warn' for >30s. */
export function classifyWindowLength(lengthSec: number): 'ideal' | 'neutral' | 'warn' {
  if (lengthSec > WINDOW_WARN) return 'warn';
  if (lengthSec <= IDEAL_MAX) return 'ideal';
  return 'neutral';
}

/**
 * Fully decode an audio File to an AudioBuffer.
 * Always decodes the real samples (ignores any recordedDuration shortcut) because
 * the trimmer needs the actual samples for RMS suggestion and slicing.
 */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await file.arrayBuffer();
    return await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    await audioContext.close();
  }
}

/**
 * Sliding-window RMS over the decoded samples — picks the highest-energy
 * contiguous window of `windowSec` (clamped to WINDOW_MIN..WINDOW_MAX) as a
 * clean-speech proxy. Sources shorter than WINDOW_MIN return the whole clip.
 */
export function suggestWindow(
  buffer: AudioBuffer,
  windowSec: number,
): { start: number; end: number } {
  const duration = buffer.duration;
  if (duration <= WINDOW_MIN) return { start: 0, end: duration };

  const len = clamp(windowSec, WINDOW_MIN, Math.min(WINDOW_MAX, duration));
  const sr = buffer.sampleRate;
  const data = buffer.getChannelData(0);

  // Coarse frame grid (20ms) of squared-sum energy for a fast prefix sum.
  const frameLen = Math.max(1, Math.floor(sr * 0.02));
  const nFrames = Math.floor(data.length / frameLen);
  const energy = new Float64Array(nFrames + 1); // prefix sum of frame energies
  for (let f = 0; f < nFrames; f++) {
    let sum = 0;
    const base = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const v = data[base + i];
      sum += v * v;
    }
    energy[f + 1] = energy[f] + sum;
  }

  const winFrames = Math.max(1, Math.round((len * sr) / frameLen));
  let bestStartFrame = 0;
  let bestEnergy = -1;
  for (let f = 0; f + winFrames <= nFrames; f++) {
    const e = energy[f + winFrames] - energy[f];
    if (e > bestEnergy) {
      bestEnergy = e;
      bestStartFrame = f;
    }
  }

  let start = (bestStartFrame * frameLen) / sr;
  let end = start + len;
  if (end > duration) {
    end = duration;
    start = Math.max(0, end - len);
  }
  return { start, end };
}

/**
 * Slice [startSec, endSec) out of the decoded buffer and encode it as WAV.
 * Reuses the exported audioBufferToWav encoder.
 */
export function sliceToWav(buffer: AudioBuffer, startSec: number, endSec: number): Blob {
  const sr = buffer.sampleRate;
  const start = clamp(Math.floor(startSec * sr), 0, buffer.length);
  const end = clamp(Math.floor(endSec * sr), start, buffer.length);
  const sliceLen = end - start;

  // Build a minimal AudioBuffer-shaped object holding only the slice.
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = new Float32Array(sliceLen);
    ch.set(buffer.getChannelData(c).subarray(start, end));
    channels.push(ch);
  }
  const out: AudioBuffer = {
    numberOfChannels: buffer.numberOfChannels,
    sampleRate: sr,
    length: sliceLen,
    duration: sliceLen / sr,
    getChannelData: (c: number) => channels[c],
  } as unknown as AudioBuffer;

  return audioBufferToWav(out);
}

// ---------------------------------------------------------------------------

export function createAudioUrl(audioId: string, serverUrl: string): string {
  return `${serverUrl}/audio/${audioId}`;
}

export function downloadAudio(url: string, filename: string): void {
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function formatAudioDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Get audio duration from a File.
 * If the file has a recordedDuration property (from recording hooks),
 * use that instead of trying to read metadata. This fixes issues on Windows
 * where WebM files from MediaRecorder don't have proper duration metadata.
 *
 * For uploaded files we use AudioContext.decodeAudioData which fully decodes
 * the audio and returns the exact duration. This is more reliable than
 * HTMLMediaElement.duration which can return incorrect large values for VBR
 * MP3 files that lack a proper XING/VBRI header.
 */
export async function getAudioDuration(
  file: File & { recordedDuration?: number },
): Promise<number> {
  if (file.recordedDuration !== undefined && Number.isFinite(file.recordedDuration)) {
    return file.recordedDuration;
  }

  // Use Web Audio API for accurate duration — avoids VBR MP3 metadata issues.
  try {
    const audioContext = new AudioContext();
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      return audioBuffer.duration;
    } finally {
      await audioContext.close();
    }
  } catch {
    // Fallback: read duration from the media element (less accurate but works for WAV).
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      const url = URL.createObjectURL(file);

      audio.addEventListener('loadedmetadata', () => {
        URL.revokeObjectURL(url);
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          resolve(audio.duration);
        } else {
          reject(new Error('Audio file has invalid duration metadata'));
        }
      });

      audio.addEventListener('error', () => {
        URL.revokeObjectURL(url);
        reject(new Error('Failed to load audio file'));
      });

      audio.src = url;
    });
  }
}

/**
 * Convert any audio blob to WAV format using Web Audio API.
 * This ensures compatibility without requiring ffmpeg on the backend.
 */
export async function convertToWav(audioBlob: Blob): Promise<Blob> {
  // Create audio context
  const audioContext = new AudioContext();

  // Read blob as array buffer
  const arrayBuffer = await audioBlob.arrayBuffer();

  // Decode audio data
  const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

  // Convert to WAV
  const wavBlob = audioBufferToWav(audioBuffer);

  // Close audio context to free resources
  await audioContext.close();

  return wavBlob;
}

/**
 * Convert AudioBuffer to WAV blob.
 */
export function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numberOfChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;

  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;

  // Interleave channels
  const interleaved = interleaveChannels(buffer);

  // Create WAV file
  const dataLength = interleaved.length * bytesPerSample;
  const buffer2 = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer2);

  // Write WAV header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, format, true); // audio format (PCM)
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(view, 36, 'data');
  view.setUint32(40, dataLength, true);

  // Write audio data
  floatTo16BitPCM(view, 44, interleaved);

  return new Blob([buffer2], { type: 'audio/wav' });
}

/**
 * Interleave multiple channels into a single array.
 */
function interleaveChannels(buffer: AudioBuffer): Float32Array {
  const numberOfChannels = buffer.numberOfChannels;
  const length = buffer.length;
  const interleaved = new Float32Array(length * numberOfChannels);

  for (let channel = 0; channel < numberOfChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++) {
      interleaved[i * numberOfChannels + channel] = channelData[i];
    }
  }

  return interleaved;
}

/**
 * Write string to DataView.
 */
function writeString(view: DataView, offset: number, string: string): void {
  for (let i = 0; i < string.length; i++) {
    view.setUint8(offset + i, string.charCodeAt(i));
  }
}

/**
 * Convert float32 audio data to 16-bit PCM.
 */
function floatTo16BitPCM(view: DataView, offset: number, input: Float32Array): void {
  for (let i = 0; i < input.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}
