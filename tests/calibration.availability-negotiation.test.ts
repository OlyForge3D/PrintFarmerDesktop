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

  it('names the disabled capabilities instead of failing validation', async () => {
    respondWith(
      printFarmerCapabilitiesResponse({ calibrationGenerationEnabled: false }),
    );
    const handler = availabilityHandler();

    const result = (await handler({}, undefined)) as Availability;

    expect(result.available).toBe(false);
    expect(result.unavailableReason).toBe('missingCapabilityFlags');
    expect(result.unavailableDetail).toContain('calibrationGenerationEnabled');
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
 * `window.printFarmer.resolveCalibrationConflict` is exposed by the preload
 * bridge and typed as though it works. It does not: model-core has no
 * calibration resolve RPC, so the registered handler rejects every call. This
 * test exists so the gap is visible from the test suite rather than only from a
 * comment, and so that whoever implements the resolve path is forced to delete
 * it rather than leaving a stale annotation behind.
 *
 * It asserts the *code*, not merely that a rejection happened -- the handler
 * would also reject on a bad profile or a malformed request, and "it threw" is
 * not evidence that it threw for the documented reason.
 */
describe('Calibration conflict resolution is not implemented end to end', () => {
  it('rejects a well-formed resolve request with the documented code', async () => {
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
   * `availableResolutions` this adapter reports.
   *
   * "The handler refuses" and "the array is empty" are both satisfied by code
   * that unconditionally refuses and unconditionally returns []. Asserting them
   * proves the *values*, not that anything was derived. A hard-coded [] and a
   * derived [] are indistinguishable until the capability is present.
   *
   * So the capability is granted here, on the prototype the predicate actually
   * reads through, and both sites are required to change on their own. If they
   * do not, "derived" was decoration.
   */
  describe('the refusal is derived from the absent capability, not asserted', () => {
    afterEach(() => {
      delete (
        SidecarCalibrationAdapter.prototype as {
          resolveCalibrationConflict?: unknown;
        }
      ).resolveCalibrationConflict;
    });

    it('offers nothing while the transport has no resolve capability', () => {
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

    it('stops refusing at the IPC boundary once the capability appears', async () => {
      const resolved: unknown[] = [];
      (
        SidecarCalibrationAdapter.prototype as {
          resolveCalibrationConflict?: unknown;
        }
      ).resolveCalibrationConflict = function (
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
