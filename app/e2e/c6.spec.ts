/**
 * C6 E2E spec — Ingest and parse EPUB/FB2/TXT/PDF (owns scenario S1).
 *
 * PREREQUISITES:
 *   - A live Voicebox backend must be running (the web build calls POST /books/import).
 *   - The web dev server is started by `just dev-web` (playwright.config.ts webServer).
 *   - The /books route is not wired into the web build until C16; this spec
 *     will go green at the orchestrator's phase-end live E2E gate, not during
 *     per-task development. `playwright test --list` should parse it without error.
 *
 * Fixture: app/e2e-fixtures/silo.epub — a minimal valid EPUB with title "Silo",
 * author "Hugh Howey", and 1 chapter. Built via ebooklib (same as backend test fixture).
 */
import { expect, test } from './fixtures';
import path from 'node:path';

test('S1: import silo.epub shows parsed title, author, chapter count before analysis', async ({
  page,
}) => {
  // Navigate to the books section and open the import screen
  await page.goto('/books');
  await page.getByTestId('import-book-btn').click();

  // Drop the silo.epub fixture into the hidden file input
  await page
    .getByTestId('book-dropzone')
    .setInputFiles(path.join(__dirname, '..', 'e2e-fixtures', 'silo.epub'));

  // The backend synchronously parses the EPUB and returns metadata —
  // these assertions should pass BEFORE the user clicks Analyze.
  await expect(page.getByTestId('meta-title')).toContainText('Silo');
  await expect(page.getByTestId('meta-author')).toContainText(/\w/);
  await expect(page.getByTestId('meta-chapters')).toContainText(/chapter/i);

  // Analysis controls and the Analyze button must be visible (no AI yet)
  await expect(page.getByTestId('model-select')).toBeVisible();
  await expect(page.getByTestId('narrator-select')).toBeVisible();
  await expect(page.getByTestId('analyze-btn')).toBeVisible();
});
