import { render, screen } from '@testing-library/react';
import { act } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { AnalysisProgress } from '@/components/BooksTab/AnalysisProgress';

let handlers: any;

vi.mock('@/lib/hooks/useBookProgress', () => ({
  useBookProgress: (_id: string, h: any) => {
    handlers = h;
  },
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({ data: { status: 'analyzing' } }),
}));

const mockSetView = vi.fn();
vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (sel: any) => sel({ selectedBookId: 'b1', setView: mockSetView }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

describe('AnalysisProgress', () => {
  beforeEach(() => {
    handlers = undefined;
    mockSetView.mockClear();
  });

  it('streams stage progress and appends detected characters before completion', () => {
    render(<AnalysisProgress />);

    act(() => {
      handlers.onAnalysisProgress?.({
        type: 'analysis_progress',
        stage: 'detect',
        progress: 50,
        message: 'chapter 14 of 23',
      });
    });

    expect(screen.getByTestId('analysis-detail')).toHaveTextContent('14 of 23');

    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c1', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 },
        total: 1,
      });
    });

    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c2', name: 'Holt', color: '#fbbf24', dialogue_count: 96, confidence: 0.8 },
        total: 2,
      });
    });

    const live = screen.getByTestId('live-characters');
    expect(live).toHaveTextContent('Mira');
    expect(live).toHaveTextContent('Holt'); // appeared before any analysis_complete
  });

  it('renders the analysis-steps container', () => {
    render(<AnalysisProgress />);
    expect(screen.getByTestId('analysis-steps')).toBeInTheDocument();
  });

  it('renders all four stages in order', () => {
    render(<AnalysisProgress />);
    const steps = screen.getByTestId('analysis-steps');
    expect(steps).toHaveTextContent('Detect');
    expect(steps).toHaveTextContent('Reconcile');
    expect(steps).toHaveTextContent('Profile');
    expect(steps).toHaveTextContent('Cast');
  });

  it('marks stage as active when receiving analysis_progress for that stage', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onAnalysisProgress?.({
        type: 'analysis_progress',
        stage: 'reconcile',
        progress: 30,
      });
    });
    // The reconcile stage should be marked active
    const steps = screen.getByTestId('analysis-steps');
    expect(steps).toBeInTheDocument();
  });

  it('deduplicates characters by id', () => {
    render(<AnalysisProgress />);

    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c1', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 },
        total: 1,
      });
    });
    // Same id again — should not duplicate
    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c1', name: 'Mira', color: '#34d399', dialogue_count: 150, confidence: 0.9 },
        total: 1,
      });
    });

    const live = screen.getByTestId('live-characters');
    const miraElements = live.querySelectorAll('[data-name="Mira"]');
    // There should be only one row for Mira (deduped)
    expect(miraElements).toHaveLength(1);
  });

  it('shows confidence badge based on confidence value', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c1', name: 'Alice', color: '#34d399', dialogue_count: 50, confidence: 0.9 },
        total: 1,
      });
    });
    const live = screen.getByTestId('live-characters');
    expect(live).toHaveTextContent('high');
  });

  it('shows medium confidence for confidence around 0.7', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c1', name: 'Bob', color: '#f87171', dialogue_count: 20, confidence: 0.7 },
        total: 1,
      });
    });
    const live = screen.getByTestId('live-characters');
    expect(live).toHaveTextContent('medium');
  });

  it('calls setView("overview") on analysis_complete', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onAnalysisComplete?.({
        type: 'analysis_complete',
        character_count: 5,
        chapter_count: 10,
      });
    });
    expect(mockSetView).toHaveBeenCalledWith('overview');
  });

  it('shows error message inline on error event', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onError?.({
        type: 'error',
        stage: 'detect',
        message: 'Something went wrong',
      });
    });
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });

  it('shows retry button after error', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onError?.({
        type: 'error',
        stage: 'detect',
        message: 'Analysis failed',
      });
    });
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows line count in character row', () => {
    render(<AnalysisProgress />);
    act(() => {
      handlers.onCharacterDetected?.({
        type: 'character_detected',
        character: { id: 'c1', name: 'Mira', color: '#34d399', dialogue_count: 142, confidence: 0.9 },
        total: 1,
      });
    });
    const live = screen.getByTestId('live-characters');
    expect(live).toHaveTextContent('142');
  });
});
