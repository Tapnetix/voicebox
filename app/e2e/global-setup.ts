/**
 * Playwright global setup — seeds "Silo 42" fixture before the test suite runs.
 *
 * Spawns the Python seed script synchronously so the DB is populated before
 * any spec navigates to /books. Fails loudly if the seed script exits non-zero.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export default function globalSetup() {
  // Resolve paths relative to the monorepo worktree root (one level up from app/)
  const worktreeRoot = path.resolve(__dirname, '..', '..');
  const python = path.join(worktreeRoot, 'backend', 'venv', 'bin', 'python');
  const seedScript = path.join(worktreeRoot, 'backend', 'tests', 'e2e_seed.py');

  console.log('[global-setup] Seeding E2E fixture: Silo 42…');
  try {
    execFileSync(python, [seedScript], {
      stdio: 'inherit',
      cwd: worktreeRoot,
    });
    console.log('[global-setup] Seed complete.');
  } catch (err) {
    console.error('[global-setup] Seed FAILED — aborting test run.');
    throw err;
  }
}
