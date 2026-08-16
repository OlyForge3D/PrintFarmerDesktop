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
import { createHash } from 'node:crypto';
import { IpcChannel } from '@shared/ipc';
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';
import {
  CALIBRATION_FIXTURE_IDS,
  calibrationActionBindingFixture,
  calibrationCandidateDto,
  calibrationContextDto,
} from './fixtures/calibrationContract.js';
import { validWorkspace } from './fixtures/calibrationWorkspacePayload.js';

// Individual cases in this file run 3.65-3.9s locally (78% of vitest's 5000ms
// default) because they drive real HTTP/schema/retry paths rather than
// mocking them out. The Windows CI runner measured ~28% slower than a dev
// laptop (issue #734, PR #733 run 31918975125), which tips these over the
// global budget on unmodified code. 15000ms gives ~4x local worst-case
// headroom -- enough to absorb runner variance without masking an actual
// hang (option 2 from #734: a targeted per-file override, not a blanket
// global increase).
vi.setConfig({ testTimeout: 15000 });

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
const BED_CLEAR_COMMAND_ID = '88888888-8888-4888-8888-888888888888';

const operationHash = (operationId: string): string =>
  createHash('sha256').update(operationId, 'utf8').digest('hex');

const CANONICAL_PERMISSIONS = [
  'calibration:read',
  'calibration:create',
  'calibration:update',
  'calibration:generate',
  // Generation submits a slicing job, enqueue is a queue write, and dispatch is
  // two queue operations. PrintFarmer enforces each on its own route, so a
  // fully-permitted principal holds all three families.
  'slicing:submit',
  'queue:write',
  'queue:read',
  'queue:acknowledge-bed-clear',
  'queue:start',
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
    delete: () => Promise.resolve(),
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
  listCalibrationWorkspaceStates: () =>
    Promise.resolve([
      {
        profileId: PROFILE_ID,
        projectId: validWorkspace().domainState.projectId,
        printerId:
          validWorkspace().domainState.binding.printer.backendPrinterId,
        displayName: validWorkspace().metadata.displayName,
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
        workspaceState: validWorkspace(),
      },
    ]),
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
  calibrationOrchestrationId: ORCHESTRATION_ID,
  pinnedPrinterConfigRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
  gcodeFileId: GCODE_FILE_ID,
  gcodeFileName: 'calibration.gcode',
  assignedPrinterId: CALIBRATION_FIXTURE_IDS.printerId,
  assignedPrinterName: 'Voron 2.4',
  status: 'Queued',
  bedClearState: 'None',
  bedClearCommandId: null,
  bedClearIdempotencyKeySha256: null,
  bedClearExpiresAtUtc: null,
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
    contextResponse?: () => Promise<Response>;
    orchestrationStatus?: number;
    job?: Record<string, unknown>;
    jobSequence?: readonly Record<string, unknown>[];
  } = {},
): { calls: string[] } {
  const calls: string[] = [];
  let jobRead = 0;
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
      if (href.includes('calibration-candidates')) {
        return Promise.resolve(json([calibrationCandidateDto()]));
      }
      if (href.includes('calibration-context')) {
        if (options.contextResponse) return options.contextResponse();
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
      if (
        options.orchestrationStatus !== undefined &&
        href.includes('calibration-orchestration')
      ) {
        return Promise.resolve(
          json(
            { status: options.orchestrationStatus },
            options.orchestrationStatus,
          ),
        );
      }
      if (href.includes('job-queue')) {
        const sequenceOverride =
          options.jobSequence?.[
            Math.min(jobRead, options.jobSequence.length - 1)
          ];
        jobRead += 1;
        return Promise.resolve(
          json({ ...QUEUE_JOB, ...options.job, ...sequenceOverride }),
        );
      }
      return Promise.resolve(json({}, 404));
    }),
  );
  return { calls };
}

function handlers(
  profiles = fakeProfiles(),
  calibrationSidecar = sidecar,
): Map<string, Handler> {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    profiles as never,
    calibrationSidecar as never,
    calibrationSidecar as never,
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
  projectId: PROJECT_ID,
  calibrationAttemptId: ATTEMPT_ID,
  calibrationOrchestrationId: ORCHESTRATION_ID,
  jobId: JOB_ID,
  operationId: OPERATION_ID,
  printerId: CALIBRATION_FIXTURE_IDS.printerId,
  rowVersion: 'AAAAAAAAAAAA==',
  jobRevision: 1,
  dispatchStateRowVersion: 'BBBBBBBBBBBB==',
  dispatchStateRevision: 1,
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

  it('does not authorize generation from a context cached under an older candidate observation', async () => {
    const { calls } = server();
    registered = handlers();
    await negotiate();
    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    await invoke(IpcChannel.CalibrationGetPrinterContext, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    });
    expect(
      calls.filter((call) => call.includes('calibration-context')),
    ).toHaveLength(1);

    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string };

    expect(response.status).toBe('submitted');
    expect(
      calls.filter((call) => call.includes('calibration-context')),
    ).toHaveLength(2);
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
    expect(
      calls.filter(
        (call) =>
          call.startsWith('GET') && call.includes(`/job-queue/${JOB_ID}`),
      ),
    ).toHaveLength(2);
  });

  it('allows an Acknowledged replay only for the exact operation hash', async () => {
    const { calls } = server({
      job: {
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearIdempotencyKeySha256: operationHash(OPERATION_ID),
        bedClearExpiresAtUtc: '2999-01-01T00:00:00.000Z',
      },
    });
    registered = handlers();
    await negotiate();

    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string };

    expect(response.status).toBe('ok');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(true);
  });

  it('replays an exact Acknowledged operation after authoritative revisions advanced', async () => {
    const { calls } = server({
      job: {
        rowVersion: 'CCCCCCCCCCCC==',
        revision: 2,
        dispatchStateRowVersion: 'DDDDDDDDDDDD==',
        dispatchStateRevision: 2,
        status: 'Printing',
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearIdempotencyKeySha256: operationHash(OPERATION_ID),
        bedClearExpiresAtUtc: '2999-01-01T00:00:00.000Z',
      },
    });
    registered = handlers();
    await negotiate();

    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string };

    expect(response.status).toBe('ok');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(true);
  });

  for (const [label, job] of [
    [
      'missing hash',
      {
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearExpiresAtUtc: '2999-01-01T00:00:00.000Z',
      },
    ],
    [
      'different hash',
      {
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearIdempotencyKeySha256: 'a'.repeat(64),
        bedClearExpiresAtUtc: '2999-01-01T00:00:00.000Z',
      },
    ],
    [
      'uppercase hash',
      {
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearIdempotencyKeySha256: operationHash(OPERATION_ID).toUpperCase(),
        bedClearExpiresAtUtc: '2999-01-01T00:00:00.000Z',
      },
    ],
    [
      'expired command',
      {
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearIdempotencyKeySha256: operationHash(OPERATION_ID),
        bedClearExpiresAtUtc: '2000-01-01T00:00:00.000Z',
      },
    ],
  ] as const) {
    it(`refuses an Acknowledged replay with a ${label}`, async () => {
      const { calls } = server({ job });
      registered = handlers();
      await negotiate();

      const response = (await invoke(
        IpcChannel.CalibrationAcknowledgeBedClear,
        bedClearRequest(),
      )) as { status: string };

      expect(response.status).toBe('error');
      expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
    });
  }

  it('hashes the exact case-sensitive UTF-8 operation ID', async () => {
    const mixedCaseOperationId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    const { calls } = server({
      job: {
        bedClearState: 'Acknowledged',
        bedClearCommandId: BED_CLEAR_COMMAND_ID,
        bedClearIdempotencyKeySha256: operationHash(
          mixedCaseOperationId.toUpperCase(),
        ),
        bedClearExpiresAtUtc: '2999-01-01T00:00:00.000Z',
      },
    });
    registered = handlers();
    await negotiate();

    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest({ operationId: mixedCaseOperationId }),
    )) as { status: string };

    expect(response.status).toBe('error');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
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
    expect(response.error.code).toBe('jobNotDispatchable');
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

  it('refuses before dispatch without the queue permissions the route enforces', async () => {
    // Corrected mapping: `acknowledge-bed-clear-and-start` is a queue
    // operation, not a calibration update. Full calibration rights do not
    // authorise it.
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
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string; error: { message: string } };
    expect(response.status).toBe('error');
    expect(response.error.message).toMatch(/queue:/);
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
  });

  it('does not even read the job without queue:read', async () => {
    // The read that establishes whether the job is awaiting acknowledgement is
    // itself an authorised operation. Performing it to decide whether the caller
    // is authorised has the order backwards, and a custom role can hold ack and
    // start without read.
    const { calls } = server({
      permissions: [
        'calibration:read',
        'queue:acknowledge-bed-clear',
        'queue:start',
      ],
    });
    registered = handlers();
    await negotiate();
    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string; error: { message: string } };
    expect(response.status).toBe('error');
    expect(response.error.message).toContain('queue:read');
    // Zero GET and zero POST.
    expect(calls.some((call) => call.includes('job-queue'))).toBe(false);
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

  for (const [label, job] of [
    ['project lineage', { calibrationProjectId: ATTEMPT_ID }],
    ['attempt lineage', { calibrationAttemptId: PROJECT_ID }],
    ['orchestration lineage', { calibrationOrchestrationId: PROJECT_ID }],
    ['job revision', { revision: 2 }],
    ['dispatch revision', { dispatchStateRevision: 2 }],
  ] as const) {
    it(`refuses before dispatch when ${label} differs`, async () => {
      const { calls } = server({ job });
      registered = handlers();
      await negotiate();

      const response = (await invoke(
        IpcChannel.CalibrationAcknowledgeBedClear,
        bedClearRequest(),
      )) as { status: string };

      expect(response.status).toBe('error');
      expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
    });
  }

  it('re-reads the exact job and refuses a change immediately before dispatch', async () => {
    const { calls } = server({
      jobSequence: [{}, { bedClearState: 'Consumed' }],
    });
    registered = handlers();
    await negotiate();

    const response = (await invoke(
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest(),
    )) as { status: string };

    expect(response.status).toBe('error');
    expect(dispatched(calls, 'acknowledge-bed-clear-and-start')).toBe(false);
    expect(
      calls.filter(
        (call) =>
          call.startsWith('GET') && call.includes(`/job-queue/${JOB_ID}`),
      ),
    ).toHaveLength(2);
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

  it('returns a typed sync-required refusal before enqueue', async () => {
    const pendingSidecar = {
      ...sidecar,
      countCalibrationPendingOps: () => Promise.resolve(1),
    };
    const { calls } = server();
    registered = handlers(fakeProfiles(), pendingSidecar);
    await negotiate();

    await expect(
      invoke(IpcChannel.CalibrationStartPrint, printRequest()),
    ).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'syncRequired',
        retryable: true,
        reference: null,
      },
    });
    expect(calls.some((call) => call.startsWith('POST'))).toBe(false);
  });

  it('returns a typed refusal when the action epoch changes immediately before enqueue', async () => {
    let authenticatedContextReads = 0;
    let deferPreDispatchContext = false;
    const immediate = fakeProfiles().getAuthenticatedContext;
    let releaseContext:
      ((value: Awaited<ReturnType<typeof immediate>>) => void) | undefined;
    let markContextStarted: (() => void) | undefined;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const deferredContext = new Promise<Awaited<ReturnType<typeof immediate>>>(
      (resolve) => {
        releaseContext = resolve;
      },
    );
    const profiles = fakeProfiles();
    profiles.getAuthenticatedContext = vi.fn(() => {
      authenticatedContextReads += 1;
      // The gate performs one direct profile read plus the HTTP client's
      // before/after identity fences. The fourth read is the handler's final
      // profile fence immediately before enqueue.
      if (!deferPreDispatchContext || authenticatedContextReads < 4) {
        return immediate();
      }
      markContextStarted?.();
      return deferredContext;
    });
    const { calls } = server();
    registered = handlers(profiles);
    await negotiate();
    authenticatedContextReads = 0;
    deferPreDispatchContext = true;

    const pendingPrint = invoke(
      IpcChannel.CalibrationStartPrint,
      printRequest(),
    );
    await expect(
      Promise.race([
        contextStarted.then(() => 'context-started'),
        pendingPrint.then(() => 'print-completed'),
      ]),
    ).resolves.toBe('context-started');
    await invoke(IpcChannel.DeleteServerProfile, { id: PROFILE_ID }).catch(
      () => undefined,
    );
    releaseContext?.(await immediate());

    await expect(pendingPrint).resolves.toMatchObject({
      status: 'error',
      error: {
        code: 'printerContextStale',
        reference: null,
      },
    });
    expect(authenticatedContextReads).toBe(4);
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

  const profileIdentityMutations = (
    ['machine', 'process', 'filament'] as const
  ).flatMap((kind) =>
    (
      [
        ['backend id', 'id', CALIBRATION_FIXTURE_IDS.otherPrinterId],
        ['Orca name', 'name', `Mutated ${kind} profile`],
        ['revision', 'profileRevision', `mutated-${kind}-revision`],
        ['content hash', 'sha256', 'e'.repeat(64)],
      ] as const
    ).map(([label, field, value]) => ({
      label: `${kind} ${label}`,
      kind,
      field,
      value,
    })),
  );

  it.each(profileIdentityMutations)(
    'refuses sync before dispatch when the exact $label changes',
    async ({ kind, field, value }) => {
      const context = structuredClone(calibrationContextDto()) as {
        snapshot: {
          profiles: Record<
            (typeof profileIdentityMutations)[number]['kind'],
            Record<(typeof profileIdentityMutations)[number]['field'], string>
          >;
        };
      };
      context.snapshot.profiles[kind][field] = value;
      const { calls } = server({ context });
      registered = handlers();
      await negotiate();

      const response = (await invoke(IpcChannel.CalibrationSyncNow, {
        profileId: PROFILE_ID,
      })) as { phase: string; error: string | null };

      expect(response.phase).toBe('failed');
      expect(response.error).toContain('profile binding changed');
      expect(
        calls.filter((call) => call.includes('calibration-context')),
      ).toHaveLength(1);
      expect(calls.some((call) => call.includes('calibration-sync'))).toBe(
        false,
      );
    },
  );

  it('does not dispatch sync when its action epoch changes during context preflight', async () => {
    let releaseContext: ((response: Response) => void) | undefined;
    let markContextStarted: (() => void) | undefined;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const deferredContext = new Promise<Response>((resolve) => {
      releaseContext = resolve;
    });
    const { calls } = server({
      orchestrationStatus: 403,
      contextResponse: () => {
        markContextStarted?.();
        return deferredContext;
      },
    });
    registered = handlers();
    await negotiate();

    const pendingSync = invoke(IpcChannel.CalibrationSyncNow, {
      profileId: PROFILE_ID,
    });
    await contextStarted;
    await expect(
      invoke(IpcChannel.CalibrationGetOrchestrationStatus, {
        profileId: PROFILE_ID,
        orchestrationId: ORCHESTRATION_ID,
      }),
    ).resolves.toMatchObject({
      status: 'error',
      error: { code: 'serverError' },
    });
    releaseContext?.(json(calibrationContextDto()));

    const response = (await pendingSync) as {
      phase: string;
      error: string | null;
    };
    expect(response.phase).toBe('failed');
    expect(response.error).toContain('authorization state changed');
    expect(calls.some((call) => call.includes('calibration-sync'))).toBe(false);
  });
});

describe('a refusal invalidates the cached permissions without replaying anything', () => {
  it('re-reads capabilities once after a 403 and never retries the mutation', async () => {
    // Permissions are not immutable: an administrator can revoke a calibration
    // role while the app is running. Caching a positive snapshot and never
    // revisiting it leaves the workspace offering actions the server will keep
    // refusing, insisting they should work.
    let generationCalls = 0;
    let capabilityCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          capabilityCalls += 1;
          return Promise.resolve(
            json(
              printFarmerCapabilitiesResponse({
                effectivePermissions: CANONICAL_PERMISSIONS,
              }),
            ),
          );
        }
        if (href.includes('calibration-context')) {
          return Promise.resolve(json(calibrationContextDto()));
        }
        if (href.includes('generate-job')) {
          generationCalls += 1;
          // The gate passed against the cached snapshot; the server disagrees.
          return Promise.resolve(
            json({ status: 403, title: 'Forbidden' }, 403),
          );
        }
        return Promise.resolve(json({}, 404));
      }),
    );
    registered = handlers();

    // A prior *positive* negotiation is the precondition. Without it the gate
    // would refuse locally and the server would never be reached, so the
    // stale-permission path this test is about would not be exercised.
    await negotiate();
    expect(capabilityCalls).toBe(1);

    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string; error: { message: string } };

    expect(response.status).toBe('error');
    // Exactly one re-read: the refusal invalidated the snapshot.
    expect(capabilityCalls).toBe(2);
    // And exactly one generation attempt. Re-reading capabilities is a read and
    // safe to do on the operator's behalf; replaying a generation is not, and an
    // app that retried because a permission check changed its mind would be
    // acting without being asked.
    expect(generationCalls).toBe(1);
    // The operator is told why retrying might behave differently.
    expect(response.error.message).toMatch(/access may have changed/i);
  });

  it('absorbs a burst of refusals into a single capability re-read', async () => {
    // Without a cooldown a server refusing everything would be met with one
    // capability fetch per refusal, turning a permission problem into a request
    // storm.
    let capabilityCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          capabilityCalls += 1;
          return Promise.resolve(
            json(
              printFarmerCapabilitiesResponse({
                effectivePermissions: CANONICAL_PERMISSIONS,
              }),
            ),
          );
        }
        if (href.includes('calibration-context')) {
          return Promise.resolve(json(calibrationContextDto()));
        }
        if (href.includes('generate-job')) {
          return Promise.resolve(
            json({ status: 403, title: 'Forbidden' }, 403),
          );
        }
        return Promise.resolve(json({}, 404));
      }),
    );
    registered = handlers();
    await negotiate();

    for (let attempt = 0; attempt < 3; attempt++) {
      await invoke(IpcChannel.CalibrationStartGeneration, generationRequest());
    }
    // One initial negotiation plus one refresh, not one per refusal.
    expect(capabilityCalls).toBe(2);
  });
});

describe('capability evidence never crosses server profiles', () => {
  // The defect this covers: the capability snapshot was process-global and
  // carried no owner, so it could be read as evidence for whichever profile
  // happened to be selected. Negotiate a permissive profile A, switch to B, and
  // every gate read A's permissions and flags — authorising save, sync,
  // generate, print start and bed-clear dispatch against a farm that had never
  // said yes to any of them.

  /**
   * A profile service whose selected profile the test controls, so a switch can
   * be performed against the real registered handlers rather than simulated.
   */
  function switchableProfiles(selected: { id: string }) {
    return {
      list: () =>
        Promise.resolve({ profiles: [], selectedProfileId: selected.id }),
      getAuthenticatedContext: () =>
        Promise.resolve({
          profile: { id: selected.id, baseUrl: BASE_URL },
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
      // The `SelectServerProfile` response is a full `ServerProfile`, which this
      // stub does not attempt to synthesise: the property under test is that
      // calibration evidence is discarded, and the handler discards it *before*
      // calling through here. `switchProfile` below tolerates the response
      // parse failing for exactly that reason, and the refusals that follow are
      // what prove the discard actually happened.
      select: (id: string) => {
        selected.id = id;
        return Promise.resolve({ selectedProfileId: id });
      },
      delete: (id: string) => {
        void id;
        selected.id = '';
        return Promise.resolve({ profiles: [], selectedProfileId: null });
      },
    };
  }

  const PROFILE_B = '22222222-2222-4222-8222-222222222222';

  function registerWith(selected: { id: string }): Map<string, Handler> {
    electronState.handlers.clear();
    registerIpcHandlers(
      undefined,
      switchableProfiles(selected) as never,
      sidecar as never,
      sidecar as never,
      {
        initialize: () => Promise.resolve(),
        dispose: () => undefined,
      } as never,
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

  /**
   * Select a different profile through the real handler.
   *
   * The response parse is allowed to fail: the stub does not synthesise a whole
   * `ServerProfile`, and it does not need to. Calibration state is discarded
   * before `profiles.select` is called, so a failure on the way back cannot
   * restore it — which is itself the ordering this suite depends on.
   */
  async function switchProfile(
    registeredHandlers: Map<string, Handler>,
    id: string,
  ): Promise<void> {
    try {
      await Promise.resolve(
        registeredHandlers.get(IpcChannel.SelectServerProfile)?.(undefined, {
          id,
        }),
      );
    } catch {
      // See above: the discard has already happened.
    }
  }

  /** Every mutating and machine-moving entry point, with a valid payload. */
  const mutations: ReadonlyArray<[string, string, Record<string, unknown>]> = [
    [
      'generation',
      IpcChannel.CalibrationStartGeneration,
      generationRequest({ profileId: PROFILE_B }),
    ],
    [
      'print start',
      IpcChannel.CalibrationStartPrint,
      {
        profileId: PROFILE_B,
        projectId: PROJECT_ID,
        attemptId: ATTEMPT_ID,
        orchestrationId: ORCHESTRATION_ID,
        gcodeFileId: GCODE_FILE_ID,
        assignedPrinterId: CALIBRATION_FIXTURE_IDS.printerId,
        operationId: OPERATION_ID,
        pinnedPrinterConfigRevision:
          CALIBRATION_FIXTURE_IDS.configurationRevision,
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
      },
    ],
    [
      'bed-clear dispatch',
      IpcChannel.CalibrationAcknowledgeBedClear,
      bedClearRequest({ profileId: PROFILE_B }),
    ],
  ];

  for (const [label, channel, request] of mutations) {
    it(`refuses ${label} for a newly selected profile that has not negotiated`, async () => {
      const selected: { id: string } = { id: PROFILE_ID };
      const { calls } = server();
      const registeredHandlers = registerWith(selected);

      // Profile A negotiates permissively. This is the precondition that made
      // the defect exploitable: without a positive snapshot there is nothing to
      // inherit.
      await Promise.resolve(
        registeredHandlers.get(IpcChannel.CalibrationGetAvailability)?.(
          undefined,
          undefined,
        ),
      );

      // Switch to B through the real handler, then make B's own negotiation
      // impossible — in flight, failing, or refused all look the same to a gate.
      await switchProfile(registeredHandlers, PROFILE_B);
      const before = calls.length;

      const response = (await Promise.resolve(
        registeredHandlers.get(channel)?.(undefined, request),
      )) as { status: string; error?: { code: string } };

      expect(response.status).toBe('error');
      expect(response.error?.code).toBe('forbidden');
      // Refused before dispatch: nothing was sent for profile B at all.
      expect(calls.slice(before).some((call) => call.startsWith('POST'))).toBe(
        false,
      );
    });
  }

  it('refuses when the selected profile changes without a select handler call', async () => {
    // Isolates the ownership check from the discard. A profile can become
    // current by a route other than `SelectServerProfile` — a binding change, a
    // restored session, a race between the switch and an in-flight request — and
    // in that case nothing has cleared the snapshot. Binding it to the profile
    // it describes is what refuses here; deleting that check alone makes this
    // test fail while every other cross-profile test still passes, because they
    // are also protected by the discard.
    const selected: { id: string } = { id: PROFILE_ID };
    const { calls } = server();
    const handlersB = registerWith(selected);
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );

    // The selection moves underneath, with A's positive snapshot still held.
    selected.id = PROFILE_B;
    const before = calls.length;

    const response = (await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationStartGeneration)?.(
        undefined,
        generationRequest({ profileId: PROFILE_B }),
      ),
    )) as { status: string; error: { code: string } };

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
    expect(calls.slice(before).some((call) => call.startsWith('POST'))).toBe(
      false,
    );
  });

  it('does not restore the original profile\u2019s evidence when it is selected again', async () => {
    // Isolates the discard from the ownership check. Ownership alone would let
    // A's snapshot spring back into force the moment A is current again, even
    // though its permissions may have been revoked while B was selected — and
    // the app would authorise a mutation on evidence it had every reason to
    // consider suspect. Selecting away from a profile discards its answer, so
    // returning to it requires asking again.
    const selected: { id: string } = { id: PROFILE_ID };
    const { calls } = server();
    const handlersB = registerWith(selected);
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );
    await switchProfile(handlersB, PROFILE_B);
    // Straight back to A, without re-negotiating.
    await switchProfile(handlersB, PROFILE_ID);
    const before = calls.length;

    const response = (await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationStartGeneration)?.(
        undefined,
        generationRequest(),
      ),
    )) as { status: string; error: { code: string } };

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
    expect(calls.slice(before).some((call) => call.startsWith('POST'))).toBe(
      false,
    );

    // Control: re-negotiating restores the ability, so the refusal above is the
    // discard and not a profile switch breaking calibration permanently.
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );
    const after = (await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationStartGeneration)?.(
        undefined,
        generationRequest(),
      ),
    )) as { status: string };
    expect(after.status).toBe('submitted');
  });

  it('discards the previous answer when a re-negotiation for the same profile fails', async () => {
    // Isolates clearing-before-fetch from the profile switch. Permissions can be
    // revoked without the selected profile changing at all: the workspace
    // re-negotiates, the request fails or times out, and the old positive
    // snapshot is still sitting there. Clearing after a successful fetch would
    // leave exactly that window open; clearing before it closes it.
    let capabilitiesShouldFail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          return Promise.resolve(
            capabilitiesShouldFail
              ? json({ status: 503 }, 503)
              : json(
                  printFarmerCapabilitiesResponse({
                    effectivePermissions: CANONICAL_PERMISSIONS,
                  }),
                ),
          );
        }
        if (href.includes('calibration-context')) {
          return Promise.resolve(json(calibrationContextDto()));
        }
        return Promise.resolve(json({}, 404));
      }),
    );
    registered = handlers();
    await negotiate();

    // Same profile throughout. Only the negotiation outcome changes.
    capabilitiesShouldFail = true;
    await negotiate();

    const response = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string; error: { code: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
  });

  it('refuses when profile B\u2019s own negotiation fails', async () => {
    const selected: { id: string } = { id: PROFILE_ID };
    let capabilitiesShouldFail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          return Promise.resolve(
            capabilitiesShouldFail
              ? json({ status: 503 }, 503)
              : json(
                  printFarmerCapabilitiesResponse({
                    effectivePermissions: CANONICAL_PERMISSIONS,
                  }),
                ),
          );
        }
        if (href.includes('calibration-context')) {
          return Promise.resolve(json(calibrationContextDto()));
        }
        return Promise.resolve(json({}, 404));
      }),
    );
    const handlersB = registerWith(selected);
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );
    await switchProfile(handlersB, PROFILE_B);
    // B tries and fails. A failed negotiation must leave *no* evidence, not the
    // previous profile's positive one.
    capabilitiesShouldFail = true;
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );

    const response = (await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationStartGeneration)?.(
        undefined,
        generationRequest({ profileId: PROFILE_B }),
      ),
    )) as { status: string; error: { code: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
  });

  it('permits the action only once profile B has negotiated for itself', async () => {
    // The positive control. Without it, every refusal above is satisfied by a
    // switch that simply breaks calibration permanently.
    const selected: { id: string } = { id: PROFILE_ID };
    server();
    const handlersB = registerWith(selected);
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );
    await switchProfile(handlersB, PROFILE_B);
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );

    const response = (await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationStartGeneration)?.(
        undefined,
        generationRequest({ profileId: PROFILE_B }),
      ),
    )) as { status: string };
    expect(response.status).toBe('submitted');
  });

  it('forgets a profile\u2019s evidence when it is deleted', async () => {
    const selected: { id: string } = { id: PROFILE_ID };
    const { calls } = server();
    const handlersB = registerWith(selected);
    await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationGetAvailability)?.(
        undefined,
        undefined,
      ),
    );
    await Promise.resolve(
      handlersB.get(IpcChannel.DeleteServerProfile)?.(undefined, {
        id: PROFILE_ID,
      }),
    );
    selected.id = PROFILE_B;
    const before = calls.length;

    const response = (await Promise.resolve(
      handlersB.get(IpcChannel.CalibrationStartGeneration)?.(
        undefined,
        generationRequest({ profileId: PROFILE_B }),
      ),
    )) as { status: string; error: { code: string } };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('forbidden');
    expect(calls.slice(before).some((call) => call.startsWith('POST'))).toBe(
      false,
    );
  });

  it('leaves no evidence when the post-refusal refresh itself fails', async () => {
    // The stale-positive window in its most direct form: a 403 says the cached
    // answer is wrong, so a refresh that cannot replace it must not leave the
    // contradicted answer in place.
    let capabilityCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          capabilityCalls += 1;
          return Promise.resolve(
            capabilityCalls === 1
              ? json(
                  printFarmerCapabilitiesResponse({
                    effectivePermissions: CANONICAL_PERMISSIONS,
                  }),
                )
              : json({ status: 503 }, 503),
          );
        }
        if (href.includes('calibration-context')) {
          return Promise.resolve(json(calibrationContextDto()));
        }
        if (href.includes('generate-job')) {
          return Promise.resolve(json({ status: 403 }, 403));
        }
        return Promise.resolve(json({}, 404));
      }),
    );
    registered = handlers();
    await negotiate();

    // First attempt reaches the server and is refused; the refresh then fails.
    const first = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string };
    expect(first.status).toBe('error');

    // Second attempt is refused *locally*, because no evidence survives.
    const second = (await invoke(
      IpcChannel.CalibrationStartGeneration,
      generationRequest(),
    )) as { status: string; error: { code: string; message: string } };
    expect(second.status).toBe('error');
    expect(second.error.code).toBe('forbidden');
    expect(second.error.message).toMatch(/not authorised|does not grant/i);
  });
});

describe('every converted refusal still invalidates', () => {
  // These handlers catch `CalibrationHttpError` and return an error *response*
  // rather than throwing, so the central channel wrapper never sees them. Each
  // was therefore its own hole: a 403 left the positive capability snapshot in
  // place and the workspace kept offering the action.
  //
  // Table-driven on purpose. A new channel that converts its errors and forgets
  // the invalidation should be visible as a missing row here.
  const converted: ReadonlyArray<{
    label: string;
    channel: string;
    request: Record<string, unknown>;
    match: string;
  }> = [
    {
      label: 'orchestration status',
      channel: IpcChannel.CalibrationGetOrchestrationStatus,
      request: { profileId: PROFILE_ID, orchestrationId: ORCHESTRATION_ID },
      match: 'calibration-orchestrations',
    },
    {
      label: 'queue state',
      channel: IpcChannel.CalibrationGetQueueState,
      request: {
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        jobId: JOB_ID,
      },
      match: 'job-queue',
    },
    {
      label: 'queue change feed',
      channel: IpcChannel.CalibrationPollQueueChanges,
      request: { profileId: PROFILE_ID, afterSequence: 0 },
      match: 'job-queue/changes',
    },
    {
      label: 'subscription resources',
      channel: IpcChannel.CalibrationGetSubscriptionResources,
      request: { profileId: PROFILE_ID },
      match: 'subscription-resources',
    },
  ];

  for (const { label, channel, request } of converted) {
    it(`discards the capability snapshot when ${label} is refused`, async () => {
      let capabilityCalls = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn((url: URL | string) => {
          const href = typeof url === 'string' ? url : url.href;
          if (href.includes('/api/calibration/capabilities')) {
            capabilityCalls += 1;
            return Promise.resolve(
              capabilityCalls === 1
                ? json(
                    printFarmerCapabilitiesResponse({
                      effectivePermissions: CANONICAL_PERMISSIONS,
                    }),
                  )
                : // The refresh finds the access genuinely gone.
                  json({ status: 403 }, 403),
            );
          }
          if (href.includes('calibration-context')) {
            return Promise.resolve(json(calibrationContextDto()));
          }
          return Promise.resolve(json({ status: 403 }, 403));
        }),
      );
      registered = handlers();
      await negotiate();

      // The refused read returns a response rather than throwing.
      await invoke(channel, request);

      // And the next mutation is refused locally, because the snapshot the
      // refusal contradicted is gone.
      const after = (await invoke(
        IpcChannel.CalibrationStartGeneration,
        generationRequest(),
      )) as { status: string; error: { code: string } };
      expect(after.status).toBe('error');
      expect(after.error.code).toBe('forbidden');
    });
  }
});

describe('the queue can be observed while local drafts are unsynced', () => {
  it('reads authoritative job state despite a pending outbox', async () => {
    // Reading what the server says about a job damages nothing, and refusing it
    // because the operator has unsaved work hid a job that was already queued or
    // printing behind a message about their own drafts. Reconciliation matters
    // most exactly when local state is behind.
    const pendingSidecar = {
      ...sidecar,
      countCalibrationPendingOps: () => Promise.resolve(3),
      listCalibrationConflicts: () => Promise.resolve([{ id: 'conflict-1' }]),
    };
    const { calls } = server();
    electronState.handlers.clear();
    registerIpcHandlers(
      undefined,
      fakeProfiles() as never,
      pendingSidecar as never,
      pendingSidecar as never,
      {
        initialize: () => Promise.resolve(),
        dispose: () => undefined,
      } as never,
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
    registered = electronState.handlers;
    await negotiate();

    const response = (await invoke(IpcChannel.CalibrationGetQueueState, {
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      jobId: JOB_ID,
    })) as { status: string };

    expect(response.status).toBe('ok');
    // The GET actually happened, rather than being short-circuited.
    expect(calls.some((call) => call.includes('job-queue'))).toBe(true);
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

describe('a legacy backup import is gated before it touches anything', () => {
  const importRequest = (): Record<string, unknown> => ({
    profileId: PROFILE_ID,
    approvalId: '88888888-8888-4888-8888-888888888888',
    operationId: OPERATION_ID,
    printerMappings: [],
  });

  it('refuses without calibration:create, consuming no approval and sending nothing', async () => {
    // `POST /api/calibration-imports/legacy-v4` enforces calibration:create.
    // Discovering that only after the single-use approval has been consumed and
    // the backup read off disk destroys the operator's approval on the way to a
    // refusal the server was always going to give.
    const { calls } = server({
      permissions: ['calibration:read', 'calibration:update'],
    });
    registered = handlers();
    await negotiate();

    const response = (await invoke(
      IpcChannel.CalibrationImportLegacyBackupV4,
      importRequest(),
    )) as { status: string; error: { code: string; message: string } };

    expect(response.status).toBe('error');
    expect(response.error.message).toContain('calibration:create');
    // Not the approval store''s own error: the permission check ran first, so
    // the approval was never consumed.
    expect(response.error.message).not.toContain('expired');
    expect(calls.some((call) => call.includes('legacy-v4'))).toBe(false);
  });

  it('reaches the approval only once the permission holds', async () => {
    server();
    registered = handlers();
    await negotiate();

    const handler = registered.get(IpcChannel.CalibrationImportLegacyBackupV4);
    const response = (await handler?.(
      { sender: { id: 42 } },
      importRequest(),
    )) as { status: string; error: { message: string } };

    // The same unknown approval now fails at the approval stage, which is what
    // proves the ordering above rather than a blanket refusal.
    expect(response.status).toBe('error');
    expect(response.error.message).toMatch(/expired|missing/i);
  });

  it('refuses once the selected profile has been discarded', async () => {
    server();
    registered = handlers();
    await negotiate();
    // Deleting the profile discards every piece of evidence the permission
    // check rested on and advances the action epoch. The stub profile service
    // has nothing to return, which does not matter: the discard happens first.
    await invoke(IpcChannel.DeleteServerProfile, { id: PROFILE_ID }).catch(
      () => undefined,
    );

    const handler = registered.get(IpcChannel.CalibrationImportLegacyBackupV4);
    const response = (await Promise.resolve(
      handler?.({ sender: { id: 42 } }, importRequest()),
    ).catch(() => ({ status: 'error', error: { message: 'rejected' } }))) as {
      status: string;
      error: { message: string };
    };

    expect(response.status).toBe('error');
    // Never the approval error: the import stopped before consuming it.
    expect(response.error.message).not.toMatch(/expired|missing or expired/i);
  });
});
