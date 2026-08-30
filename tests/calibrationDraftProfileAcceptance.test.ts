/**
 * Draft-profile write-back / completion-promotion acceptance criteria
 * (issue #795, scoped from parent #790).
 *
 * Drives the real `CalibrationSubmitCalibrationObservation` and
 * `CalibrationCompleteCalibrationProject` handlers through the real
 * `CalibrationHttpClient` and wire schemas, with only `globalThis.fetch`
 * stubbed — same harness shape as
 * `tests/calibration.queue-change-feed-gap.test.ts`.
 *
 * Two cases, paired per the acceptance criteria:
 *   - Abandon: submitting observations without ever completing the project
 *     never calls the completion/promotion route at all, so no NEW
 *     (promoted) profile is created. This does NOT by itself mean the
 *     user's custom filament profile list is empty — the pre-existing
 *     clone created at wizard step 1 is a separate, disclosed, unresolved
 *     limitation (see the doc comment on
 *     `CalibrationCompleteCalibrationProjectResponse` in `src/shared/ipc.ts`
 *     and OlyForge3D/PrintFarmer#2203) that this issue does not eliminate.
 *     What IS proven here is the narrower, still-real claim: abandoning
 *     never triggers a second, promoted orphan on top of the clone.
 *   - Control: completing the project calls
 *     `PATCH /api/calibration-projects/{projectId}` with
 *     `lifecycleStatus: "Completed"`, and the handler reports the
 *     server-promoted profile id back to the caller ("completed one does
 *     appear").
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  dialog: {
    showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.from(''),
    decryptString: () => '',
  },
  shell: { openExternal: () => Promise.resolve() },
}));

const { registerIpcHandlers } = await import('../src/main/ipc.js');

const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const BASE_URL = 'https://draft-profile.internal.example';
const PROJECT_ID = '22222222-2222-4222-8222-222222222222';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const OBSERVATION_ID = '44444444-4444-4444-8444-444444444444';
const PROMOTED_PROFILE_ID = '55555555-5555-4555-8555-555555555555';

interface RouteLog {
  method: string;
  path: string;
}

/**
 * Registers the real handlers and stubs `fetch` to serve every route the
 * draft-profile write-back / completion flow touches, recording every call
 * so a test can assert exactly which routes were (or were not) hit.
 */
function setUp(): { calls: RouteLog[] } {
  electronState.handlers.clear();
  const calls: RouteLog[] = [];
  let projectRevision = 1;
  let projectLifecycleStatus = 'Active';
  let promotedProfileId: string | null = null;

  vi.stubGlobal(
    'fetch',
    (input: URL | Request | string, init?: RequestInit) => {
      const href =
        input instanceof URL
          ? input.href
          : input instanceof Request
            ? input.url
            : input;
      const url = new URL(href);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: url.pathname });

      const json = (body: unknown, status = 200) =>
        Promise.resolve(
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
        );

      if (
        method === 'POST' &&
        url.pathname === `/api/calibration-projects/${PROJECT_ID}/attempts`
      ) {
        return json(
          {
            id: ATTEMPT_ID,
            projectId: PROJECT_ID,
            sequence: 0,
            parentAttemptId: null,
            calibrationKind: 'temperature',
            method: 'temperature_tower',
            definitionVersion: '1',
            input: {},
            specification: {},
            specificationSha256: 'a'.repeat(64),
            profileSnapshotIds: {},
            actualSpoolSnapshot: null,
            disposition: 'Pending',
            createdAtUtc: '2026-01-01T00:00:00.000Z',
          },
          201,
        );
      }
      if (
        method === 'POST' &&
        url.pathname === `/api/calibration-attempts/${ATTEMPT_ID}/observations`
      ) {
        return json(
          {
            id: OBSERVATION_ID,
            attemptId: ATTEMPT_ID,
            sequence: 0,
            observationType: 'selection',
            measurements: { temperature_c: 215 },
            result: {},
            units: {},
            confidence: null,
            retestRecommended: false,
            notes: null,
            selectionParentObservationId: null,
            selectionReason: null,
            observedAtUtc: '2026-01-01T00:00:00.000Z',
          },
          201,
        );
      }
      if (
        method === 'GET' &&
        url.pathname === `/api/calibration-projects/${PROJECT_ID}`
      ) {
        return json({
          id: PROJECT_ID,
          name: 'PolyLite PLA Blue (calibration project)',
          lifecycleStatus: projectLifecycleStatus,
          experienceMode: 'Coach',
          printerId: '66666666-6666-4666-8666-666666666666',
          selectedToolheadId: null,
          selectedToolheadIndex: null,
          filament: {
            provider: 'printfarmer',
            productId: '77777777-7777-4777-8777-777777777777',
            sku: null,
            vendor: null,
            productName: 'PolyLite PLA Blue',
            material: 'unknown',
            diameter: null,
            color: null,
            filamentTypeId: null,
            spoolmanFilamentId: null,
            localSpoolId: null,
            spoolmanSpoolId: null,
            snapshot: {},
          },
          orderedSteps: [],
          currentStep: null,
          currentSelections: {},
          revision: projectRevision,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
          completedAtUtc: null,
          deletedAtUtc: null,
        });
      }
      if (
        method === 'PATCH' &&
        url.pathname === `/api/calibration-projects/${PROJECT_ID}`
      ) {
        // Completing the project is what triggers server-side promotion —
        // simulate that side effect so the subsequent draft-profile
        // read-back reflects it.
        projectLifecycleStatus = 'Completed';
        projectRevision += 1;
        promotedProfileId = PROMOTED_PROFILE_ID;
        return json({
          id: PROJECT_ID,
          name: 'PolyLite PLA Blue (calibration project)',
          lifecycleStatus: projectLifecycleStatus,
          experienceMode: 'Coach',
          printerId: '66666666-6666-4666-8666-666666666666',
          selectedToolheadId: null,
          selectedToolheadIndex: null,
          filament: {
            provider: 'printfarmer',
            productId: '77777777-7777-4777-8777-777777777777',
            sku: null,
            vendor: null,
            productName: 'PolyLite PLA Blue',
            material: 'unknown',
            diameter: null,
            color: null,
            filamentTypeId: null,
            spoolmanFilamentId: null,
            localSpoolId: null,
            spoolmanSpoolId: null,
            snapshot: {},
          },
          orderedSteps: [],
          currentStep: null,
          currentSelections: {},
          revision: projectRevision,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
          completedAtUtc: '2026-01-02T00:00:00.000Z',
          deletedAtUtc: null,
        });
      }
      if (
        method === 'GET' &&
        url.pathname === `/api/calibration-projects/${PROJECT_ID}/draft-profile`
      ) {
        return json({
          id: '88888888-8888-4888-8888-888888888888',
          projectId: PROJECT_ID,
          values: { temperature_c: 215 },
          revision: 1,
          promotedProfileId,
          promotedAtUtc:
            promotedProfileId !== null ? '2026-01-02T00:00:00.000Z' : null,
          createdAtUtc: '2026-01-01T00:00:00.000Z',
          updatedAtUtc: '2026-01-01T00:00:00.000Z',
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url.pathname}`);
    },
  );

  const profiles = {
    list: () =>
      Promise.resolve({
        profiles: [{ id: PROFILE_ID, name: 'selected', baseUrl: BASE_URL }],
        selectedProfileId: PROFILE_ID,
      }),
    getAuthenticatedContext: (id: string) =>
      Promise.resolve({
        profile: { id, baseUrl: BASE_URL },
        token: 'token',
        revision: 1,
        generation: 1,
        serverBinding: 'binding',
        endpoint: (p: string) => `${BASE_URL}${p}`,
      }),
    getAuthenticatedServerContext: () =>
      Promise.resolve({
        baseUrl: BASE_URL,
        token: 'token',
        binding: 'binding',
      }),
  };

  const inert = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        return () => Promise.resolve({});
      },
    },
  );

  registerIpcHandlers(
    undefined,
    profiles as never,
    inert as never,
    inert as never,
    { initialize: () => Promise.resolve(), dispose: () => undefined } as never,
    {
      authorizeFile: () => Promise.reject(new Error('not used')),
      canonicalizePickerFile: (p: string) => Promise.resolve(p),
      resolve: () => Promise.reject(new Error('not used')),
      reset: () => Promise.resolve(),
    } as never,
    {
      initialize: () => Promise.resolve(),
      dispose: () => undefined,
      purge: () => Promise.resolve(),
      loadScene: () => Promise.resolve({}),
      adoptRecipe: () => Promise.resolve(),
    } as never,
  );

  return { calls };
}

function getHandler(channel: string): Handler {
  const handler = electronState.handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} handler was not registered`);
  }
  return handler;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('draft-profile write-back and completion promotion (#795)', () => {
  it('abandon: submitting observations without completing never calls the completion route, so nothing is promoted', async () => {
    const { calls } = setUp();
    const submit = getHandler(
      IpcChannel.CalibrationSubmitCalibrationObservation,
    );

    const response = await submit(
      {},
      {
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        requestId: '99999999-9999-4999-8999-999999999999',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        measurement: {
          method: 'temperature_tower',
          nozzleTemperature: 215,
          nozzleTemperatureInitialLayer: 220,
        },
      },
    );

    expect(response).toMatchObject({
      status: 'ok',
      attemptId: ATTEMPT_ID,
      observationId: OBSERVATION_ID,
    });
    // Only the attempt-create and observation-append routes were hit — no
    // PATCH to the project (the only route that can trigger promotion) and
    // no draft-profile read, so nothing was ever promoted.
    expect(calls).toEqual([
      {
        method: 'POST',
        path: `/api/calibration-projects/${PROJECT_ID}/attempts`,
      },
      {
        method: 'POST',
        path: `/api/calibration-attempts/${ATTEMPT_ID}/observations`,
      },
    ]);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('control: completing the project after observations reports a promoted profile id', async () => {
    const { calls } = setUp();
    const submit = getHandler(
      IpcChannel.CalibrationSubmitCalibrationObservation,
    );
    const complete = getHandler(
      IpcChannel.CalibrationCompleteCalibrationProject,
    );

    await submit(
      {},
      {
        profileId: PROFILE_ID,
        projectId: PROJECT_ID,
        requestId: '99999999-9999-4999-8999-999999999999',
        operationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        measurement: {
          method: 'temperature_tower',
          nozzleTemperature: 215,
          nozzleTemperatureInitialLayer: 220,
        },
      },
    );

    const response = await complete(
      {},
      { profileId: PROFILE_ID, projectId: PROJECT_ID },
    );

    expect(response).toMatchObject({
      status: 'ok',
      lifecycleStatus: 'Completed',
      promotedProfileId: PROMOTED_PROFILE_ID,
    });
    expect(
      calls.some(
        (c) =>
          c.method === 'PATCH' &&
          c.path === `/api/calibration-projects/${PROJECT_ID}`,
      ),
    ).toBe(true);
  });

  it('completing an already-completed project is idempotent and still reports the promoted profile id', async () => {
    setUp();
    const complete = getHandler(
      IpcChannel.CalibrationCompleteCalibrationProject,
    );

    const first = await complete(
      {},
      { profileId: PROFILE_ID, projectId: PROJECT_ID },
    );
    const second = await complete(
      {},
      { profileId: PROFILE_ID, projectId: PROJECT_ID },
    );

    expect(first).toMatchObject({ status: 'ok', lifecycleStatus: 'Completed' });
    expect(second).toMatchObject({
      status: 'ok',
      lifecycleStatus: 'Completed',
      promotedProfileId: PROMOTED_PROFILE_ID,
    });
  });
});
