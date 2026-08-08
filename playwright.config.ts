import { defineConfig } from '@playwright/test';

/**
 * Playwright configuration for the Electron end-to-end suite.
 *
 * The shell smoke tests launch production main/preload/renderer bundles through
 * Electron's test launcher. Release-hardening specs launch the actual Forge
 * packaged executable and attach over Chromium's remote-debugging protocol so
 * ASAR integrity and production fuses remain enabled. Both tiers use the real
 * compiled Rust sidecar and stay isolated from the jsdom Vitest suite.
 *
 * ## First packaged-launch cold start (#509)
 *
 * `page.waitForLoadState('domcontentloaded')` carries its own implicit 30s
 * timeout, independent of the `timeout: 60_000` below. A freshly packaged
 * app's very first Electron launch can be genuinely slower than that 30s
 * default (first-touch disk/AV scan on a fresh package), which would
 * otherwise fail a required check on nothing but bad luck.
 *
 * `e2e/helpers/packagedApp.ts` makes that budget explicit instead of relying
 * on the library default: `FIRST_LAUNCH_TIMEOUT_MS` (45s, with headroom under
 * this file's 60s hook timeout) governs the first packaged launch of a
 * worker process, `STEADY_STATE_LAUNCH_TIMEOUT_MS` (30s) governs every launch
 * after that. `launchInstrumentedElectronTestApp` also performs one warm-up
 * retry of the first launch only, and always logs the launch duration (not
 * only on failure), so a slow-but-passing cold start is a visible number in
 * the run log rather than only inferable from a timeout.
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
  // Kept at 0 rather than made non-zero (#509): a retry here would re-run
  // the whole test/hook -- including reopening any process/file handles it
  // already touched -- and could mask a genuine regression as "just flaky".
  // The one failure mode this file exists to guard against (a slow first
  // packaged Electron launch) is instead absorbed one layer down, at the
  // launch helper itself (see the block comment above and
  // e2e/helpers/packagedApp.ts's launchInstrumentedElectronTestApp), with an
  // explicit timeout and a single warm-up retry scoped to just that first
  // launch -- not to the test as a whole.
  retries: 0,
  reporter: [['list']],
});
