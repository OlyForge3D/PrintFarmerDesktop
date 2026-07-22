import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the Electron end-to-end suite.
 *
 * These tests launch the *real* built Electron app (main + preload + renderer
 * bundles under `.vite/`, produced by `npm run package`) together with the
 * compiled Rust sidecar, and drive it through Chromium's DevTools protocol.
 * They are intentionally isolated from the Vitest unit suite (`tests/`), which
 * runs in jsdom without a real Electron process.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  // Launching Electron + spawning the sidecar is slower than a unit test.
  timeout: 60_000,
  expect: { timeout: 15_000 },
  // A single Electron app instance is shared across the file; never parallelize.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
});
