/**
 * Calibration preload-boundary Playwright E2E tests.
 *
 * The pre-#756 version of this file (ported from PR #135 e2e/calibration.spec.ts,
 * lines 1–1404) covered the D-07 IPC / preload boundary for the printer-
 * calibration saga: `startCalibrationGeneration`,
 * `getCalibrationOrchestrationStatus`, `getCalibrationQueueState`, and
 * `acknowledgeCalibrationBedClear` request-rejection and response-schema
 * acceptance tests. All four channels were reaped in
 * `OlyForge3D/PrintFarmerDesktop#756` — those tests were deleted rather than
 * weakened, because their subject no longer exists on the preload bridge.
 *
 * What survives is the set of preload boundary invariants that are still
 * meaningful under Path D:
 *
 *   - Preload bridge availability (A-02, S-01, S-04)
 *   - CalibrationApi does not expose generic URL primitives (S-04)
 *   - Request-schema Zod rejections propagate as thrown errors, not
 *     unhandled promise rejections (S-05)
 *
 * The rejection tests are retargeted at `cloneCalibrationFilamentProfile` —
 * the first of the five wizard channels, first-in-flow so a mutation making
 * its schema more permissive is discoverable immediately, and a channel whose
 * request contract requires `profileId: z.string().uuid()` (see
 * `CalibrationCloneFilamentProfileRequest` in `src/shared/ipc.ts`).
 *
 * Fixture strategy: no in-flight IPC mocks. Every test drives the live
 * production handler in the packaged app — the same code the operator hits.
 * The rejection tests deliberately do not install fixture handlers for the
 * channel under test, so the request lands on the real Zod parse.
 */
import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachPackagedFailureDiagnostics,
  cleanupPackagedApp,
  createPackagedFailureDiagnostics,
  createPackagedProcessLog,
  createPackagedStartupTrace,
  launchInstrumentedElectronTestApp,
  type PackagedProcessLog,
  type PackagedStartupTrace,
} from './helpers/packagedApp.js';

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
let appStarted = false;
let e2eStateRoot: string | null = null;
let processLog: PackagedProcessLog;
let startupTrace: PackagedStartupTrace;

test.beforeEach(async ({ browserName }) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run test:e2e` (which builds first) before this spec.',
      );
    }
  }

  processLog = createPackagedProcessLog();
  startupTrace = createPackagedStartupTrace();

  e2eStateRoot = mkdtempSync(path.join(tmpdir(), 'pf-cal-'));
  const catalogDb = path.join(e2eStateRoot, 'catalog.sqlite3');
  const userDataPath = path.join(e2eStateRoot, 'user-data');
  mkdirSync(userDataPath, { recursive: true });

  const launched = await launchInstrumentedElectronTestApp<
    Page,
    ElectronApplication
  >(
    () =>
      electron.launch({
        args: ['.'],
        cwd: repoRoot,
        env: {
          ...process.env,
          PRINTFARMER_CATALOG_DB: catalogDb,
          PRINTFARMER_USER_DATA_PATH: userDataPath,
        },
      }),
    processLog,
    startupTrace,
  );
  app = launched.app;
  page = launched.page;
  appStarted = true;

  // Seed localStorage with a library source root so the onboarding modal
  // does not block subsequent navigation. This spec exercises only the
  // preload bridge, so no calibration-specific IPC seeding is needed —
  // request rejections target the real production handlers, and no
  // in-flow calibration IPC is invoked here.
  await page.evaluate(() => {
    localStorage.setItem(
      'printfarmer.library.sourceRoots.v1',
      JSON.stringify({
        version: 1,
        roots: [
          {
            rootId: 'e2e-fixture-root-a',
            path: '/fixtures/e2e-models',
            approvalId: null,
            removed: false,
            lastReport: null,
            lastScannedAt: null,
          },
        ],
      }),
    );
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async ({ browserName }, testInfo) => {
  expect(browserName).toBe('chromium');
  let cleanupError: unknown;
  try {
    await cleanupPackagedApp(
      appStarted ? app : null,
      e2eStateRoot === null ? [] : [e2eStateRoot],
    );
  } catch (error) {
    cleanupError = error;
  }
  appStarted = false;
  e2eStateRoot = null;

  const primaryError =
    testInfo.error ??
    cleanupError ??
    new Error(`Calibration E2E ended with status ${testInfo.status}.`);
  if (
    testInfo.status !== testInfo.expectedStatus ||
    cleanupError !== undefined
  ) {
    await attachPackagedFailureDiagnostics(
      testInfo,
      processLog.read(),
      createPackagedFailureDiagnostics(
        primaryError,
        cleanupError === undefined ? [] : [cleanupError],
      ),
      startupTrace.snapshot(),
    );
  }
  if (cleanupError !== undefined) {
    throw cleanupError instanceof Error
      ? cleanupError
      : new Error('Calibration E2E cleanup failed with a non-Error value.', {
          cause: cleanupError,
        });
  }
});

// ─── A-02 / S-01 / S-04: Allowlisted external navigation IPC ─────────────────

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

// ─── Basic app mount / preload bridge ─────────────────────────────────────────

test('calibration: preload bridge exposes the filament wizard IPC methods', async () => {
  // The saga's `startCalibrationGeneration`, `getCalibrationOrchestrationStatus`,
  // `getCalibrationQueueState`, and `acknowledgeCalibrationBedClear` methods
  // were removed from the preload bridge in #756. The wizard's five channels
  // (Bishop #752) are the surviving IPC surface for filament calibration and
  // are what this test now asserts on.
  const methods = await page.evaluate(() => {
    const api = (window as unknown as { printFarmer?: Record<string, unknown> })
      .printFarmer;
    if (!api) return { present: [], absent: [] };
    const required = [
      'cloneCalibrationFilamentProfile',
      'submitCalibrationSlice',
      'getCalibrationSliceJobStatus',
      'sendCalibrationSliceToPrinter',
      'updateCalibrationFilamentProfileMeasurement',
    ];
    const reaped = [
      'startCalibrationGeneration',
      'getCalibrationOrchestrationStatus',
      'getCalibrationQueueState',
      'acknowledgeCalibrationBedClear',
    ];
    return {
      present: required.filter((key) => typeof api[key] === 'function'),
      absent: reaped.filter((key) => !(key in api)),
    };
  });
  // Positive arm: every surviving filament wizard method is on the bridge.
  expect(methods.present).toEqual([
    'cloneCalibrationFilamentProfile',
    'submitCalibrationSlice',
    'getCalibrationSliceJobStatus',
    'sendCalibrationSliceToPrinter',
    'updateCalibrationFilamentProfileMeasurement',
  ]);
  // Discriminator: every reaped saga method is absent. Without this control
  // the positive arm would still pass on a bridge that also exposed the
  // saga channels, and the reap would have regressed silently.
  expect(methods.absent).toEqual([
    'startCalibrationGeneration',
    'getCalibrationOrchestrationStatus',
    'getCalibrationQueueState',
    'acknowledgeCalibrationBedClear',
  ]);
});

// ─── Filament channel — named requests reject bad input (S-01, S-05) ─────────
// These tests exercise the REAL production handler (no fixture override for the
// channel under test). Each assertion checks the Zod error path string so that
// a mutation making the schema more permissive causes the assertion to fail.

test('calibration: cloneCalibrationFilamentProfile rejects request with missing profileId (S-01)', async () => {
  // Sends a request with sourceProfileId + name but NO profileId.
  // Production handler: ipcSchemas[CalibrationCloneFilamentProfile]
  //   .request.parse() rejects because profileId is z.string().uuid()
  //   (required).
  // The Zod error message JSON contains "profileId" in the path.
  // Mutation target: CalibrationCloneFilamentProfileRequest.profileId
  //   → optional.
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            cloneCalibrationFilamentProfile: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.cloneCalibrationFilamentProfile({
        sourceProfileId: '22222222-2222-4222-8222-222222222222',
        name: 'Test Clone',
        // profileId intentionally absent — Zod must reject
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  // Zod path ["profileId"] serialises into the error message JSON
  expect(msg).toMatch(/profileId/);
});

test('calibration: cloneCalibrationFilamentProfile rejects request with invalid UUID in profileId (S-05)', async () => {
  // All fields valid EXCEPT profileId which is a plain string.
  // Production handler: request.parse() rejects because profileId is
  //   z.string().uuid().
  // Zod error message contains "uuid" (the validation keyword).
  // Mutation target: CalibrationCloneFilamentProfileRequest.profileId
  //   → z.string() (loses .uuid()).
  const msg = await page.evaluate(async () => {
    try {
      await (
        window as unknown as {
          printFarmer: {
            cloneCalibrationFilamentProfile: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.cloneCalibrationFilamentProfile({
        profileId: 'not-a-valid-uuid',
        sourceProfileId: '22222222-2222-4222-8222-222222222222',
        name: 'Test Clone',
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  });
  expect(msg).not.toBeNull();
  // Zod "Invalid uuid" message for profileId
  expect(msg).toMatch(/uuid/i);
});

// ─── IPC unhandled-rejection safety (S-03, S-05) ─────────────────────────────

test('calibration: renderer IPC rejection is surfaced as a thrown error, not an unhandled promise (S-05)', async () => {
  // The property being asserted is independent of channel: any Zod-rejected
  // request must propagate as a thrown error in the renderer, not become an
  // unhandled promise rejection. `cloneCalibrationFilamentProfile` with a
  // syntactically invalid `profileId` is rejected by `z.string().uuid()` and
  // is the least-coupled surviving probe for that.
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
            cloneCalibrationFilamentProfile: (r: unknown) => Promise<unknown>;
          };
        }
      ).printFarmer.cloneCalibrationFilamentProfile({
        profileId: 'not-a-uuid',
        sourceProfileId: '22222222-2222-4222-8222-222222222222',
        name: 'Test Clone',
      });
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
