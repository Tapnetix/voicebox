import { useEffect, useRef } from 'react';
import { apiClient } from '@/lib/api/client';
import type {
  AnalysisCompleteEvent,
  AnalysisProgressEvent,
  BookErrorEvent,
  BookProgressEvent,
  CharacterDetectedEvent,
  ExportCompleteEvent,
  ExportProgressEvent,
  GenerationCompleteEvent,
  GenerationProgressEvent,
} from '@/lib/api/types';

export interface BookProgressHandlers {
  onAnalysisProgress?: (event: AnalysisProgressEvent) => void;
  onCharacterDetected?: (event: CharacterDetectedEvent) => void;
  onAnalysisComplete?: (event: AnalysisCompleteEvent) => void;
  onGenerationProgress?: (event: GenerationProgressEvent) => void;
  onGenerationComplete?: (event: GenerationCompleteEvent) => void;
  onExportProgress?: (event: ExportProgressEvent) => void;
  onExportComplete?: (event: ExportCompleteEvent) => void;
  onError?: (event: BookErrorEvent) => void;
}

/**
 * Opens one EventSource at apiClient.getBookEventsUrl(bookId) and dispatches
 * contract-04 SSE events by type discriminator to the provided handler callbacks.
 * Tears down (source.close()) on unmount or bookId change.
 * Does NOT invalidate queries — let consumers decide.
 */
export function useBookProgress(bookId: string, handlers: BookProgressHandlers): void {
  // Keep a ref to the handlers to avoid stale closures
  const handlersRef = useRef<BookProgressHandlers>(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!bookId) return;

    const url = apiClient.getBookEventsUrl(bookId);
    const source = new EventSource(url);

    source.onmessage = (event: MessageEvent) => {
      try {
        const data: BookProgressEvent = JSON.parse(event.data as string);
        const h = handlersRef.current;

        switch (data.type) {
          case 'analysis_progress':
            h.onAnalysisProgress?.(data);
            break;
          case 'character_detected':
            h.onCharacterDetected?.(data);
            break;
          case 'analysis_complete':
            h.onAnalysisComplete?.(data);
            break;
          case 'generation_progress':
            h.onGenerationProgress?.(data);
            break;
          case 'generation_complete':
            h.onGenerationComplete?.(data);
            break;
          case 'export_progress':
            h.onExportProgress?.(data);
            break;
          case 'export_complete':
            h.onExportComplete?.(data);
            break;
          case 'error':
            h.onError?.(data);
            break;
          // ready/ping heartbeats have no known type — fall through silently
        }
      } catch {
        // Swallow parse errors from ready/ping heartbeats
      }
    };

    source.onerror = () => {
      // Transient connection error — do NOT close; let EventSource auto-reconnect.
      // Notify the optional error handler so the UI can show a retry indicator.
      handlersRef.current.onError?.({ type: 'error', stage: 'connection', message: 'SSE connection error' });
    };

    return () => {
      source.close();
    };
  }, [bookId]);
}
