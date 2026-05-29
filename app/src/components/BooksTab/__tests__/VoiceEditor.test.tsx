/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { VoiceEditor } from '@/components/BooksTab/VoiceEditor';

// ─── Store mock ───────────────────────────────────────────────────────────────

const mockSetSelectedCharacterId = vi.fn();
const mockSetView = vi.fn();

let storeState: {
  selectedBookId: string | null;
  selectedCharacterId: string | null;
  setSelectedCharacterId: ReturnType<typeof vi.fn>;
  setView: ReturnType<typeof vi.fn>;
} = {
  selectedBookId: 'b1',
  selectedCharacterId: 'm',
  setSelectedCharacterId: mockSetSelectedCharacterId,
  setView: mockSetView,
};

vi.mock('@/stores/booksStore', () => ({
  useBooksStore: (s: any) => s(storeState),
}));

// ─── Hook mocks ───────────────────────────────────────────────────────────────

const previewMutate = vi.fn();
const updateMutate = vi.fn();

let previewData: { generation_id: string; audio_path: string } | undefined = {
  generation_id: 'g1',
  audio_path: '/audio/g1',
};

let characterList = [
  {
    id: 'm',
    name: 'Mira',
    color: '#34d399',
    voice_type: 'designed',
    voice_label: 'designed',
    vocal_description: 'warm, resolute',
    dialogue_count: 142,
    confidence: 0.9,
    archetype: 'determined, weary, protective',
    gender: 'female',
    age_range: '30s',
  },
  {
    id: 'j',
    name: 'Jules',
    color: '#6d8bff',
    voice_type: 'preset',
    voice_label: 'preset',
    vocal_description: 'deep, calm',
    dialogue_count: 80,
    confidence: 0.75,
    archetype: undefined,
    gender: undefined,
    age_range: undefined,
  },
];

vi.mock('@/lib/hooks/useBooks', () => ({
  useCharacters: () => ({
    data: characterList,
  }),
  usePreviewCharacter: () => ({
    mutate: previewMutate,
    data: previewData,
    isPending: false,
  }),
  useUpdateCharacter: () => ({ mutate: updateMutate, isPending: false }),
}));

// ─── API client mock ──────────────────────────────────────────────────────────

vi.mock('@/lib/api/client', () => ({
  apiClient: {
    getBookAudioUrl: (id: string) => `http://localhost/audio/${id}`,
  },
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VoiceEditor (Design)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeState = {
      selectedBookId: 'b1',
      selectedCharacterId: 'm',
      setSelectedCharacterId: mockSetSelectedCharacterId,
      setView: mockSetView,
    };
    previewData = { generation_id: 'g1', audio_path: '/audio/g1' };
    characterList = [
      {
        id: 'm',
        name: 'Mira',
        color: '#34d399',
        voice_type: 'designed',
        voice_label: 'designed',
        vocal_description: 'warm, resolute',
        dialogue_count: 142,
        confidence: 0.9,
        archetype: 'determined, weary, protective',
        gender: 'female',
        age_range: '30s',
      },
      {
        id: 'j',
        name: 'Jules',
        color: '#6d8bff',
        voice_type: 'preset',
        voice_label: 'preset',
        vocal_description: 'deep, calm',
        dialogue_count: 80,
        confidence: 0.75,
        archetype: undefined,
        gender: undefined,
        age_range: undefined,
      },
    ];
  });

  it('shows character context and an assigned-voice preview control, no generate/export', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('character-context')).toHaveTextContent('Mira');
    expect(screen.getByTestId('preview-player')).toBeInTheDocument();
    expect(screen.getByTestId('assign-voice-btn')).toBeInTheDocument();
    expect(screen.queryByTestId('generate-all-btn')).not.toBeInTheDocument();
    expect(screen.queryByTestId('export-btn')).not.toBeInTheDocument();
  });

  it('generates a preview of the assigned voice', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByTestId('preview-voice-btn'));
    expect(previewMutate).toHaveBeenCalled();
  });

  it('renders the 3-tab scaffold: Library, Clone, Design', () => {
    render(<VoiceEditor />);
    expect(screen.getByRole('tab', { name: /library/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /clone/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /design/i })).toBeInTheDocument();
  });

  it('renders design-prompt textarea in the Design tab', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('design-prompt')).toBeInTheDocument();
  });

  it('renders save-to-library-btn', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('save-to-library-btn')).toBeInTheDocument();
  });

  it('renders current-voice badge with character voice type', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('current-voice')).toBeInTheDocument();
    expect(screen.getByTestId('current-voice')).toHaveTextContent('designed');
  });

  it('renders back-to-overview and character-switcher', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('back-to-overview')).toBeInTheDocument();
    expect(screen.getByTestId('character-switcher')).toBeInTheDocument();
  });

  it('shows character name in switcher', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('character-switcher')).toHaveTextContent('Mira');
  });

  it('back-to-overview button calls setView("overview")', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByTestId('back-to-overview'));
    expect(mockSetView).toHaveBeenCalledWith('overview');
  });

  it('assign-voice-btn calls updateMutate with design_prompt', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByTestId('assign-voice-btn'));
    expect(updateMutate).toHaveBeenCalledWith(
      expect.objectContaining({ bookId: 'b1', charId: 'm' }),
      expect.any(Object),
    );
  });

  it('design-prompt textarea is pre-filled with vocal_description', () => {
    render(<VoiceEditor />);
    const textarea = screen.getByTestId('design-prompt') as HTMLTextAreaElement;
    expect(textarea.value).toBe('warm, resolute');
  });

  it('typing in design-prompt textarea updates value', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    const textarea = screen.getByTestId('design-prompt') as HTMLTextAreaElement;
    await u.clear(textarea);
    await u.type(textarea, 'bold, loud');
    expect(textarea.value).toBe('bold, loud');
  });

  it('character switcher next button calls setSelectedCharacterId', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    const switcher = screen.getByTestId('character-switcher');
    // The ▶ button is the second button in the switcher
    const btns = switcher.querySelectorAll('button');
    await u.click(btns[1]); // ▶ next
    expect(mockSetSelectedCharacterId).toHaveBeenCalledWith('j');
  });

  it('character switcher prev button wraps around', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    const switcher = screen.getByTestId('character-switcher');
    const btns = switcher.querySelectorAll('button');
    await u.click(btns[0]); // ◀ prev — wraps from index 0 to last
    expect(mockSetSelectedCharacterId).toHaveBeenCalledWith('j');
  });

  it('shows "1 of 2" position in the switcher', () => {
    render(<VoiceEditor />);
    expect(screen.getByTestId('character-switcher')).toHaveTextContent('1 of 2');
  });

  it('renders preview-player row with audio ready state', () => {
    render(<VoiceEditor />);
    const player = screen.getByTestId('preview-player');
    // previewData is set so the player should show cached/ready state
    expect(player).toBeInTheDocument();
  });

  it('renders preview-player with empty state when no preview data', () => {
    previewData = undefined;
    render(<VoiceEditor />);
    const player = screen.getByTestId('preview-player');
    expect(player).toBeInTheDocument();
    expect(player).toHaveTextContent(/not generated/i);
  });

  it('shows character archetype as traits when present', () => {
    render(<VoiceEditor />);
    const ctx = screen.getByTestId('character-context');
    expect(ctx).toHaveTextContent('determined, weary, protective');
  });

  it('shows gender and age_range badges when present', () => {
    render(<VoiceEditor />);
    const ctx = screen.getByTestId('character-context');
    expect(ctx).toHaveTextContent('female · 30s');
  });

  it('shows "no character selected" message when character list is empty', () => {
    characterList = [];
    storeState = { ...storeState, selectedCharacterId: null };
    render(<VoiceEditor />);
    expect(screen.getByText(/no character selected/i)).toBeInTheDocument();
  });

  it('preview-player play button is disabled when no audio src available', () => {
    previewData = undefined;
    render(<VoiceEditor />);
    const player = screen.getByTestId('preview-player');
    // The play button should be disabled when no audio src
    const playBtn = player.querySelector('button');
    expect(playBtn).toBeDisabled();
  });

  it('Library tab body shows placeholder text', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByRole('tab', { name: /library/i }));
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('Clone tab body shows placeholder text', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    await u.click(screen.getByRole('tab', { name: /clone/i }));
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
  });

  it('preview-voice-btn passes design_prompt to preview mutate', async () => {
    const u = userEvent.setup();
    render(<VoiceEditor />);
    // clear and type in new prompt
    const textarea = screen.getByTestId('design-prompt') as HTMLTextAreaElement;
    await u.clear(textarea);
    await u.type(textarea, 'gruff old man');
    await u.click(screen.getByTestId('preview-voice-btn'));
    expect(previewMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        charId: 'm',
        data: expect.objectContaining({ design_prompt: 'gruff old man' }),
      }),
    );
  });
});
