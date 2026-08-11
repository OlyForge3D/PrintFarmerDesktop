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
/**
 * The printer the operator selected. Required by the handler now: profile
 * resolution is scoped to one printer, so there is no way to ask for the farm.
 */
const SELECTED_PRINTER = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

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
  printerId: string;
  configurationRevision: number | null;
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
      { profileId: PROFILE_ID, printerId: SELECTED_PRINTER },
    )) as OrcaProfilesResponse;

    // Server-bound profiles are legitimately empty; the local ones are not.
    expect(response.profiles).toEqual([]);
    expect(response.discovery.kind).toBe('profileResolverUnavailable');
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
    expect(response.localDiscovery.kind).toBe('ok');
  });

  it('still reports installed profiles when the calibration route is absent', async () => {
    respondWith({ status: 404 }, 404);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID, printerId: SELECTED_PRINTER },
    )) as OrcaProfilesResponse;

    expect(response.discovery.kind).toBe('routeUnavailable');
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
  });

  it('still reports installed profiles when the session is unauthenticated', async () => {
    respondWith({ status: 401 }, 401);

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID, printerId: SELECTED_PRINTER },
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
      { profileId: PROFILE_ID, printerId: SELECTED_PRINTER },
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
    // The healthy candidate's context request is served the candidate array by
    // this single-route stub, so its context is unreadable too. That second
    // loss must survive alongside the first: an earlier shape gated the
    // context clause on the diagnosis still being `ok`, so one malformed
    // candidate silently erased it.
    expect(response.discovery.message).toContain('1 printer context');
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

  it('survives one candidate cancelled by the deadline, keeping siblings and the local scan', async () => {
    // The headline fix of the last commit, previously untested. `cancelled` is
    // what the transport produces when this handler's own
    // `AbortSignal.timeout(15_000)` fires — there is no caller signal on this
    // path — so rethrowing it rejected the `Promise.all` and discarded the
    // whole response, local OrcaSlicer scan included. Driven through the real
    // transport so the error is a genuine typed CalibrationHttpError with code
    // `cancelled`, not a hand-built stand-in.
    const healthyA = 'aaaaaaaa-1111-4111-8111-222222222222';
    const cancelledOne = 'bbbbbbbb-1111-4111-8111-222222222222';
    const healthyB = 'cccccccc-1111-4111-8111-222222222222';

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;

        if (url.includes('calibration-candidates')) {
          return Promise.resolve(
            new Response(
              JSON.stringify([
                candidateDto({ id: healthyA }),
                candidateDto({ id: cancelledOne }),
                candidateDto({ id: healthyB }),
              ]),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }

        // Exactly one printer's context aborts. `mapError` turns an AbortError
        // into the typed `cancelled` code, which is the branch under test.
        if (url.includes(cancelledOne)) {
          return Promise.reject(
            new DOMException('The operation was aborted.', 'AbortError'),
          );
        }

        // The other two answer, but with a context this client cannot bind, so
        // the assertion below is about survival rather than about profiles.
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    // It resolved at all: rethrowing `cancelled` made this reject outright.
    expect(response.discovery.kind).toBe('partiallyUnreadable');
    // Exactly one printer failed, so exactly one is reported — the two whose
    // contexts merely 404'd are a legitimate answer, not a fault.
    expect(response.discovery.message).toContain('1 printer context');
    // The local scan survives, which is the whole reason it runs outside the
    // server path.
    expect(response.localProfiles.map((p) => p.name)).toContain(TARGET_PROFILE);
    // And the candidate-level counts are untouched by a context failure.
    expect(response.printersUnreadable).toBe(0);
    expect(response.printersTruncated).toBe(false);
  });

  it('reports a profile it refused, rather than presenting the list as complete', async () => {
    // A profile existed and this client would not render it. Returning a bare
    // null made that indistinguishable from "this printer has no profile", so
    // the response claimed `ok` while a real profile was missing — the same
    // silent loss, reached through the profile instead of the candidate.
    //
    // The fixture is the real *wire* DTO, not the normalised internal shape:
    // an earlier version of this test used the latter, so the context failed
    // `PrinterContextSchema.parse` outright and the assertion passed through
    // the generic `invalidResponse` catch without ever reaching the `refused`
    // branch it was written for. Every field below is required to get there —
    // `id`, `snapshot.printerId`, the slicer identity, a single toolhead, and
    // a filament profile that is legal on the wire.
    const TOOLHEAD_GUID = 'dddddddd-1111-4111-8111-222222222222';
    const FILAMENT_GUID = 'eeeeeeee-1111-4111-8111-222222222222';
    const refusedContext = {
      ...candidateDto(),
      schemaVersion: '1.0',
      snapshotSha256: 'a'.repeat(64),
      capturedAtUtc: '2026-08-11T12:00:00Z',
      capturedBySubject: 'subject-1',
      configurationRevision: 7,
      snapshot: {
        printerId: 'aaaaaaaa-1111-4111-8111-222222222222',
        configurationRevision: 7,
        snapshotSha256: 'a'.repeat(64),
        toolheads: [{ id: TOOLHEAD_GUID, index: 0, nozzleDiameter: 0.4 }],
        profiles: {
          filament: {
            id: FILAMENT_GUID,
            name: 'Generic PLA @0.4 nozzle',
            // Legal on the wire (`.max(256)`, no `.min`), refused by
            // `OrcaProfileEntry.profileRevision`, which is `.min(1)`.
            profileRevision: '',
          },
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        const body = url.includes('calibration-candidates')
          ? [candidateDto()]
          : refusedContext;
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );

    const response = (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;

    // It must not claim the list is complete...
    expect(response.discovery.kind).toBe('partiallyUnreadable');
    expect(response.discovery.kind).not.toBe('ok');
    // ...and exactly one printer must be named, not zero and not the whole
    // farm, so a reverted fold fails loudly rather than quietly.
    // Named as a profile this app could not read — NOT as a context read
    // failure. The context arrived and parsed; the refusal was local. Saying
    // otherwise sends the operator after a server problem that is not there,
    // and this assertion is also what distinguishes the `refused` path from
    // the generic `invalidResponse` catch, whose message names the context.
    expect(response.discovery.message).toContain(
      '1 calibration profile could not be read by this app',
    );
    expect(response.discovery.message).not.toContain('printer context');
    // The refused profile is genuinely absent, which is what makes the
    // qualification necessary rather than decorative.
    expect(response.profiles).toEqual([]);
    // Candidate parsing was clean; the loss happened at the profile.
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
      { profileId: PROFILE_ID, printerId: SELECTED_PRINTER },
    )) as OrcaProfilesResponse;

    expect(JSON.stringify(response)).not.toContain(sandbox);
  });
});

describe('every layer that lost something is named, none overwritten', () => {
  // The defect this suite exists to prevent: the composition used to be gated
  // on the diagnosis still being `ok` or `farmTruncated`, so a single
  // malformed candidate — which already set `partiallyUnreadable` — discarded
  // the context and profile counts entirely, and the surviving sentence
  // claimed "the printers listed are the ones that could". Losses at
  // different layers are independent facts about one answer.

  const CTX_FAIL = 'bbbbbbbb-1111-4111-8111-222222222222';
  const REFUSED = 'cccccccc-1111-4111-8111-222222222222';

  /** A context that parses cleanly but carries a profile this app refuses. */
  function refusedContextFor(printerId: string) {
    return {
      ...candidateDto({ id: printerId }),
      schemaVersion: '1.0',
      snapshotSha256: 'a'.repeat(64),
      capturedAtUtc: '2026-08-11T12:00:00Z',
      capturedBySubject: 'subject-1',
      configurationRevision: 7,
      snapshot: {
        printerId,
        configurationRevision: 7,
        snapshotSha256: 'a'.repeat(64),
        toolheads: [
          {
            id: 'dddddddd-1111-4111-8111-222222222222',
            index: 0,
            nozzleDiameter: 0.4,
          },
        ],
        profiles: {
          filament: {
            id: 'eeeeeeee-1111-4111-8111-222222222222',
            name: 'Generic PLA @0.4 nozzle',
            profileRevision: '',
          },
        },
      },
    };
  }

  /** Routes the candidate list and each printer's context independently. */
  function routeFetch(candidates: unknown[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL) => {
        const url =
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (url.includes('calibration-candidates')) {
          return Promise.resolve(
            new Response(JSON.stringify(candidates), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (url.includes(CTX_FAIL)) {
          return Promise.resolve(
            new Response(JSON.stringify({ title: 'boom' }), {
              status: 500,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        if (url.includes(REFUSED)) {
          return Promise.resolve(
            new Response(JSON.stringify(refusedContextFor(REFUSED)), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        }
        return Promise.resolve(
          new Response(JSON.stringify({}), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }),
    );
  }

  async function discover() {
    return (await listOrcaProfilesHandler()(
      {},
      { profileId: PROFILE_ID },
    )) as OrcaProfilesResponse;
  }

  it('names all three causes at once, with the wire diagnosis retained', async () => {
    routeFetch([
      { id: 'not-a-guid', name: '' },
      candidateDto({ id: CTX_FAIL }),
      candidateDto({ id: REFUSED }),
    ]);

    const response = await discover();

    expect(response.discovery.kind).toBe('partiallyUnreadable');
    expect(response.discovery.message).toContain('1 calibration candidate');
    expect(response.discovery.message).toContain('1 printer context');
    expect(response.discovery.message).toContain('1 calibration profile');
    // Three clauses: serial comma, single "and" before the last.
    expect(response.discovery.message).toMatch(
      /^1 calibration candidate .*, 1 printer context .*, and 1 calibration profile .*, so this list is missing printers\.$/,
    );
    // The wire-level count is still structured evidence, not just prose.
    expect(response.printersUnreadable).toBe(1);
    // And the claim that survived before — that the rest of the list is
    // complete — is gone, because this handler cannot know it.
    expect(response.discovery.message).not.toContain('the ones that could');
  });

  it('adds truncation as a fourth clause without displacing the others', async () => {
    const farm: unknown[] = [
      { id: 'not-a-guid', name: '' },
      candidateDto({ id: CTX_FAIL }),
      candidateDto({ id: REFUSED }),
    ];
    while (farm.length < CALIBRATION_MAX_PRINTER_CANDIDATES + 3) {
      farm.push(
        candidateDto({
          id: `${farm.length.toString(16).padStart(8, '0')}-1111-4111-8111-999999999999`,
          reachability: 'offline',
        }),
      );
    }
    routeFetch(farm);

    const response = await discover();

    expect(response.printersTruncated).toBe(true);
    expect(response.discovery.message).toContain('1 calibration candidate');
    expect(response.discovery.message).toContain('1 printer context');
    expect(response.discovery.message).toContain('1 calibration profile');
    expect(response.discovery.message).toContain('only the first');
  });

  it('uses two-clause grammar without a serial comma', async () => {
    routeFetch([candidateDto({ id: CTX_FAIL }), candidateDto({ id: REFUSED })]);

    const response = await discover();

    expect(response.discovery.message).toMatch(
      /^1 printer context could not be read and 1 calibration profile could not be read by this app, so this list is missing printers\.$/,
    );
  });

  it('uses one-clause grammar with no conjunction at all', async () => {
    routeFetch([candidateDto({ id: REFUSED })]);

    const response = await discover();

    expect(response.discovery.message).toMatch(
      /^1 calibration profile could not be read by this app, so this list is missing printers\.$/,
    );
    expect(response.discovery.message).not.toContain(' and ');
  });

  it('agrees in number when a cause counts more than one', async () => {
    routeFetch([
      { id: 'not-a-guid', name: '' },
      { id: 'also-not-a-guid', name: '' },
      candidateDto({ id: REFUSED }),
    ]);

    const response = await discover();

    expect(response.discovery.message).toContain('2 calibration candidates');
    expect(response.discovery.message).not.toContain(
      '2 calibration candidate ',
    );
  });

  it('names nothing when nothing was lost (absence control)', async () => {
    // Offline printers request no context, so there is no fault of any kind.
    routeFetch([
      candidateDto({
        id: 'ffffffff-1111-4111-8111-222222222222',
        reachability: 'offline',
      }),
    ]);

    const response = await discover();

    expect(response.discovery.kind).toBe('ok');
    expect(response.discovery.message).not.toContain('could not be read');
    expect(response.printersUnreadable).toBe(0);
    expect(response.printersTruncated).toBe(false);
  });

  it('does not double-count a printer that failed once', async () => {
    routeFetch([candidateDto({ id: CTX_FAIL })]);

    const response = await discover();

    expect(response.discovery.message).toContain('1 printer context');
    expect(response.discovery.message).not.toContain('2 printer');
    expect(response.discovery.message).not.toContain('calibration profile');
  });
});
