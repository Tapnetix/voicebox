// NOTE: Phase-C E2E reality — the /books route is not wired into the web build
// until C16, so per-task E2E specs (c6–c15) are authored RED and only go green
// at the phase-end E2E gate (orchestrator boots the live stack via `just dev-web`).
// C1 just needs `bunx playwright test --list` to parse the config without error.
import { defineConfig } from '@playwright/test';

const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  webServer: {
    command: 'just dev-web',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
