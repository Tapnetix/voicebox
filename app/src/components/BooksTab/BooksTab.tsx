import { useBooksStore } from '@/stores/booksStore';
import { BookLibrary } from './BookLibrary';

/**
 * BooksTab — view router for the Books section.
 *
 * Only the `library` arm is implemented here (C5). The remaining arms
 * (import, analysis, overview, voice-editor, chapter-editor, export) are
 * wired in C16 once the corresponding components (C6, C7, C8, C10, C14, D7)
 * exist. Importing missing modules breaks tsc/build, so each stub returns null
 * until C16 fills them in.
 */
export function BooksTab() {
  const view = useBooksStore((s) => s.view);

  switch (view) {
    case 'library':
      return <BookLibrary />;

    // TODO (C16): replace these stubs with the real components once they land
    case 'import':       // BookImport (C6)
    case 'analysis':     // AnalysisProgress (C7)
    case 'overview':     // BookOverview (C8)
    case 'voice-editor': // VoiceEditor (C10)
    case 'chapter-editor': // ChapterEditor (C14)
    case 'export':       // AudiobookExport (D7)
      return null;

    default:
      return null;
  }
}
