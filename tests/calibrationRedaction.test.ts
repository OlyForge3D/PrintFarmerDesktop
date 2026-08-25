// @vitest-environment node

/**
 * Calibration observability: redaction and correlation, driven through the
 * *registered* IPC handlers (issue #159).
 *
 * The saga-specific generation/orchestration/queue/bed-clear correlation and
 * failure-path coverage this file used to hold was removed under issue #758,
 * alongside the `CalibrationStartGeneration`, `CalibrationGetOrchestrationStatus`,
 * `CalibrationGetQueueState`, and `CalibrationAcknowledgeBedClear` channels
 * themselves (issue #756's saga teardown). What remains here drives the real
 * `CalibrationGetDiagnostics` handler through the real `CalibrationHttpClient`,
 * the real wire schemas and the real correlation registry, with only `fetch`,
 * the profile service and the sidecar replaced.
 * Following the precedent in `tests/calibration.availability-negotiation.test.ts`.
 *
 * ## Why every redaction claim here has a control
 *
 * Redaction in `calibrationLog` is structural: a record has no key for a token,
 * a credential, a photo or a path. That makes "the record contains no secret"
 * true *by construction* — and therefore worthless as evidence on its own. An
 * assertion that cannot fail proves nothing.
 *
 * So each claim below is paired with a control proving the secret was genuinely
 * in play on that same production path:
 *
 * - The JWT control asserts the `Authorization` header the client actually sent
 *   carried the token, so it was present at the moment the record was built.
 * - The backend-detail control asserts the server's ProblemDetails `detail`
 *   reached `CalibrationHttpError.message` and survived into the IPC error
 *   payload, so a logger reaching for `message` — which is what the ad-hoc
 *   `console.error(tag, error)` calls did — would have emitted it.
 * - Every content assertion is preceded by a non-empty guard on the captured
 *   record set, because an empty capture passes every "does not contain"
 *   assertion trivially.
 *
 * ## A finding this test pins and does not fix
 *
 * `CalibrationApiError.message` and `CalibrationSyncStatus.error` carry the
 * backend's ProblemDetails `detail` verbatim to the renderer. That is a real
 * leak channel and it is asserted below **as a control, not as desired
 * behaviour**. It is out of scope for #159, which governs emitted log records
 * and the diagnostics output; flagged for the reviewer to rule on rather than
 * silently changed.
 */

import {
  beforeEach,
  afterAll,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import osDefault from 'node:os';
import * as osNamespace from 'node:os';
import { IpcChannel } from '@shared/ipc';
import { CALIBRATION_FIXTURE_IDS } from './fixtures/calibrationContract.js';
import {
  captureCalibrationLogs,
  resetCalibrationLogSink,
} from '../src/main/calibrationLog.js';
import { calibrationCorrelation } from '../src/main/calibrationCorrelation.js';
import { validWorkspace } from './fixtures/calibrationWorkspacePayload.js';

type Handler = (event: unknown, request: unknown) => unknown;

/**
 * `registerIpcHandlers` builds a real `RetargetArtifactService`, which claims a
 * directory under the OS temp dir and, on initialize, reaps instance
 * directories whose owning process is gone. Registering handlers once per test
 * in the shared real temp dir races the retarget suite and surfaces as an
 * unhandled `EPERM: rmdir`. Retarget is irrelevant here, so give this file its
 * own temp root.
 */
/**
 * `retargetArtifacts` claims `<tmpdir>/PrintFarmer/retarget` and, on
 * `initialize()`, reaps sibling instance directories whose owner process is
 * gone. That is right in production and hostile in a test: this file registers
 * the IPC handlers several times, so several instances reap the same tree
 * concurrently and race each other into `EPERM: rmdir` / `ENOENT: lstat`.
 * Vitest reports those as unhandled rejections and exits non-zero even with
 * every test green.
 *
 * The initialize call is also a floating promise in `ipc.ts`, so the test
 * cannot await it. Handing every caller its own fresh root removes the shared
 * tree the instances were fighting over.
 */
const tempRootRef = vi.hoisted(() => ({ path: '' }));

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  const fs = await import('node:fs');
  const p = await import('node:path');
  tempRootRef.path = fs.mkdtempSync(
    p.join(actual.tmpdir(), `pf-calibration-log-${process.pid}-`),
  );
  // `retargetArtifacts.ts` imports the default export, so the override has to
  // be on the default too. Returning the unmodified `actual` as `default` left
  // the real temp dir in play and made this mock silently do nothing.
  const patched = {
    ...actual,
    tmpdir: () => fs.mkdtempSync(p.join(tempRootRef.path, 'root-')),
  };
  return { ...patched, default: patched };
});

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => '/test/userData',
    getVersion: () => '0.0.0-test',
    on: () => undefined,
  },
  ipcMain: {
    handle: (channel: string, handler: Handler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => ({ id: 'window-stub' }) },
  dialog: { showOpenDialog: () => Promise.resolve({ canceled: true }) },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  shell: {},
}));

const { registerIpcHandlers } = await import('../src/main/ipc.js');

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const BASE_URL = 'http://farm.local';

/** A structurally real JWT: three base64url segments. */
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvcGVyYXRvciJ9.c2lnbmF0dXJlLXZhbHVl';
const API_KEY = 'pf_live_sk_9d41c0ba7e5f4a2b8c6d0e3f1a5b7c9d';
/** A GPS EXIF payload of the kind a phone photo carries. */
const EXIF_GPS = 'GPSLatitude=47.6062N;GPSLongitude=122.3321W';
const ABSOLUTE_PATH =
  '/Users/operator/Library/Application Support/PrintFarmer/calibration-photos/v1/plate.jpg';

/** Every secret class issue #159 names, in one place. */
const SECRETS: ReadonlyArray<[string, string]> = [
  ['a JWT', JWT],
  ['a server credential', API_KEY],
  ['photo EXIF/GPS metadata', EXIF_GPS],
  ['an absolute local path', ABSOLUTE_PATH],
];

function fakeProfiles() {
  return {
    list: () =>
      Promise.resolve({ profiles: [], selectedProfileId: PROFILE_ID }),
    // The real token the client will put in the Authorization header.
    getAuthenticatedContext: () =>
      Promise.resolve({
        profile: { id: PROFILE_ID, baseUrl: BASE_URL },
        token: JWT,
        serverBinding: 'binding-abc',
      }),
    getAuthenticatedServerContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: JWT,
        binding: 'binding-abc',
      }),
    onBindingChanged: () => () => undefined,
  };
}

/**
 * A sidecar whose outbox is clean, so the online-action prerequisite check
 * passes and the generation/queue handlers reach the network.
 */
function fakeSidecar(overrides: Record<string, unknown> = {}) {
  const workspace = validWorkspace();
  return {
    initialize: () => Promise.resolve(),
    dispose: () => Promise.resolve(),
    disposeAll: () => Promise.resolve(),
    countCalibrationPendingOps: () => Promise.resolve(0),
    isCalibrationPrinterContextFresh: () => Promise.resolve(true),
    listCalibrationConflicts: () => Promise.resolve([]),
    listCalibrationPendingOps: () => Promise.resolve([]),
    getCalibrationCursorState: () =>
      Promise.resolve({
        cursor: null,
        serverRevision: 0,
        checkpointGeneration: 0,
      }),
    commitCalibrationCursor: () => Promise.resolve(),
    applyCalibrationSnapshot: () => Promise.resolve(),
    settleCalibrationOp: () => Promise.resolve(),
    replayCalibrationOp: () => Promise.resolve(),
    recordCalibrationConflict: () => Promise.resolve(),
    getCalibrationWorkspaceState: () =>
      Promise.resolve({
        profileId: PROFILE_ID,
        projectId: workspace.domainState.projectId,
        printerId: workspace.domainState.binding.printer.backendPrinterId,
        displayName: workspace.metadata.displayName,
        description: null,
        status: 'draft',
        completedStepCount: 0,
        totalStepCount: 9,
        isSynced: false,
        isPrinterContextFresh: true,
        hasConflicts: false,
        remoteProjectId: null,
        baseRevision: null,
        createdAt: CALIBRATION_FIXTURE_IDS.now,
        updatedAt: CALIBRATION_FIXTURE_IDS.now,
        workspaceState: workspace,
      }),
    ...overrides,
  };
}

function handlers(
  sidecar = fakeSidecar(),
  profiles: unknown = fakeProfiles(),
): Map<string, Handler> {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    profiles as never,
    sidecar as never,
    sidecar as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    {
      canonicalizePickerFile: (p: string) => Promise.resolve(p),
      authorizeFile: () => Promise.reject(new Error('denied')),
      resolve: () => Promise.reject(new Error('denied')),
      approveFromPicker: () => Promise.reject(new Error('denied')),
      reset: () => Promise.resolve(),
    } as never,
    {
      initialize: () => Promise.resolve(),
      purge: () => Promise.resolve(),
    } as never,
  );
  return electronState.handlers;
}

function invoke(
  registered: Map<string, Handler>,
  channel: string,
  request: unknown,
): Promise<unknown> {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return Promise.resolve(handler(undefined, request));
}

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

afterEach(() => {
  resetCalibrationLogSink();
  vi.unstubAllGlobals();
  electronState.handlers.clear();
  // The registry is process-wide, so without this a job ID bound by one test
  // resolves to the previous test's flow.
  calibrationCorrelation.clear();
});

const TEMP_ROOT_PREFIX = 'pf-calibration-log-';
const TEMP_ROOT_OWNER = /^pf-calibration-log-(\d+)-/;

/**
 * Reap roots left by *dead* runs only.
 *
 * The first version of this swept every `pf-calibration-log-*` in `%TEMP%`
 * except its own, on the reasoning that anything else was left over from a
 * previous run. That reasoning holds for one checkout and is false on any
 * machine running two — `os.tmpdir()` is shared process-wide *and*
 * worktree-wide, so a concurrent run of this file in another checkout had its
 * root deleted mid-test and failed with `ENOENT: mkdtemp`. CI never saw it:
 * each job is an isolated runner with exactly one checkout, so the sweep had
 * nothing foreign to hit. It reproduced roughly one run in four locally.
 *
 * So ownership is now explicit rather than inferred: the root name carries the
 * pid that created it, and a root is only removed once that process is gone.
 * This mirrors `retargetArtifacts.ts`, which already gates instance cleanup on
 * `isProcessRunning(marker.pid)` for the same reason.
 */
function ownerIsGone(entry: string): boolean {
  const owner = TEMP_ROOT_OWNER.exec(entry);
  // Unattributable roots predate this scheme; leave them rather than guess.
  if (!owner) return false;
  const pid = Number(owner[1]);
  if (pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM means the pid is alive and owned by someone else.
    return (error as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

function reapStaleTempRoots(): void {
  if (tempRootRef.path === '') return;
  const parent = path.dirname(tempRootRef.path);
  for (const entry of readdirSync(parent)) {
    if (!entry.startsWith(TEMP_ROOT_PREFIX)) continue;
    const candidate = path.join(parent, entry);
    if (candidate === tempRootRef.path) continue;
    if (!ownerIsGone(entry)) continue;
    rmSync(candidate, { recursive: true, force: true });
  }
}

afterAll(() => {
  // Deliberately no `rmSync` here. `ipc.ts:237` calls
  // `retargetArtifacts.initialize()` as a floating promise, so this file has no
  // handle to await; deleting the tree in `afterAll` removed directories out
  // from under an initialize still in flight and produced an unhandled
  // `ENOENT: lstat`, which fails the run with every test green. Instead the
  // roots are left in the OS temp directory and reaped by the *next* run, when
  // nothing is holding them. See the known non-fixes in the PR body.
  reapStaleTempRoots();
});

// ==========================================================================
// The two mechanisms this file depends on, pinned (#228)
// ==========================================================================

/**
 * Both were shipped correct and unprotected. Removing the ownership guard left
 * all of this file's tests green despite being the exact edit that fails two
 * runs in three concurrently, and the `node:os` mock had already been reverted
 * once to a shape that did nothing and passed CI by luck.
 *
 * A fix with no failing-before is a fix that can be reverted with nothing
 * noticing, so each assertion below is the *discriminating* one. "No error was
 * thrown" is satisfied by a mechanism that never fired, which is exactly how
 * the broken mock passed: an unfired mechanism and a working one look identical
 * from the outside.
 */
describe('temp-root ownership and the node:os override', () => {
  it('spares a live foreign root and reaps a dead one', async () => {
    // A root is foreign-but-live only if some *other* process really is alive,
    // so borrow real pids rather than assert against invented numbers.
    const live = spawn(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 60000)'],
      {
        stdio: 'ignore',
      },
    );
    const doomed = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await once(doomed, 'exit');

    expect(tempRootRef.path).not.toBe('');
    expect(live.pid).toBeTypeOf('number');
    expect(doomed.pid).toBeTypeOf('number');

    const parent = path.dirname(tempRootRef.path);
    const liveRoot = path.join(
      parent,
      `${TEMP_ROOT_PREFIX}${String(live.pid)}-probe`,
    );
    const deadRoot = path.join(
      parent,
      `${TEMP_ROOT_PREFIX}${String(doomed.pid)}-probe`,
    );
    mkdirSync(liveRoot, { recursive: true });
    mkdirSync(deadRoot, { recursive: true });

    try {
      // Both exist going in, so a later `false` cannot be a directory that was
      // never created.
      expect(existsSync(liveRoot)).toBe(true);
      expect(existsSync(deadRoot)).toBe(true);

      reapStaleTempRoots();

      // Fails if the ownership guard is dropped: the sweep would take a root
      // belonging to a process still using it, which is the cross-checkout
      // ENOENT this scheme replaced.
      expect(existsSync(liveRoot)).toBe(true);
      // Fails if reaping is disabled altogether, so the test above cannot be
      // satisfied by a sweep that simply does nothing.
      expect(existsSync(deadRoot)).toBe(false);
    } finally {
      live.kill();
      rmSync(liveRoot, { recursive: true, force: true });
      rmSync(deadRoot, { recursive: true, force: true });
    }
  });

  it('routes tmpdir into the private root through the default export', async () => {
    const actual = await vi.importActual<typeof import('node:os')>('node:os');

    expect(tempRootRef.path).not.toBe('');
    // Control: the override only means something if it differs from the real
    // temp dir. Without this, both assertions below would pass on a mock that
    // returned the unmodified module.
    expect(path.dirname(tempRootRef.path)).toBe(actual.tmpdir());

    // `retargetArtifacts.ts` imports the *default* export, so this is the
    // assertion that goes red on `return { ...patched, default: actual }` —
    // the shape that shipped once and did nothing.
    expect(path.dirname(osDefault.tmpdir())).toBe(tempRootRef.path);
    // The named export is a separate binding and can regress independently.
    expect(path.dirname(osNamespace.tmpdir())).toBe(tempRootRef.path);
  });
});

// ==========================================================================
// Diagnostics
// ==========================================================================

describe('diagnostics command', () => {
  let capture: ReturnType<typeof captureCalibrationLogs>;

  beforeEach(() => {
    capture = captureCalibrationLogs();
  });

  afterEach(() => {
    capture.stop();
    resetCalibrationLogSink();
  });

  it('reports outbox depth, conflict count and a copyable report, secret-free', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(json({}, 503))),
    );
    const registered = handlers(
      fakeSidecar({
        countCalibrationPendingOps: () => Promise.resolve(3),
        listCalibrationConflicts: () =>
          Promise.resolve([
            {
              conflictId: '99999999-9999-4999-8999-999999999999',
              profileId: PROFILE_ID,
              projectId: PROJECT_ID,
              entityId: ATTEMPT_ID,
              entityType: 'CalibrationAttempt',
              conflictKind: 'outcomeSelection',
              serverRevision: 4,
              createdAt: '2026-01-01T00:00:00.000Z',
            },
          ]),
      }),
    );
    const diagnostics = (await invoke(
      registered,
      IpcChannel.CalibrationGetDiagnostics,
      { profileId: PROFILE_ID },
    )) as {
      profileId: string | null;
      outbox: {
        pendingOperationCount: number;
        unresolvedConflictCount: number;
      } | null;
      report: string;
    };

    expect(diagnostics.profileId).toBe(PROFILE_ID);
    expect(diagnostics.outbox?.pendingOperationCount).toBe(3);
    expect(diagnostics.outbox?.unresolvedConflictCount).toBe(1);
    // Non-empty guard: an empty report would satisfy every "does not contain"
    // assertion below without proving anything.
    expect(diagnostics.report.length).toBeGreaterThan(100);
    for (const [label, secret] of SECRETS) {
      expect(
        diagnostics.report,
        `${label} reached the copyable diagnostics report`,
      ).not.toContain(secret);
    }
    // Control: the profile the report describes is authenticated with that
    // exact JWT, so the token was reachable from the data the report was built
    // from.
    await expect(
      fakeProfiles().getAuthenticatedContext(),
    ).resolves.toMatchObject({ token: JWT });
  });

  // The runbooks tell an operator which `outboxUnavailableReason` values they
  // can actually meet. That is a claim about this call site: the handler passes
  // the sidecar adapter unconditionally, so `notAttempted` is unreachable here
  // and the runbook is entitled to say so. If that ever stops being true these
  // two tests fail, rather than the documentation quietly going false.
  it('reports noProfileSelected, never notAttempted, when no profile is selected', async () => {
    const registered = handlers(fakeSidecar(), {
      ...fakeProfiles(),
      list: () => Promise.resolve({ profiles: [], selectedProfileId: null }),
    });
    const diagnostics = (await invoke(
      registered,
      IpcChannel.CalibrationGetDiagnostics,
      {},
    )) as {
      outbox: unknown;
      outboxUnavailableReason: string | null;
      report: string;
    };

    expect(diagnostics.outbox).toBeNull();
    // The value, not merely the key: `notAttempted` is what a handler that had
    // stopped supplying an outbox source would produce, and it wins on
    // precedence, so this assertion is what pins the call site.
    expect(diagnostics.outboxUnavailableReason).toBe('noProfileSelected');
    expect(diagnostics.report).toContain('unavailable (noProfileSelected)');
  });

  it('reports an available outbox when a profile is selected', async () => {
    // Positive control for the test above: without it, `noProfileSelected`
    // is indistinguishable from a handler that can never reach the outbox at
    // all, and the pin would hold for the wrong reason.
    const registered = handlers(
      fakeSidecar({ countCalibrationPendingOps: () => Promise.resolve(2) }),
    );
    const diagnostics = (await invoke(
      registered,
      IpcChannel.CalibrationGetDiagnostics,
      { profileId: PROFILE_ID },
    )) as {
      outbox: { pendingOperationCount: number } | null;
      outboxUnavailableReason: string | null;
    };

    expect(diagnostics.outbox?.pendingOperationCount).toBe(2);
    expect(diagnostics.outboxUnavailableReason).toBeNull();
  });

  it('records the negotiated capability snapshot when availability is checked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          json({
            apiContractVersion: '1.4',
            calibrationApiVersion: '2026-07-01',
            calibrationSchemaVersion: '7',
            // Load-bearing: `calibrationPersistenceEnabled` and
            // `calibrationSyncEnabled` back the internal `calibrationApi*`
            // / `calibrationChangeFeed*` / `calibrationOfflineDraft*` gates.
            // The `calibrationContextEnabled` / `calibrationEventsEnabled`
            // / `operatorFeatures.offlineWriteReplayEnabled` fields are real
            // wire fields the schema declares but are not the load-bearing
            // bits today. See `CALIBRATION_FLAG_SOURCES`.
            calibrationContextEnabled: true,
            calibrationEventsEnabled: true,
            calibrationPersistenceEnabled: true,
            calibrationSyncEnabled: true,
            calibrationPhotosEnabled: true,
            calibrationGenerationEnabled: true,
            operatorFeatures: { offlineWriteReplayEnabled: true },
            supportedFirmwareFamilies: ['Klipper'],
            supportedGcodeDialects: ['Klipper'],
            supportedSlicerEngines: [
              { engine: 'OrcaSlicer', versions: ['2.1'] },
            ],
            effectivePermissions: ['calibration:read'],
          }),
        ),
      ),
    );
    const registered = handlers();
    await invoke(registered, IpcChannel.CalibrationGetAvailability, undefined);
    const diagnostics = (await invoke(
      registered,
      IpcChannel.CalibrationGetDiagnostics,
      { profileId: PROFILE_ID },
    )) as {
      capability: {
        negotiatedApiVersion: string | null;
        negotiatedSchemaVersion: string | null;
        grantedScopes: string[];
      } | null;
      report: string;
    };
    expect(diagnostics.capability?.negotiatedApiVersion).toBe('2026-07-01');
    expect(diagnostics.capability?.negotiatedSchemaVersion).toBe('7');
    expect(diagnostics.capability?.grantedScopes).toEqual(['calibration:read']);
    expect(diagnostics.report).toContain('2026-07-01');
  });
});
