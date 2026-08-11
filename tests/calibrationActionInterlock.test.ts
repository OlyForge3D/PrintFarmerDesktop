// @vitest-environment node

/**
 * Production-path coverage for the calibration action interlock.
 *
 * Drives the registered `CalibrationStartGeneration`, `CalibrationStartPrint`
 * and `CalibrationAcknowledgeBedClear` handlers through the real HTTP client and
 * the real wire schemas, with only `fetch` and the profile service replaced.
 *
 * Every refusal is asserted together with the *absence of a dispatch*. A gate
 * that refuses after sending the request has not gated anything, and a response
 * assertion alone cannot tell the two apart — which is exactly how the previous
 * interlock passed review while sending machine-moving requests unchecked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';
import {
  CALIBRATION_FIXTURE_IDS,
  calibrationActionBindingFixture,
  calibrationContextDto,
} from './fixtures/calibrationContract.js';

type Handler = (event: unknown, request: unknown) => unknown;

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
const { calibrationDiagnostics } =
  await import('../src/main/calibrationDiagnostics.js');

const PROFILE_ID = CALIBRATION_FIXTURE_IDS.profileId;
const BASE_URL = 'http://farm.local';
const PROJECT_ID = '44444444-4444-4444-8444-444444444444';
const ATTEMPT_ID = '77777777-7777-4777-8777-777777777777';
const ORCHESTRATION_ID = '22222222-2222-4222-8222-222222222222';
const GCODE_FILE_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '55555555-5555-4555-8555-555555555555';
const OPERATION_ID = '66666666-6666-4666-8666-666666666666';

const CANONICAL_PERMISSIONS = [
  'calibration:read',
  'calibration:create',
  'calibration:update',
  'calibration:generate',
];

function fakeProfiles() {
  return {
    list: () =>
      Promise.resolve({ profiles: [], selectedProfileId: PROFILE_ID }),
    getAuthenticatedContext: () =>
      Promise.resolve({
        profile: { id: PROFILE_ID, baseUrl: BASE_URL },
        token: 'test-jwt',
        serverBinding: 'binding-abc',
      }),
    getAuthenticatedServerContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: 'test-jwt',
        binding: 'binding-abc',
      }),
    onBindingChanged: () => () => undefined,
  };
}

const sidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
  // The engine's online-action prerequisites, spelled as the sidecar adapter
  // actually calls them. All satisfied so that the interlock is what decides
  // these tests, not an unrelated precondition.
  countCalibrationPendingOps: () => Promise.resolve(0),
  isCalibrationPrinterContextFresh: () => Promise.resolve(true),
  listCalibrationConflicts: () => Promise.resolve([]),
  listCalibrationPendingOperations: () => Promise.resolve([]),
  getCalibrationCursorState: () =>
    Promise.resolve({ cursor: null, updatedAt: null }),
  commitCalibrationCursor: () => Promise.resolve(),
  applyCalibrationSnapshot: () => Promise.resolve(),
  settleCalibrationOperation: () => Promise.resolve(),
  recordCalibrationConflict: () => Promise.resolve(),
};

const QUEUE_JOB = {
  id: JOB_ID,
  rowVersion: 'AAAAAAAAAAAA==',
  revision: 1,
  dispatchStateRowVersion: 'BBBBBBBBBBBB==',
  dispatchStateRevision: 1,
  dispatchResult: null,
  jobKind: 'FilamentCalibration',
  calibrationProjectId: PROJECT_ID,
  calibrationAttemptId: ATTEMPT_ID,
  pinnedPrinterConfigRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
  gcodeFileId: GCODE_FILE_ID,
  gcodeFileName: 'calibration.gcode',
  assignedPrinterId: CALIBRATION_FIXTURE_IDS.printerId,
  assignedPrinterName: 'Voron 2.4',
  status: 'Queued',
  bedClearState: 'None',
  priority: 0,
  queuePosition: 1,
  copies: 1,
  completedCopies: 0,
  remainingCopies: 1,
  createdAt: CALIBRATION_FIXTURE_IDS.now,
  updatedAt: CALIBRATION_FIXTURE_IDS.now,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Routes by URL and records what was actually sent. */
function server(
  options: {
    permissions?: readonly string[];
    generationEnabled?: boolean;
    context?: unknown;
    job?: Record<string, unknown>;
  } = {},
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL | string, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.href;
      calls.push(`${init?.method ?? 'GET'} ${href}`);
      if (href.includes('/api/calibration/capabilities')) {
        return Promise.resolve(
          json(
            printFarmerCapabilitiesResponse({
              effectivePermissions:
                options.permissions ?? CANONICAL_PERMISSIONS,
              calibrationGenerationEnabled: options.generationEnabled ?? true,
            }),
          ),
        );
      }
      if (href.includes('calibration-context')) {
        return Promise.resolve(
          json(options.context ?? calibrationContextDto()),
        );
      }
      if (href.includes('acknowledge-bed-clear-and-start')) {
        return Promise.resolve(
          json({
            jobETag: 'CCCCCCCCCCCC==',
            dispatchStateETag: 'DDDDDDDDDDDD==',
          }),
        );
      }
      if (href.includes('generate-job')) {
        return Promise.resolve(
          json({
            id: ORCHESTRATION_ID,
            projectId: PROJECT_ID,
            attemptId: ATTEMPT_ID,
            operationId: OPERATION_ID,
            status: 'Running',
            currentStep: 'Slicing',
            revision: 1,
            retryCount: 0,
            nextRetryAtUtc: null,
            stepStartedAtUtc: null,
            lastErrorCode: null,
            problems: [],
            model3DId: null,
            sliceJobId: null,
            workerId: null,
            sourceArtifactId: null,
            finalArtifactId: null,
            gcodeFileId: null,
            specificationSha256: null,
            planManifestSha256: null,
            gcodeSha256: null,
            statusRoute: `/api/calibration-orchestrations/${ORCHESTRATION_ID}`,
            createdAtUtc: CALIBRATION_FIXTURE_IDS.now,
            updatedAtUtc: CALIBRATION_FIXTURE_IDS.now,
          }),
        );
      }
      if (href.includes('job-queue')) {
        return Promise.resolve(json({ ...QUEUE_JOB, ...options.job }));
      }
      return Promise.resolve(json({}, 404));
    }),
  );
  return { calls };
}

function handlers(): Map<string, Handler> {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    fakeProfiles() as never,
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

let registered: Map<string, Handler>;

function invoke(channel: string, request?: unknown): Promise<unknown> {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return Promise.resolve(handler(undefined, request));
}

/** Negotiate capabilities, as the workspace does when it opens. */
async function negotiate(): Promise<void> {
  await invoke(IpcChannel.CalibrationGetAvailability, undefined);
}

const generationRequest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  projectId: PROJECT_ID,
  attemptId: ATTEMPT_ID,
  method: 'FlowRate',
  definitionVersion: '1.0',
  options: {},
  operationId: OPERATION_ID,
  baseRevision: null,
  binding: calibrationActionBindingFixture(),
  ...overrides,
});

const bedClearRequest = (
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  profileId: PROFILE_ID,
  jobId: JOB_ID,
  operationId: OPERATION_ID,
  printerId: CALIBRATION_FIXTURE_IDS.printerId,
  rowVersion: 'AAAAAAAAAAAA==',
  dispatchStateRowVersion: 'BBBBBBBBBBBB==',
  expectedPrinterConfigRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
  ...overrides,
});

const dispatched = (calls: readonly string[], fragment: string): boolean =>
  calls.some((call) => call.includes(fragment));

beforeEach(() => {
  vi.unstubAllGlobals();
  // Capability negotiation is recorded in a process-wide store, so without this
  // a test asserting "nothing has been negotiated" would silently inherit the
  // negotiation of whichever test ran before it — and would pass against a gate
  // that never checked.
  calibrationDiagnostics.reset();
});

describe('generation dispatches only with complete evidence', () => {
  it('submits when permission, capability and binding all hold', async () => {
    // Control. Without it every refusal below would be satisfied by a handler
    // that refuses unconditionally.
    const { calls } = server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string };
    expect(response.status).toBe('submitted');
    expect(dispatched(calls, 'generate-job')).toBe(true);
  });

  it('refuses before dispatch when capabilities were never negotiated', async () => {
    const { calls } = server();
    registered = handlers();
    // Deliberately no negotiation: nothing has authorised anything yet.
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string; error: { code: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
    // The refusal cost no request at all.
    expect(dispatched(calls, 'generate-job')).toBe(false);
  });

  it('refuses before dispatch without calibration:generate', async () => {
    const { calls } = server({
      permissions: [
        'calibration:read',
        'calibration:create',
        'calibration:update',
      ],
    });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string; error: { code: string; message: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
    expect(response.error.message).toContain('calibration:generate');
    expect(dispatched(calls, 'generate-job')).toBe(false);
  });

  it('refuses before dispatch when the deployment has generation disabled', async () => {
    const { calls } = server({ generationEnabled: false });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string };
    expect(response.status).toBe('error');
    expect(dispatched(calls, 'generate-job')).toBe(false);
  });

  it('refuses before dispatch when the configuration moved on', async () => {
    const { calls } = server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest({
        binding: calibrationActionBindingFixture({ configurationRevision: 99 }),
      }),
    )) as { status: string; error: { code: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('printerContextStale');
    expect(dispatched(calls, 'generate-job')).toBe(false);
  });

  it('refuses before dispatch when the binding names another printer', async () => {
    const { calls } = server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest({
        binding: calibrationActionBindingFixture({
          printerId: CALIBRATION_FIXTURE_IDS.otherPrinterId,
          configurationRevision: null,
          snapshotId: null,
          toolId: null,
        }),
      }),
    )) as { status: string };
    expect(response.status).toBe('error');
    expect(dispatched(calls, 'generate-job')).toBe(false);
  });

  it('cannot be asked to generate without naming a binding at all', async () => {
    server();
    registered = handlers();
    await negotiate();
    const withoutBinding = { ...generationRequest() };
    delete withoutBinding.binding;
    await expect(
      invoke(IpcChannel.CalibrationStartGeneration, withoutBinding),
    ).rejects.toThrow();
  });
});

describe('bed-clear dispatch requires a ledger-backed acknowledgement', () => {
  it('acknowledges when the server reports the job awaiting bed clear', async () => {
    const { calls } = server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string };
    expect(response.status).toBe('ok');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(true);
  });

  it('refuses before dispatch when the server already consumed the acknowledgement', async () => {
    // A replay. The server has spent this acknowledgement, so no ledger record
    // is minted and the dispatch has nothing to consume.
    const { calls } = server({ job: { bedClearState: 'Consumed' } });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string; error: { code: string; message: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
    expect(response.error.message).toMatch(/machine is clear/i);
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
  });

  it('refuses before dispatch when the server invalidated the acknowledgement', async () => {
    const { calls } = server({ job: { bedClearState: 'Invalidated' } });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string };
    expect(response.status).toBe('error');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
  });

  it('refuses before dispatch when the job is assigned to a different printer', async () => {
    // The renderer cannot manufacture the server's own view of the job, which
    // is the whole reason the acknowledgement is established in main.
    const { calls } = server({
      job: { assignedPrinterId: CALIBRATION_FIXTURE_IDS.otherPrinterId },
    });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string };
    expect(response.status).toBe('error');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
  });

  it('refuses before dispatch without calibration:update', async () => {
    const { calls } = server({
      permissions: ['calibration:read', 'calibration:create'],
    });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string; error: { message: string } };
    expect(response.status).toBe('error');
    expect(response.error.message).toContain('calibration:update');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
  });

  it('refuses before dispatch when the pinned revision no longer matches', async () => {
    const { calls } = server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest({ expectedPrinterConfigRevision: 99 }),
    )) as { status: string };
    expect(response.status).toBe('error');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
  });
});

describe('enqueue is gated, but not on a bed-clear acknowledgement', () => {
  const printRequest = (
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    attemptId: ATTEMPT_ID,
    orchestrationId: ORCHESTRATION_ID,
    gcodeFileId: GCODE_FILE_ID,
    assignedPrinterId: CALIBRATION_FIXTURE_IDS.printerId,
    operationId: OPERATION_ID,
    pinnedPrinterConfigRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    gcodeContentSha256: null,
    specificationSha256: null,
    machineProfileSha256: null,
    processProfileSha256: null,
    filamentProfileSha256: null,
    printerConfigSnapshotSha256: null,
    requiredFirmwareFamily: 'Klipper',
    requiredGcodeDialect: 'Klipper',
    requiredSlicerEngine: null,
    requiredSlicerDistribution: null,
    requiredSlicerVersion: null,
    requiredSlicerContainerDigest: null,
    ...overrides,
  });

  it('enqueues without any bed-clear evidence', async () => {
    // Placing a job in the queue moves nothing. Requiring an acknowledgement
    // here would be unsatisfiable, because the job being acknowledged does not
    // exist until this call has already succeeded.
    server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartPrint,
      printRequest(),
    )) as { status: string };
    expect(response.status).toBe('ok');
  });

  it('refuses before dispatch when the pinned revision is stale', async () => {
    const { calls } = server();
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartPrint,
      printRequest({ pinnedPrinterConfigRevision: 99 }),
    )) as { status: string; error: { code: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('printerContextStale');
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);
  });

  it('refuses before dispatch without calibration:update', async () => {
    const { calls } = server({
      permissions: ['calibration:read', 'calibration:create'],
    });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationStartPrint,
      printRequest(),
    )) as { status: string };
    expect(response.status).toBe('error');
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);
  });
});

describe('outbox application is gated too', () => {
  it('refuses to sync without a write permission and sends nothing', async () => {
    const { calls } = server({ permissions: ['calibration:read'] });
    registered = handlers();
    await negotiate();
    const response = (await invoke(IpcChannel.CalibrationSyncNow, {
      profileId: PROFILE_ID,
    })) as { phase: string; error: string | null };
    expect(response.phase).toBe('failed');
    expect(response.error).toContain('calibration:update');
    expect(calls.some((call) => call.includes('calibration-sync'))).toBe(false);
  });
});

describe('discovery needs only the read permission', () => {
  it('reports calibration available to an account that can read but not write', async () => {
    // Requiring every calibration permission to *open* the workspace would
    // refuse an operator who is allowed to look at the farm.
    server({ permissions: ['calibration:read'] });
    registered = handlers();
    const availability = (await invoke(
      IpcChannel.CalibrationGetAvailability,
      undefined,
    )) as { available: boolean };
    expect(availability.available).toBe(true);
  });

  it('reports missingScopes, distinctly from an empty farm, without the read permission', async () => {
    server({ permissions: ['models:read'] });
    registered = handlers();
    const availability = (await invoke(
      IpcChannel.CalibrationGetAvailability,
      undefined,
    )) as {
      available: boolean;
      unavailableReason: string;
      unavailableDetail: string;
    };
    expect(availability.available).toBe(false);
    // A permission failure and "this farm has no printers" are different
    // problems with different remedies; the reason was declared but never once
    // emitted before, so an unauthorised account saw an empty list instead.
    expect(availability.unavailableReason).toBe('missingScopes');
    expect(availability.unavailableDetail).toContain('calibration:read');
  });
});
