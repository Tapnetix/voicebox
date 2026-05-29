/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { BooksTab } from '@/components/BooksTab/BooksTab';
import { useBooksStore } from '@/stores/booksStore';

// Stub each child screen so BooksTab is tested in isolation.
// Using named stubs with distinct testids lets us assert the right arm fires.
vi.mock('@/components/BooksTab/BookLibrary', () => ({
  BookLibrary: () => <div data-testid="stub-book-library" />,
}));
vi.mock('@/components/BooksTab/BookImport', () => ({
  BookImport: () => <div data-testid="stub-book-import" />,
}));
vi.mock('@/components/BooksTab/AnalysisProgress', () => ({
  AnalysisProgress: () => <div data-testid="stub-analysis-progress" />,
}));
vi.mock('@/components/BooksTab/BookOverview', () => ({
  BookOverview: () => <div data-testid="stub-book-overview" />,
}));
vi.mock('@/components/BooksTab/VoiceEditor', () => ({
  VoiceEditor: () => <div data-testid="stub-voice-editor" />,
}));
vi.mock('@/components/BooksTab/ChapterEditor', () => ({
  ChapterEditor: () => <div data-testid="stub-chapter-editor" />,
}));
vi.mock('@/components/BooksTab/AudiobookExport', () => ({
  AudiobookExport: () => <div data-testid="stub-audiobook-export" />,
}));

describe('BooksTab view router', () => {
  beforeEach(() => {
    useBooksStore.getState().reset();
  });

  it('renders BookLibrary when view is "library"', () => {
    useBooksStore.getState().setView('library');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-book-library')).toBeInTheDocument();
  });

  it('renders BookImport when view is "import"', () => {
    useBooksStore.getState().setView('import');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-book-import')).toBeInTheDocument();
  });

  it('renders AnalysisProgress when view is "analysis"', () => {
    useBooksStore.getState().setView('analysis');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-analysis-progress')).toBeInTheDocument();
  });

  it('renders BookOverview when view is "overview"', () => {
    useBooksStore.getState().setView('overview');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-book-overview')).toBeInTheDocument();
  });

  it('renders VoiceEditor when view is "voice-editor"', () => {
    useBooksStore.getState().setView('voice-editor');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-voice-editor')).toBeInTheDocument();
  });

  it('renders ChapterEditor when view is "chapter-editor"', () => {
    useBooksStore.getState().setView('chapter-editor');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-chapter-editor')).toBeInTheDocument();
  });

  it('renders AudiobookExport when view is "export"', () => {
    useBooksStore.getState().setView('export');
    render(<BooksTab />);
    expect(screen.getByTestId('stub-audiobook-export')).toBeInTheDocument();
  });

  it('renders exactly one child per active view — no cross-contamination', () => {
    useBooksStore.getState().setView('overview');
    render(<BooksTab />);
    // Only the overview stub should appear
    expect(screen.getByTestId('stub-book-overview')).toBeInTheDocument();
    expect(screen.queryByTestId('stub-book-library')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-book-import')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-voice-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stub-chapter-editor')).not.toBeInTheDocument();
  });
});
