import { create } from 'zustand';

export type BooksView =
  | 'library'
  | 'import'
  | 'analysis'
  | 'overview'
  | 'voice-editor'
  | 'chapter-editor'
  | 'export';

interface BooksState {
  // Active sub-view
  view: BooksView;
  setView: (view: BooksView) => void;

  // Selection ids
  selectedBookId: string | null;
  setSelectedBookId: (id: string | null) => void;
  selectedChapterId: string | null;
  setSelectedChapterId: (id: string | null) => void;
  selectedSegmentId: string | null;
  setSelectedSegmentId: (id: string | null) => void;
  selectedCharacterId: string | null;
  setSelectedCharacterId: (id: string | null) => void;

  // Read-along playback state
  readAlongPlaying: boolean;
  setReadAlong: (playing: boolean) => void;
  currentSpokenSegmentId: string | null;
  setCurrentSpokenSegment: (id: string | null) => void;

  // Reset to initial state
  reset: () => void;
}

const INITIAL_STATE = {
  view: 'library' as BooksView,
  selectedBookId: null,
  selectedChapterId: null,
  selectedSegmentId: null,
  selectedCharacterId: null,
  readAlongPlaying: false,
  currentSpokenSegmentId: null,
};

export const useBooksStore = create<BooksState>((set) => ({
  ...INITIAL_STATE,

  setView: (view) => set({ view }),

  setSelectedBookId: (id) => set({ selectedBookId: id }),
  setSelectedChapterId: (id) => set({ selectedChapterId: id }),
  setSelectedSegmentId: (id) => set({ selectedSegmentId: id }),
  setSelectedCharacterId: (id) => set({ selectedCharacterId: id }),

  setReadAlong: (playing) => set({ readAlongPlaying: playing }),
  setCurrentSpokenSegment: (id) => set({ currentSpokenSegmentId: id }),

  reset: () => set(INITIAL_STATE),
}));
