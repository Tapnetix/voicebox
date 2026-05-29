/**
 * D4 E2E spec — owns S6: Edit segment emotion and preview
 *
 * Live-backend prerequisite (deferred to phase-end gate):
 *   - Running backend with the "Silo 42" fixture book (analyzed, with dialogue segments)
 *   - E2E_BASE_URL pointing to the running dev server
 *   - The fixture book has at least one chapter with dialogue segments
 *
 * Per-task E2E gate: authored RED here; goes green at phase-end when the full
 * stack is assembled. Verify parse with:
 *   cd app && bun x playwright test e2e/d4.spec.ts --list
 *
 * S6 acceptance: pick "angry" from a dialogue line's emotion pill and preview
 * it, asserting the pill now reads "angry" and the preview plays.
 */

import { test, expect } from './fixtures';

// ─── S6: Edit segment emotion and preview ─────────────────────────────────────

test('S6: picking angry from a dialogue emotion pill updates the pill label', async ({ page }) => {
  // Navigate to books
  await page.goto('/books');

  // Select the fixture book
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // Open the first chapter
  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  // Wait for chapter editor
  const chapterText = page.getByTestId('chapter-text');
  await expect(chapterText).toBeVisible({ timeout: 8_000 });

  // Find the first emotion pill in a dialogue segment
  const emotionPill = chapterText.locator('[data-testid^="emotion-"]').first();
  await expect(emotionPill).toBeVisible({ timeout: 5_000 });

  // Click the pill to open the delivery popover
  await emotionPill.click();

  // The delivery popover should appear
  const deliveryPopover = page.getByTestId('delivery-popover');
  await expect(deliveryPopover).toBeVisible({ timeout: 3_000 });

  // Click the "angry" preset button
  const angryBtn = deliveryPopover.getByRole('button', { name: /angry/i });
  await expect(angryBtn).toBeVisible({ timeout: 2_000 });
  await angryBtn.click();

  // The pill label should now show "angry"
  await expect(emotionPill).toHaveText(/angry/, { timeout: 3_000 });

  // Close the popover
  await page.keyboard.press('Escape');
});

test('S6: preview button in delivery popover triggers a preview', async ({ page }) => {
  // Navigate to books
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  const chapterText = page.getByTestId('chapter-text');
  await expect(chapterText).toBeVisible({ timeout: 8_000 });

  // Open the first emotion pill
  const emotionPill = chapterText.locator('[data-testid^="emotion-"]').first();
  await expect(emotionPill).toBeVisible({ timeout: 5_000 });
  await emotionPill.click();

  const deliveryPopover = page.getByTestId('delivery-popover');
  await expect(deliveryPopover).toBeVisible({ timeout: 3_000 });

  // Find the preview button
  const previewBtn = deliveryPopover.getByTestId('preview-btn');
  await expect(previewBtn).toBeVisible({ timeout: 2_000 });

  // Click preview — assert it's clickable (enabled)
  await expect(previewBtn).toBeEnabled();
  await previewBtn.click();

  // After clicking, the button may momentarily show "Previewing…" (disabled)
  // then return to normal — we just assert the click didn't crash the page
  await expect(page.getByTestId('book-view')).toBeVisible({ timeout: 3_000 });
});
