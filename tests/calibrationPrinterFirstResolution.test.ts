// @vitest-environment node

/**
 * Production-path coverage for printer-first profile resolution.
 *
 * Drives the *registered* `CalibrationListOrcaProfiles` handler — the exact code
 * the wizard calls — through the real `CalibrationHttpClient`, the real wire
 * schemas and the real local scanner, with only `fetch`, the profile service and
 * the OrcaSlicer roots replaced. The handler is not mocked, because the defect
 * being guarded lives in its wiring: a schema-level test cannot see that a
 * handler fetched a context for every printer on the farm.
 *
 * The central claim is a *count*. Resolution for one selected printer must cost
 * one candidate listing and one context read, whether the farm holds one printer
 * or fifty. Asserting only on the returned profiles would pass just as happily
 * against the fan-out this replaced.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { IpcChannel } from '@shared/ipc';
import {
  CALIBRATION_FIXTURE_IDS,
  calibrationCandidateDto,
  calibrationContextDto,
} from './fixtures/calibrationContract.js';

type Handler = (event: unknown, request: unknown) => unknown;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));
const localDiscoveryRace = vi.hoisted(() => ({
  gate: null as Promise<void> | null,
  started: null as (() => void) | null,
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

vi.mock('../src/main/orcaProfileDiscovery.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/main/orcaProfileDiscovery.js')
  >('../src/main/orcaProfileDiscovery.js');
  return {
    ...actual,
    discoverLocalOrcaFilamentProfiles: async (
      context: Parameters<typeof actual.discoverLocalOrcaFilamentProfiles>[0],
    ) => {
      const result = await actual.discoverLocalOrcaFilamentProfiles(context);
      localDiscoveryRace.started?.();
      if (localDiscoveryRace.gate !== null) {
        await localDiscoveryRace.gate;
      }
      return result;
    },
  };
});

const { registerIpcHandlers } = await import('../src/main/ipc.js');

const PROFILE_ID = CALIBRATION_FIXTURE_IDS.profileId;
const BASE_URL = 'http://farm.local';
/** Matches `snapshot.profiles.filament.name` in the context fixture. */
const TARGET_PROFILE = 'Upstream PLA @0.4 nozzle';

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

function invoke(channel: string, request: unknown): Promise<unknown> {
  const handler = electronState.handlers.get(channel);
  if (!handler) throw new Error(`handler not registered: ${channel}`);
  return Promise.resolve(handler(undefined, request));
}

interface ProfilesResponse {
  profiles: Array<Record<string, unknown>>;
  printerId: string;
  configurationRevision: number | null;
  discovery: { kind: string; message: string };
  localProfiles: Array<{ name: string }>;
  localDiscovery: { kind: string; message: string };
}

/** A farm of `size` candidates, the first of which is the fixture printer. */
function farmOf(size: number): Record<string, unknown>[] {
  return [
    calibrationCandidateDto(),
    ...Array.from({ length: size - 1 }, (_, index) =>
      calibrationCandidateDto({
        id: `bbbbbbbb-1111-4111-8111-${String(index).padStart(12, '0')}`,
        name: `Filler printer ${index}`,
      }),
    ),
  ];
}

function exactProfileTriple(filamentName: string): Record<string, unknown> {
  return {
    machine: {
      id: CALIBRATION_FIXTURE_IDS.machineProfileId,
      kind: 'machine',
      name: 'Voron 2.4 0.4 nozzle',
      slicerType: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      slicerVersion: '2.4.2',
      profileFormat: 'orca-json',
      profileRevision: 'machine-r7',
      sha256: 'b'.repeat(64),
    },
    process: {
      id: CALIBRATION_FIXTURE_IDS.processProfileId,
      kind: 'process',
      name: '0.20 mm Standard',
      slicerType: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      slicerVersion: '2.4.2',
      profileFormat: 'orca-json',
      profileRevision: 'process-r7',
      sha256: 'c'.repeat(64),
    },
    filament: {
      id: CALIBRATION_FIXTURE_IDS.filamentProfileId,
      kind: 'filament',
      name: filamentName,
      slicerType: 'OrcaSlicer',
      slicerDistribution: 'upstream',
      slicerVersion: '2.4.2',
      profileFormat: 'orca-json',
      profileRevision: 'profile-r7',
      sha256: 'd'.repeat(64),
    },
  };
}

/** Routes by URL and records every request the client actually made. */
function server(
  options: {
    candidates?: unknown;
    candidateStatus?: number;
    context?: unknown;
    contextStatus?: number;
    contextResponse?: () => Promise<Response>;
  } = {},
): { calls: string[] } {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((url: URL | string) => {
      const href = typeof url === 'string' ? url : url.href;
      calls.push(href);
      if (href.includes('calibration-candidates')) {
        return Promise.resolve(
          new Response(
            JSON.stringify(options.candidates ?? [calibrationCandidateDto()]),
            {
              status: options.candidateStatus ?? 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      if (href.includes('calibration-context')) {
        if (options.contextResponse) return options.contextResponse();
        return Promise.resolve(
          new Response(
            JSON.stringify(options.context ?? calibrationContextDto()),
            {
              status: options.contextStatus ?? 200,
              headers: { 'content-type': 'application/json' },
            },
          ),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );
  // CalibrationHttpClient captures fetch at handler construction. Register only
  // after the stub is installed so 401/403 cases exercise the typed HTTP path
  // rather than an accidental transport failure.
  handlers();
  return { calls };
}

const countOf = (calls: readonly string[], fragment: string): number =>
  calls.filter((href) => href.includes(fragment)).length;

async function resolveSelectedPrinter(
  configurationRevision?: number,
): Promise<ProfilesResponse> {
  await invoke(IpcChannel.CalibrationListPrinters, {
    profileId: PROFILE_ID,
  });
  await invoke(IpcChannel.CalibrationGetPrinterContext, {
    profileId: PROFILE_ID,
    printerId: CALIBRATION_FIXTURE_IDS.printerId,
    ...(configurationRevision === undefined ? {} : { configurationRevision }),
  });
  return (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
    profileId: PROFILE_ID,
    printerId: CALIBRATION_FIXTURE_IDS.printerId,
    ...(configurationRevision === undefined ? {} : { configurationRevision }),
  })) as ProfilesResponse;
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
  localDiscoveryRace.gate = null;
  localDiscoveryRace.started = null;
  sandbox = await mkdtemp(path.join(os.tmpdir(), 'pfd-printer-first-'));
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

describe('profile resolution is scoped to the selected printer', () => {
  it('lists candidates without reading any printer context or profile resolver', async () => {
    const { calls } = server({ candidates: farmOf(25) });

    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: unknown[] };

    expect(response.printers).toHaveLength(25);
    expect(countOf(calls, 'calibration-candidates')).toBe(1);
    expect(countOf(calls, 'calibration-context')).toBe(0);
  });

  it('reads exactly one context regardless of how large the farm is', async () => {
    const { calls } = server({ candidates: farmOf(25) });

    const response = await resolveSelectedPrinter();
    await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    });

    // The claim. Twenty-five candidates, one context read — the previous
    // handler would have issued twenty-five here, plus a full local OrcaSlicer
    // scan each.
    expect(countOf(calls, 'calibration-context')).toBe(1);
    expect(countOf(calls, 'calibration-candidates')).toBe(1);
    // And the one it read is the one that was asked for.
    expect(
      calls.find((href) => href.includes('calibration-context')),
    ).toContain(CALIBRATION_FIXTURE_IDS.printerId);
    expect(response.printerId).toBe(CALIBRATION_FIXTURE_IDS.printerId);
  });

  it('keeps malformed-candidate evidence on the same cached epoch', async () => {
    const { calls } = server({
      candidates: [
        calibrationCandidateDto(),
        { ...calibrationCandidateDto(), id: 'not-a-guid' },
      ],
    });

    const listed = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printersUnreadable: number };
    await invoke(IpcChannel.CalibrationGetPrinterContext, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    });
    const resolved = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse & { printersUnreadable: number };

    expect(listed.printersUnreadable).toBe(1);
    expect(resolved.printersUnreadable).toBe(1);
    expect(countOf(calls, 'calibration-candidates')).toBe(1);
    expect(countOf(calls, 'calibration-context')).toBe(1);
  });

  it('does not grow its work as the farm grows', async () => {
    // A count that happened to be 1 for a one-printer farm would prove nothing.
    // Two farm sizes, same cost.
    const small = server({ candidates: farmOf(2) });
    await resolveSelectedPrinter();
    const smallReads = countOf(small.calls, 'calibration-context');
    vi.unstubAllGlobals();

    const large = server({ candidates: farmOf(50) });
    await resolveSelectedPrinter();
    expect(countOf(large.calls, 'calibration-context')).toBe(smallReads);
  });

  it('pins the context request to the configuration revision it was given', async () => {
    const { calls } = server();
    await resolveSelectedPrinter(CALIBRATION_FIXTURE_IDS.configurationRevision);
    const contextCall = calls.find((href) =>
      href.includes('calibration-context'),
    );
    expect(contextCall).toContain(
      `configurationRevision=${CALIBRATION_FIXTURE_IDS.configurationRevision}`,
    );
    // `slicerType` is mandatory server-side and must survive the addition.
    expect(contextCall).toContain('slicerType=OrcaSlicer');
  });

  it('refuses a renderer-supplied revision that differs from the selected candidate', async () => {
    const { calls } = server();
    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });

    await expect(
      invoke(IpcChannel.CalibrationGetPrinterContext, {
        profileId: PROFILE_ID,
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
        configurationRevision:
          CALIBRATION_FIXTURE_IDS.configurationRevision + 1,
      }),
    ).rejects.toMatchObject({
      code: 'CALIBRATION_PRINTER_SELECTION_REQUIRED',
    });
    expect(countOf(calls, 'calibration-context')).toBe(0);
  });

  it('echoes the printer and revision the answer is about', async () => {
    server();
    const response = await resolveSelectedPrinter();
    // The renderer fences on both. Without the echo a late reply for printer A
    // is indistinguishable from a reply for printer B.
    expect(response.printerId).toBe(CALIBRATION_FIXTURE_IDS.printerId);
    expect(response.configurationRevision).toBe(
      CALIBRATION_FIXTURE_IDS.configurationRevision,
    );
  });

  it('rejects an in-flight context when a newer candidate observation lands', async () => {
    let releaseContext: ((response: Response) => void) | undefined;
    let markContextStarted: (() => void) | undefined;
    const contextStarted = new Promise<void>((resolve) => {
      markContextStarted = resolve;
    });
    const deferredContext = new Promise<Response>((resolve) => {
      releaseContext = resolve;
    });
    const { calls } = server({
      contextResponse: () => {
        markContextStarted?.();
        return deferredContext;
      },
    });
    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    const pendingContext = invoke(IpcChannel.CalibrationGetPrinterContext, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    });
    await contextStarted;

    // A refresh creates a new candidate-list generation while the old context
    // request is still on the wire.
    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    releaseContext?.(
      new Response(JSON.stringify(calibrationContextDto()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    await expect(pendingContext).rejects.toMatchObject({
      code: 'CALIBRATION_PRINTER_SELECTION_CHANGED',
    });
    const profiles = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    })) as ProfilesResponse;
    expect(profiles.discovery.kind).toBe('selectedPrinterContextUnavailable');
    expect(countOf(calls, 'calibration-candidates')).toBe(2);
    expect(countOf(calls, 'calibration-context')).toBe(1);
  });

  it('discards profile resolution when candidates refresh during the local scan', async () => {
    const { calls } = server();
    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    await invoke(IpcChannel.CalibrationGetPrinterContext, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    });

    let releaseScan: (() => void) | undefined;
    localDiscoveryRace.gate = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const scanStarted = new Promise<void>((resolve) => {
      localDiscoveryRace.started = resolve;
    });
    const pendingProfiles = invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    });
    await scanStarted;

    await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    });
    releaseScan?.();
    const response = (await pendingProfiles) as ProfilesResponse;

    expect(response.profiles).toEqual([]);
    expect(response.discovery.kind).toBe('selectedPrinterContextUnavailable');
    expect(countOf(calls, 'calibration-candidates')).toBe(2);
    expect(countOf(calls, 'calibration-context')).toBe(1);
  });
});

describe('backend profile GUIDs and OrcaSlicer names stay distinct', () => {
  it('matches the local file on the profile name, never on the server GUID', async () => {
    server();
    const response = await resolveSelectedPrinter();

    const fromServer = response.profiles.find(
      (entry) => entry.source === 'printFarmer',
    );
    // The server entry keeps the immutable GUID as its identity and carries the
    // OrcaSlicer-facing name separately. Collapsing the two is what made local
    // discovery compare a GUID against a filename and never match.
    expect(fromServer?.orcaProfileId).toBe(
      CALIBRATION_FIXTURE_IDS.filamentProfileId,
    );
    expect(fromServer?.orcaProfileName).toBe('Upstream PLA');
  });

  it('binds a local file when the server names a profile this machine has', async () => {
    // Positive control for the miss cases below. Without it, "no local match"
    // would be satisfiable by a lookup that never matches anything at all.
    server({
      context: calibrationContextDto({
        snapshot: {
          profiles: exactProfileTriple(TARGET_PROFILE),
        },
      }),
    });
    const response = await resolveSelectedPrinter();

    const local = response.profiles.find(
      (entry) => entry.source !== 'printFarmer',
    );
    expect(local, 'the installed profile was not bound').toBeDefined();
    // Matched by name, and bound to this printer's snapshot and nozzle.
    expect(local?.orcaProfileName).toBe(TARGET_PROFILE);
    expect(local?.printerId).toBe(CALIBRATION_FIXTURE_IDS.printerId);
    expect(local?.nozzleDiameterMm).toBe(0.4);
    expect(response.localDiscovery.kind).toBe('ok');
  });

  it('never reports a local match for a profile name this machine does not have', async () => {
    server({
      context: calibrationContextDto({
        snapshot: {
          profiles: exactProfileTriple('A profile that is not installed here'),
        },
      }),
    });
    const response = await resolveSelectedPrinter();

    expect(
      response.profiles.some((entry) => entry.source !== 'printFarmer'),
    ).toBe(false);
    // Distinct from "OrcaSlicer is broken": the install is healthy, it simply
    // does not hold the profile this printer names.
    expect(response.localDiscovery.kind).toBe('noMatchForSelectedPrinter');
  });
});

describe('each failure remains scoped to its production step', () => {
  for (const [status, expected, expectedReads] of [
    [401, /authenticat/i, 2],
    [403, /forbidden|authoriz|denied/i, 1],
  ] as const) {
    it(`executes the typed ${status} candidate response path`, async () => {
      const { calls } = server({ candidateStatus: status, candidates: {} });
      await expect(
        invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID }),
      ).rejects.toThrow(expected);
      expect(countOf(calls, 'calibration-candidates')).toBe(expectedReads);
      expect(countOf(calls, 'calibration-context')).toBe(0);
    });
  }

  it('reports a selected printer absent from cached candidate evidence', async () => {
    server({
      candidates: [
        calibrationCandidateDto({
          id: CALIBRATION_FIXTURE_IDS.otherPrinterId,
        }),
      ],
    });
    await invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID });
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;
    expect(response.discovery.kind).toBe('selectedPrinterNotACandidate');
  });

  it('does not reinterpret a failed exact-context read as an empty farm', async () => {
    server({ contextStatus: 500, context: {} });
    await invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID });
    await expect(
      invoke(IpcChannel.CalibrationGetPrinterContext, {
        profileId: PROFILE_ID,
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
      }),
    ).rejects.toThrow();
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;
    expect(response.discovery.kind).toBe('selectedPrinterContextUnavailable');
  });

  it('does not read a context for a printer the server already refused', async () => {
    const { calls } = server({
      candidates: [
        calibrationCandidateDto({
          eligible: false,
          rejectionReasons: [{ code: 'printer_offline', message: 'offline' }],
        }),
      ],
    });
    await invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID });
    await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    });
    expect(countOf(calls, 'calibration-context')).toBe(0);
  });

  it('still reports the local install when the server refuses entirely', async () => {
    // A server refusal says nothing about the profiles on this machine, and
    // collapsing the two hid a healthy install behind a server outage.
    server({ candidateStatus: 401, candidates: {} });
    await expect(
      invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID }),
    ).rejects.toThrow(/authenticat/i);
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;
    expect(response.localProfiles.map((entry) => entry.name)).toContain(
      TARGET_PROFILE,
    );
    expect(response.localDiscovery.kind).toBe('ok');
  });

  it('never puts a filesystem path in the response', async () => {
    server({ candidateStatus: 401, candidates: {} });
    await expect(
      invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID }),
    ).rejects.toThrow(/authenticat/i);
    const response = await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    });
    expect(JSON.stringify(response)).not.toContain(sandbox);
  });

  it('caps the local profile names it returns', async () => {
    // The diagnostic exists to show that profiles were read, not to inventory
    // them. An install with 12,000 files must not put 2,000 names on the wire.
    const dir = path.join(redirectOrcaUserRoot(), 'filament');
    for (let index = 0; index < 40; index++) {
      await writeFile(
        path.join(dir, `Bulk profile ${index}.json`),
        JSON.stringify({
          type: 'filament',
          name: `Bulk profile ${index}`,
          filament_type: ['PLA'],
        }),
      );
    }
    server({ candidateStatus: 401, candidates: {} });
    await expect(
      invoke(IpcChannel.CalibrationListPrinters, { profileId: PROFILE_ID }),
    ).rejects.toThrow(/authenticat/i);
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;
    expect(response.localProfiles.length).toBeLessThanOrEqual(5);
  });
});

describe('candidate listing requires the exact preliminary contract', () => {
  it('isolates a candidate when the server omits profilesEvaluated', async () => {
    // Older PrintFarmer builds do not send the field. Silence means the server
    // said nothing, and reading nothing as "profiles were evaluated" would let
    // the cheap candidate screen stand in for the authoritative context.
    const candidate = calibrationCandidateDto();
    delete candidate.profilesEvaluated;
    server({ candidates: [candidate] });
    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: unknown[]; printersUnreadable: number };
    expect(response.printers).toEqual([]);
    expect(response.printersUnreadable).toBe(1);
  });

  it('reports preliminary when the server explicitly says profiles were not evaluated', async () => {
    // The expected steady state for a candidate listing.
    server({
      candidates: [calibrationCandidateDto({ profilesEvaluated: false })],
    });
    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: Array<{ evaluationScope: string }> };
    expect(response.printers[0]?.evaluationScope).toBe('preliminary');
  });

  it('isolates a candidate that incorrectly reports full evaluation', async () => {
    server({
      candidates: [calibrationCandidateDto({ profilesEvaluated: true })],
    });
    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: unknown[]; printersUnreadable: number };
    expect(response.printers).toEqual([]);
    expect(response.printersUnreadable).toBe(1);
  });

  it('still lists a printer whose eligibility is preliminary', async () => {
    // Preliminary is not a refusal. A basic pass is enough to show the printer
    // and let it be chosen; it is only insufficient as evidence for binding.
    server();
    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: Array<{ eligibility: unknown }> };
    expect(response.printers).toHaveLength(1);
    expect(response.printers[0]?.eligibility).not.toBeNull();
  });
});

describe('the request cannot express a farm-wide resolution', () => {
  it('refuses a request that names no printer', async () => {
    server();
    await expect(
      invoke(IpcChannel.CalibrationListOrcaProfiles, { profileId: PROFILE_ID }),
    ).rejects.toThrow();
  });

  it('refuses a request for a server profile that is not selected', async () => {
    server();
    await expect(
      invoke(IpcChannel.CalibrationListOrcaProfiles, {
        profileId: '99999999-9999-4999-8999-999999999999',
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
      }),
    ).rejects.toThrow(/selected profile/i);
  });

  it('fences the server profile before validating the rest of the payload', async () => {
    // The fence must not depend on the request schema succeeding. When a future
    // field is added, a cross-profile request has to keep failing *as a
    // cross-profile request*, not as a validation error that happens to throw.
    server();
    await expect(
      invoke(IpcChannel.CalibrationListOrcaProfiles, {
        profileId: '99999999-9999-4999-8999-999999999999',
      }),
    ).rejects.toThrow(/selected profile/i);
  });
});

describe('a scan that could not look is not a scan that found nothing', () => {
  it('reports an unreadable profile folder as a scan failure, not a missing install', async () => {
    // A directory the scanner cannot read is a permissions problem the operator
    // can fix. Reporting it as `noInstallFound` sent operators with a perfectly
    // good OrcaSlicer off to install OrcaSlicer.
    // A file where the scanner expects the profile root: readdir fails with
    // ENOTDIR on every platform, which is the same shape as a permission
    // denial on a directory that is really there.
    const userRoot = redirectOrcaUserRoot();
    await rm(userRoot, { recursive: true, force: true });
    await writeFile(userRoot, 'not a directory');

    server();
    const response = await resolveSelectedPrinter();

    expect(response.localDiscovery.kind).toBe('scanFailed');
    expect(response.localDiscovery.message).not.toContain(userRoot);
    // The server side of the answer is untouched: a local scan problem must not
    // erase the printer''s own profile.
    expect(
      response.profiles.some((entry) => entry.source === 'printFarmer'),
    ).toBe(true);
  });
});
