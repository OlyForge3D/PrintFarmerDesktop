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
import { IpcChannel } from '@shared/ipc';

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
  localProfiles: Array<{ name: string; source: string }>;
  localDiscovery: { kind: string; message: string };
}

let sandbox: string;
let previousAppData: string | undefined;
let previousProgramFiles: string | undefined;

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'pfd-listorca-'));

  // Redirect the canonical Windows roots into the sandbox so the scan reads a
  // known tree rather than whatever the machine running the suite has
  // installed. The Windows roots are the ones the reported failure occurred on.
  previousAppData = process.env['APPDATA'];
  previousProgramFiles = process.env['PROGRAMFILES'];
  process.env['APPDATA'] = path.join(sandbox, 'appdata');
  process.env['PROGRAMFILES'] = path.join(sandbox, 'programfiles');

  const dir = path.join(
    sandbox,
    'programfiles',
    'OrcaSlicer',
    'resources',
    'profiles',
    'Voron',
    'filament',
  );
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
  if (previousAppData === undefined) delete process.env['APPDATA'];
  else process.env['APPDATA'] = previousAppData;
  if (previousProgramFiles === undefined) delete process.env['PROGRAMFILES'];
  else process.env['PROGRAMFILES'] = previousProgramFiles;
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
    expect(response.localProfiles.map((p) => p.name)).toEqual([TARGET_PROFILE]);
    expect(response.localDiscovery.kind).toBe('ok');
  });

  it('still reports installed profiles when the calibration route is absent', async () => {
    respondWith({ status: 404 }, 404);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('routeUnavailable');
    expect(response.localProfiles.map((p) => p.name)).toEqual([TARGET_PROFILE]);
  });

  it('still reports installed profiles when the session is unauthenticated', async () => {
    respondWith({ status: 401 }, 401);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('unauthenticated');
    expect(response.localProfiles.map((p) => p.name)).toEqual([TARGET_PROFILE]);
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
    expect(response.localProfiles.map((p) => p.name)).toEqual([TARGET_PROFILE]);
  });

  it('reports a missing OrcaSlicer install distinctly from a missing profile', async () => {
    process.env['PROGRAMFILES'] = path.join(sandbox, 'no-such-programfiles');
    process.env['APPDATA'] = path.join(sandbox, 'no-such-appdata');
    respondWith({ status: 401 }, 401);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    expect(response.localProfiles).toEqual([]);
    expect(response.localDiscovery.kind).toBe('noInstallFound');
    // The server problem is still reported independently of the local one.
    expect(response.discovery.kind).toBe('unauthenticated');
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
