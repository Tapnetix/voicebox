/**
 * Shared E2E test fixture — re-seeds the "Silo 42" book before EACH test.
 *
 * The book specs mutate shared state (reassign dialogue, split/merge segments,
 * merge/delete cast members). With a single global seed those mutations leak
 * across specs and make count/structure-sensitive assertions order-dependent
 * (e.g. the cast-merge total in c9). Re-seeding per test makes every spec
 * deterministic and independent of run order.
 *
 * `e2e_seed.py` is idempotent — it deletes and recreates the fixture book — so
 * calling it before each test resets to a known-good baseline. Synchronous
 * spawn is fine: the suite runs with workers=1 and no request is in flight at
 * beforeEach time (navigation happens inside the test body).
 */
import { test as base, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

function reseed() {
  const worktreeRoot = path.resolve(__dirname, '..', '..');
  const python = path.join(worktreeRoot, 'backend', 'venv', 'bin', 'python');
  const seedScript = path.join(worktreeRoot, 'backend', 'tests', 'e2e_seed.py');
  execFileSync(python, [seedScript], { cwd: worktreeRoot });
}

// An automatic, test-scoped fixture. Unlike a bare `test.beforeEach()` declared
// in an imported module (which Playwright does NOT attach to consumer spec
// files), an `auto` fixture on the extended `test` runs before every test in
// every file that imports this `test`.
export const test = base.extend<{ freshSeed: void }>({
  freshSeed: [
    async ({}, use) => {
      reseed();
      await use();
    },
    { auto: true },
  ],
});

export { expect };
