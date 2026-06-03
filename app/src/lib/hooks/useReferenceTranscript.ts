import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranscription } from '@/lib/hooks/useTranscription';
import type { LanguageCode } from '@/lib/constants/languages';

export type ReferenceTranscriptStatus = 'idle' | 'transcribing' | 'filled' | 'failed';

export interface UseReferenceTranscriptArgs {
  file: File | null;
  text: string;
  setText: (value: string) => void;
  language?: LanguageCode;
}

export interface UseReferenceTranscriptResult {
  status: ReferenceTranscriptStatus;
  isTranscribing: boolean;
  regeneratePrompt: boolean;
  retranscribe: () => void;
  acceptRegenerate: () => void;
  keepEdits: () => void;
}

export function useReferenceTranscript({
  file,
  text,
  setText,
  language,
}: UseReferenceTranscriptArgs): UseReferenceTranscriptResult {
  const transcribe = useTranscription();

  const [status, setStatus] = useState<ReferenceTranscriptStatus>('idle');
  const [regeneratePrompt, setRegeneratePrompt] = useState(false);

  // Reference identity of the last file we acted on (transcribed or prompted for).
  const lastFileRef = useRef<File | null>(null);
  // The last string we auto-filled — used to detect manual edits.
  const lastAutoFilledRef = useRef<string>('');
  // Keep latest text/language available to async callbacks without re-binding effects.
  const textRef = useRef(text);
  textRef.current = text;
  const languageRef = useRef(language);
  languageRef.current = language;
  const setTextRef = useRef(setText);
  setTextRef.current = setText;

  const isEdited = useCallback(() => {
    return textRef.current.trim() !== lastAutoFilledRef.current.trim();
  }, []);

  const runTranscribe = useCallback(async (target: File) => {
    setStatus('transcribing');
    setRegeneratePrompt(false);
    try {
      const result = await transcribe.mutateAsync({
        file: target,
        language: languageRef.current,
      });
      const detected = (result?.text ?? '').trim();
      if (detected.length === 0) {
        setStatus('failed');
        return;
      }
      lastAutoFilledRef.current = detected;
      setTextRef.current(detected);
      setStatus('filled');
    } catch {
      setStatus('failed');
    }
    // transcribe.mutateAsync identity is stable for the lifetime of the hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React to a new confirmed file (by reference identity).
  useEffect(() => {
    if (!file) {
      lastFileRef.current = null;
      setStatus('idle');
      setRegeneratePrompt(false);
      return;
    }
    if (file === lastFileRef.current) {
      return; // same window — nothing to do
    }
    const isFirstFile = lastFileRef.current === null;
    lastFileRef.current = file;

    if (!isFirstFile && isEdited()) {
      // New window WHILE edited → ask, do not clobber.
      setRegeneratePrompt(true);
      return;
    }
    void runTranscribe(file);
    // isEdited / runTranscribe are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  const retranscribe = useCallback(() => {
    if (lastFileRef.current) {
      void runTranscribe(lastFileRef.current);
    }
  }, [runTranscribe]);

  const acceptRegenerate = useCallback(() => {
    if (lastFileRef.current) {
      void runTranscribe(lastFileRef.current);
    }
  }, [runTranscribe]);

  const keepEdits = useCallback(() => {
    setRegeneratePrompt(false);
  }, []);

  return {
    status,
    isTranscribing: status === 'transcribing',
    regeneratePrompt,
    retranscribe,
    acceptRegenerate,
    keepEdits,
  };
}
