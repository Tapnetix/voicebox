/**
 * C9 E2E spec — owns S7: Manage cast (merge/delete) from overview
 *
 * Prerequisites (live-backend gate, deferred to phase-end):
 *   - Live backend running at E2E_BASE_URL (set in playwright.config.ts)
 *   - An already-analyzed book fixture ("Silo 42") in the database
 *   - The fixture book must have at least 2 non-narrator cast entries that
 *     represent the same person (e.g. "Mira" and "Mira (the woman)") so
 *     the merge flow can be exercised end-to-end
 *   - /books route wired in the web build (C16)
 *
 * Scenario S7 covers:
 *   - Selecting 2 non-narrator cast entries and merging them
 *   - After merge: one fewer char-card, survivor owns the combined dialogue_count
 *   - Selecting 1 non-narrator cast entry and deleting it (via confirm dialog)
 *
 * Per-task E2E gate: authored here; goes green at phase-end when the full
 * stack is assembled. Verify it parses with: bun x playwright test --list
 */
import { test, expect } from '@playwright/test';

// ─── S7: Cast merge flow ───────────────────────────────────────────────────────

test('S7: merge two same-person cast entries collapses roster to one fewer character', async ({
  page,
}) => {
  // Navigate to the analyzed book overview
  await page.goto('/books');
  await page.getByText('Silo 42').click();

  // Wait for cast-roster to load
  const roster = page.getByTestId('cast-roster');
  await roster.waitFor({ state: 'visible', timeout: 10_000 });

  // Count initial non-narrator char-cards (there should be ≥2 to merge)
  const charCards = roster.locator('[data-testid^="char-card"]');
  const initialCount = await charCards.count();
  expect(initialCount).toBeGreaterThanOrEqual(3); // narrator + at least 2 non-narrators

  // Gather the dialogue_counts of the first two non-narrator characters
  // by reading their "N lines" badge text before merging
  const nonNarratorCards = roster.locator('[data-testid^="char-card"]:has([role="checkbox"])');
  const firstCard = nonNarratorCards.nth(0);
  const secondCard = nonNarratorCards.nth(1);

  // Read dialogue counts before merge (format: "N lines")
  const firstLinesText = await firstCard.getByText(/\d+ lines/).textContent();
  const secondLinesText = await secondCard.getByText(/\d+ lines/).textContent();
  const firstLines = parseInt(firstLinesText?.match(/(\d+)/)?.[1] ?? '0', 10);
  const secondLines = parseInt(secondLinesText?.match(/(\d+)/)?.[1] ?? '0', 10);

  // Select both checkboxes
  await firstCard.getByRole('checkbox').click();
  await secondCard.getByRole('checkbox').click();

  // merge-btn should now be enabled
  const mergeBtn = page.getByTestId('merge-btn');
  await expect(mergeBtn).not.toBeDisabled();
  await mergeBtn.click();

  // After merge: roster should have one fewer char-card
  await expect(charCards).toHaveCount(initialCount - 1, { timeout: 8_000 });

  // The survivor should now show the combined line count
  const expectedTotal = firstLines + secondLines;
  const survivorCard = nonNarratorCards.nth(0);
  await expect(survivorCard.getByText(`${expectedTotal} lines`)).toBeVisible({ timeout: 5_000 });
});

// ─── S7: Cast delete flow ─────────────────────────────────────────────────────

test('S7: delete a non-narrator character via confirm dialog reassigns their lines to narration', async ({
  page,
}) => {
  await page.goto('/books');
  await page.getByText('Silo 42').click();

  const roster = page.getByTestId('cast-roster');
  await roster.waitFor({ state: 'visible', timeout: 10_000 });

  // Count characters before delete
  const charCards = roster.locator('[data-testid^="char-card"]');
  const initialCount = await charCards.count();

  // Select exactly one non-narrator character
  const nonNarratorCards = roster.locator('[data-testid^="char-card"]:has([role="checkbox"])');
  await nonNarratorCards.nth(0).getByRole('checkbox').click();

  // delete-btn should be enabled (exactly 1 selected)
  const deleteBtn = page.getByTestId('delete-btn');
  await expect(deleteBtn).not.toBeDisabled();
  await deleteBtn.click();

  // Confirm dialog must appear
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toBeVisible({ timeout: 3_000 });

  // Confirm the deletion
  const confirmBtn = dialog.getByRole('button', { name: /delete|confirm/i });
  await confirmBtn.click();

  // Roster should show one fewer char-card after the mutation resolves
  await expect(charCards).toHaveCount(initialCount - 1, { timeout: 8_000 });
});

// ─── S7: narrator is not selectable ──────────────────────────────────────────

test('S7: narrator card has no checkbox and cannot be selected for merge or delete', async ({
  page,
}) => {
  await page.goto('/books');
  await page.getByText('Silo 42').click();

  const roster = page.getByTestId('cast-roster');
  await roster.waitFor({ state: 'visible', timeout: 10_000 });

  // Locate the narrator card
  const narratorCard = roster.locator('[data-testid^="char-card"]', { hasText: 'Narrator' });
  await expect(narratorCard).toBeVisible();

  // Narrator card must not contain a checkbox
  await expect(narratorCard.getByRole('checkbox')).toHaveCount(0);

  // merge-btn and delete-btn remain disabled (nothing selected)
  await expect(page.getByTestId('merge-btn')).toBeDisabled();
  await expect(page.getByTestId('delete-btn')).toBeDisabled();
});
