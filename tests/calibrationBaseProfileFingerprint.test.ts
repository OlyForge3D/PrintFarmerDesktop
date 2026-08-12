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
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';
import {
  NOW,
  PROFILE_ID,
  PROJECT_ID,
  SNAPSHOT_SHA,
  workspaceWithCompletedAttempt,
} from './fixtures/calibrationWorkspacePayload.js';

type Handler = (event: unknown, request: unknown) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

/** Counts calls to the one function that actually writes to OrcaSlicer. */
const installState = vi.hoisted(() => ({
  writes: 0,
  beforeWrite: null as (() => Promise<void>) | null,
}));

/** What the local scan reports for the profile named by the workspace. */
const localState = vi.hoisted(() => ({
  contentHash: 'b'.repeat(64),
  found: true,
  lookups: [] as string[],
  gateAtLookup: null as number | null,
  lookupGate: null as Promise<void> | null,
  lookupStarted: null as (() => void) | null,
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
    findLocalOrcaProfileRaw: async (name: string) => {
      localState.lookups.push(name);
      if (localState.lookups.length === localState.gateAtLookup) {
        localState.lookupStarted?.();
        if (localState.lookupGate !== null) await localState.lookupGate;
      }
      return localState.found && name === 'Upstream PLA'
        ? {
            resolvedRaw: {
              name: 'Upstream PLA',
              from: 'system',
              nozzle_temperature: ['210'],
            },
            contentHash: localState.contentHash,
            filePath: '/test/orca/Upstream PLA.json',
          }
        : null;
    },
  };
});

vi.mock('../src/main/orcaProfileInstall.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/main/orcaProfileInstall.js')
  >('../src/main/orcaProfileInstall.js');
  return {
    ...actual,
    installOrcaProfileWindows: async (
      _json: string,
      hash: string,
      _safeFilename: string,
      _operationId: string,
      revalidateBeforeWrite?: () => Promise<void>,
    ): Promise<{ installedHash: string; backupHash: string }> => {
      await installState.beforeWrite?.();
      await revalidateBeforeWrite?.();
      installState.writes += 1;
      return {
        installedHash: hash,
        backupHash: 'e'.repeat(64),
      };
    },
  };
});

const { registerIpcHandlers } = await import('../src/main/ipc.js');
const { clearProfileCache, getCachedProfile } =
  await import('../src/main/orcaProfileInstall.js');

const OPERATION_ID = '99999999-9999-4999-8999-999999999999';
const RECORDED_HASH = 'a'.repeat(64);

function workspaceState(baseHash: string | null): unknown {
  const workspace = workspaceWithCompletedAttempt();
  // The fixture's completed attempt carries an empty recommendation. Generation
  // needs at least one mapped value, or it refuses before it ever looks at the
  // base profile.
  const attempt = workspace.domainState.attempts[0]!;
  workspace.domainState.binding.snapshot.snapshotId = workspaceSnapshotId;
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
let workspaceSnapshotId = SNAPSHOT_SHA;
let workspaceReadGate: Promise<void> | null = null;
let noteWorkspaceRead: (() => void) | null = null;
let profileSaveGate: Promise<void> | null = null;
let noteProfileSave: (() => void) | null = null;

const sidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
  getCalibrationWorkspaceState: async () => {
    noteWorkspaceRead?.();
    if (workspaceReadGate) await workspaceReadGate;
    return workspaceState(recordedBaseHash);
  },
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
  save: async () => {
    noteProfileSave?.();
    if (profileSaveGate !== null) await profileSaveGate;
    return {
      id: PROFILE_ID,
      displayName: 'Updated farm',
      baseUrl: 'http://farm.changed',
      authMode: 'apiKey',
      version: null,
      capabilities: null,
      availability: {
        modelUpload: {
          available: false,
          mode: 'unavailable',
          reason: null,
        },
        librarySync: { available: false, reason: null },
        clientThumbnailUpload: { available: false, reason: null },
        serverThumbnailFallback: { available: false, reason: null },
      },
      status: 'connected',
      lastCheckedAt: NOW,
      warnings: ['insecureHttp'],
    };
  },
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
  clearProfileCache();
  installState.writes = 0;
  installState.beforeWrite = null;
  vi.unstubAllGlobals();
  selectedProfileId = PROFILE_ID;
  recordedBaseHash = RECORDED_HASH;
  localState.contentHash = RECORDED_HASH;
  localState.found = true;
  localState.lookups = [];
  localState.gateAtLookup = null;
  localState.lookupGate = null;
  localState.lookupStarted = null;
  workspaceSnapshotId = SNAPSHOT_SHA;
  workspaceReadGate = null;
  noteWorkspaceRead = null;
  profileSaveGate = null;
  noteProfileSave = null;
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

    // The refusal itself, not a later schema error, proves no generated bytes
    // became reachable under this operation.
    expect(getCachedProfile(OPERATION_ID)).toBeUndefined();
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

  it('does not stamp generated bytes with an epoch that changed mid-generation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                printFarmerCapabilitiesResponse({
                  effectivePermissions: [
                    'calibration:read',
                    'calibration:create',
                    'calibration:update',
                    'calibration:generate',
                    'slicing:submit',
                  ],
                }),
              ),
              {
                status: 200,
                headers: { 'content-type': 'application/json' },
              },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ status: 403 }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
    registered = handlers();
    await invoke(IpcChannel.CalibrationGetAvailability, undefined);

    let releaseWorkspaceRead: (() => void) | undefined;
    workspaceReadGate = new Promise<void>((resolve) => {
      releaseWorkspaceRead = resolve;
    });
    const workspaceReadStarted = new Promise<void>((resolve) => {
      noteWorkspaceRead = resolve;
    });
    const pendingGeneration = invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    );
    await workspaceReadStarted;

    // This server refusal advances the action epoch without clearing a profile
    // that has not been cached yet.
    await invoke(IpcChannel.CalibrationGetOrchestrationStatus, {
      profileId: PROFILE_ID,
      orchestrationId: '66666666-6666-4666-8666-666666666666',
    });
    releaseWorkspaceRead?.();

    const response = (await pendingGeneration) as {
      status: string;
      error: { code: string };
    };
    expect(response.status).toBe('error');
    expect(response.error.code).toBe('workspaceNotReady');
    expect(getCachedProfile(OPERATION_ID)).toBeUndefined();
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
          projectId: PROJECT_ID,
          snapshotId: SNAPSHOT_SHA,
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
    'strands generated bytes before updating a selected profile under the same ID',
    async () => {
      await generate();
      expect(getCachedProfile(OPERATION_ID)).toBeDefined();
      let releaseSave: (() => void) | undefined;
      profileSaveGate = new Promise<void>((resolve) => {
        releaseSave = resolve;
      });
      const saveStarted = new Promise<void>((resolve) => {
        noteProfileSave = resolve;
      });

      const pendingSave = invoke(IpcChannel.SaveServerProfile, {
        id: PROFILE_ID,
        displayName: 'Updated farm',
        baseUrl: 'http://farm.changed',
        credentials: { authMode: 'apiKey', apiKey: 'replacement-key' },
        allowLegacy: false,
      });
      await saveStarted;

      expect(getCachedProfile(OPERATION_ID)).toBeUndefined();
      releaseSave?.();
      await expect(pendingSave).resolves.toMatchObject({ id: PROFILE_ID });
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
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_SHA,
        operationId: OPERATION_ID,
        confirmedProfileJsonHash: profileJsonHash,
      })) as { status: string; error: { code: string } };

      expect(response.status).toBe('error');
      expect(response.error.code).toBe('baseProfileChanged');
      expect(localState.lookups).toEqual(['Upstream PLA', 'Upstream PLA']);
      expect(installState.writes).toBe(0);
    },
  );

  onWindows(
    'refuses to install after the exact base profile was removed',
    async () => {
      const profileJsonHash = await generate();
      localState.found = false;

      const response = (await invoke(IpcChannel.CalibrationInstallOrcaProfile, {
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_SHA,
        operationId: OPERATION_ID,
        confirmedProfileJsonHash: profileJsonHash,
      })) as { status: string; error: { code: string } };

      expect(response.status).toBe('error');
      expect(response.error.code).toBe('baseProfileMissing');
      expect(installState.writes).toBe(0);
    },
  );

  onWindows(
    'refuses a generated operation presented from another open project',
    async () => {
      const profileJsonHash = await generate();

      const response = (await invoke(IpcChannel.CalibrationInstallOrcaProfile, {
        profileId: PROFILE_ID,
        projectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        snapshotId: SNAPSHOT_SHA,
        operationId: OPERATION_ID,
        confirmedProfileJsonHash: profileJsonHash,
      })) as { status: string; error: { code: string } };

      expect(response.status).toBe('error');
      expect(response.error.code).toBe('workspaceNotReady');
      expect(installState.writes).toBe(0);
    },
  );

  onWindows(
    're-reads and refuses a project that rebased to another snapshot',
    async () => {
      const profileJsonHash = await generate();
      workspaceSnapshotId = 'f'.repeat(64);

      const response = (await invoke(IpcChannel.CalibrationInstallOrcaProfile, {
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        snapshotId: SNAPSHOT_SHA,
        operationId: OPERATION_ID,
        confirmedProfileJsonHash: profileJsonHash,
      })) as { status: string; error: { code: string } };

      expect(response.status).toBe('error');
      expect(response.error.code).toBe('workspaceNotReady');
      expect(installState.writes).toBe(0);
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
          projectId: PROJECT_ID,
          snapshotId: SNAPSHOT_SHA,
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

describe('the pre-write epoch fence stands on its own', () => {
  const onWindows = process.platform === 'win32' ? it : it.skip;

  const CANONICAL_PERMISSIONS = [
    'calibration:read',
    'calibration:create',
    'calibration:update',
    'calibration:generate',
    'slicing:submit',
    'queue:read',
    'queue:write',
  ];

  /**
   * Capabilities negotiate cleanly; everything else is refused.
   *
   * The refusal has to come from the server, not from a local gate. A gate that
   * declines before issuing a request never reaches the 403 handling, so the
   * epoch would never advance and the test would be measuring nothing.
   */
  /** Must be called before `handlers()`: the HTTP client captures fetch. */
  function serverRefusingEverythingButCapabilities(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn((url: URL | string) => {
        const href = typeof url === 'string' ? url : url.href;
        if (href.includes('/api/calibration/capabilities')) {
          return Promise.resolve(
            new Response(
              JSON.stringify(
                printFarmerCapabilitiesResponse({
                  effectivePermissions: CANONICAL_PERMISSIONS,
                }),
              ),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({ status: 403 }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
  }

  async function generate(): Promise<string> {
    const generated = (await invoke(
      IpcChannel.CalibrationGenerateOrcaProfile,
      generateRequest(),
    )) as { status: string; profileJsonHash: string };
    expect(generated.status).toBe('ok');
    return generated.profileJsonHash;
  }

  function install(profileJsonHash: string): Promise<unknown> {
    return invoke(IpcChannel.CalibrationInstallOrcaProfile, {
      profileId: PROFILE_ID,
      projectId: PROJECT_ID,
      snapshotId: SNAPSHOT_SHA,
      operationId: OPERATION_ID,
      confirmedProfileJsonHash: profileJsonHash,
    });
  }

  onWindows(
    'refuses the write when the epoch advanced but the bytes are still cached',
    async () => {
      serverRefusingEverythingButCapabilities();
      registered = handlers();
      await invoke(IpcChannel.CalibrationGetAvailability, undefined);
      const profileJsonHash = await generate();

      // A 403 on an unrelated read, arriving while the operator sits on the
      // install confirmation. This is the epoch advance that matters here:
      // `noteCalibrationForbidden` deliberately does *not* clear the generated
      // profile cache, because a refusal about orchestration access says
      // nothing about whether locally generated bytes are readable. The bytes
      // survive, the epoch moves, and the only thing between them and the disk
      // is the check taken immediately before the write.
      await invoke(IpcChannel.CalibrationGetOrchestrationStatus, {
        profileId: PROFILE_ID,
        orchestrationId: '66666666-6666-4666-8666-666666666666',
      });

      // The premise, asserted rather than assumed. Without this the test could
      // pass because the entry vanished, which would prove nothing about the
      // epoch fence.
      expect(getCachedProfile(OPERATION_ID)).toBeDefined();

      const response = (await install(profileJsonHash)) as {
        status: string;
        error: { code: string; message: string };
      };

      expect(response.status).toBe('error');
      expect(response.error.message).toContain('calibration session changed');
      // The claim that matters: nothing was written. A refusal issued after the
      // write would not be a fence.
      expect(installState.writes).toBe(0);
    },
    30_000,
  );

  onWindows(
    'writes when nothing invalidated the session, so the refusal above is not unconditional',
    async () => {
      const profileJsonHash = await generate();

      const response = (await install(profileJsonHash)) as { status: string };

      expect(response.status).toBe('ok');
      expect(installState.writes).toBe(1);
    },
  );

  onWindows(
    're-reads the workspace after the final base lookup before writing',
    async () => {
      const profileJsonHash = await generate();
      let releaseLookup: (() => void) | undefined;
      localState.lookupGate = new Promise<void>((resolve) => {
        releaseLookup = resolve;
      });
      const lookupStarted = new Promise<void>((resolve) => {
        localState.lookupStarted = resolve;
      });
      // Generation performed lookup 1. The handler preflight performs lookup 2;
      // lookup 3 is the installer callback immediately at the write boundary.
      localState.gateAtLookup = localState.lookups.length + 2;

      const pendingInstall = install(profileJsonHash);
      await lookupStarted;
      workspaceSnapshotId = 'f'.repeat(64);
      releaseLookup?.();

      const response = (await pendingInstall) as {
        status: string;
        error: { code: string };
      };
      expect(response.status).toBe('error');
      expect(response.error.code).toBe('workspaceNotReady');
      expect(installState.writes).toBe(0);
    },
  );

  onWindows(
    'revalidates after installer preflight and refuses an epoch change at the write boundary',
    async () => {
      serverRefusingEverythingButCapabilities();
      registered = handlers();
      await invoke(IpcChannel.CalibrationGetAvailability, undefined);
      const profileJsonHash = await generate();
      installState.beforeWrite = async () => {
        installState.beforeWrite = null;
        await invoke(IpcChannel.CalibrationGetOrchestrationStatus, {
          profileId: PROFILE_ID,
          orchestrationId: '66666666-6666-4666-8666-666666666666',
        });
      };

      const response = (await install(profileJsonHash)) as {
        status: string;
        error: { code: string; message: string };
      };

      expect(response.status).toBe('error');
      expect(response.error.code).toBe('workspaceNotReady');
      expect(response.error.message).toContain('calibration session changed');
      expect(getCachedProfile(OPERATION_ID)).toBeDefined();
      expect(installState.writes).toBe(0);
    },
    30_000,
  );
});
