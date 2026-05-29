/// <reference types="@testing-library/jest-dom/vitest" />
import '@/i18n';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { PlatformProvider } from '@/platform/PlatformContext';
import type { Platform, UpdateStatus } from '@/platform/types';

// Mock apiClient so the library renders an empty state without a live server
vi.mock('@/lib/api/client', () => ({
  apiClient: {
    listBooks: vi.fn().mockResolvedValue([]),
    getHealth: vi.fn().mockResolvedValue({ status: 'healthy', model_loaded: true, gpu_available: false }),
  },
}));

// Minimal mock platform so RootLayout/App doesn't crash
const mockUpdateStatus: UpdateStatus = {
  checking: false,
  available: false,
  downloading: false,
  installing: false,
  readyToInstall: false,
};

const mockPlatform: Platform = {
  filesystem: {
    saveFile: vi.fn(),
    openPath: vi.fn(),
    pickDirectory: vi.fn(),
  },
  updater: {
    checkForUpdates: vi.fn(),
    downloadAndInstall: vi.fn(),
    restartAndInstall: vi.fn(),
    getStatus: vi.fn().mockReturnValue(mockUpdateStatus),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
  audio: {
    isSystemAudioSupported: vi.fn().mockResolvedValue(false),
    startSystemAudioCapture: vi.fn(),
    stopSystemAudioCapture: vi.fn(),
    listOutputDevices: vi.fn().mockResolvedValue([]),
    playToDevices: vi.fn(),
    stopPlayback: vi.fn(),
  },
  lifecycle: {
    startServer: vi.fn().mockResolvedValue('http://localhost:8000'),
    stopServer: vi.fn(),
    restartServer: vi.fn().mockResolvedValue('http://localhost:8000'),
    setKeepServerRunning: vi.fn(),
    setupWindowCloseHandler: vi.fn(),
    subscribeToServerLogs: vi.fn().mockReturnValue(() => {}),
  },
  metadata: {
    getVersion: vi.fn().mockResolvedValue('0.0.0'),
    isTauri: false,
  },
};

// Also mock the useBooks hook used by BookLibrary
vi.mock('@/lib/hooks/useBooks', () => ({
  useBooks: vi.fn().mockReturnValue({ data: [], isLoading: false }),
  useBook: vi.fn().mockReturnValue({ data: undefined }),
  useImportBook: vi.fn().mockReturnValue({ mutate: vi.fn(), data: undefined, isPending: false }),
  useAnalyzeBook: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
}));

beforeEach(() => {
  // Reset booksStore view to library so each test starts fresh
  import('@/stores/booksStore').then(({ useBooksStore }) => {
    useBooksStore.getState().reset?.();
  });
});

it('navigating to /books renders the Books library in the production router graph', async () => {
  // Import the real production router after mocks are set up
  const { router } = await import('@/router');

  // Navigate to /books
  await router.navigate({ to: '/books' });

  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <PlatformProvider platform={mockPlatform}>
        <RouterProvider router={router} />
      </PlatformProvider>
    </QueryClientProvider>,
  );

  expect(await screen.findByTestId('book-grid')).toBeInTheDocument();
});
