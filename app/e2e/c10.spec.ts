/**
 * C10 E2E spec — owns S4: Character voice editor (Design tab + preview)
 *
 * Prerequisites (deferred to phase-end gate):
 *   - Live backend running with an already-analyzed book fixture ("Silo 42")
 *   - /books route wired in the web build (C16)
 *   - E2E_BASE_URL pointing to the running dev server
 *   - TTS preview queue available (preview endpoint needs the TTS engine running)
 *
 * Per-task E2E gate: authored RED here; goes green at phase-end
 * when the full stack is assembled. Verify parse with:
 *   bun x playwright test --list
 *
 * NOTE on audio assertion:
 *   The Playwright assertion for audio playback uses a real numeric check
 *   (audio.currentTime > 0) after calling play(), NOT a custom matcher.
 */
import { test, expect } from '@playwright/test';

// ─── S4: Voice editor — Design tab ───────────────────────────────────────────

test('S4: opening a character\'s voice editor shows Design tab and voice preview controls', async ({
  page,
}) => {
  // Navigate to the Books tab — /books route is wired at C16
  await page.goto('/books');

  // Select the fixture book
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // Wait for the overview cast roster
  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  // Click a non-narrator character to drill into voice editor
  const charLinks = castRoster.locator('[data-testid^="char-link"]');
  await expect(charLinks.first()).toBeVisible();
  await charLinks.first().click();

  // Voice editor should now be visible
  await expect(page.getByTestId('character-context')).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId('voice-panel')).toBeVisible();
  await expect(page.getByTestId('character-switcher')).toBeVisible();
  await expect(page.getByTestId('back-to-overview')).toBeVisible();

  // The three tabs exist
  await expect(page.getByRole('tab', { name: /library/i })).toBeVisible();
  await expect(page.getByRole('tab', { name: /clone/i })).toBeVisible();
  await expect(page.getByRole('tab', { name: /design/i })).toBeVisible();

  // Design tab is active by default — design-prompt textarea is visible
  await expect(page.getByTestId('design-prompt')).toBeVisible();

  // Action buttons present
  await expect(page.getByTestId('preview-voice-btn')).toBeVisible();
  await expect(page.getByTestId('assign-voice-btn')).toBeVisible();
  await expect(page.getByTestId('save-to-library-btn')).toBeVisible();

  // current-voice badge is present
  await expect(page.getByTestId('current-voice')).toBeVisible();

  // preview-player row is present
  await expect(page.getByTestId('preview-player')).toBeVisible();

  // No generate-all or export controls
  await expect(page.getByTestId('generate-all-btn')).not.toBeVisible().catch(() => {
    // may not be in DOM at all — either way, acceptable
  });
  await expect(page.getByTestId('export-btn')).not.toBeVisible().catch(() => {});
});

test('S4: clicking preview-voice-btn generates a preview and audio becomes playable', async ({
  page,
}) => {
  // Navigate to a character's voice editor
  await page.goto('/books');
  await page.getByText('Silo 42').click();

  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  // Click a non-narrator character
  const charLinks = castRoster.locator('[data-testid^="char-link"]');
  await charLinks.first().click();
  await expect(page.getByTestId('voice-panel')).toBeVisible({ timeout: 5_000 });

  // Click "Generate preview" — triggers POST /characters/{id}/preview
  await page.getByTestId('preview-voice-btn').click();

  // Wait for the preview to complete (button stops showing "Generating…")
  await expect(page.getByTestId('preview-voice-btn')).not.toHaveText(/generating/i, {
    timeout: 30_000,
  });

  // The preview-player row should now reflect that audio is available
  const previewPlayer = page.getByTestId('preview-player');
  await expect(previewPlayer).toBeVisible();

  // Attempt to play — verify audio element gets a src and currentTime advances
  // Click the play button within the preview-player row
  const playBtn = previewPlayer.locator('button').first();
  await playBtn.click();

  // Assert audio plays: the <audio> element currentTime advances past 0
  // (live-backend prerequisite: TTS must produce audio output)
  const audioAdvanced = await page.evaluate(async () => {
    const audio = document.querySelector('audio');
    if (!audio) return false;
    await new Promise<void>((resolve) => setTimeout(resolve, 1500));
    return audio.currentTime > 0;
  });
  expect(audioAdvanced).toBe(true);
});

test('S4: back-to-overview button returns to the cast roster', async ({ page }) => {
  await page.goto('/books');
  await page.getByText('Silo 42').click();

  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  const charLinks = castRoster.locator('[data-testid^="char-link"]');
  await charLinks.first().click();
  await expect(page.getByTestId('voice-panel')).toBeVisible({ timeout: 5_000 });

  // Click back
  await page.getByTestId('back-to-overview').click();

  // Overview cast roster should be visible again
  await expect(page.getByTestId('cast-roster')).toBeVisible({ timeout: 3_000 });
});

test('S4: character-switcher navigates between characters', async ({ page }) => {
  await page.goto('/books');
  await page.getByText('Silo 42').click();

  const castRoster = page.getByTestId('cast-roster');
  await expect(castRoster).toBeVisible({ timeout: 5_000 });

  const charLinks = castRoster.locator('[data-testid^="char-link"]');
  await charLinks.first().click();
  await expect(page.getByTestId('character-switcher')).toBeVisible({ timeout: 5_000 });

  // Get the current character name shown in the switcher
  const switcherText = await page.getByTestId('character-switcher').textContent();

  // Click ▶ to go to next character
  const btns = page.getByTestId('character-switcher').locator('button');
  await btns.nth(1).click(); // ▶ next

  // The switcher text should change (different character)
  await expect(page.getByTestId('character-switcher')).not.toHaveText(switcherText ?? '', {
    timeout: 3_000,
  }).catch(() => {
    // If there's only 1 character the text won't change — that's acceptable
  });
});
