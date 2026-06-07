import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranscription } from '@/lib/hooks/useTranscription';
import type { LanguageCode } from '@/lib/constants/languages';

export type ReferenceTranscriptStatus =
  | 'idle'
  | 'transcribing'
  | 'downloading'
  | 'filled'
  | 'failed';

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

// First-run transcription triggers a one-time Whisper model download; the
// backend returns HTTP 202 (surfaced by apiClient as an error with this code).
// We show a "downloading" state and poll until the model is ready.
const DOWNLOAD_RETRY_MS = 4000;
const MAX_DOWNLOAD_RETRIES = 75; // ~5 min ceiling

function isModelDownloading(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'MODEL_DOWNLOADING';
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

  // Pending model-download retry timer + a self-ref so a scheduled retry can
  // re-invoke the latest runTranscribe without it depending on itself.
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runTranscribeRef = useRef<(target: File, attempt?: number) => void>(() => {});
  const clearRetry = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
  }, []);

  const isEdited = useCallback(() => {
    return textRef.current.trim() !== lastAutoFilledRef.current.trim();
  }, []);

  const runTranscribe = useCallback(
    async (target: File, attempt = 0) => {
      clearRetry();
      // attempt 0 = fresh STT; subsequent attempts mean we're waiting on the
      // one-time model download, so keep showing the "downloading" state.
      setStatus(attempt === 0 ? 'transcribing' : 'downloading');
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
      } catch (e) {
        if (isModelDownloading(e) && attempt < MAX_DOWNLOAD_RETRIES) {
          // One-time Whisper model download in progress: show it and auto-retry.
          setStatus('downloading');
          retryTimerRef.current = setTimeout(() => {
            runTranscribeRef.current(target, attempt + 1);
          }, DOWNLOAD_RETRY_MS);
          return;
        }
        setStatus('failed');
      }
      // transcribe.mutateAsync identity is stable for the lifetime of the hook.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [clearRetry],
  );
  runTranscribeRef.current = runTranscribe;

  // React to a new confirmed file (by reference identity).
  useEffect(() => {
    if (!file) {
      clearRetry();
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
    clearRetry(); // cancel any pending retry from a previous clip

    if (!isFirstFile && isEdited()) {
      // New window WHILE edited → ask, do not clobber.
      setRegeneratePrompt(true);
      return;
    }
    void runTranscribe(file);
    // isEdited / runTranscribe / clearRetry are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // Cancel a pending retry on unmount.
  useEffect(() => () => clearRetry(), [clearRetry]);

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
    isTranscribing: status === 'transcribing' || status === 'downloading',
    regeneratePrompt,
    retranscribe,
    acceptRegenerate,
    keepEdits,
  };
}
