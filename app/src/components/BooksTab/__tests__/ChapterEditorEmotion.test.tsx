/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ChapterEditor } from '@/components/BooksTab/ChapterEditor';

// ─── Mocks ────────────────────────────────────────────────────────────────────

const updateMutate = vi.fn();
const previewMutate = vi.fn();

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) =>
    s({
      selectedBookId: 'b1',
      selectedChapterId: 'c1',
      setView: vi.fn(),
      readAlongPlaying: false,
      currentSpokenSegmentId: null,
      setReadAlong: vi.fn(),
      setCurrentSpokenSegment: vi.fn(),
    }),
}));

vi.mock('@/stores/storyStore', () => ({
  useStoryStore: (s: any) =>
    s({
      isPlaying: false,
      currentTimeMs: 0,
      playbackStoryId: null,
      play: vi.fn(),
      pause: vi.fn(),
      stop: vi.fn(),
      setActiveStory: vi.fn(),
    }),
}));

vi.mock('@/lib/hooks/useStories', () => ({
  useStory: () => ({ data: null }),
}));

vi.mock('@/lib/hooks/useStoryPlayback', () => ({
  useStoryPlayback: vi.fn(),
}));

vi.mock('@/lib/hooks/useBooks', () => ({
  useBook: () => ({ data: null }),
  useCharacters: () => ({
    data: [
      { id: 'n', name: 'Narrator', is_narrator: true, color: '#6d8bff' },
      { id: 'm', name: 'Mira', color: '#34d399', confidence: 0.9 },
    ],
  }),
  useSegments: () => ({
    data: [
      {
        id: '12',
        order: 0,
        type: 'dialogue',
        text: '"We need to move fast,"',
        character_id: 'm',
        character_name: 'Mira',
        emotion: 'tense',
        emotion_intensity: 0.5,
        delivery: '',
        audio: { status: 'none' },
      },
    ],
  }),
  useUpdateSegment: () => ({ mutate: updateMutate, isPending: false }),
  usePreviewSegment: () => ({ mutate: previewMutate, isPending: false }),
  useSplitSegment: () => ({ mutateAsync: vi.fn().mockResolvedValue([]), isPending: false }),
  useMergeSegments: () => ({ mutate: vi.fn(), isPending: false }),
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ChapterEditor — emotion/delivery D4', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the emotion pill with the segment emotion label', () => {
    render(<ChapterEditor />);
    const pill = screen.getByTestId('emotion-12');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent('tense');
  });

  it('clicking emotion-pill opens delivery-popover', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    expect(screen.getByTestId('delivery-popover')).toBeInTheDocument();
  });

  it('delivery-popover contains emotion preset buttons', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    const popover = screen.getByTestId('delivery-popover');
    expect(within(popover).getByRole('button', { name: /angry/i })).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: /neutral/i })).toBeInTheDocument();
    expect(within(popover).getByRole('button', { name: /happy/i })).toBeInTheDocument();
  });

  it('clicking "angry" preset calls useUpdateSegment with emotion: angry', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    const popover = screen.getByTestId('delivery-popover');
    await u.click(within(popover).getByRole('button', { name: /angry/i }));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentId: '12',
        data: expect.objectContaining({ emotion: 'angry' }),
      }),
      expect.anything(),
    );
  });

  it('pill label updates to angry after selection', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    const popover = screen.getByTestId('delivery-popover');
    await u.click(within(popover).getByRole('button', { name: /angry/i }));
    // The pill should show the new emotion optimistically or via re-render
    await waitFor(() => {
      expect(screen.getByTestId('emotion-12')).toHaveTextContent('angry');
    });
  });

  it('delivery-popover contains a preview button that calls usePreviewSegment', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    const popover = screen.getByTestId('delivery-popover');
    const previewBtn = within(popover).getByTestId('preview-btn');
    expect(previewBtn).toBeInTheDocument();
    await u.click(previewBtn);
    expect(previewMutate).toHaveBeenCalled();
  });

  it('changing the intensity slider calls useUpdateSegment with updated emotion_intensity', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    // Radix Slider renders a <span role="slider"> that responds to keyboard events.
    // Initial value is 0.5, step is 0.05 — one ArrowRight press => 0.55.
    const popover = screen.getByTestId('delivery-popover');
    const sliderThumb = within(popover).getByRole('slider');
    fireEvent.keyDown(sliderThumb, { key: 'ArrowRight', code: 'ArrowRight' });
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentId: '12',
        data: expect.objectContaining({ emotion_intensity: 0.55 }),
      }),
      expect.anything(),
    );
  });

  it('typing in the delivery input then blurring calls useUpdateSegment with the delivery text', async () => {
    const u = userEvent.setup();
    render(<ChapterEditor />);
    await u.click(screen.getByTestId('emotion-12'));
    const popover = screen.getByTestId('delivery-popover');
    const deliveryInput = within(popover).getByPlaceholderText(/trembling voice/i);
    await u.type(deliveryInput, 'speak slowly');
    // handleDeliveryChange is called on each keystroke — assert intermediate state
    expect(deliveryInput).toHaveValue('speak slowly');
    // blur triggers handleDeliveryBlur which persists via updateMutate
    fireEvent.blur(deliveryInput);
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        segmentId: '12',
        data: expect.objectContaining({ delivery: 'speak slowly' }),
      }),
      expect.anything(),
    );
  });
});
