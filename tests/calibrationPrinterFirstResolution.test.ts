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
  const handler = handlers().get(channel);
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

/** Routes by URL and records every request the client actually made. */
function server(
  options: {
    candidates?: unknown;
    candidateStatus?: number;
    context?: unknown;
    contextStatus?: number;
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
  return { calls };
}

const countOf = (calls: readonly string[], fragment: string): number =>
  calls.filter((href) => href.includes(fragment)).length;

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
  it('reads exactly one context regardless of how large the farm is', async () => {
    const { calls } = server({ candidates: farmOf(25) });

    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;

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

  it('does not grow its work as the farm grows', async () => {
    // A count that happened to be 1 for a one-printer farm would prove nothing.
    // Two farm sizes, same cost.
    const small = server({ candidates: farmOf(2) });
    await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    });
    const smallReads = countOf(small.calls, 'calibration-context');
    vi.unstubAllGlobals();

    const large = server({ candidates: farmOf(50) });
    await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    });
    expect(countOf(large.calls, 'calibration-context')).toBe(smallReads);
  });

  it('pins the context request to the configuration revision it was given', async () => {
    const { calls } = server();
    await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
      configurationRevision: CALIBRATION_FIXTURE_IDS.configurationRevision,
    });
    const contextCall = calls.find((href) =>
      href.includes('calibration-context'),
    );
    expect(contextCall).toContain(
      `configurationRevision=${CALIBRATION_FIXTURE_IDS.configurationRevision}`,
    );
    // `slicerType` is mandatory server-side and must survive the addition.
    expect(contextCall).toContain('slicerType=OrcaSlicer');
  });

  it('echoes the printer and revision the answer is about', async () => {
    server();
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;
    // The renderer fences on both. Without the echo a late reply for printer A
    // is indistinguishable from a reply for printer B.
    expect(response.printerId).toBe(CALIBRATION_FIXTURE_IDS.printerId);
    expect(response.configurationRevision).toBe(
      CALIBRATION_FIXTURE_IDS.configurationRevision,
    );
  });
});

describe('backend profile GUIDs and OrcaSlicer names stay distinct', () => {
  it('matches the local file on the profile name, never on the server GUID', async () => {
    server();
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;

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
          profiles: {
            machine: null,
            process: null,
            filament: {
              id: CALIBRATION_FIXTURE_IDS.filamentProfileId,
              kind: 'filament',
              name: TARGET_PROFILE,
              slicerType: 'OrcaSlicer',
              slicerDistribution: 'upstream',
              slicerVersion: '2.4.2',
              profileFormat: 'orca-json',
              profileRevision: 'profile-r7',
              sha256: null,
            },
          },
        },
      }),
    });
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;

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
          profiles: {
            machine: null,
            process: null,
            filament: {
              id: CALIBRATION_FIXTURE_IDS.filamentProfileId,
              kind: 'filament',
              name: 'A profile that is not installed here',
              slicerType: 'OrcaSlicer',
              slicerDistribution: 'upstream',
              slicerVersion: '2.4.2',
              profileFormat: 'orca-json',
              profileRevision: 'profile-r7',
              sha256: null,
            },
          },
        },
      }),
    });
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;

    expect(
      response.profiles.some((entry) => entry.source !== 'printFarmer'),
    ).toBe(false);
    // Distinct from "OrcaSlicer is broken": the install is healthy, it simply
    // does not hold the profile this printer names.
    expect(response.localDiscovery.kind).toBe('noMatchForSelectedPrinter');
  });
});

describe('each failure names its own remedy', () => {
  const cases: ReadonlyArray<{
    label: string;
    options: Parameters<typeof server>[0];
    expected: string;
  }> = [
    {
      label: 'an unauthenticated session',
      options: { candidateStatus: 401, candidates: {} },
      expected: 'unauthenticated',
    },
    {
      label: 'a session without the calibration permission',
      options: { candidateStatus: 403, candidates: {} },
      expected: 'forbidden',
    },
    {
      label: 'a server build without the route',
      options: { candidateStatus: 404, candidates: {} },
      expected: 'routeUnavailable',
    },
    {
      label: 'a farm with no candidates at all',
      options: { candidates: [] },
      expected: 'noEligiblePrinters',
    },
    {
      label: 'a selected printer the server no longer lists',
      options: {
        candidates: [
          calibrationCandidateDto({
            id: CALIBRATION_FIXTURE_IDS.otherPrinterId,
          }),
        ],
      },
      expected: 'selectedPrinterNotACandidate',
    },
    {
      label: 'a printer the server refuses',
      options: {
        candidates: [
          calibrationCandidateDto({
            eligible: false,
            rejectionReasons: [{ code: 'printer_offline', message: 'offline' }],
          }),
        ],
      },
      expected: 'noProfilesForSelectedPrinter',
    },
    {
      label: 'a context read that fails',
      options: { contextStatus: 500, context: {} },
      expected: 'selectedPrinterContextUnavailable',
    },
    {
      label: 'a profile resolver outage',
      options: {
        contextStatus: 503,
        context: { status: 503, code: 'profile_service_unavailable' },
      },
      expected: 'profileResolverUnavailable',
    },
  ];

  for (const { label, options, expected } of cases) {
    it(`reports ${expected} for ${label}`, async () => {
      server(options);
      const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
        profileId: PROFILE_ID,
        printerId: CALIBRATION_FIXTURE_IDS.printerId,
      })) as ProfilesResponse;
      expect(response.discovery.kind).toBe(expected);
      // Whatever went wrong, the answer still says which printer it is about,
      // so the renderer can discard it if the operator has moved on.
      expect(response.printerId).toBe(CALIBRATION_FIXTURE_IDS.printerId);
    });
  }

  it('does not read a context for a printer the server already refused', async () => {
    const { calls } = server({
      candidates: [
        calibrationCandidateDto({
          eligible: false,
          rejectionReasons: [{ code: 'printer_offline', message: 'offline' }],
        }),
      ],
    });
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
    const response = (await invoke(IpcChannel.CalibrationListOrcaProfiles, {
      profileId: PROFILE_ID,
      printerId: CALIBRATION_FIXTURE_IDS.printerId,
    })) as ProfilesResponse;
    expect(response.localProfiles.length).toBeLessThanOrEqual(5);
  });
});

describe('candidate evaluation scope is additive and never inferred from silence', () => {
  it('reports preliminary when the server omits profilesEvaluated', async () => {
    // Older PrintFarmer builds do not send the field. Silence means the server
    // said nothing, and reading nothing as "profiles were evaluated" would let
    // the cheap candidate screen stand in for the authoritative context.
    server();
    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: Array<{ evaluationScope: string }> };
    expect(response.printers[0]?.evaluationScope).toBe('preliminary');
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

  it('reports full only when the server explicitly says so', async () => {
    server({
      candidates: [calibrationCandidateDto({ profilesEvaluated: true })],
    });
    const response = (await invoke(IpcChannel.CalibrationListPrinters, {
      profileId: PROFILE_ID,
    })) as { printers: Array<{ evaluationScope: string }> };
    expect(response.printers[0]?.evaluationScope).toBe('full');
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
