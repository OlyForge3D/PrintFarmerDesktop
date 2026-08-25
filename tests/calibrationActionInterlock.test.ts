// @vitest-environment node

/**
 * Production-path coverage for the calibration action interlock.
 *
 * The saga-specific generation/bed-clear/start-print dispatch coverage this
 * file used to hold was removed under issue #758, alongside the
 * `CalibrationStartGeneration`, `CalibrationAcknowledgeBedClear`, and
 * `CalibrationStartPrint` channels themselves (issue #756's saga teardown).
 * What remains here is the still-live outbox-sync gate and the
 * read-permission-only discovery path, driven through the real HTTP client
 * and real wire schemas, with only `fetch` and the profile service replaced.
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
    context?: unknown;
    contextResponse?: () => Promise<Response>;
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
            }),
          ),
        );
      }
      if (
        href.includes('calibration-candidates') ||
        href.endsWith('/api/printers') ||
        href.includes('/api/printers?')
      ) {
        return Promise.resolve(json([calibrationCandidateDto()]));
      }
      if (href.includes('calibration-context')) {
        if (options.contextResponse) return options.contextResponse();
        return Promise.resolve(
          json(options.context ?? calibrationContextDto()),
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

beforeEach(() => {
  vi.unstubAllGlobals();
  // Capability negotiation is recorded in a process-wide store, so without this
  // a test asserting "nothing has been negotiated" would silently inherit the
  // negotiation of whichever test ran before it — and would pass against a gate
  // that never checked.
  calibrationDiagnostics.reset();
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
