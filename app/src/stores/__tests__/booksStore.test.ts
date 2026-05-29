import { beforeEach, describe, expect, it } from 'vitest';
import { useBooksStore } from '@/stores/booksStore';

beforeEach(() => useBooksStore.getState().reset());

describe('booksStore', () => {
  it('defaults to the library view with no selection', () => {
    const s = useBooksStore.getState();
    expect(s.view).toBe('library');
    expect(s.selectedBookId).toBeNull();
  });

  it('selects a book and switches view', () => {
    useBooksStore.getState().setSelectedBookId('b1');
    useBooksStore.getState().setView('overview');
    expect(useBooksStore.getState().selectedBookId).toBe('b1');
    expect(useBooksStore.getState().view).toBe('overview');
  });

  it('tracks the current read-along line', () => {
    useBooksStore.getState().setReadAlong(true);
    useBooksStore.getState().setCurrentSpokenSegment('seg-12');
    const s = useBooksStore.getState();
    expect(s.readAlongPlaying).toBe(true);
    expect(s.currentSpokenSegmentId).toBe('seg-12');
  });

  it('reset returns to the library with cleared selection', () => {
    useBooksStore.getState().setSelectedBookId('b1');
    useBooksStore.getState().setView('chapter-editor');
    useBooksStore.getState().reset();
    expect(useBooksStore.getState().view).toBe('library');
    expect(useBooksStore.getState().selectedBookId).toBeNull();
  });
});
