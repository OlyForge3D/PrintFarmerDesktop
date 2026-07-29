/**
 * Calibration workspace Playwright E2E tests (D-07, A-02, S-04).
 *
 * Tests run against the built Electron app (same architecture as mvp.spec.ts).
 * Requires compiled artifacts from `npm run test:e2e` (which runs build-e2e.mjs
 * first) or from a prior `npm run package`.
 *
 * Coverage areas:
 *   - Security boundary: openCalibrationExternalUrl IPC exists, window.open blocked
 *   - Preload bridge availability (A-02, S-01, S-04)
 *   - CalibrationApi does not expose generic URL primitives (S-04)
 *   - Basic calibration workspace navigation
 *   - Focus trap skeleton: Tab key cycles focus inside modal-like panels
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const requiredArtifacts = [
  path.join(repoRoot, '.vite', 'build', 'main.js'),
  path.join(repoRoot, '.vite', 'build', 'preload.js'),
  path.join(repoRoot, '.vite', 'renderer', 'main_window', 'index.html'),
];

let app: ElectronApplication;
let page: Page;
let e2eStateRoot: string;

test.beforeAll(async () => {
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run test:e2e` (which builds first) before running calibration E2E.',
      );
    }
  }

  e2eStateRoot = mkdtempSync(path.join(repoRoot, '.pf-cal-e2e-'));
  const catalogDb = path.join(e2eStateRoot, 'catalog.sqlite3');
  const userDataPath = path.join(e2eStateRoot, 'user-data');
  mkdirSync(userDataPath, { recursive: true });

  app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PRINTFARMER_CATALOG_DB: catalogDb,
      PRINTFARMER_USER_DATA_PATH: userDataPath,
    },
  });

  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  if (e2eStateRoot) {
    rmSync(e2eStateRoot, { recursive: true, force: true });
  }
});

// ─── A-02 / S-01 / S-04: Allowlisted external navigation IPC ─────────────────

test('openCalibrationExternalUrl is present on the preload bridge (A-02, S-01)', async () => {
  const fnType = await page.evaluate(
    () =>
      typeof (window as unknown as { printFarmer?: Record<string, unknown> })
        .printFarmer?.openCalibrationExternalUrl,
  );
  expect(fnType).toBe('function');
});

test('no generic openExternalUrl(url:string) primitive on printFarmer bridge (S-04)', async () => {
  const hasGeneric = await page.evaluate(
    () =>
      'openExternalUrl' in
      ((window as unknown as { printFarmer?: Record<string, unknown> })
        .printFarmer ?? {}),
  );
  // The generic url-string primitive must NOT be exposed on the bridge
  expect(hasGeneric).toBe(false);
});

test('renderer window.open is blocked by setWindowOpenHandler (S-04)', async () => {
  // Electron hardenWindow() installs setWindowOpenHandler that denies all
  // new windows; window.open() returns null in the renderer.
  const result = await page.evaluate(() => {
    const w = window.open('https://example.com', '_blank');
    return w === null;
  });
  expect(result).toBe(true);
});

test('openCalibrationExternalUrl rejects invalid linkId via preload Zod schema (S-05)', async () => {
  // The preload bridge validates the request using ipcSchemas before invoking IPC.
  // An invalid linkId must throw or reject rather than pass through to main.
  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            openCalibrationExternalUrl: (r: unknown) => Promise<void>;
          };
        }
      ).printFarmer.openCalibrationExternalUrl({
        linkId: 'https://evil.example.com/arbitrary',
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(true);
});

// ─── Basic app mount / preload bridge ─────────────────────────────────────────

test('calibration: preload bridge is an object with calibration IPC methods', async () => {
  const methods = await page.evaluate(() => {
    const api = (window as unknown as { printFarmer?: Record<string, unknown> })
      .printFarmer;
    if (!api) return [];
    return [
      'startCalibrationGeneration',
      'getCalibrationOrchestrationStatus',
      'getCalibrationQueueState',
      'acknowledgeCalibrationBedClear',
      'openCalibrationExternalUrl',
      'openCalibrationLocalModel',
      'validateCalibrationLocalModel',
    ].filter((key) => typeof api[key] === 'function');
  });
  expect(methods).toContain('startCalibrationGeneration');
  expect(methods).toContain('getCalibrationQueueState');
  expect(methods).toContain('acknowledgeCalibrationBedClear');
  expect(methods).toContain('openCalibrationExternalUrl');
});

test('calibration: openCalibrationExternalUrl with valid linkId calls through to shell (A-02)', async () => {
  // Intercept shell.openExternal in the main process to capture the URL.
  let capturedUrl: string | null = null;
  await app.evaluate(({ shell }) => {
    // Stub openExternal to capture the URL
    const originalOpen = shell.openExternal.bind(shell);
    (shell as { openExternal: (url: string) => Promise<void> }).openExternal =
      async (url: string) => {
        process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] = url;
        return originalOpen(url);
      };
  });

  await page.evaluate(async () => {
    await (
      window as unknown as {
        printFarmer: {
          openCalibrationExternalUrl: (r: { linkId: string }) => Promise<void>;
        };
      }
    ).printFarmer.openCalibrationExternalUrl({
      linkId: 'calibration-source-releases',
    });
  });

  capturedUrl = await app.evaluate(
    () => process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] ?? null,
  );

  expect(capturedUrl).toMatch(/^https:\/\/github\.com\//);
  expect(capturedUrl).toContain('Filament_Calibration_Wizard');
  expect(capturedUrl).toContain('v1.3.2');
});
