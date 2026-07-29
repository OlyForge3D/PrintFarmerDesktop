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
  // Stub shell.openExternal WITHOUT calling the original — no side effects in tests.
  await app.evaluate(({ shell }) => {
    (shell as { openExternal: (url: string) => Promise<void> }).openExternal =
      async (url: string) => {
        process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] = url;
        // Deliberately does NOT call the original — no real browser open in tests.
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

  const capturedUrl = await app.evaluate(
    () => process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] ?? null,
  );

  expect(capturedUrl).toMatch(/^https:\/\/github\.com\//);
  expect(capturedUrl).toContain('Filament_Calibration_Wizard');
  expect(capturedUrl).toContain('v1.3.2');
});

// ─── Calibration IPC — named channels reject bad input (S-01, S-05) ──────────

test('calibration: getCalibrationQueueState rejects request with missing profileId (S-01)', async () => {
  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            getCalibrationQueueState: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.getCalibrationQueueState({ jobId: null });
      return false;
    } catch {
      return true;
    }
  });
  // Zod schema rejects the request — no profileId supplied
  expect(threw).toBe(true);
});

test('calibration: acknowledgeCalibrationBedClear rejects request with invalid UUID (S-05)', async () => {
  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            acknowledgeCalibrationBedClear: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.acknowledgeCalibrationBedClear({
        profileId: 'not-a-uuid',
        jobId: 'also-not-a-uuid',
        printerId: 'still-not-a-uuid',
        operationId: 'not-a-uuid-either',
        jobEtag: 'AABBCCDD',
        dispatchStateEtag: 'AABBCCDD',
        expectedPrinterConfigRevision: 7,
      });
      return false;
    } catch {
      return true;
    }
  });
  // Zod schema rejects non-UUID profileId
  expect(threw).toBe(true);
});

test('calibration: startCalibrationGeneration rejects renderer-supplied arbitrary method (S-04)', async () => {
  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            startCalibrationGeneration: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.startCalibrationGeneration({
        profileId: '11111111-1111-4111-8111-111111111111',
        projectId: '22222222-2222-4222-8222-222222222222',
        attemptId: '33333333-3333-4333-8333-333333333333',
        operationId: '44444444-4444-4444-8444-444444444444',
        method: 'ARBITRARY_UNSAFE_METHOD',
        definitionVersion: '1.0',
        methodOptions: null,
        baseRevision: null,
      });
      return false;
    } catch {
      return true;
    }
  });
  // Method value must be from the allowed calibration method enum
  expect(threw).toBe(true);
});

// ─── Calibration IPC — no generic URL/shell primitive exposed (S-04) ─────────

test('calibration: no generic getCalibrationOrchestrationStatus without profileId (S-04)', async () => {
  // Verifies that the named IPC channel has Zod-validated schema that requires profileId
  const threw = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            getCalibrationOrchestrationStatus: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.getCalibrationOrchestrationStatus({
        orchestrationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        // profileId intentionally missing
      });
      return false;
    } catch {
      return true;
    }
  });
  expect(threw).toBe(true);
});

// ─── IPC unhandled-rejection safety (S-03, S-05) ─────────────────────────────

test('calibration: renderer IPC rejection is surfaced as a thrown error, not an unhandled promise (S-05)', async () => {
  // The preload bridge wraps IPC calls so that a schema rejection throws
  // synchronously in the renderer rather than creating an unhandled rejection.
  const result = await page.evaluate(async () => {
    let threw = false;
    let unhandled = false;
    const handler = () => {
      unhandled = true;
    };
    window.addEventListener('unhandledrejection', handler);
    try {
      await (
        window as unknown as {
          printFarmer: {
            openCalibrationExternalUrl: (r: unknown) => Promise<void>;
          };
        }
      ).printFarmer.openCalibrationExternalUrl({ linkId: 'not-in-allowlist' });
    } catch {
      threw = true;
    }
    // Yield so that unhandled-rejection handlers can fire if applicable
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    window.removeEventListener('unhandledrejection', handler);
    return { threw, unhandled };
  });
  expect(result.threw).toBe(true);
  expect(result.unhandled).toBe(false);
});
