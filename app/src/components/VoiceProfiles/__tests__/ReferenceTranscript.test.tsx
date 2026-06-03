/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReferenceTranscript } from '@/components/VoiceProfiles/ReferenceTranscript';

const baseProps = {
  value: '',
  onChange: vi.fn(),
  status: 'idle' as const,
  isTranscribing: false,
  regeneratePrompt: false,
  onRetranscribe: vi.fn(),
  onAcceptRegenerate: vi.fn(),
  onKeepEdits: vi.fn(),
};

describe('ReferenceTranscript', () => {
  it('shows the auto-filled hint and the text when filled (S1)', () => {
    render(
      <ReferenceTranscript {...baseProps} status="filled" value="detected words" />,
    );
    expect(screen.getByTestId('transcript-autofilled-hint')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-input')).toHaveValue('detected words');
  });

  it('shows the transcribing indicator, disables Re-transcribe, but keeps the input typeable (S2)', async () => {
    render(
      <ReferenceTranscript {...baseProps} status="transcribing" isTranscribing />,
    );
    expect(screen.getByTestId('transcript-transcribing')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-retranscribe')).toBeDisabled();
    const input = screen.getByTestId('transcript-input');
    expect(input).not.toBeDisabled();
    await userEvent.type(input, 'x');
    expect(baseProps.onChange).toHaveBeenCalled();
  });

  it('shows an error note with an empty editable field and an enabled retry on failure (S4)', () => {
    render(<ReferenceTranscript {...baseProps} status="failed" value="" />);
    expect(screen.getByTestId('transcript-error')).toBeInTheDocument();
    expect(screen.getByTestId('transcript-input')).not.toBeDisabled();
    expect(screen.getByTestId('transcript-retranscribe')).not.toBeDisabled();
  });

  it('invokes onRetranscribe when Re-transcribe is clicked (S7)', async () => {
    const onRetranscribe = vi.fn();
    render(
      <ReferenceTranscript
        {...baseProps}
        status="filled"
        value="words"
        onRetranscribe={onRetranscribe}
      />,
    );
    await userEvent.click(screen.getByTestId('transcript-retranscribe'));
    expect(onRetranscribe).toHaveBeenCalledTimes(1);
  });

  it('renders the regenerate banner and wires confirm/keep buttons', async () => {
    const onAcceptRegenerate = vi.fn();
    const onKeepEdits = vi.fn();
    render(
      <ReferenceTranscript
        {...baseProps}
        status="filled"
        regeneratePrompt
        value="edited"
        onAcceptRegenerate={onAcceptRegenerate}
        onKeepEdits={onKeepEdits}
      />,
    );
    expect(screen.getByTestId('transcript-regenerate-prompt')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('transcript-regenerate-confirm'));
    expect(onAcceptRegenerate).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByTestId('transcript-regenerate-keep'));
    expect(onKeepEdits).toHaveBeenCalledTimes(1);
  });
});
