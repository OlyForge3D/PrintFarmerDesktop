import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the Electron end-to-end suite.
 *
 * The shell smoke tests launch production main/preload/renderer bundles through
 * Electron's test launcher. Release-hardening specs launch the actual Forge
 * packaged executable and attach over Chromium's remote-debugging protocol so
 * ASAR integrity and production fuses remain enabled. Both tiers use the real
 * compiled Rust sidecar and stay isolated from the jsdom Vitest suite.
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
