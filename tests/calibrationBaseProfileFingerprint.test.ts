// @vitest-environment node

/**
 * The generated profile must come from the base the project was bound to.
 *
 * A calibration profile's value is that it is a named base plus a recorded set
 * of measured changes. `findLocalOrcaProfileRaw` matches on *name*, and
 * OrcaSlicer rewrites profiles in place, so the file standing under that name
 * when generation runs is not necessarily the file the operator selected.
 *
 * Generation used to patch whatever it found. The output then carried a
 * provenance record naming a base that was never used — silently, and for
 * exactly the artefact whose whole point is a pinned base.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import {
  NOW,
  PROFILE_ID,
  PROJECT_ID,
  workspaceWithCompletedAttempt,
} from './fixtures/calibrationWorkspacePayload.js';

type Handler = (event: unknown, request: unknown) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

/** What the local scan reports for the profile named by the workspace. */
const localState = vi.hoisted(() => ({
  contentHash: 'b'.repeat(64),
  found: true,
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

// Only the filesystem scan is replaced. The handler under test, the workspace
// schemas and the profile generator are all the production ones.
vi.mock('../src/main/orcaProfileDiscovery.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/main/orcaProfileDiscovery.js')
  >('../src/main/orcaProfileDiscovery.js');
  return {
    ...actual,
    findLocalOrcaProfileRaw: () =>
      Promise.resolve(
        localState.found
          ? {
              resolvedRaw: {
                name: 'Upstream PLA',
                from: 'system',
                nozzle_temperature: ['210'],
              },
              contentHash: localState.contentHash,
              filePath: '/test/orca/Upstream PLA.json',
            }
          : null,
      ),
  };
});

const { registerIpcHandlers } = await import('../src/main/ipc.js');

const OPERATION_ID = '99999999-9999-4999-8999-999999999999';
const RECORDED_HASH = 'a'.repeat(64);

function workspaceState(baseHash: string | null): unknown {
  const workspace = workspaceWithCompletedAttempt();
  // The fixture's completed attempt carries an empty recommendation. Generation
  // needs at least one mapped value, or it refuses before it ever looks at the
  // base profile.
  const attempt = workspace.domainState.attempts[0]!;
  attempt.recommendation = {
    summary: 'Use 210 C',
    rationale: 'Best surface quality',
    values: [
      {
        key: 'nozzle_temperature',
        value: 210,
        unit: 'celsius',
      },
    ],
  };
  return {
    profileId: PROFILE_ID,
    projectId: PROJECT_ID,
    displayName: workspace.metadata.displayName,
    description: null,
    printerId: workspace.domainState.binding.printer.backendPrinterId,
    status: 'awaitingGeneration',
    completedStepCount: 1,
    totalStepCount: 9,
    isSynced: true,
    isPrinterContextFresh: true,
    hasConflicts: false,
    remoteProjectId: null,
    baseRevision: null,
    createdAt: NOW,
    updatedAt: NOW,
    workspaceState: {
      ...workspace,
      selectedBaseProfile: {
        ...workspace.selectedBaseProfile,
        orcaProfileName: 'Upstream PLA',
        contentHash: baseHash,
      },
    },
  };
}

let recordedBaseHash: string | null = RECORDED_HASH;

const sidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
  getCalibrationWorkspaceState: () =>
    Promise.resolve(workspaceState(recordedBaseHash)),
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

let selectedProfileId: string = PROFILE_ID;

const profileService = {
  list: () => Promise.resolve({ profiles: [], selectedProfileId }),
  getAuthenticatedContext: () =>
    Promise.resolve({
      profile: { id: PROFILE_ID, baseUrl: 'http://farm.local' },
      token: 'test-jwt',
      serverBinding: 'binding-abc',
    }),
  getAuthenticatedServerContext: () =>
    Promise.resolve({
      baseUrl: 'http://farm.local',
      token: 'test-jwt',
      binding: 'binding-abc',
    }),
  onBindingChanged: () => () => undefined,
};

function handlers(): Map<string, Handler> {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    profileService as never,
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

const generateRequest = () => ({
  profileId: PROFILE_ID,
  projectId: PROJECT_ID,
  operationId: OPERATION_ID,
});

beforeEach(() => {
  selectedProfileId = PROFILE_ID;
  recordedBaseHash = RECORDED_HASH;
  localState.contentHash = RECORDED_HASH;
  localState.found = true;
  registered = handlers();
});

describe('generation verifies the base profile it is about to patch', () => {
  it('generates when the local file is byte-for-byte the recorded base', async () => {
    const response = (await invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    )) as { status: string };

    expect(response.status).toBe('ok');
  });

  it('refuses when the same name now holds different bytes', async () => {
    // Same profile name, changed content: OrcaSlicer edited it, or the operator
    // replaced it, after this project was bound.
    localState.contentHash = 'c'.repeat(64);

    const response = (await invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    )) as { status: string; error: { code: string; message: string } };

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('baseProfileChanged');

    // And nothing was cached under the operation id, so a later export or
    // install cannot pick up a profile this refusal says was never generated.
    const exported = (await invoke(IpcChannel.CalibrationInstallOrcaProfile, {
      operationId: OPERATION_ID,
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
    }).catch(() => ({ status: 'error' }))) as { status: string };
    expect(exported.status).toBe('error');
  });

  it('refuses when the project recorded no fingerprint at all', async () => {
    // Nothing to verify against. Generating anyway would make the pinned-base
    // guarantee unenforceable rather than merely unproven.
    recordedBaseHash = null;

    const response = (await invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    )) as { status: string; error: { code: string } };

    expect(response.status).toBe('error');
    expect(response.error.code).toBe('baseProfileUnverifiable');
  });

  it('still reports a genuinely absent base profile as missing', async () => {
    localState.found = false;

    const response = (await invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    )) as { status: string; error: { code: string } };

    expect(response.status).toBe('error');
    // Distinct from "changed": one is repaired by reinstalling OrcaSlicer or
    // the profile, the other by re-selecting a base.
    expect(response.error.code).toBe('baseProfileMissing');
  });
});

describe('generated bytes stay bound to what produced them', () => {
  // Windows-only: install writes to this machine's OrcaSlicer directory, and
  // the handler refuses on other platforms before any binding is consulted.
  const onWindows = process.platform === 'win32' ? it : it.skip;

  async function generate(): Promise<string> {
    const response = (await invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    )) as { status: string; profileJsonHash: string };
    expect(response.status).toBe('ok');
    return response.profileJsonHash;
  }

  onWindows(
    'refuses to install bytes generated for a different server profile',
    async () => {
      const profileJsonHash = await generate();

      // The operator switches farms between generating and installing. The
      // bytes describe a printer on the farm they left.
      selectedProfileId = '77777777-7777-4777-8777-777777777777';

      const response = (await Promise.resolve(
        registered.get(IpcChannel.CalibrationInstallOrcaProfile)?.(undefined, {
          profileId: selectedProfileId,
          operationId: OPERATION_ID,
          confirmedProfileJsonHash: profileJsonHash,
        }),
      ).catch(() => ({ status: 'error', error: { code: 'rejected' } }))) as {
        status: string;
        error: { code: string };
      };

      expect(response.status).toBe('error');
    },
  );

  onWindows(
    'refuses to install after the base profile changed underneath',
    async () => {
      const profileJsonHash = await generate();

      // OrcaSlicer rewrites the base while the operator reads the preview. The
      // generated bytes are still valid *as bytes*; they are no longer bytes
      // derived from the file now on disk.
      localState.contentHash = 'd'.repeat(64);

      const response = (await invoke(IpcChannel.CalibrationInstallOrcaProfile, {
        profileId: PROFILE_ID,
        operationId: OPERATION_ID,
        confirmedProfileJsonHash: profileJsonHash,
      })) as { status: string; error: { code: string } };

      expect(response.status).toBe('error');
      expect(response.error.code).toBe('baseProfileChanged');
    },
  );

  onWindows(
    'refuses to install once the calibration session has been invalidated',
    async () => {
      const profileJsonHash = await generate();

      // Any invalidation — a refusal, an expired session, a profile switch —
      // advances the epoch and strands bytes generated before it.
      await Promise.resolve(
        registered.get(IpcChannel.DeleteServerProfile)?.(undefined, {
          id: PROFILE_ID,
        }),
      ).catch(() => undefined);

      const response = (await Promise.resolve(
        registered.get(IpcChannel.CalibrationInstallOrcaProfile)?.(undefined, {
          profileId: PROFILE_ID,
          operationId: OPERATION_ID,
          confirmedProfileJsonHash: profileJsonHash,
        }),
      ).catch(() => ({ status: 'error', error: { code: 'rejected' } }))) as {
        status: string;
        error: { code: string };
      };

      expect(response.status).toBe('error');
    },
  );
});
