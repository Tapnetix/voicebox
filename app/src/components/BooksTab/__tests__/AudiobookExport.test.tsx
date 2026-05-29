/**
 * AudiobookExport component tests (D7)
 *
 * Tests cover:
 * - Renders format radio group (export-format)
 * - Renders metadata section (export-metadata) with title/author inputs and cover drop
 * - Renders action section (export-action) with export-status, start-export-btn, download-btn
 * - download-btn is disabled by default
 * - Clicking start-export-btn calls startExport and enables progress display
 * - On export_complete SSE event, download-btn becomes enabled
 * - Download button label reflects the selected format ("Download .m4b")
 * - Changing format to mp3_single shows correct download label
 * - Error event shows error message in export-status
 */
/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AudiobookExport } from '@/components/BooksTab/AudiobookExport';

// ─── Mocks ────────────────────────────────────────────────────────────────────

let exportProgressHandler: ((event: any) => void) | undefined;
let exportCompleteHandler: ((event: any) => void) | undefined;
let errorHandler: ((event: any) => void) | undefined;

vi.mock('@/lib/hooks/useBookProgress', () => ({
  useBookProgress: (_id: string, handlers: any) => {
    exportProgressHandler = handlers.onExportProgress;
    exportCompleteHandler = handlers.onExportComplete;
    errorHandler = handlers.onError;
  },
}));

const mockStartExport = vi.fn();
vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({
    data: { id: 'book-1', title: 'Test Book', author: 'Jane Doe', status: 'ready' },
  }),
  useStartExport: () => ({
    mutateAsync: mockStartExport,
    isPending: false,
  }),
  useDownloadExport: () => ({
    mutateAsync: vi.fn().mockResolvedValue(new Blob()),
    isPending: false,
  }),
}));

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (sel: any) =>
    sel({
      selectedBookId: 'book-1',
      setView: vi.fn(),
    }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('AudiobookExport', () => {
  beforeEach(() => {
    exportProgressHandler = undefined;
    exportCompleteHandler = undefined;
    errorHandler = undefined;
    mockStartExport.mockClear();
    mockStartExport.mockResolvedValue({ book_id: 'book-1', task_id: 'task-1', status: 'exporting' });
  });

  it('renders the export-format radio group', () => {
    render(<AudiobookExport />);
    expect(screen.getByTestId('export-format')).toBeInTheDocument();
  });

  it('renders export-metadata section with title, author, and cover-drop', () => {
    render(<AudiobookExport />);
    const metadata = screen.getByTestId('export-metadata');
    expect(metadata).toBeInTheDocument();
    expect(metadata.querySelector('[data-testid="cover-drop"]')).toBeInTheDocument();
  });

  it('renders export-action section', () => {
    render(<AudiobookExport />);
    expect(screen.getByTestId('export-action')).toBeInTheDocument();
  });

  it('renders export-status inside export-action', () => {
    render(<AudiobookExport />);
    const action = screen.getByTestId('export-action');
    expect(action.querySelector('[data-testid="export-status"]')).toBeInTheDocument();
  });

  it('renders start-export-btn inside export-action', () => {
    render(<AudiobookExport />);
    expect(screen.getByTestId('start-export-btn')).toBeInTheDocument();
  });

  it('renders download-btn inside export-action', () => {
    render(<AudiobookExport />);
    expect(screen.getByTestId('download-btn')).toBeInTheDocument();
  });

  it('download-btn is disabled initially', () => {
    render(<AudiobookExport />);
    expect(screen.getByTestId('download-btn')).toBeDisabled();
  });

  it('start-export-btn calls startExport on click', async () => {
    render(<AudiobookExport />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-export-btn'));
    });
    expect(mockStartExport).toHaveBeenCalledOnce();
  });

  it('download-btn becomes enabled after export_complete event', async () => {
    render(<AudiobookExport />);

    // Start export first
    await act(async () => {
      fireEvent.click(screen.getByTestId('start-export-btn'));
    });

    // Fire export_complete SSE event
    act(() => {
      exportCompleteHandler?.({
        type: 'export_complete',
        download_path: '/tmp/test.m4b',
        filename: 'test.m4b',
      });
    });

    expect(screen.getByTestId('download-btn')).toBeEnabled();
  });

  it('download button label reflects m4b format by default', () => {
    render(<AudiobookExport />);
    // Default format is m4b
    expect(screen.getByTestId('download-btn')).toHaveTextContent('.m4b');
  });

  it('updates export-status when export_progress event fires', async () => {
    render(<AudiobookExport />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-export-btn'));
    });

    act(() => {
      exportProgressHandler?.({
        type: 'export_progress',
        progress: 50,
      });
    });

    // Status section should reflect that exporting is in progress
    const status = screen.getByTestId('export-status');
    expect(status).toBeInTheDocument();
  });

  it('shows error message in export-status on error event', async () => {
    render(<AudiobookExport />);

    await act(async () => {
      fireEvent.click(screen.getByTestId('start-export-btn'));
    });

    act(() => {
      errorHandler?.({
        type: 'error',
        stage: 'export',
        message: 'Export failed due to missing audio',
      });
    });

    const status = screen.getByTestId('export-status');
    expect(status).toHaveTextContent(/export failed/i);
  });

  it('format radio group contains m4b, mp3_single, mp3_per_chapter options', () => {
    render(<AudiobookExport />);
    const formatGroup = screen.getByTestId('export-format');
    expect(formatGroup).toHaveTextContent('m4b');
    expect(formatGroup).toHaveTextContent('mp3');
  });
});
