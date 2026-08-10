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
import { IpcChannel, type CalibrationConflictResolution } from '@shared/ipc';
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

const noopSidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
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
 * Executable annotation for the calibration conflict resolution surface.
 *
 * The resolve path now exists end to end (issue #216), so this block no longer
 * documents a gap. It documents the *negotiation*: the IPC handler refuses when
 * the transport cannot resolve, and stops refusing when it can, from one
 * predicate.
 *
 * The refusal arm is still live code — any `CalibrationSidecar` implementation
 * without the method reaches it — so it is exercised by removing the capability
 * rather than by deleting the test. A refusal test that can no longer be
 * triggered would have to be deleted or would pass vacuously; this one is
 * driven, and the test below proves the removal removes something.
 *
 * It asserts the *code*, not merely that a rejection happened -- the handler
 * would also reject on a bad profile or a malformed request, and "it threw" is
 * not evidence that it threw for the documented reason.
 */
describe('Calibration conflict resolution negotiates on one capability', () => {
  type ResolveCapable = { resolveCalibrationConflict?: unknown };
  const prototype = SidecarCalibrationAdapter.prototype as ResolveCapable;
  let original: unknown;

  beforeEach(() => {
    original = prototype.resolveCalibrationConflict;
  });

  afterEach(() => {
    // Restore, never delete. Deleting was correct while the seam was empty;
    // against a real implementation it would silently strip the capability for
    // every later test in this file, and they would pass by measuring an
    // adapter that no longer exists in production.
    if (original === undefined) {
      delete prototype.resolveCalibrationConflict;
    } else {
      prototype.resolveCalibrationConflict = original;
    }
  });

  it('ships an adapter that can resolve, so removing the capability removes something', () => {
    expect(
      supportsConflictResolution(new SidecarCalibrationAdapter({} as never)),
      'the shipped adapter has no resolve capability, so every "capability ' +
        'absent" test below is testing the state it already ships in and ' +
        'proves nothing about negotiation',
    ).toBe(true);
  });

  it('rejects a well-formed resolve request with the documented code when the transport cannot resolve', async () => {
    delete prototype.resolveCalibrationConflict;
    const handler = registeredHandler(IpcChannel.CalibrationResolveConflict);

    const rejection = await (
      handler(
        {},
        {
          profileId: PROFILE_ID,
          conflictId: '66666666-6666-4666-8666-666666666666',
          resolution: 'acceptServer',
        },
      ) as Promise<unknown>
    ).then(
      () => null,
      (error: unknown) => error as { code?: string; message?: string },
    );

    expect(rejection).not.toBeNull();
    expect(rejection?.code).toBe('CALIBRATION_CONFLICT_RESOLUTION_UNAVAILABLE');
    expect(rejection?.message).toContain('resolution RPC');
  });

  it('rejects a malformed resolve request differently, so the check above is reached', async () => {
    delete prototype.resolveCalibrationConflict;
    const handler = registeredHandler(IpcChannel.CalibrationResolveConflict);

    const rejection = await (
      handler(
        {},
        {
          profileId: PROFILE_ID,
          conflictId: '66666666-6666-4666-8666-666666666666',
          resolution: 'lastWriteWins',
        },
      ) as Promise<unknown>
    ).then(
      () => null,
      (error: unknown) => error as { code?: string },
    );

    expect(rejection).not.toBeNull();
    expect(rejection?.code).not.toBe(
      'CALIBRATION_CONFLICT_RESOLUTION_UNAVAILABLE',
    );
  });

  /*
   * The counterfactual for the refusal above, and for the empty
   * `availableResolutions` an incapable transport reports.
   *
   * "The handler refuses" and "the array is empty" are both satisfied by code
   * that unconditionally refuses and unconditionally returns []. Asserting them
   * proves the *values*, not that anything was derived. A hard-coded [] and a
   * derived [] are indistinguishable until the capability is present.
   *
   * So the capability is varied here, on the prototype the predicate actually
   * reads through, and both sites are required to change on their own. If they
   * do not, "derived" was decoration.
   */
  describe('the refusal is derived from the absent capability, not asserted', () => {
    // These no longer vary by kind: conflictResolutionsFor carries no per-kind
    // policy (issue #304). It gates whatever resolutions the store already
    // put on the wire, so the fixture list stands in for "whatever the store
    // sent" rather than for any kind-specific table.
    const SAMPLE_RESOLUTIONS: CalibrationConflictResolution[] = [
      'acceptServer',
      'keepLocalAsNewRevision',
      'manualFieldMerge',
    ];

    it('offers nothing while the transport has no resolve capability', () => {
      expect(supportsConflictResolution({})).toBe(false);
      expect(
        conflictResolutionsFor({}, SAMPLE_RESOLUTIONS),
        'an incapable transport must report nothing, regardless of what the ' +
          'store sent',
      ).toEqual([]);
    });

    it('offers exactly what it was given as soon as a transport can resolve', () => {
      const capable = {
        resolveCalibrationConflict: () => Promise.resolve(undefined),
      };
      expect(supportsConflictResolution(capable)).toBe(true);
      expect(
        conflictResolutionsFor(capable, SAMPLE_RESOLUTIONS),
        'a capable transport must pass the store-provided list through ' +
          'unchanged -- this function has no policy of its own to apply',
      ).toEqual(SAMPLE_RESOLUTIONS);
    });

    it('applies no per-kind opinion of its own, in either direction', () => {
      // Issue #304's fix removed the second table rather than adding a test of
      // it. What is left to prove is that this function cannot reintroduce
      // one: whatever the store says is permitted for a kind -- including a
      // set with no manualFieldMerge, or an unusual one with it -- must come
      // back unfiltered given a capable transport.
      const capable = {
        resolveCalibrationConflict: () => Promise.resolve(undefined),
      };
      const noMerge: CalibrationConflictResolution[] = [
        'acceptServer',
        'keepLocalAsNewRevision',
      ];
      const onlyMerge: CalibrationConflictResolution[] = ['manualFieldMerge'];
      expect(conflictResolutionsFor(capable, noMerge)).toEqual(noMerge);
      expect(conflictResolutionsFor(capable, onlyMerge)).toEqual(onlyMerge);
      expect(conflictResolutionsFor(capable, [])).toEqual([]);
    });

    it('stops refusing at the IPC boundary once the capability appears', async () => {
      const resolved: unknown[] = [];
      prototype.resolveCalibrationConflict = function (
        request: unknown,
      ): Promise<unknown> {
        resolved.push(request);
        return Promise.resolve({ ok: true });
      };

      const handler = registeredHandler(IpcChannel.CalibrationResolveConflict);
      const outcome = await (
        handler(
          {},
          {
            profileId: PROFILE_ID,
            conflictId: '66666666-6666-4666-8666-666666666666',
            resolution: 'acceptServer',
          },
        ) as Promise<unknown>
      ).then(
        (value) => ({ value }),
        (error: unknown) => ({ error: error as { code?: string } }),
      );

      expect(
        'error' in outcome ? outcome.error.code : null,
        'the resolve handler still refused after the transport gained a ' +
          'resolve capability, so its refusal is hard-coded rather than ' +
          'derived from the same predicate that empties availableResolutions',
      ).not.toBe('CALIBRATION_CONFLICT_RESOLUTION_UNAVAILABLE');
      expect(resolved).toHaveLength(1);
    });
  });
});

/**
 * #363 -- the resolve channel validates its own response.
 *
 * Its sibling `CalibrationListConflicts` has parsed its response against
 * `ipcSchemas` since it was written; this channel returned the adapter's value
 * unchecked, which is why the epoch-seconds `createdAt` broke the *list* channel
 * loudly and passed through this one in silence.
 *
 * The variable is deliberately NOT a timestamp. `sidecarTimestampToIso` already
 * converts those, so a timestamp could not reach the parse and a spec built on
 * one would pass whether or not the parse existed. A non-UUID `profileId` is a
 * field the adapter does not touch, so it reaches the boundary intact and only
 * the parse can reject it.
 */
describe('#363 the resolve channel parses its response against the contract', () => {
  type ResolveCapable = { resolveCalibrationConflict?: unknown };
  const prototype = SidecarCalibrationAdapter.prototype as ResolveCapable;
  let original: unknown;

  beforeEach(() => {
    original = prototype.resolveCalibrationConflict;
  });

  afterEach(() => {
    if (original === undefined) {
      delete prototype.resolveCalibrationConflict;
    } else {
      prototype.resolveCalibrationConflict = original;
    }
  });

  function resolveReturning(conflictOverrides: Record<string, unknown>) {
    prototype.resolveCalibrationConflict = function () {
      return Promise.resolve({
        conflict: {
          conflictId: '66666666-6666-4666-8666-666666666666',
          profileId: PROFILE_ID,
          projectId: '22222222-2222-4222-8222-222222222222',
          entityId: '44444444-4444-4444-8444-444444444444',
          kind: 'projectMetadata' as const,
          availableResolutions: ['acceptServer' as const],
          localPayloadSummary: 'local',
          serverPayloadSummary: 'server',
          serverRevision: 4,
          resolution: 'acceptServer',
          resolvedAt: '2026-08-05T00:00:00.000Z',
          createdAt: '2026-08-05T00:00:00.000Z',
          ...conflictOverrides,
        },
        supersededObservations: [],
      });
    };
    return registeredHandler(IpcChannel.CalibrationResolveConflict);
  }

  const request = {
    profileId: PROFILE_ID,
    conflictId: '66666666-6666-4666-8666-666666666666',
    resolution: 'acceptServer',
  };

  it('POSITIVE CONTROL: a contract-satisfying response is returned, so the spec below is not measuring a handler that rejects everything', async () => {
    const handler = resolveReturning({});

    const outcome = await (handler({}, request) as Promise<unknown>).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    expect(
      'value' in outcome,
      'the handler rejected a response that satisfies its own contract, so a ' +
        'rejection below would prove nothing about validation',
    ).toBe(true);
  });

  it('rejects a response the contract forbids instead of forwarding it to the renderer', async () => {
    const handler = resolveReturning({ profileId: 'not-a-uuid' });

    const outcome = await (handler({}, request) as Promise<unknown>).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    expect(
      'error' in outcome,
      'the resolve channel forwarded a payload its own response schema ' +
        'rejects; the renderer receives data the contract says cannot occur',
    ).toBe(true);
  });
});
