/**
 * D2 E2E spec — owns S8: Generate chapter audio from overview
 *
 * LIVE-BACKEND PREREQUISITE: this spec requires a running backend with real
 * synthesis capability. The per-task gate verifies parse (--list) at task time;
 * functional green runs at the phase-end gate with a full stack.
 *
 * Verify parse with:
 *   cd app && bun x playwright test e2e/d2.spec.ts --list
 */
import { test, expect } from './fixtures';

// ─── S8: Generate chapter audio from overview ─────────────────────────────────

test('S8: clicking Generate on a chapter row streams per-segment progress and chapter becomes playable on completion', async ({
  page,
}) => {
  // Navigate to the Books tab — /books route wired at C16
  await page.goto('/books');

  // The library should show the fixture book (pre-analyzed "Silo 42")
  const bookCard = page.getByText('Silo 42');
  await expect(bookCard).toBeVisible({ timeout: 10_000 });
  await bookCard.click();

  // Wait for the overview to load with the chapter list
  const chapterList = page.getByTestId('chapter-list');
  await expect(chapterList).toBeVisible({ timeout: 5_000 });

  // Find the first chapter's Generate button (generate-chapter-1)
  const generateBtn = page.getByTestId('generate-chapter-1');
  await expect(generateBtn).toBeVisible({ timeout: 5_000 });
  await expect(generateBtn).not.toBeDisabled();

  // Click the Generate button to start chapter audio generation
  await generateBtn.click();

  // After clicking, the button should be disabled (chapter is now in-flight)
  // and the row should show progress (generating n/m badge)
  await expect(generateBtn).toBeDisabled({ timeout: 5_000 });

  // Wait for the progress badge to appear — row shows "generating n/m"
  // This validates that SSE generation_progress events are received and rendered
  const progressBadge = chapterList.locator('text=/generating \\d+\\/\\d+/');
  await expect(progressBadge).toBeVisible({ timeout: 60_000 });

  // Wait for generation to complete (real synthesis — may take time)
  // The chapter row should flip to a "done" badge + ▶ play control
  const doneBadge = chapterList.locator('text=done');
  await expect(doneBadge).toBeVisible({ timeout: 120_000 });

  // The play control (▶) should appear, indicating the chapter is now playable
  const playControl = chapterList.locator('[aria-label="play-chapter-1"]');
  await expect(playControl).toBeVisible({ timeout: 5_000 });

  // Generate button should be re-enabled after completion (or still present)
  // (Optionally verify the chapter can be clicked to play — not yet wired)
});
