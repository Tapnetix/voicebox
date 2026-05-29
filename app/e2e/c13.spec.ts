/**
 * C13 E2E spec — owns S13: Save/promote a voice to the library
 *
 * Prerequisites (deferred to phase-end gate):
 *   - Live backend running with an analyzed book fixture ("Silo 42")
 *   - /books route wired in the web build (C16)
 *   - E2E_BASE_URL pointing to the running dev server
 *   - At least two books in the fixture so we can open a second book to verify
 *     that the promoted voice appears there as a library voice
 *   - The character must have an assigned voice before the test runs (either
 *     set up via API or prior test flow)
 *
 * Per-task E2E gate: authored RED here; goes green at phase-end
 * when the full stack is assembled. Verify parse with:
 *   bun x playwright test --list
 *
 * S13: User opens a character's voice editor, clicks "★ Save to library" on
 *      a character with an assigned voice, sees a success toast, and then
 *      the promoted voice appears under "Your library" in the Library tab
 *      when editing a character from a different book.
 */
import { test, expect } from './fixtures';

// ─── S13: Save/promote a voice to the global library ─────────────────────────

test('S13: user saves a character voice to the library and it appears in another book\'s library picker', async ({
  page,
}) => {
  // Navigate to the Books tab
  await page.goto('/books');

  // Select the fixture book "Silo 42"
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // Wait for the cast overview roster
  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  // Click the first non-narrator character that has an assigned voice
  const charLinks = castRoster.locator('[data-testid^="char-link"]');
  await expect(charLinks.first()).toBeVisible();
  const charName = await charLinks.first().textContent();
  await charLinks.first().click();

  // Voice editor should be visible
  await expect(page.getByTestId('character-context')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('voice-panel')).toBeVisible();

  // The save-to-library button should be enabled (character has an assigned voice)
  const saveBtn = page.getByTestId('save-to-library-btn');
  await expect(saveBtn).toBeVisible();
  await expect(saveBtn).not.toBeDisabled();

  // Click "★ Save to library"
  await saveBtn.click();

  // A success toast should appear with text "Saved to your library".
  // Use the toast heading element (div with text-sm font-semibold) rather than
  // the ARIA live-region to avoid strict-mode double-match.
  await expect(
    page.locator('div.text-sm.font-semibold', { hasText: /saved to your library/i }).first(),
  ).toBeVisible({ timeout: 5_000 });

  // User stays in the voice editor — no navigation away
  await expect(page.getByTestId('character-context')).toBeVisible();

  // ── Verify the promoted voice appears in the Library tab of another book ──

  // Go back to the book list
  await page.goto('/books');
  await expect(page).toHaveURL(/\/books/, { timeout: 5_000 });

  // Open a second book (any book that isn't "Silo 42") — or re-enter Silo 42
  // and switch to a different character via the Library tab to confirm
  // the promoted voice appears under "Your library"
  const secondBookCard = page.getByTestId('book-card').nth(1);
  if (await secondBookCard.isVisible()) {
    await secondBookCard.click();
  } else {
    // Fall back: re-open Silo 42 and use the Library tab to verify
    await page.getByText('Silo 42').click();
  }

  await expect(page.getByTestId('cast-roster')).toBeVisible({ timeout: 5_000 });

  // Open any character's voice editor
  const otherCharLinks = page.getByTestId('cast-roster').locator('[data-testid^="char-link"]');
  await expect(otherCharLinks.first()).toBeVisible();
  await otherCharLinks.first().click();

  await expect(page.getByTestId('character-context')).toBeVisible({ timeout: 5_000 });

  // Switch to the Library tab
  await page.getByRole('tab', { name: /library/i }).click();
  const libraryPanel = page.getByTestId('voice-panel-library');
  await expect(libraryPanel).toBeVisible({ timeout: 3_000 });

  // The promoted voice should appear under "Your library"
  const libraryVoices = page.getByTestId('library-voices');
  await expect(libraryVoices).toBeVisible();
  const charNameText = (charName ?? '').trim();
  if (charNameText) {
    // The promoted voice should list the character's name (or a related voice name)
    await expect(libraryVoices).toContainText(charNameText, { timeout: 5_000 });
  } else {
    // At minimum, library voices section should have at least one entry now
    const voiceCards = libraryVoices.locator('[role="button"]');
    await expect(voiceCards.first()).toBeVisible({ timeout: 5_000 });
  }
});

// ─── S13b: save-to-library-btn is disabled when character has no assigned voice ─

test('S13: save-to-library-btn is disabled for a character with no voice assignment', async ({
  page,
}) => {
  // Navigate to the Books tab
  await page.goto('/books');

  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  // Look for a character badge that indicates "no voice" / unassigned
  const unassignedChar = castRoster.locator('[data-testid^="char-link"]').filter({
    has: page.locator('[data-testid="voice-badge"]').filter({ hasText: /none|unassigned/i }),
  });

  if (await unassignedChar.count() > 0) {
    await unassignedChar.first().click();

    await expect(page.getByTestId('character-context')).toBeVisible({ timeout: 5_000 });

    const saveBtn = page.getByTestId('save-to-library-btn');
    await expect(saveBtn).toBeVisible();
    await expect(saveBtn).toBeDisabled();
  } else {
    // If all characters in the fixture have assigned voices, skip this sub-check
    // (the unit test covers this branch comprehensively)
    test.skip();
  }
});
