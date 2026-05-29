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

  it('ignores heartbeats and closes the stream on unmount', () => {
    const { unmount } = renderHook(() => useBookProgress('b1', {}));
    const es = MockEventSource.instances[0];
    expect(() => es.emit('not-json' as never)).not.toThrow();   // ping/ready swallowed
    unmount();
    expect(es.closed).toBe(true);
  });
});
