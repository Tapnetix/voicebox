import { useBooksStore } from '@/stores/booksStore';
import { AnalysisProgress } from './AnalysisProgress';
import { BookImport } from './BookImport';
import { BookLibrary } from './BookLibrary';
import { BookOverview } from './BookOverview';
import { ChapterEditor } from './ChapterEditor';
import { VoiceEditor } from './VoiceEditor';

/**
 * BooksTab — view router for the Books section.
 *
 * Sub-view routing is store-driven (booksStore.view). The route /books is a
 * single TanStack route; all sub-views are rendered here based on the store.
 *
 * export arm is left as a null placeholder — AudiobookExport is phase D (D7)
 * and is not built yet.
 */
export function BooksTab() {
  const view = useBooksStore((s) => s.view);

  switch (view) {
    case 'library':
      return <BookLibrary />;

    case 'import':
      return <BookImport />;

    case 'analysis':
      return <AnalysisProgress />;

    case 'overview':
      return <BookOverview />;

    case 'voice-editor':
      return <VoiceEditor />;

    case 'chapter-editor':
      return <ChapterEditor />;

    case 'export':
      // AudiobookExport is phase D (D7) — not built yet
      return null;

    default:
      return null;
  }
}
