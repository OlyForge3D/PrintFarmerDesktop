// @vitest-environment node

/**
 * Production-path regression test for the Printer Calibration availability
 * gate.
 *
 * This drives the *registered* `CalibrationGetAvailability` IPC handler — the
 * exact code the calibration tab calls — through the real
 * `CalibrationHttpClient` and the real wire schema, with only `fetch` and the
 * profile service replaced. Before the capability-contract fix, the live
 * PrintFarmer `PlatformCapabilitiesDto` body made this handler report
 * `Calibration API response validation failed: Required`.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, CalibrationConflictKind } from '@shared/ipc';
import {
  conflictResolutionsFor,
  SidecarCalibrationAdapter,
  supportsConflictResolution,
} from '../src/main/calibrationService.js';
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';

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

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'http://farm.local';

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

/** Every `resolveCalibrationConflict` the adapter forwards to the sidecar. */
const sidecarResolveCalls: unknown[][] = [];

const noopSidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
  resolveCalibrationConflict: (...args: unknown[]) => {
    sidecarResolveCalls.push(args);
    return Promise.resolve();
  },
};

function registeredHandler(channel: string): Handler {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    fakeProfiles() as never,
    noopSidecar as never,
    noopSidecar as never,
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
  const handler = electronState.handlers.get(channel);
  if (!handler) throw new Error(`no handler was registered for ${channel}`);
  return handler;
}

function availabilityHandler(): Handler {
  return registeredHandler(IpcChannel.CalibrationGetAvailability);
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

interface Availability {
  available: boolean;
  unavailableReason: string | null;
  unavailableDetail: string | null;
  negotiatedApiVersion: string | null;
  negotiatedSchemaVersion: string | null;
  capabilityFlags: Record<string, boolean> | null;
  grantedScopes: string[] | null;
  offlineEditingEnabled: boolean;
}

beforeEach(() => {
  electronState.handlers.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CalibrationGetAvailability against the live PrintFarmer contract', () => {
  it('reports calibration as available for the real capabilities response', async () => {
    respondWith(printFarmerCapabilitiesResponse());
    const handler = availabilityHandler();

    const result = (await handler({}, undefined)) as Availability;

    expect(result.unavailableDetail).toBeNull();
    expect(result.available).toBe(true);
    expect(result.negotiatedApiVersion).toBe('1.0');
    expect(result.negotiatedSchemaVersion).toBe('1.0');
    expect(result.offlineEditingEnabled).toBe(true);
    expect(result.grantedScopes).toEqual([
      'calibration:create',
      'calibration:read',
    ]);
  });

  it('stays available when only optional features are disabled', async () => {
    respondWith(
      printFarmerCapabilitiesResponse({
        calibrationGenerationEnabled: false,
        calibrationPhotosEnabled: false,
      }),
    );
    const handler = availabilityHandler();

    const result = (await handler({}, undefined)) as Availability;

    // Generation and photos are features, not preconditions: an operator can
    // still record measured results by hand, so the tab must open.
    expect(result.available).toBe(true);
    expect(result.unavailableDetail).toBeNull();
    expect(result.capabilityFlags?.calibrationGenerationEnabled).toBe(false);
    expect(result.capabilityFlags?.calibrationPhotoUploadEnabled).toBe(false);
  });

  it('names the disabled capability when a core requirement is off', async () => {
    respondWith(
      printFarmerCapabilitiesResponse({ calibrationSyncEnabled: false }),
    );
    const handler = availabilityHandler();

    const result = (await handler({}, undefined)) as Availability;

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe('missingCapabilityFlags');
    expect(result.unavailableDetail).toContain('calibrationChangeFeedEnabled');
    expect(result.negotiatedApiVersion).toBe('1.0');
  });

  it('reports unsupported firmware when Klipper is not advertised', async () => {
    respondWith(
      printFarmerCapabilitiesResponse({
        supportedFirmwareFamilies: ['Marlin'],
        supportedGcodeDialects: ['Marlin'],
      }),
    );
    const handler = availabilityHandler();

    const result = (await handler({}, undefined)) as Availability;

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe('unsupportedFirmware');
  });

  it('still fails closed with a field path when the response is malformed', async () => {
    respondWith(
      printFarmerCapabilitiesResponse({ calibrationPersistenceEnabled: 42 }),
    );
    const handler = availabilityHandler();

    const result = (await handler({}, undefined)) as Availability;

    expect(result.available).toBe(false);
    expect(result.unavailableDetail).toContain(
      'calibrationPersistenceEnabled: Expected boolean, received number',
    );
    expect(result.capabilityFlags).toBeNull();
  });
});

/**
 * Production-path tests for the calibration conflict resolve channel.
 *
 * This block previously asserted that the channel refused every call, because
 * model-core had no resolve RPC. It now has one, so the annotation had to go
 * rather than be left behind as a passing description of a world that ended.
 *
 * Every rejection here asserts the *code*, and every code is asserted to
 * differ from the others. "It threw" is not evidence that it threw for the
 * documented reason: a bad profile, a malformed request and a forbidden
 * resolution all reject, and only one of them means the policy check ran.
 */
describe('Calibration conflict resolution over the registered IPC channel', () => {
  const OPEN_CONFLICT_ID = '66666666-6666-4666-8666-666666666666';

  /** Replaces the store read the adapter performs to learn a conflict's kind. */
  function withOpenConflict(kind: string): void {
    (
      SidecarCalibrationAdapter.prototype as {
        listCalibrationConflicts?: unknown;
      }
    ).listCalibrationConflicts = () =>
      Promise.resolve([
        {
          conflictId: OPEN_CONFLICT_ID,
          profileId: PROFILE_ID,
          projectId: '77777777-7777-4777-8777-777777777777',
          kind,
          entityId: '88888888-8888-4888-8888-888888888888',
          localPayloadSummary: null,
          serverPayloadSummary: null,
          serverRevision: 4,
          availableResolutions: [],
          resolvedAt: null,
          resolution: null,
          createdAt: '2026-07-26T15:01:00.000Z',
        },
      ]);
  }

  function resolveRequest(resolution: string, conflictId = OPEN_CONFLICT_ID) {
    return {
      profileId: PROFILE_ID,
      conflictId,
      resolution,
    };
  }

  async function callResolve(request: unknown): Promise<{
    value?: unknown;
    error?: { code?: string; message?: string };
  }> {
    const handler = registeredHandler(IpcChannel.CalibrationResolveConflict);
    return (handler({}, request) as Promise<unknown>).then(
      (value) => ({ value }),
      (error: unknown) => ({ error: error as { code?: string } }),
    );
  }

  beforeEach(() => {
    sidecarResolveCalls.length = 0;
  });

  afterEach(() => {
    delete (
      SidecarCalibrationAdapter.prototype as {
        listCalibrationConflicts?: unknown;
      }
    ).listCalibrationConflicts;
  });

  it('resolves an open conflict with a resolution its kind permits', async () => {
    withOpenConflict('projectMetadata');

    const outcome = await callResolve(resolveRequest('acceptServer'));

    expect(
      outcome.error,
      `resolving a projectMetadata conflict with acceptServer was rejected: ${
        outcome.error?.message ?? ''
      }`,
    ).toBeUndefined();
    expect(
      sidecarResolveCalls,
      'the handler reported success without the sidecar being asked to ' +
        'resolve anything, so nothing was written',
    ).toHaveLength(1);
    expect(sidecarResolveCalls[0]).toEqual([
      PROFILE_ID,
      OPEN_CONFLICT_ID,
      'acceptServer',
    ]);
  });

  /*
   * The acceptance item this whole PR turns on. A test that only proves a
   * permitted resolution succeeds cannot tell an enforced policy from an
   * absent one -- both accept it. Only a refusal of a forbidden one can.
   */
  it('refuses a resolution the conflict kind does not permit, before writing', async () => {
    withOpenConflict('outcomeSelection');

    const outcome = await callResolve(resolveRequest('manualFieldMerge'));

    expect(outcome.error?.code).toBe(
      'CALIBRATION_CONFLICT_RESOLUTION_NOT_PERMITTED',
    );
    expect(
      outcome.error?.message,
      'the refusal must name the kind and what it does allow, or an ' +
        'operator cannot tell a policy from a malfunction',
    ).toContain('outcomeSelection');
    expect(
      sidecarResolveCalls,
      'a forbidden resolution reached the store; refusing after the write ' +
        'is not refusing',
    ).toHaveLength(0);
  });

  /*
   * The control for the test above. manualFieldMerge must be refused because
   * *this kind* forbids it -- not because the handler refuses manualFieldMerge
   * always, which would pass the previous test just as well.
   */
  it('permits manualFieldMerge for a kind the schema does allow it for', async () => {
    withOpenConflict('stepDraft');

    const outcome = await callResolve(resolveRequest('manualFieldMerge'));

    expect(
      outcome.error,
      'manualFieldMerge was refused for stepDraft, so the refusal above is ' +
        'about the resolution rather than about the conflict kind',
    ).toBeUndefined();
    expect(sidecarResolveCalls).toHaveLength(1);
  });

  it('refuses a conflict that is not open, with its own code', async () => {
    withOpenConflict('projectMetadata');

    const outcome = await callResolve(
      resolveRequest('acceptServer', '99999999-9999-4999-8999-999999999999'),
    );

    expect(outcome.error?.code).toBe('CALIBRATION_CONFLICT_NOT_OPEN');
    expect(sidecarResolveCalls).toHaveLength(0);
  });

  it('rejects a malformed resolution differently, so the checks above are reached', async () => {
    withOpenConflict('projectMetadata');

    const outcome = await callResolve(resolveRequest('lastWriteWins'));

    expect(outcome.error).toBeDefined();
    // Rejected by the request schema before any of this handler's logic runs.
    // If this shared a code with the policy refusal, a passing policy test
    // could be the parser firing and nobody would know.
    expect(outcome.error?.code).not.toBe(
      'CALIBRATION_CONFLICT_RESOLUTION_NOT_PERMITTED',
    );
    expect(outcome.error?.code).not.toBe('CALIBRATION_CONFLICT_NOT_OPEN');
    expect(sidecarResolveCalls).toHaveLength(0);
  });

  /*
   * The derivation counterfactual, inverted.
   *
   * It used to grant the absent capability and require both sites to switch
   * on. The capability now ships, so the same control runs the other way:
   * remove it and require both sites to switch back off. "The handler
   * resolves" and "availableResolutions is non-empty" are equally satisfied by
   * code that unconditionally resolves and unconditionally returns a list.
   * Removing the capability is what separates those.
   */
  describe('both sites are derived from the capability, not asserted', () => {
    let real: unknown;

    beforeEach(() => {
      real = (
        SidecarCalibrationAdapter.prototype as {
          resolveCalibrationConflict?: unknown;
        }
      ).resolveCalibrationConflict;
    });

    afterEach(() => {
      (
        SidecarCalibrationAdapter.prototype as {
          resolveCalibrationConflict?: unknown;
        }
      ).resolveCalibrationConflict = real;
    });

    it('reports the shipped adapter as capable of resolving', () => {
      expect(
        supportsConflictResolution(SidecarCalibrationAdapter.prototype),
        'the adapter no longer carries a resolve method, so every ' +
          'capability-present assertion below is vacuous',
      ).toBe(true);
    });

    it('offers nothing while a transport has no resolve capability', () => {
      expect(supportsConflictResolution({})).toBe(false);
      for (const kind of CalibrationConflictKind.options) {
        expect(
          conflictResolutionsFor({}, kind),
          `${kind} advertised a resolution while no resolve capability exists`,
        ).toEqual([]);
      }
    });

    it('offers resolutions as soon as a transport can resolve', () => {
      const capable = {
        resolveCalibrationConflict: () => Promise.resolve(undefined),
      };
      expect(supportsConflictResolution(capable)).toBe(true);
      for (const kind of CalibrationConflictKind.options) {
        expect(
          conflictResolutionsFor(capable, kind).length,
          `${kind} still advertised nothing even though the transport can ` +
            `resolve, so the empty result above proves nothing about derivation`,
        ).toBeGreaterThan(0);
      }
    });

    it('restricts manualFieldMerge to the kinds the schema restricts it to', () => {
      const capable = {
        resolveCalibrationConflict: () => Promise.resolve(undefined),
      };
      const withMerge = CalibrationConflictKind.options.filter((kind) =>
        conflictResolutionsFor(capable, kind).includes('manualFieldMerge'),
      );
      // Transcribed from the CalibrationConflictResolution schema doc, which
      // limits manualFieldMerge to metadata/draft conflicts. Not a new policy.
      expect(withMerge).toEqual(['projectMetadata', 'stepDraft']);
    });

    it('refuses at the IPC boundary again once the capability is taken away', async () => {
      delete (
        SidecarCalibrationAdapter.prototype as {
          resolveCalibrationConflict?: unknown;
        }
      ).resolveCalibrationConflict;
      withOpenConflict('projectMetadata');

      const outcome = await callResolve(resolveRequest('acceptServer'));

      expect(
        outcome.error?.code,
        'the resolve handler still succeeded with no resolve capability on ' +
          'the transport, so its success is unconditional rather than ' +
          'derived from the same predicate that fills availableResolutions',
      ).toBe('CALIBRATION_CONFLICT_RESOLUTION_UNAVAILABLE');
      expect(sidecarResolveCalls).toHaveLength(0);
    });
  });
});
