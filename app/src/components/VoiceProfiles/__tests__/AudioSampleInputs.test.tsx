/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// Stub out the shadcn form wrappers so they render without a react-hook-form context.
vi.mock('@/components/ui/form', () => ({
  FormItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FormControl: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  FormMessage: () => null,
}));

import { AudioSampleUpload } from '@/components/VoiceProfiles/AudioSampleUpload';
import { AudioSampleRecording } from '@/components/VoiceProfiles/AudioSampleRecording';
import { AudioSampleSystem } from '@/components/VoiceProfiles/AudioSampleSystem';

const sampleFile = new File(['x'], 'clip.wav', { type: 'audio/wav' });

describe('AudioSample inputs have no Transcribe button', () => {
  it('AudioSampleUpload renders without a Transcribe button when a file is present', () => {
    render(
      <AudioSampleUpload
        file={sampleFile}
        onFileChange={vi.fn()}
        onPlayPause={vi.fn()}
        isPlaying={false}
        fieldName="file"
      />,
    );
    expect(screen.queryByRole('button', { name: /transcribe/i })).not.toBeInTheDocument();
    // Play/Remove still present (use getAllBy to handle the dropzone div[role=button] wrapper)
    expect(screen.getAllByRole('button', { name: /remove/i }).length).toBeGreaterThan(0);
  });

  it('AudioSampleRecording renders without a Transcribe button when a file is present', () => {
    render(
      <AudioSampleRecording
        file={sampleFile}
        isRecording={false}
        duration={0}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onPlayPause={vi.fn()}
        isPlaying={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /transcribe/i })).not.toBeInTheDocument();
  });

  it('AudioSampleSystem renders without a Transcribe button when a file is present', () => {
    render(
      <AudioSampleSystem
        file={sampleFile}
        isRecording={false}
        duration={0}
        onStart={vi.fn()}
        onStop={vi.fn()}
        onCancel={vi.fn()}
        onPlayPause={vi.fn()}
        isPlaying={false}
      />,
    );
    expect(screen.queryByRole('button', { name: /transcribe/i })).not.toBeInTheDocument();
  });
});
