import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { useBooks } from '@/lib/hooks/useBooks';
import { cn } from '@/lib/utils/cn';
import type { BookResponse, BookStatus } from '@/lib/api/types';
import { useBooksStore } from '@/stores/booksStore';

// Status badge variant mapping
function statusVariant(status: BookStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (status) {
    case 'analyzed':
    case 'completed':
      return 'default';
    case 'generating':
    case 'analyzing':
      return 'secondary';
    case 'error':
      return 'destructive';
    default:
      return 'outline';
  }
}

interface BookCardProps {
  book: BookResponse;
  onSelect: (book: BookResponse) => void;
}

function BookCard({ book, onSelect }: BookCardProps) {
  const { t } = useTranslation();

  const statusLabel =
    t(`books.status.${book.status}`, { defaultValue: book.status });

  return (
    <Card
      className="cursor-pointer hover:bg-accent transition-colors"
      onClick={() => onSelect(book)}
    >
      <CardContent className="p-4">
        <div className="flex items-start gap-3">
          {/* Cover placeholder */}
          <div
            className="w-[54px] h-[78px] rounded-md shrink-0 bg-muted border border-border"
            aria-hidden
          />
          <div className="flex-1 min-w-0">
            <div className="font-semibold truncate">{book.title}</div>
            {book.author && (
              <div className="text-sm text-muted-foreground truncate">{book.author}</div>
            )}
            <div className="flex flex-wrap gap-1.5 mt-2">
              <Badge variant={statusVariant(book.status)}>{statusLabel}</Badge>
              <Badge variant="secondary">
                {t('books.chapters', { count: book.chapter_count })}
              </Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function BookLibrary() {
  const { t } = useTranslation();
  const { data: books = [], isLoading } = useBooks();
  const setView = useBooksStore((s) => s.setView);
  const setSelectedBookId = useBooksStore((s) => s.setSelectedBookId);

  function handleSelectBook(book: BookResponse) {
    setSelectedBookId(book.id);
    // Books still being processed go to analysis view, ready books go to overview
    const analysisStatuses: BookStatus[] = ['analyzing', 'imported'];
    if (analysisStatuses.includes(book.status)) {
      setView('analysis');
    } else {
      setView('overview');
    }
  }

  function handleImport() {
    setView('import');
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('books.title')}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">{t('books.subtitle')}</p>
        </div>
        {books.length > 0 && (
          <Button onClick={handleImport} data-testid="import-book-btn">
            {t('books.import.btn')}
          </Button>
        )}
      </div>

      {books.length === 0 ? (
        /* Empty state */
        <Card data-testid="book-grid" className={cn('mt-2 text-center')}>
          <CardContent className="py-12 flex flex-col items-center gap-4">
            <p className="text-muted-foreground max-w-sm">{t('books.empty')}</p>
            <Button onClick={handleImport} data-testid="import-book-btn">
              {t('books.import.btn')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        /* Book grid */
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
          data-testid="book-grid"
        >
          {books.map((book) => (
            <BookCard key={book.id} book={book} onSelect={handleSelectBook} />
          ))}
        </div>
      )}
    </div>
  );
}
