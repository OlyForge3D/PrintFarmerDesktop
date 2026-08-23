// @vitest-environment node

/**
 * Handler coverage for the `CalibrationListPrinters` `/details` enrichment
 * that sources `printerModelId` for each candidate.
 *
 * The wire `CalibrationCandidateDto`
 * (`OlyForge3D/PrintFarmer:src/infra/Calibration/CalibrationContracts.cs:205-296`)
 * does not carry the catalog `PrinterModel` Guid. Path C's cascade needs one to
 * call `GET /api/slicer/profiles/machine/for-model/{modelId}` and to filter
 * user-created machine/process profiles by exact model. Without the
 * enrichment, the renderer degrades to the catalog-wide `/extended` list.
 *
 * `PrinterDetailsDto` (`src/infra/Dtos/PrinterDetailsDto.cs:10-66`) exposes
 * `Guid? ModelId`, so the handler fetches `/api/printers/{id}/details` once
 * per candidate and merges the result. This file's tests prove:
 *
 * 1. A candidate whose `/details` fetch succeeds surfaces with a real Guid on
 *    `printerModelId` — the fallback disengages.
 * 2. Control: a candidate whose `/details` fetch returns 404 or 403 still
 *    surfaces in the list (the whole farm does not disappear) and its
 *    `printerModelId` is `null` — Dallas's permissive fallback re-engages by
 *    design. This is the exact opposite result of test 1, evaluated by the
 *    same predicate on the same handler.
 * 3. Precedence: when a future server build populates `printerModelId` on the
 *    candidate wire itself, the wire value wins over the `/details`
 *    enrichment. This documents the migration path so the enrichment can be
 *    switched off when the field is unconditionally present upstream.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { IpcChannel, type CalibrationListPrintersResponse } from '@shared/ipc';
import {
  CALIBRATION_FIXTURE_IDS,
  calibrationCandidateDto,
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

// A separate fixture id per printer so multiple candidates in one list can be
// told apart. The Guids match `PrinterDetailsDto.Id`
// (`src/infra/Dtos/PrinterDetailsDto.cs:11`).
const PRINTER_A = CALIBRATION_FIXTURE_IDS.printerId;
const PRINTER_B = CALIBRATION_FIXTURE_IDS.otherPrinterId;
const MODEL_A = '77777777-7777-4777-8777-000000000001';
const MODEL_B = '77777777-7777-4777-8777-000000000002';

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

/**
 * A verbatim `PrinterDetailsDto` fixture.
 *
 * Only `modelId` is exercised by the schema (`RemotePrinterDetailsDto` uses
 * `.passthrough()`) — every other field is shaped to match
 * `src/infra/Dtos/PrinterDetailsDto.cs:10-66` so a future change to that
 * schema is caught by the same fixture, not by a coincidence.
 */
function printerDetailsDto(overrides: {
  id: string;
  modelId: string | null;
}): Record<string, unknown> {
  return {
    id: overrides.id,
    name: 'A cell in the farm',
    slugName: 'a-cell',
    enabled: true,
    backend: 'Moonraker',
    reachability: 'online',
    isOnline: true,
    lastSeenAtUtc: CALIBRATION_FIXTURE_IDS.now,
    modelId: overrides.modelId,
    modelName: overrides.modelId === null ? null : 'Voron 2.4 350',
    firmwareFamily: 'Klipper',
    firmwareVersion: 'v0.12.0',
  };
}

/**
 * Programmable fake for `fetch` shared by the three tests.  Callers register a
 * response per URL substring; unmatched URLs fall back to a default response.
 * The `calls` array records every URL requested, which the tests assert on.
 */
function server(routes: {
  candidates: readonly unknown[];
  detailsByPrinterId: Record<
    string,
    { status: number; body: unknown } | undefined
  >;
}): { calls: string[] } {
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
      if (url.includes('/calibration-candidates')) {
        return Promise.resolve(
          new Response(JSON.stringify(routes.candidates), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      const detailsMatch = url.match(/\/api\/printers\/([^/]+)\/details/);
      if (detailsMatch) {
        const printerId = decodeURIComponent(detailsMatch[1]!);
        const configured = routes.detailsByPrinterId[printerId];
        if (!configured) {
          return Promise.resolve(new Response('{}', { status: 404 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify(configured.body), {
            status: configured.status,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      return Promise.resolve(new Response('{}', { status: 404 }));
    }),
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('CalibrationListPrinters — printerModelId enrichment', () => {
  it('populates printerModelId from GET /api/printers/{id}/details for each candidate', async () => {
    const { calls } = server({
      candidates: [
        calibrationCandidateDto({ id: PRINTER_A }),
        calibrationCandidateDto({ id: PRINTER_B }),
      ],
      detailsByPrinterId: {
        [PRINTER_A]: {
          status: 200,
          body: printerDetailsDto({ id: PRINTER_A, modelId: MODEL_A }),
        },
        [PRINTER_B]: {
          status: 200,
          body: printerDetailsDto({ id: PRINTER_B, modelId: MODEL_B }),
        },
      },
    });

    const response = (await invoke(
      handlers(),
      IpcChannel.CalibrationListPrinters,
      { profileId: PROFILE_ID },
    )) as CalibrationListPrintersResponse;

    expect(response.printers).toHaveLength(2);
    // The handler fetched details for every candidate — exactly one per,
    // never more, never fewer.
    expect(
      calls.filter((url) => url.includes(`/${PRINTER_A}/details`)),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes(`/${PRINTER_B}/details`)),
    ).toHaveLength(1);
    const byId = new Map(response.printers.map((p) => [p.printerId, p]));
    expect(byId.get(PRINTER_A)?.printerModelId).toBe(MODEL_A);
    expect(byId.get(PRINTER_B)?.printerModelId).toBe(MODEL_B);
  });

  // Control for the test above. Same handler, same request, same shape of
  // candidates — the *only* thing that changes is that the details endpoint
  // fails. If `printerModelId` were still populated here, the enrichment
  // would be running from a fixture-leaked value rather than the wire; if the
  // whole list vanished, the handler would be treating one enrichment
  // failure as fatal, which is the empty-farm failure this contract exists
  // to prevent. Both outcomes are opposite to the success test and prove the
  // enrichment is doing what it claims.
  it('CONTROL: a details fetch failure does not drop the printer; printerModelId is null', async () => {
    const { calls } = server({
      candidates: [
        calibrationCandidateDto({ id: PRINTER_A }),
        calibrationCandidateDto({ id: PRINTER_B }),
      ],
      detailsByPrinterId: {
        [PRINTER_A]: undefined, // 404 fallback
        [PRINTER_B]: {
          status: 403,
          body: { error: 'Calibration.Read not granted' },
        },
      },
    });

    const response = (await invoke(
      handlers(),
      IpcChannel.CalibrationListPrinters,
      { profileId: PROFILE_ID },
    )) as CalibrationListPrintersResponse;

    // Both printers still surface — losing them because their details
    // endpoint returned 404/403 would reintroduce the empty-list failure
    // the candidate contract already exists to prevent.
    expect(response.printers).toHaveLength(2);
    // Every printer was tried; the failures were tolerated per candidate.
    expect(
      calls.filter((url) => url.includes(`/${PRINTER_A}/details`)),
    ).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes(`/${PRINTER_B}/details`)),
    ).toHaveLength(1);
    const byId = new Map(response.printers.map((p) => [p.printerId, p]));
    // Both resolve to `null` — Dallas's permissive fallback distinguishes
    // "model unknown" (null → wider pool) from "model known but matches
    // nothing" (Guid → empty list). Never an empty string.
    expect(byId.get(PRINTER_A)?.printerModelId).toBeNull();
    expect(byId.get(PRINTER_B)?.printerModelId).toBeNull();
  });

  it('prefers a server-supplied wire printerModelId over the /details enrichment', async () => {
    // Documents the migration path: when a future server build populates
    // `printerModelId` on `CalibrationCandidateDto` itself, the enrichment
    // becomes redundant. Prefer the wire value so the extra round-trip can
    // be dropped later without changing observable behaviour. This test
    // engineers a disagreement between the two so precedence is provable:
    // wire says MODEL_A, enrichment says MODEL_B; wire must win.
    const { calls } = server({
      candidates: [
        calibrationCandidateDto({ id: PRINTER_A, printerModelId: MODEL_A }),
      ],
      detailsByPrinterId: {
        [PRINTER_A]: {
          status: 200,
          body: printerDetailsDto({ id: PRINTER_A, modelId: MODEL_B }),
        },
      },
    });

    const response = (await invoke(
      handlers(),
      IpcChannel.CalibrationListPrinters,
      { profileId: PROFILE_ID },
    )) as CalibrationListPrintersResponse;

    expect(response.printers).toHaveLength(1);
    expect(response.printers[0]?.printerModelId).toBe(MODEL_A);
    // The details endpoint is still fetched — the handler does not yet know
    // whether the wire will supply the field, so it always tries. This
    // documents current behaviour without asserting it must stay that way.
    expect(
      calls.filter((url) => url.includes(`/${PRINTER_A}/details`)),
    ).toHaveLength(1);
  });
});
