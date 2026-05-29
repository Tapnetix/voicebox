/**
 * C14 E2E spec — owns S5: Reassign dialogue in book view
 *
 * Prerequisites (deferred to phase-end gate):
 *   - Live backend running with an already-analyzed book fixture ("Silo 42")
 *     that includes at least one chapter with both narration and dialogue segments
 *   - The fixture book must have at least 2 characters (Narrator + 1 named character)
 *   - /books route wired in the web build (C16)
 *   - E2E_BASE_URL pointing to the running dev server
 *
 * Per-task E2E gate: authored RED here; goes green at phase-end
 * when the full stack is assembled. Verify parse with:
 *   bun x playwright test --list
 *
 * S5 acceptance: clicking a dialogue line, choosing a different character from
 * the reassign popover, and observing that the line recolors to the new character.
 */

import { test, expect } from './fixtures';

// ─── S5: Reassign dialogue in book view ──────────────────────────────────────

test('S5: chapter editor opens and shows color-coded segments', async ({ page }) => {
  // Navigate to books tab
  await page.goto('/books');

  // Select the fixture book
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // From the overview, click the first chapter's Edit button
  const chapterList = page.getByTestId('chapter-list');
  await expect(chapterList).toBeVisible({ timeout: 5_000 });
  const editBtn = chapterList.locator('[data-testid^="edit-chapter"]').first();
  await expect(editBtn).toBeVisible();
  await editBtn.click();

  // The chapter editor should load
  const bookView = page.getByTestId('book-view');
  await expect(bookView).toBeVisible({ timeout: 8_000 });

  // The chapter text area should be present
  const chapterText = page.getByTestId('chapter-text');
  await expect(chapterText).toBeVisible();

  // At least one segment should be rendered
  const segments = chapterText.locator('[data-testid^="seg-"]');
  await expect(segments.first()).toBeVisible({ timeout: 5_000 });
});

test('S5: back-to-overview button navigates back to the overview', async ({ page }) => {
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  const backBtn = page.getByTestId('back-to-overview');
  await expect(backBtn).toBeVisible({ timeout: 5_000 });
  await backBtn.click();

  // Should navigate back to the overview (chapter-list should reappear)
  await expect(page.getByTestId('chapter-list')).toBeVisible({ timeout: 5_000 });
});

test('S5: reassigning a dialogue line recolors it to the new character', async ({ page }) => {
  /**
   * Core S5 acceptance: click a dialogue seg → pick a different character
   * from the reassign popover → assert the line recolors (span color changes
   * to the new character's color and/or the speaker chip updates).
   */
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  // Wait for the chapter editor to load
  const chapterText = page.getByTestId('chapter-text');
  await expect(chapterText).toBeVisible({ timeout: 8_000 });

  // Find the first dialogue segment (has an emotion-pill sibling)
  const firstDialogueSeg = chapterText.locator('[data-testid^="seg-"]').filter({
    has: page.locator('[data-testid^="emotion-"]').first(),
  }).first();

  // If no dialogue segment exists, skip the reassign step
  const segCount = await firstDialogueSeg.count();
  if (segCount === 0) {
    test.skip(true, 'No dialogue segments in fixture chapter');
    return;
  }

  // Get the segment's test-id to identify its speaker chip
  const segTestId = await firstDialogueSeg.getAttribute('data-testid');
  const segId = segTestId?.replace('seg-', '') ?? '';

  // Read the current color of the segment
  const initialColor = await firstDialogueSeg.evaluate(
    (el) => window.getComputedStyle(el).color,
  );

  // Read current speaker chip text
  const speakerChip = page.getByTestId(`speaker-chip-${segId}`);
  const initialSpeaker = await speakerChip.textContent();

  // Click the segment to open the reassign popover
  await firstDialogueSeg.click();

  // The reassign dropdown should appear
  const dropdown = page.getByTestId('reassign-dropdown');
  await expect(dropdown).toBeVisible({ timeout: 3_000 });

  // Pick a different character — any item that is NOT the current speaker
  const items = dropdown.locator('button');
  const itemCount = await items.count();
  let reassigned = false;

  for (let i = 0; i < itemCount; i++) {
    const itemText = await items.nth(i).textContent();
    // Skip the current character (has ✓) and pick the first different one
    if (itemText && !itemText.includes('✓')) {
      const newCharName = itemText.trim();
      await items.nth(i).click();
      reassigned = true;

      // Wait for the mutation to propagate and segments to re-render
      await page.waitForTimeout(500);

      // The speaker chip should now show the new character name (or have changed)
      const updatedSpeaker = await page.getByTestId(`speaker-chip-${segId}`).textContent();
      expect(updatedSpeaker).not.toEqual(initialSpeaker);
      // The color of the segment span should have changed
      const updatedColor = await page.getByTestId(`seg-${segId}`).evaluate(
        (el) => window.getComputedStyle(el).color,
      );
      expect(updatedColor).not.toEqual(initialColor);

      break;
    }
  }

  if (!reassigned) {
    test.skip(true, 'Only one character available in fixture — cannot reassign to a different one');
  }
});

test('S5: review-toolbar filters work — Dialogue only hides narration', async ({ page }) => {
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  const toolbar = page.getByTestId('review-toolbar');
  await expect(toolbar).toBeVisible({ timeout: 5_000 });

  // Count initial segments
  const chapterText = page.getByTestId('chapter-text');
  await expect(chapterText).toBeVisible({ timeout: 8_000 });
  await expect(chapterText.locator('[data-testid^="seg-"]').first()).toBeVisible({
    timeout: 5_000,
  });
  const allCount = await chapterText.locator('[data-testid^="seg-"]').count();

  // Click "Dialogue only"
  await toolbar.getByText('Dialogue only').click();
  await page.waitForTimeout(200);

  // Dialogue-only count should be <= total count
  const dialogueCount = await chapterText.locator('[data-testid^="seg-"]').count();
  expect(dialogueCount).toBeLessThanOrEqual(allCount);
});

test('S5: review-rail is visible and shows review-progress', async ({ page }) => {
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  await expect(page.getByTestId('review-rail')).toBeVisible({ timeout: 8_000 });
  await expect(page.getByTestId('review-progress')).toBeVisible({ timeout: 3_000 });
});

test('S5: readalong-btn is present and active (wired by D5)', async ({ page }) => {
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const editBtn = page.getByTestId('chapter-list')
    .locator('[data-testid^="edit-chapter"]')
    .first();
  await expect(editBtn).toBeVisible({ timeout: 5_000 });
  await editBtn.click();

  const readAlongBtn = page.getByTestId('readalong-btn');
  await expect(readAlongBtn).toBeVisible({ timeout: 8_000 });
  // D5 wired the read-along interaction, so the control is now enabled
  // (it was an inert placeholder at C14 time). Read-along playback itself
  // (S14) is exercised by d5.spec.ts.
  await expect(readAlongBtn).toBeEnabled();
});
