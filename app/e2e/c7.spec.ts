// C7 E2E spec — owns scenario S2: Stream analysis progress with live characters
//
// PREREQUISITE: Live backend + web server must be running (`just dev-web`).
// The /books route is not wired into the web build until C16; this spec goes green
// at the phase-end E2E gate when the full stack is up.
//
// This spec seeds a book via the REST API, triggers analysis, then asserts:
//   S2-a: The analysis stage feed advances (at least one stage becomes active/done).
//   S2-b: At least one character appears in `live-characters` BEFORE the screen
//         transitions to the overview (proving incremental streaming, not all-at-once).

import { expect, test } from '@playwright/test';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:8000';

test.describe('S2: Stream analysis progress with live characters', () => {
  test('S2: analysis stage feed advances and characters appear before completion', async ({
    page,
    request,
  }) => {
    // ── 1. Seed a book via the API ────────────────────────────────────────────
    // Upload a minimal EPUB fixture so we have a real book to analyze.
    // Fall back to a pre-existing book if one is already present.
    let bookId: string;

    const listRes = await request.get(`${API_BASE}/books`);
    expect(listRes.ok()).toBe(true);
    const books = (await listRes.json()) as Array<{ id: string; status: string }>;

    const existingAnalyzable = books.find((b) =>
      ['imported', 'analyzing'].includes(b.status),
    );

    if (existingAnalyzable) {
      bookId = existingAnalyzable.id;
    } else {
      // Import the smallest fixture we have
      const formData = new FormData();
      // Use a plain-text file as a minimal book
      formData.append(
        'file',
        new Blob(['Chapter 1\n\n"Hello," said Alice.\n"Hi," said Bob.'], {
          type: 'text/plain',
        }),
        'fixture.txt',
      );
      const importRes = await request.post(`${API_BASE}/books/import`, {
        multipart: {
          file: {
            name: 'fixture.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('Chapter 1\n\n"Hello," said Alice.\n"Hi," said Bob.'),
          },
        },
      });
      expect(importRes.ok()).toBe(true);
      const imported = (await importRes.json()) as { id: string };
      bookId = imported.id;
    }

    // ── 2. Navigate to the Books tab and select the book ─────────────────────
    await page.goto('/');
    // Click the Books nav item
    await page.getByRole('link', { name: /books/i }).click();

    // Select the book from the library list
    await page.getByTestId('book-grid').waitFor({ state: 'visible' });
    await page.locator(`[data-book-id="${bookId}"]`).click();

    // ── 3. If status is 'imported', trigger analysis via the UI or API ────────
    // The overview / analysis view depends on C5; fall back to direct navigation.
    const analyzeBtn = page.getByRole('button', { name: /analyze/i });
    if (await analyzeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await analyzeBtn.click();
    } else {
      // Trigger analysis via API directly and reload to analysis view
      await request.post(`${API_BASE}/books/${bookId}/analyze`);
    }

    // ── 4. Wait for analysis view ─────────────────────────────────────────────
    const analysisSteps = page.getByTestId('analysis-steps');
    await analysisSteps.waitFor({ state: 'visible', timeout: 15_000 });

    // ── 5. S2-a: At least one stage becomes active or done ────────────────────
    await expect(
      page.locator('[data-testid="analysis-steps"] [data-status="active"], [data-testid="analysis-steps"] [data-status="done"]'),
    ).toHaveCount({ minimum: 1 }, { timeout: 30_000 });

    // ── 6. S2-b: Characters appear in live-characters BEFORE completion ───────
    // The component appends character_detected events incrementally; assert at
    // least one character is visible while the analysis is still running
    // (i.e., analysis-steps still present, not yet on overview).
    const liveCharacters = page.getByTestId('live-characters');
    await liveCharacters.waitFor({ state: 'visible', timeout: 15_000 });

    // Wait for at least one character to appear in the live list
    await expect(liveCharacters).not.toBeEmpty({ timeout: 60_000 });

    // Confirm the analysis-steps panel is still visible at this point
    // (we're still on the analysis view, not yet transitioned to overview)
    // Note: this assertion uses a short timeout since we just confirmed characters
    // appeared; the transition happens after analysis_complete.
    const stepsStillVisible = await analysisSteps.isVisible();
    expect(stepsStillVisible).toBe(true);

    // ── 7. Wait for completion — screen should transition to overview ─────────
    // After analysis_complete the component calls setView('overview').
    // The overview is rendered by a different component (C8+), so we just assert
    // that analysis-steps eventually disappears (the analysis screen unmounts).
    await expect(analysisSteps).toBeHidden({ timeout: 120_000 });
  });
});
