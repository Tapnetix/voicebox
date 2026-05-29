/**
 * C11 E2E spec — owns S11: Library-tab voice assignment
 *
 * Prerequisites (deferred to phase-end gate):
 *   - Live backend running with an analyzed book fixture ("Silo 42")
 *   - /books route wired in the web build (C16)
 *   - E2E_BASE_URL pointing to the running dev server
 *   - At least one Kokoro preset available via GET /books/{id}/voice-options
 *
 * Per-task E2E gate: authored RED here; goes green at phase-end
 * when the full stack is assembled. Verify parse with:
 *   bun x playwright test --list
 *
 * S11: User opens the Library tab, selects a preset voice, previews it,
 *      clicks "Assign & back", and the character cast card on overview
 *      reflects the newly assigned preset voice.
 */
import { test, expect } from '@playwright/test';

// ─── S11: Library tab voice assignment ────────────────────────────────────────

test('S11: user selects a preset in the Library tab, previews and assigns it', async ({
  page,
}) => {
  // Navigate to the Books tab
  await page.goto('/books');

  // Select the fixture book
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // Wait for the overview cast roster
  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  // Click the first non-narrator character to open the voice editor
  const charLinks = castRoster.locator('[data-testid^="char-link"]');
  await expect(charLinks.first()).toBeVisible();
  const charName = await charLinks.first().textContent();
  await charLinks.first().click();

  // Voice editor should be visible
  await expect(page.getByTestId('character-context')).toBeVisible({ timeout: 5_000 });

  // Switch to the Library tab
  await page.getByRole('tab', { name: /library/i }).click();

  // Library panel should appear
  const libraryPanel = page.getByTestId('voice-panel-library');
  await expect(libraryPanel).toBeVisible({ timeout: 3_000 });

  // Wait for voice options to load
  const presetSection = page.getByTestId('preset-voices');
  await expect(presetSection).toBeVisible({ timeout: 5_000 });

  // Select the first preset voice card
  const firstPreset = presetSection.locator('[role="button"]').first();
  await expect(firstPreset).toBeVisible({ timeout: 5_000 });
  const presetName = await firstPreset.locator('strong').first().textContent();
  await firstPreset.click();

  // Generate a preview of the selected candidate (non-destructive)
  await page.getByTestId('preview-voice-btn').click();

  // The preview player should become active (audio loading or playing)
  const previewPlayer = page.getByTestId('preview-player');
  await expect(previewPlayer).toBeVisible();

  // Assign the selected preset voice and navigate back
  await page.getByTestId('assign-selected-btn').click();

  // Should navigate back to the cast overview
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  // The character's cast card should now show the assigned preset voice
  if (charName) {
    const charCard = castRoster.getByText(charName.trim()).first();
    await expect(charCard).toBeVisible();
    // The voice type badge or label should reflect preset assignment
    const charRow = charCard.locator('..').locator('..');
    await expect(charRow).toContainText(presetName?.trim() ?? '', { ignoreCase: true });
  }
});
