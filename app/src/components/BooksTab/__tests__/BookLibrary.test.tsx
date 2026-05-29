/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach, type Mock } from 'vitest';
import { BookLibrary } from '@/components/BooksTab/BookLibrary';

vi.mock('@/lib/hooks/useBooks', () => ({ useBooks: vi.fn() }));
import { useBooks } from '@/lib/hooks/useBooks';

// Reset booksStore between tests
import { useBooksStore } from '@/stores/booksStore';

const wrap = (ui: React.ReactNode) => (
  <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);

describe('BookLibrary', () => {
  beforeEach(() => {
    useBooksStore.getState().reset();
  });

  it('lists books with status + chapter count', () => {
    (useBooks as unknown as Mock).mockReturnValue({
      data: [{ id: 'b1', title: 'Silo 42', author: 'Zev Paiss', status: 'analyzed', chapter_count: 23 }],
      isLoading: false,
    });
    render(wrap(<BookLibrary />));
    expect(screen.getByText('Silo 42')).toBeInTheDocument();
    expect(screen.getByText(/analyzed/i)).toBeInTheDocument();
    expect(screen.getByTestId('book-grid')).toBeInTheDocument();
  });

  it('shows author when provided', () => {
    (useBooks as unknown as Mock).mockReturnValue({
      data: [{ id: 'b1', title: 'Silo 42', author: 'Zev Paiss', status: 'analyzed', chapter_count: 23 }],
      isLoading: false,
    });
    render(wrap(<BookLibrary />));
    expect(screen.getByText('Zev Paiss')).toBeInTheDocument();
  });

  it('shows the empty-state import CTA when there are no books', () => {
    (useBooks as unknown as Mock).mockReturnValue({ data: [], isLoading: false });
    render(wrap(<BookLibrary />));
    expect(screen.getByTestId('import-book-btn')).toBeInTheDocument();
    expect(screen.getByText(/import an epub/i)).toBeInTheDocument();
  });

  it('clicking the import button sets view to import', () => {
    (useBooks as unknown as Mock).mockReturnValue({ data: [], isLoading: false });
    render(wrap(<BookLibrary />));
    fireEvent.click(screen.getByTestId('import-book-btn'));
    expect(useBooksStore.getState().view).toBe('import');
  });

  it('clicking an analyzed book sets selectedBookId and navigates to overview', () => {
    (useBooks as unknown as Mock).mockReturnValue({
      data: [{ id: 'b1', title: 'Silo 42', author: 'Zev Paiss', status: 'analyzed', chapter_count: 5 }],
      isLoading: false,
    });
    render(wrap(<BookLibrary />));
    fireEvent.click(screen.getByText('Silo 42'));
    expect(useBooksStore.getState().selectedBookId).toBe('b1');
    expect(useBooksStore.getState().view).toBe('overview');
  });

  it('clicking an analyzing book navigates to analysis view', () => {
    (useBooks as unknown as Mock).mockReturnValue({
      data: [{ id: 'b2', title: 'The Long Quiet', author: 'A. Okonkwo', status: 'analyzing', chapter_count: 19 }],
      isLoading: false,
    });
    render(wrap(<BookLibrary />));
    fireEvent.click(screen.getByText('The Long Quiet'));
    expect(useBooksStore.getState().selectedBookId).toBe('b2');
    expect(useBooksStore.getState().view).toBe('analysis');
  });

  it('shows loading state', () => {
    (useBooks as unknown as Mock).mockReturnValue({ data: [], isLoading: true });
    render(wrap(<BookLibrary />));
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });
});
