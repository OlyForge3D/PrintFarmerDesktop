// @vitest-environment node

/**
 * Production-path regression test for the `CalibrationListOrcaProfiles` IPC
 * handler.
 *
 * This drives the *registered* handler — the exact code the calibration wizard
 * calls — through the real `CalibrationHttpClient`, the real wire schemas and
 * the real local profile scanner, with only `fetch`, the profile service and
 * the OrcaSlicer root locations replaced.
 *
 * It exists because a schema-level test cannot see the defect it guards. Local
 * OrcaSlicer scanning was previously reachable only from inside
 * `candidates.map(...)`, so when the server refused to list printers the
 * candidate array stayed empty, the callback never ran, and the handler
 * returned an empty profile list having never looked at the machine's
 * OrcaSlicer install at all. Every part of that is wiring, and only the
 * assembled handler shows it.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CALIBRATION_MAX_PRINTER_CANDIDATES, IpcChannel } from '@shared/ipc';

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
const TARGET_PROFILE = 'Generic PLA @0.4 nozzle';

/** A candidate shaped as PrintFarmer emits it, so "readable" means readable. */
function candidateDto(overrides: Record<string, unknown> = {}) {
  return {
    id: 'aaaaaaaa-1111-4111-8111-222222222222',
    name: 'Rack A cell 3',
    enabled: true,
    inMaintenance: false,
    configurationRevision: 4,
    reachability: 'online',
    operationalState: 'idle',
    observedAtUtc: '2026-08-11T12:00:00Z',
    isStale: false,
    firmware: {
      family: 'Klipper',
      gcodeDialect: 'Klipper',
      detectionSource: 'moonraker',
      version: 'v0.12.0',
      verified: true,
    },
    slicer: {
      engine: 'OrcaSlicer',
      distribution: 'upstream',
      version: '2.4.2',
      profileFormat: 'orca-json',
    },
    eligible: true,
    missingInputs: [],
    rejectionReasons: [],
    ...overrides,
  };
}

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

function listOrcaProfilesHandler(): Handler {
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
  const handler = electronState.handlers.get(
    IpcChannel.CalibrationListOrcaProfiles,
  );
  if (!handler) throw new Error('no listOrcaProfiles handler was registered');
  return handler;
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

interface OrcaProfilesResponse {
  profiles: unknown[];
  discovery: { kind: string; message: string };
  printersUnreadable: number;
  printersTruncated: boolean;
  localProfiles: Array<{ name: string; source: string }>;
  localDiscovery: { kind: string; message: string };
}

let sandbox: string;
const savedEnv = new Map<string, string | undefined>();

/**
 * Returns the OrcaSlicer *user* profile directory for this OS, rooted in the
 * sandbox, and redirects whatever environment variable resolves it.
 *
 * The user root is used rather than the system root because it is the only one
 * redirectable on every platform: the macOS and Linux system roots are
 * hardcoded absolute paths (`/Applications/...`, `/usr/share/...`) with no
 * environment indirection, so a `PROGRAMFILES` redirect is meaningless there.
 */
function redirectOrcaUserRoot(): string {
  const remember = (key: string, value: string) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };
  if (process.platform === 'win32') {
    const appData = path.join(sandbox, 'appdata');
    remember('APPDATA', appData);
    // Also redirect the install root so a real local OrcaSlicer cannot leak in.
    remember('PROGRAMFILES', path.join(sandbox, 'programfiles'));
    remember('PROGRAMFILES(X86)', path.join(sandbox, 'programfiles-x86'));
    return path.join(appData, 'OrcaSlicer', 'user');
  }
  if (process.platform === 'darwin') {
    const home = path.join(sandbox, 'home');
    remember('HOME', home);
    return path.join(
      home,
      'Library',
      'Application Support',
      'OrcaSlicer',
      'user',
    );
  }
  const configHome = path.join(sandbox, 'config');
  remember('HOME', path.join(sandbox, 'home'));
  remember('XDG_CONFIG_HOME', configHome);
  return path.join(configHome, 'OrcaSlicer', 'user');
}

function restoreEnv(): void {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'pfd-listorca-'));

  const userRoot = redirectOrcaUserRoot();
  const dir = path.join(userRoot, 'filament');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `${TARGET_PROFILE}.json`),
    JSON.stringify({
      type: 'filament',
      name: TARGET_PROFILE,
      filament_type: ['PLA'],
      nozzle_temperature: ['210'],
    }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  restoreEnv();
  await rm(sandbox, { recursive: true, force: true });
});

describe('CalibrationListOrcaProfiles handler — local scanning is not gated on the server', () => {
  it('still reports installed OrcaSlicer profiles when the server cannot list printers', async () => {
    // Exactly the production 503: the upstream profile resolver is unroutable,
    // so PrintFarmer returns no candidates at all.
    respondWith(
      {
        status: 503,
        title: 'Profile service unavailable',
        code: 'profile_service_unavailable',
      },
      503,
    );

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    // Server-bound profiles are legitimately empty; the local ones are not.
    expect(response.profiles).toEqual([]);
    expect(response.discovery.kind).toBe('serverDependencyUnavailable');
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
    expect(response.localDiscovery.kind).toBe('ok');
  });

  it('still reports installed profiles when the calibration route is absent', async () => {
    respondWith({ status: 404 }, 404);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('routeUnavailable');
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
  });

  it('still reports installed profiles when the session is unauthenticated', async () => {
    respondWith({ status: 401 }, 401);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('unauthenticated');
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
  });

  it('separates an empty eligible set from a server refusal', async () => {
    // The server answered normally and simply has no candidates. That is a
    // different situation from a refusal and must read differently.
    respondWith([]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('noEligiblePrinters');
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
  });

  it('does not call an unreadable farm an empty one', async () => {
    // Every candidate is malformed. Parsing them separately means one bad
    // record no longer empties the farm — but the farm *is* empty here, and
    // saying "no candidate printers for this account" is a statement about
    // the account that is simply false. The printers exist; this client could
    // not read them, and an operator told otherwise goes hunting an enrolment
    // problem that does not exist.
    respondWith([{ id: 'not-a-guid', name: '' }, null, 7]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('malformedResponse');
    expect(response.discovery.kind).not.toBe('noEligiblePrinters');
    // The count is the evidence, asserted as a number rather than read back
    // out of a sentence.
    expect(response.printersUnreadable).toBe(3);
    expect(response.discovery.message).toContain('3 calibration candidates');
    // The local scan is unaffected, as with every other server-side failure.
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
  });

  it('qualifies a partially unreadable farm instead of reporting plain ok', async () => {
    respondWith([{ id: 'not-a-guid', name: '' }, candidateDto()]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('partiallyUnreadable');
    expect(response.printersUnreadable).toBe(1);
    expect(response.discovery.message).toContain('1 calibration candidate');
  });

  it('reports zero unreadable for a genuinely empty farm', async () => {
    // The distinction the count exists to make: nothing came back, and
    // nothing was lost reading it.
    respondWith([]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('noEligiblePrinters');
    expect(response.printersUnreadable).toBe(0);
  });

  it('reports plain ok and zero unreadable when every candidate was readable', async () => {
    // Offline, so no per-printer context request is made. The claim under test
    // is about candidate readability; a candidate whose *context* call is
    // served the candidate array by this single-route stub would be an
    // unreadable context, which is a different (and separately tested) thing.
    respondWith([candidateDto({ reachability: 'offline' })]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('ok');
    expect(response.printersUnreadable).toBe(0);
  });

  it('does not report an unqualified ok when a printer context is unreadable', async () => {
    // The candidate parses; its context does not. Those profiles are missing
    // from the list, so `ok` would describe a complete answer that is not one.
    // Previously this rejected the entire handler, discarding the local scan
    // with it.
    respondWith([candidateDto()]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('partiallyUnreadable');
    expect(response.discovery.message).toContain('printer context');
    // The local scan survives, which is the whole point of running it outside
    // the server path.
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
  });

  it('reports a truncated farm rather than plain ok', async () => {
    // Reachable and previously untested: every record readable, but more were
    // offered than were considered, so `ok` would describe a farm this handler
    // never saw the whole of. Offline candidates, so no context request is
    // made and the truncation branch is what is under test.
    respondWith(
      Array.from({ length: CALIBRATION_MAX_PRINTER_CANDIDATES + 5 }, (_u, i) =>
        candidateDto({
          id: `${i.toString(16).padStart(8, '0')}-1111-4111-8111-222222222222`,
          reachability: 'offline',
        }),
      ),
    );

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('farmTruncated');
    expect(response.printersTruncated).toBe(true);
    expect(response.printersUnreadable).toBe(0);
  });

  it('will not let the server set the unreadable count itself', async () => {
    // Client-derived by counting failures. A payload asserting its own count
    // must not be believed, or the number would be forgeable by the party it
    // is evidence against.
    respondWith({
      printers: [{ id: 'not-a-guid', name: '' }, candidateDto()],
      printersUnreadable: 0,
      unreadable: 0,
    });

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.printersUnreadable).toBe(1);
    expect(response.discovery.kind).toBe('partiallyUnreadable');
  });

  it('leaks no server-supplied value through the unreadable diagnostic', async () => {
    // The count crosses the boundary; the offending content must not, or
    // parsing candidates separately would have moved the leak rather than
    // closed it.
    respondWith([
      {
        id: 'not-a-guid',
        name: '<script>alert(1)</script>',
        secret: 'hunter2',
      },
      candidateDto(),
    ]);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('partiallyUnreadable');
    const serialised = JSON.stringify(response);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('<script>');
    expect(serialised).not.toContain('not-a-guid');
  });

  it('never puts a filesystem path in the response', async () => {
    respondWith({ status: 401 }, 401);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(JSON.stringify(response)).not.toContain(sandbox);
  });
});
