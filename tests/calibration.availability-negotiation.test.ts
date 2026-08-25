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
import { IpcChannel } from '@shared/ipc';
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
      // The desktop's `calibrationChangeFeedEnabled` gate reads
      // `calibrationSyncEnabled` (the sync/change-feed path). Not
      // `calibrationEventsEnabled` (a distinct future event-streaming
      // subsystem hardcoded `false` in the server today — see
      // `CalibrationCapabilityService.cs:203-205` and the DTO XML docs at
      // `PlatformCapabilitiesDto.cs:47-48` vs `:71-72`). See
      // `CALIBRATION_FLAG_SOURCES`.
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
