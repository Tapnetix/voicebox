import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useBookProgress } from '@/lib/hooks/useBookProgress';

class MockEventSource {
  static instances: MockEventSource[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { MockEventSource.instances.push(this); }
  close() { this.closed = true; }
  emit(obj: unknown) { this.onmessage?.({ data: JSON.stringify(obj) } as MessageEvent); }
  triggerError() { this.onerror?.(); }
}

beforeEach(() => { (globalThis as any).EventSource = MockEventSource; MockEventSource.instances = []; });
afterEach(() => vi.restoreAllMocks());

describe('useBookProgress', () => {
  it('dispatches character_detected and analysis_complete by type', () => {
    const onChar = vi.fn();
    const onDone = vi.fn();
    renderHook(() => useBookProgress('b1', { onCharacterDetected: onChar, onAnalysisComplete: onDone }));
    const es = MockEventSource.instances[0];
    expect(es.url).toMatch(/\/events\/books\/b1$/);
    es.emit({ type: 'character_detected', character: { id: 'c1', name: 'Mira' }, total: 1 });
    es.emit({ type: 'analysis_complete', character_count: 1, chapter_count: 3 });
    expect(onChar).toHaveBeenCalledWith(expect.objectContaining({ character: expect.any(Object) }));
    expect(onDone).toHaveBeenCalledWith(expect.objectContaining({ chapter_count: 3 }));
  });

  it('dispatches analysis_progress with contract-04 shape (stage/progress)', () => {
    const onProgress = vi.fn();
    renderHook(() => useBookProgress('b1', { onAnalysisProgress: onProgress }));
    const es = MockEventSource.instances[0];
    es.emit({ type: 'analysis_progress', stage: 'detect', progress: 50 });
    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'detect', progress: 50 }),
    );
  });

  it('dispatches generation_progress with contract-04 shape (completed/errors/total/overall_progress)', () => {
    const onGenProgress = vi.fn();
    renderHook(() => useBookProgress('b1', { onGenerationProgress: onGenProgress }));
    const es = MockEventSource.instances[0];
    es.emit({ type: 'generation_progress', chapter_id: 'ch1', completed: 3, errors: 0, total: 10, overall_progress: 30 });
    expect(onGenProgress).toHaveBeenCalledWith(
      expect.objectContaining({ chapter_id: 'ch1', completed: 3, total: 10, overall_progress: 30 }),
    );
  });

  it('dispatches export_complete with contract-04 shape (download_path + filename)', () => {
    const onExportComplete = vi.fn();
    renderHook(() => useBookProgress('b1', { onExportComplete }));
    const es = MockEventSource.instances[0];
    es.emit({ type: 'export_complete', download_path: '/tmp/book.m4b', filename: 'book.m4b' });
    expect(onExportComplete).toHaveBeenCalledWith(
      expect.objectContaining({ download_path: '/tmp/book.m4b', filename: 'book.m4b' }),
    );
  });

  it('dispatches error with contract-04 shape (stage + message)', () => {
    const onError = vi.fn();
    renderHook(() => useBookProgress('b1', { onError }));
    const es = MockEventSource.instances[0];
    es.emit({ type: 'error', stage: 'cast', message: 'Voice assignment failed' });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ stage: 'cast', message: 'Voice assignment failed' }),
    );
  });

  it('ignores heartbeats and closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useBookProgress('b1', {}));
    const es = MockEventSource.instances[0];
    expect(() => es.emit('not-json' as never)).not.toThrow();   // ping/ready swallowed
    unmount();
    expect(es.closed).toBe(true);
  });

  it('does NOT close the stream on transient onerror (allows auto-reconnect)', () => {
    const onError = vi.fn();
    renderHook(() => useBookProgress('b1', { onError }));
    const es = MockEventSource.instances[0];
    es.triggerError();
    // Source must remain open so EventSource can auto-reconnect
    expect(es.closed).toBe(false);
    // onError handler is notified
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', stage: 'connection' }),
    );
  });

  it('does NOT close stream on transient error even without onError handler', () => {
    renderHook(() => useBookProgress('b1', {}));
    const es = MockEventSource.instances[0];
    expect(() => es.triggerError()).not.toThrow();
    expect(es.closed).toBe(false);
  });
});
