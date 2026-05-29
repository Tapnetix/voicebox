import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // Stub out the virtual changelog module that requires a Vite plugin
      'virtual:changelog': path.resolve(__dirname, 'src/__mocks__/virtual-changelog.ts'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
    coverage: {
      provider: 'istanbul',
      reporter: ['text', 'html'],
      include: [
        'src/components/BooksTab/**',
        'src/lib/hooks/useBooks*.ts',
        'src/stores/booksStore.ts',
      ],
    },
  },
});
