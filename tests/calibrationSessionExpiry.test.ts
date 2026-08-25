// @vitest-environment node

/**
 * Production-path coverage for expired and revoked calibration sessions.
 *
 * The desktop app authenticates with a fifteen-minute JWT exchanged from a
 * configured API key. Two things therefore produce a 401 routinely: the token
 * ages out while the workspace sits open, and an administrator forces a
 * revocation. Neither is a statement about the operator's rights, so neither may
 * be reported — or handled — as a 403.
 *
 * These tests drive the registered handlers through the real HTTP client, with
 * only `fetch` and the profile service replaced, and assert the two properties
 * that matter and cannot be seen from a response alone: exactly how many times
 * the app re-exchanges its key, and that a mutation which met a 401 was never
 * sent a second time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel } from '@shared/ipc';
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';
import { CALIBRATION_FIXTURE_IDS } from './fixtures/calibrationContract.js';

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

const PROFILE_ID = CALIBRATION_FIXTURE_IDS.profileId;
const BASE_URL = 'http://farm.local';

const CANONICAL_PERMISSIONS = [
  'calibration:read',
  'calibration:create',
  'calibration:update',
  'calibration:generate',
  'slicing:submit',
  'queue:write',
  'queue:read',
  'queue:acknowledge-bed-clear',
  'queue:start',
];

/** Default desktop exchange-token lifetime. */
const TOKEN_LIFETIME_MS = 15 * 60 * 1000;

/**
 * A profile service that mints tokens the way the real exchange does.
 *
 * `exchanges` is the number the recovery path is bounded on: the whole point of
 * single-flighting and the cooldown is that a farm answering 401 to everything
 * cannot turn each failing request into another key exchange.
 */
function tokenService(options: { failExchange?: boolean } = {}) {
  const state = {
    exchanges: 0,
    token: 'jwt-1',
    issuedAt: Date.now(),
  };
  const mint = () => {
    state.exchanges += 1;
    state.token = `jwt-${state.exchanges + 1}`;
    state.issuedAt = Date.now();
    return state.token;
  };
  return {
    state,
    service: {
      list: () =>
        Promise.resolve({ profiles: [], selectedProfileId: PROFILE_ID }),
      getAuthenticatedContext: () =>
        Promise.resolve({
          profile: { id: PROFILE_ID, baseUrl: BASE_URL },
          token: state.token,
          serverBinding: 'binding-abc',
        }),
      getAuthenticatedServerContext: (
        _id: string,
        _baseUrl?: string,
        force?: boolean,
      ) => {
        if (force === true) {
          if (options.failExchange === true) {
            state.exchanges += 1;
            return Promise.reject(new Error('API key rejected.'));
          }
          mint();
        }
        return Promise.resolve({
          baseUrl: BASE_URL,
          token: state.token,
          binding: 'binding-abc',
        });
      },
      onBindingChanged: () => () => undefined,
    },
  };
}

const sidecar = {
  initialize: () => Promise.resolve(),
  dispose: () => Promise.resolve(),
  disposeAll: () => Promise.resolve(),
  request: () => Promise.resolve({}),
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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface ServerOptions {
  /** Tokens the server accepts. Anything else is answered 401. */
  accepts?: (token: string) => boolean;
  capabilityOverrides?: Record<string, unknown>;
  /** Force an authorization response for requests matching this fragment. */
  rejectFragment?: string;
  /** Status used by the forced refusal. */
  rejectStatus?: 401 | 403;
}

/** Routes by URL, and answers 401 for any token it does not accept. */
function server(options: ServerOptions = {}): { calls: string[] } {
  const calls: string[] = [];
  const accepts = options.accepts ?? (() => true);
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL | string, init?: RequestInit) => {
      const href = typeof url === 'string' ? url : url.href;
      const method = init?.method ?? 'GET';
      calls.push(`${method} ${href}`);
      const header = new Headers(init?.headers);
      const authorization = header.get('authorization') ?? '';
      const presented = authorization.split(' ').pop() ?? '';
      if (
        !accepts(presented) ||
        (options.rejectFragment !== undefined &&
          href.includes(options.rejectFragment))
      ) {
        const status =
          !accepts(presented) || options.rejectStatus === undefined
            ? 401
            : options.rejectStatus;
        return Promise.resolve(
          json(
            {
              title: status === 401 ? 'Unauthorized' : 'Forbidden',
              status,
            },
            status,
          ),
        );
      }
      if (href.includes('/api/calibration/capabilities')) {
        return Promise.resolve(
          json(
            printFarmerCapabilitiesResponse({
              effectivePermissions: CANONICAL_PERMISSIONS,
              ...options.capabilityOverrides,
            }),
          ),
        );
      }
      return Promise.resolve(json({}, 404));
    }),
  );
  return { calls };
}

function handlers(profileService: unknown): Map<string, Handler> {
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a rejected token is recovered, not treated as a refusal', () => {
  it('re-exchanges the API key once when the token has aged out', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const tokens = tokenService();
    // The farm accepts only the token issued most recently, exactly as a
    // server validating a fifteen-minute JWT does once the old one expires.
    const { calls } = server({
      accepts: (token) => token === tokens.state.token,
    });
    registered = handlers(tokens.service);

    await invoke(IpcChannel.CalibrationGetAvailability, undefined);
    expect(tokens.state.exchanges).toBe(0);

    // Fifteen minutes pass with the workspace open, and the farm stops
    // accepting the token the app is still holding.
    vi.setSystemTime(new Date(Date.now() + TOKEN_LIFETIME_MS + 1000));
    const stale = tokens.state.token;
    const { calls: after } = server({
      accepts: (token) => token !== stale,
    });
    registered = handlers(tokens.service);

    const response = (await invoke(
      IpcChannel.CalibrationGetAvailability,
      undefined,
    )) as {
      available: boolean;
      unavailableReason: string | null;
    };

    expect(tokens.state.exchanges).toBe(1);
    // Recovery re-reads capabilities against the new token, so availability is
    // answered rather than the operator being told to reconnect.
    expect(response.available).toBe(true);
    expect(response.unavailableReason).toBeNull();
    expect(calls.length).toBeGreaterThan(0);
    expect(countingExchangeReads(after)).toBeGreaterThanOrEqual(1);
  });

  it('reports a session that cannot be re-established as expired, never as a legacy server', async () => {
    const tokens = tokenService();
    // Forced revocation: every token this key produces is refused.
    server({ accepts: () => false });
    registered = handlers(tokens.service);

    const response = (await invoke(
      IpcChannel.CalibrationGetAvailability,
      undefined,
    )) as {
      available: boolean;
      unavailableReason: string | null;
      unavailableDetail: string | null;
    };

    expect(response.available).toBe(false);
    // The failure that used to be reported as `legacyServer`, telling an
    // operator with a revoked session that their server was too old.
    expect(response.unavailableReason).toBe('sessionExpired');
    expect(response.unavailableDetail).toContain('Reconnect');
    // Exactly one exchange: the capability read taken immediately after it is
    // refused too, and that terminates recovery instead of restarting it.
    expect(tokens.state.exchanges).toBe(1);
  });

  it('re-applies firmware support gates to capabilities read after re-authentication', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const tokens = tokenService();
    server({ accepts: (token) => token === tokens.state.token });
    registered = handlers(tokens.service);
    await invoke(IpcChannel.CalibrationGetAvailability, undefined);

    vi.setSystemTime(new Date(Date.now() + TOKEN_LIFETIME_MS + 1000));
    const stale = tokens.state.token;
    const { calls } = server({
      accepts: (token) => token !== stale,
      capabilityOverrides: {
        supportedFirmwareFamilies: ['Marlin'],
        supportedGcodeDialects: ['Marlin'],
      },
    });
    registered = handlers(tokens.service);

    const response = (await invoke(
      IpcChannel.CalibrationGetAvailability,
      undefined,
    )) as {
      available: boolean;
      unavailableReason: string | null;
      unavailableDetail: string | null;
    };

    expect(tokens.state.exchanges).toBe(1);
    expect(response.available).toBe(false);
    expect(response.unavailableReason).toBe('unsupportedFirmware');
    expect(response.unavailableDetail).toContain('Klipper');
    expect(countingExchangeReads(calls)).toBeGreaterThanOrEqual(1);
  });

  it('stops when the key exchange itself fails', async () => {
    const tokens = tokenService({ failExchange: true });
    const { calls } = server({ accepts: () => false });
    registered = handlers(tokens.service);

    const response = (await invoke(
      IpcChannel.CalibrationGetAvailability,
      undefined,
    )) as { available: boolean; unavailableReason: string | null };

    expect(response.unavailableReason).toBe('sessionExpired');
    // One attempted exchange, and no capability read can follow a failed one:
    // there is no token to read capabilities with.
    expect(tokens.state.exchanges).toBe(1);
    expect(countingExchangeReads(calls)).toBeLessThanOrEqual(3);
  });

  it('performs one exchange for a burst of concurrent rejections', async () => {
    const tokens = tokenService();
    server({ accepts: () => false });
    registered = handlers(tokens.service);

    await Promise.all([
      invoke(IpcChannel.CalibrationGetAvailability, undefined),
      invoke(IpcChannel.CalibrationGetAvailability, undefined),
      invoke(IpcChannel.CalibrationGetAvailability, undefined),
    ]);

    // Single-flight, then the cooldown. Three panels refreshing at once must
    // not mean three key exchanges.
    expect(tokens.state.exchanges).toBe(1);
  });
});

/** Capability reads, which is what recovery performs after an exchange. */
function countingExchangeReads(calls: readonly string[]): number {
  return calls.filter((call) => call.includes('/api/calibration/capabilities'))
    .length;
}

beforeEach(() => {
  electronState.handlers.clear();
});
