// @vitest-environment node

/**
 * Production-path coverage for selected-printer Orca profile resolution.
 *
 * Candidate listing is deliberately preliminary. It must not scan contexts or
 * resolve profiles across the farm; only an explicit selection may load one
 * authoritative context and then combine its exact profile with the local
 * OrcaSlicer scan.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CALIBRATION_MAX_PRINTER_CANDIDATES, IpcChannel } from '@shared/ipc';
import {
  CALIBRATION_FIXTURE_IDS,
  calibrationCandidateDto,
  calibrationContextDto,
} from './fixtures/calibrationContract.js';

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
const TARGET_PROFILE = 'Upstream PLA';

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

function handlers(): Map<string, Handler> {
  electronState.handlers.clear();
  registerIpcHandlers(
    undefined,
    fakeProfiles() as never,
    noopSidecar as never,
    noopSidecar as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    {
      canonicalizePickerFile: (value: string) => Promise.resolve(value),
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

function invoke(
  registered: Map<string, Handler>,
  channel: IpcChannel,
  request: unknown,
): Promise<unknown> {
  const handler = registered.get(channel);
  if (!handler) throw new Error(`${channel} was not registered`);
  return Promise.resolve(handler({}, request));
}

function server(
  candidates: readonly unknown[],
  context: unknown = calibrationContextDto(),
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push(url);
      const body = url.includes('calibration-candidates')
        ? candidates
        : context;
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  return { calls };
}

interface OrcaProfilesResponse {
  profiles: Array<{ orcaProfileName: string; source: string }>;
  discovery: { kind: string; message: string };
  printersUnreadable: number;
  printersTruncated: boolean;
  localProfiles: Array<{ name: string; source: string }>;
  localDiscovery: { kind: string; message: string };
}

let sandbox: string;
const savedEnv = new Map<string, string | undefined>();

function redirectOrcaUserRoot(): string {
  const remember = (key: string, value: string) => {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = value;
  };
  if (process.platform === 'win32') {
    const appData = path.join(sandbox, 'appdata');
    remember('APPDATA', appData);
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

beforeEach(async () => {
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'pfd-listorca-'));
  const dir = path.join(redirectOrcaUserRoot(), 'filament');
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
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  await rm(sandbox, { recursive: true, force: true });
});

async function selectAndResolve(
  registered: Map<string, Handler>,
): Promise<OrcaProfilesResponse> {
  await invoke(registered, IpcChannel.CalibrationListPrinters, {
    profileId: PROFILE_ID,
  });
  await invoke(registered, IpcChannel.CalibrationGetPrinterContext, {
    profileId: PROFILE_ID,
    printerId: CALIBRATION_FIXTURE_IDS.printerId,
    configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
  });
  return (await invoke(registered, IpcChannel.CalibrationListOrcaProfiles, {
    profileId: PROFILE_ID,
    printerId: CALIBRATION_FIXTURE_IDS.printerId,
    configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
  })) as OrcaProfilesResponse;
}

describe('CalibrationListOrcaProfiles selected-only resolution', () => {
  it('lists preliminarily, then reads one context and resolves one exact triple', async () => {
    const { calls } = server([calibrationCandidateDto()]);
    const response = await selectAndResolve(handlers());

    expect(
      calls.filter((url) => url.includes('calibration-candidates')),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes('calibration-context')),
    ).toHaveLength(1);
    expect(
      response.profiles.filter((profile) => profile.source === 'printFarmer'),
    ).toEqual([expect.objectContaining({ orcaProfileName: TARGET_PROFILE })]);
    expect(response.localProfiles.map((profile) => profile.name)).toContain(
      TARGET_PROFILE,
    );
    expect(response.discovery.kind).toBe('ok');
    expect(response.localDiscovery.kind).toBe('ok');
  });

  it('never guesses or fetches a context when no current selection evidence exists', async () => {
    const { calls } = server([calibrationCandidateDto()]);
    const response = (await invoke(
      handlers(),
      IpcChannel.CalibrationListOrcaProfiles,
      {
        profileId: PROFILE_ID,
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
      },
    )) as OrcaProfilesResponse;

    expect(response.profiles).toEqual([]);
    expect(response.discovery.kind).toBe('selectedPrinterNotACandidate');
    expect(response.localProfiles.map((profile) => profile.name)).toContain(
      TARGET_PROFILE,
    );
    expect(calls).toEqual([]);
  });

  it('retains client-derived malformed-candidate evidence without re-listing', async () => {
    const { calls } = server([
      calibrationCandidateDto(),
      { ...calibrationCandidateDto(), id: 'not-a-guid' },
    ]);
    const response = await selectAndResolve(handlers());

    expect(response.printersUnreadable).toBe(1);
    expect(response.discovery.kind).toBe('partiallyUnreadable');
    expect(response.discovery.message).toContain('1 calibration candidate');
    expect(
      calls.filter((url) => url.includes('calibration-candidates')),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes('calibration-context')),
    ).toHaveLength(1);
  });

  it('retains bounded truncation evidence through selected resolution', async () => {
    const candidates = [
      calibrationCandidateDto(),
      ...Array.from(
        { length: CALIBRATION_MAX_PRINTER_CANDIDATES + 4 },
        (_unused, index) =>
          calibrationCandidateDto({
            id: `${index.toString(16).padStart(8, '0')}-2222-4222-8222-333333333333`,
          }),
      ),
    ];
    const { calls } = server(candidates);
    const response = await selectAndResolve(handlers());

    expect(response.printersTruncated).toBe(true);
    expect(response.discovery.kind).toBe('farmTruncated');
    expect(
      calls.filter((url) => url.includes('calibration-candidates')),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes('calibration-context')),
    ).toHaveLength(1);
  });

  it('does not resolve profiles after the selected context fails to parse', async () => {
    const { calls } = server([calibrationCandidateDto()], {});
    const registered = handlers();
    await invoke(registered, IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    await expect(
      invoke(registered, IpcChannel.CalibrationGetPrinterContext, {
        profileId: PROFILE_ID,
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
      }),
    ).rejects.toBeDefined();

    const response = (await invoke(
      registered,
      IpcChannel.CalibrationListOrcaProfiles,
      {
        profileId: PROFILE_ID,
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
      },
    )) as OrcaProfilesResponse;
    expect(response.profiles).toEqual([]);
    expect(response.discovery.kind).toBe('selectedPrinterContextUnavailable');
    expect(
      calls.filter((url) => url.includes('calibration-context')),
    ).toHaveLength(1);
  });
});
