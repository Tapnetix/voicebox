/**
 * D7 E2E spec — owns S10: Audiobook export (M4B/MP3/ZIP)
 *
 * LIVE-STACK NOTE:
 *   S10 requires a running backend + web stack AND a generated book
 *   (audio rendered for at least one segment). That live environment is
 *   assembled at the PHASE-END E2E gate by the orchestrator. At task time,
 *   only ensure the spec PARSES/LISTS:
 *     cd app && bun x playwright test e2e/d7.spec.ts --list
 *   shows the S10 test. Do not block on greening it live.
 *
 * Prerequisites (deferred to phase-end gate):
 *   - Live backend running with a fixture book that has at least one completed
 *     audio segment ("Silo 42" seeded by e2e_seed.py with audio rendered)
 *   - /books route wired in the web build
 *   - E2E_BASE_URL pointing to the running dev server
 */
import { test, expect } from './fixtures';

// ─── S10: Audiobook export ────────────────────────────────────────────────────

test('S10: open export from hub, choose M4B, fill metadata, start export, wait complete, download .m4b', async ({
  page,
}) => {
  // Navigate to the Books tab
  await page.goto('/books');

  // Select the fixture book that has rendered audio
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // Wait for overview to load and click Export
  await expect(page.getByTestId('book-header')).toBeVisible({ timeout: 5_000 });
  await page.getByTestId('export-btn').click();

  // Export view should be visible with the format radio group
  await expect(page.getByTestId('export-format')).toBeVisible({ timeout: 5_000 });

  // Choose M4B format (should be default, but explicitly select it)
  const m4bOption = page.getByTestId('export-format').locator('label', { hasText: 'M4B' });
  await m4bOption.click();

  // Fill in metadata
  const metadataSection = page.getByTestId('export-metadata');
  await expect(metadataSection).toBeVisible();

  // Fill title
  const titleInput = metadataSection.locator('input[id="export-title"]');
  await titleInput.fill('Silo 42 Audiobook');

  // Fill author
  const authorInput = metadataSection.locator('input[id="export-author"]');
  await authorInput.fill('Test Author');

  // Drop a cover image (simulate with a programmatic file)
  const coverDrop = page.getByTestId('cover-drop');
  await expect(coverDrop).toBeVisible();
  // Skip file upload in E2E — just verify the drop zone is present and functional

  // Verify action section exists
  const actionSection = page.getByTestId('export-action');
  await expect(actionSection).toBeVisible();

  // Confirm download-btn is disabled before export
  await expect(page.getByTestId('download-btn')).toBeDisabled();

  // Click start-export-btn to kick off export
  await page.getByTestId('start-export-btn').click();

  // Wait for export-status to show completion
  // The export pipeline runs in the background and SSE events update the UI
  await expect(page.getByTestId('export-status')).toContainText(/done|complete/i, {
    timeout: 120_000,
  });

  // After completion, download-btn should be enabled
  await expect(page.getByTestId('download-btn')).toBeEnabled({ timeout: 5_000 });

  // Click download and wait for file download event
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByTestId('download-btn').click(),
  ]);

  // Verify the downloaded file has .m4b extension
  expect(download.suggestedFilename()).toMatch(/\.m4b$/);
});
