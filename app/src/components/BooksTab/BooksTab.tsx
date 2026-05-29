import { useBooksStore } from '@/stores/booksStore';
import { AnalysisProgress } from './AnalysisProgress';
import { AudiobookExport } from './AudiobookExport';
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
      return <AudiobookExport />;

    default:
      return null;
  }
}
