/**
 * The calibration IPC authorization matrix (issue #157).
 *
 * `tests/ipc.authz.test.ts` proves the filesystem-path channels authorize their
 * renderer input, and `calibration.integration.test.ts`,
 * `calibration.availability-negotiation.test.ts` and
 * `calibration.renderer-boundary.test.ts` each spot-check a calibration case.
 * What none of them do is *enumerate*: every one of them names the channels it
 * exercises, so a `calibration:*` channel added tomorrow joins the surface
 * without joining any of them, and the suite stays green because nothing was
 * ever asserted about it.
 *
 * This file is the enumeration. It derives the channel list from the shared
 * contract at run time and fails when a new profile-scoped channel appears
 * without a row here — which is the only part of this file that keeps working
 * without somebody remembering it.
 *
 * ## What the desktop actually enforces, measured rather than assumed
 *
 * #157 asks for denial behavior under six conditions. Three of them are
 * enforced in this process and are asserted per channel below:
 *
 *   - **no server profile selected** and **identity changed since the request
 *     was formed** — both are `requireSelectedCalibrationProfile`
 *     (`src/main/ipc.ts:336-350`), which refuses unless the `profileId` the
 *     renderer named is *currently* the selected one, with the typed code
 *     `CALIBRATION_PROFILE_MISMATCH`. One fence, both conditions: an unselected
 *     profile and a since-changed profile are the same comparison.
 *   - **renderer escalation by extra request fields** — every calibration
 *     request schema is `.strict()`, asserted here per channel rather than for
 *     the four channels that happen to have a test today.
 *
 * The other three are **not** gated per channel in the main process, and this
 * file says so with a test rather than with a comment. Measured on the handler
 * layer: `missingCalibrationFlags`, `supportsKlipper` and `supportsOrcaSlicer`
 * are each referenced exactly twice in `src/main/ipc.ts` — the import and the
 * single use inside `calibration:getAvailability`. No data channel consults
 * availability, and there is no `requireCalibrationAvailable`. Scope and
 * capability enforcement is the server's (`OlyForge3D/PrintFarmer`, tracked for
 * live confirmation in #138); `calibration:getAvailability` is advisory, it
 * tells the *UI* what to offer, and a renderer that never calls it reaches
 * every data channel exactly as before.
 *
 * That is a real property of this boundary and the honest deliverable for the
 * desktop half of #157. `it.each` over the matrix asserting a scope denial that
 * this process does not perform would be the failure this repo keeps filing:
 * an assertion that cannot fail, reported as coverage. The gap is pinned below
 * as a characterization test so that adding a real gate breaks it loudly and
 * whoever adds it is sent here.
 */
import { describe, expect, it, vi } from 'vitest';
import { IpcChannel, ipcSchemas } from '@shared/ipc';

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

/** The profile the user has actually selected. */
const SELECTED_PROFILE = '11111111-1111-4111-8111-111111111111';
/**
 * A profile the renderer names but the user has not selected. Every refusal
 * below is driven with this: it is the "identity changed since the request was
 * formed" condition and the "resource belongs to another account" condition at
 * once, because on this boundary they are the same request.
 */
const OTHER_PROFILE = '22222222-2222-4222-8222-222222222222';

/**
 * Planted in the fake profile store. Nothing a refusal produces may contain it.
 * A literal marker rather than a regex for "looks like a JWT": the assertion
 * has to fail when the credential leaks, and a pattern that never matches
 * anything is the vacuous check this repo keeps finding.
 */
const SECRET_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.TEST_CREDENTIAL_MUST_NOT_LEAK.sig';
const SECRET_BASE_URL = 'https://calibration.internal.example';

const uuid = (n: number) =>
  `${String(n).repeat(8)}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.slice(0, 36);
const SHA256 = 'a'.repeat(64);

interface Harness {
  handlers: Map<string, Handler>;
  /** Everything the handler layer reached *after* the fence. */
  downstream: string[];
}

/**
 * Registers the real handlers against a profile service whose selection we
 * control. `getAuthenticatedContext` is the first thing every remote
 * calibration handler does once the fence lets it through, so recording it is
 * how "the refusal happened before the act" is observed rather than assumed.
 */
function harness(selectedProfileId: string | null): Harness {
  electronState.handlers.clear();
  const downstream: string[] = [];

  const profiles = {
    list: () =>
      Promise.resolve({
        profiles: [
          {
            id: SELECTED_PROFILE,
            name: 'selected',
            baseUrl: SECRET_BASE_URL,
          },
        ],
        selectedProfileId,
      }),
    getAuthenticatedContext: (id: string) => {
      downstream.push(`getAuthenticatedContext(${id})`);
      return Promise.resolve({
        profile: { id, baseUrl: SECRET_BASE_URL },
        token: SECRET_TOKEN,
        revision: 1,
        generation: 1,
        serverBinding: 'binding',
        endpoint: (p: string) => `${SECRET_BASE_URL}${p}`,
      });
    },
    getAuthenticatedServerContext: (id: string) => {
      downstream.push(`getAuthenticatedServerContext(${id})`);
      return Promise.resolve({
        baseUrl: SECRET_BASE_URL,
        token: SECRET_TOKEN,
        binding: 'binding',
      });
    },
  };

  const recording = new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        return (...args: unknown[]) => {
          downstream.push(`sidecar.${String(prop)}`);
          void args;
          return Promise.resolve({});
        };
      },
    },
  );

  registerIpcHandlers(
    undefined,
    profiles as never,
    recording as never,
    recording as never,
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

  return { handlers: new Map(electronState.handlers), downstream };
}

/**
 * Calibration channels whose request schema carries a `profileId`, read from
 * `ipcSchemas` at run time.
 *
 * Deriving is the whole point. A transcribed list records what one person read
 * once; a channel added afterwards simply never appears in it, and every
 * per-channel assertion below silently stops applying to the newest and least
 * reviewed part of the surface.
 */
function profileScopedChannels(): string[] {
  const found: string[] = [];
  for (const [channel, pair] of Object.entries(ipcSchemas)) {
    if (!channel.startsWith('calibration:')) continue;
    const shape = (
      (pair as { request: unknown }).request as
        { shape?: Record<string, unknown> } | undefined
    )?.shape;
    if (shape && Object.prototype.hasOwnProperty.call(shape, 'profileId')) {
      found.push(channel);
    }
  }
  return found;
}

/** Every calibration channel, profile-scoped or not. */
function calibrationChannels(): string[] {
  return Object.values(IpcChannel)
    .map(String)
    .filter((c) => c.startsWith('calibration:'));
}

/**
 * The matrix. Membership is checked against {@link profileScopedChannels} below
 * so it cannot drift behind the contract; what each row adds is the one thing
 * that cannot be derived — a request the channel's schema actually accepts.
 *
 * The fixtures are load-bearing in a way that is easy to miss. Every handler
 * parses before it authorizes, so a fixture the schema rejects produces a
 * rejection that looks exactly like a refusal. All 26 channels could "deny"
 * because all 26 fixtures were malformed. `the fixture is a request the
 * contract accepts` below is what forecloses that, and it is the reason these
 * are spelled out rather than generated from `{ profileId }` alone.
 */
const MATRIX: { channel: string; request: (profileId: string) => unknown }[] = [
  {
    channel: IpcChannel.CalibrationListPrinters,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationGetPrinterContext,
    request: (profileId) => ({ profileId, printerId: uuid(3) }),
  },
  {
    channel: IpcChannel.CalibrationListWorkspaceStates,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationGetWorkspaceState,
    request: (profileId) => ({ profileId, projectId: uuid(4) }),
  },
  {
    channel: IpcChannel.CalibrationSyncNow,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationGetDiagnostics,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationPollQueueChanges,
    request: (profileId) => ({ profileId, afterSequence: 0 }),
  },
  {
    channel: IpcChannel.CalibrationGetSubscriptionResources,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationListOrcaProfiles,
    request: (profileId) => ({ profileId, printerId: uuid(9) }),
  },
  {
    channel: IpcChannel.CalibrationExportOrcaProfile,
    request: (profileId) => ({
      profileId,
      projectId: uuid(4),
      snapshotId: SHA256,
      orcaProfileId: 'Generated PLA',
      operationId: uuid(5),
    }),
  },
  {
    channel: IpcChannel.CalibrationResolveConflict,
    request: (profileId) => ({
      profileId,
      conflictId: uuid(6),
      resolution: 'acceptServer',
    }),
  },
  {
    channel: IpcChannel.CalibrationListConflicts,
    request: (profileId) => ({ profileId, projectId: uuid(4) }),
  },
  {
    channel: IpcChannel.CalibrationListExtendedProfiles,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationListMachineProfilesForModel,
    request: (profileId) => ({ profileId, printerModelId: uuid(3) }),
  },
  {
    channel: IpcChannel.CalibrationListProcessProfilesForMachines,
    request: (profileId) => ({ profileId, machineNames: ['Voron 2.4 350'] }),
  },
  {
    channel: IpcChannel.CalibrationListFilamentProfilesForMachines,
    request: (profileId) => ({ profileId, machineNames: ['Voron 2.4 350'] }),
  },
  {
    channel: IpcChannel.CalibrationListCustomProfiles,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationCloneFilamentProfile,
    request: (profileId) => ({
      profileId,
      sourceProfileId: uuid(9),
      name: 'PolyLite PLA Blue',
    }),
  },
  {
    channel: IpcChannel.CalibrationResolveSystemProfile,
    request: (profileId) => ({
      profileId,
      printerModelId: uuid(3),
      profileType: 'filament',
      profileName: 'PolyLite PLA Blue',
    }),
  },
  {
    channel: IpcChannel.CalibrationSubmitCalibrationSlice,
    request: (profileId) => ({
      profileId,
      printerId: uuid(3),
      machineProfileName: 'Voron 2.4 350',
      processProfileName: '0.20mm Standard @Voron 2.4',
      filamentProfileName: 'PolyLite PLA Blue',
      method: 'flow_rate_pass_1',
    }),
  },
  {
    channel: IpcChannel.CalibrationGetSliceJobStatus,
    request: (profileId) => ({ profileId, jobId: uuid(6), pollAttempt: 0 }),
  },
  {
    channel: IpcChannel.CalibrationSendSliceToPrinter,
    request: (profileId) => ({
      profileId,
      jobId: uuid(6),
      printerId: uuid(3),
      startPrint: false,
      operatorAcknowledgement: null,
    }),
  },
  {
    channel: IpcChannel.CalibrationUpdateFilamentProfileMeasurement,
    request: (profileId) => ({
      profileId,
      customProfileId: uuid(9),
      measurement: { method: 'flow_rate_pass_1', filamentFlowRatio: 0.98 },
    }),
  },
  {
    channel: IpcChannel.CalibrationSaveFilamentWizardState,
    request: (profileId) => ({
      profileId,
      state: {
        schemaVersion: 1,
        printerId: uuid(3),
        printerModelId: null,
        machineName: 'Voron 2.4 350',
        processName: '0.20mm Standard @Voron 2.4',
        baseFilamentName: 'PolyLite PLA Blue',
        baseFilamentGuid: uuid(5),
        cloneId: uuid(7),
        cloneName: 'PolyLite PLA Blue (calibration)',
        completedMethods: [],
        currentMethod: 'flow_rate_pass_1',
        inFlightJob: {
          jobId: uuid(6),
          method: 'flow_rate_pass_1',
          submittedAt: '2026-01-01T00:00:00.000Z',
          pollAttempt: 0,
          lastStatus: 'Queued',
        },
        phase: 'pollingSlice',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    }),
  },
  {
    channel: IpcChannel.CalibrationGetFilamentWizardState,
    request: (profileId) => ({ profileId }),
  },
  {
    channel: IpcChannel.CalibrationClearFilamentWizardState,
    request: (profileId) => ({ profileId }),
  },
];

/** Reads the `code` a handler refused with, without assuming it threw an Error. */
function refusalCode(error: unknown): unknown {
  return (error as { code?: unknown } | null)?.code;
}

async function invoke(
  h: Harness,
  channel: string,
  request: unknown,
): Promise<{ ok: true } | { ok: false; error: unknown }> {
  const handler = h.handlers.get(channel);
  if (!handler) throw new Error(`no handler registered for ${channel}`);
  try {
    await handler({ sender: { id: 1, once: () => undefined } }, request);
    return { ok: true };
  } catch (error) {
    return { ok: false, error };
  }
}

describe('calibration IPC authorization matrix', () => {
  it('registers every calibration channel in the shared contract', () => {
    // Guards the harness. If registration silently stopped happening, every
    // denial below would pass against an empty map — the vacuous direction,
    // which is the one nobody rechecks because it reports success.
    const h = harness(SELECTED_PROFILE);
    for (const channel of calibrationChannels()) {
      expect(h.handlers.has(channel), `${channel} is not registered`).toBe(
        true,
      );
    }
  });

  it('covers exactly the calibration channels whose request carries a profileId', () => {
    // THE control. Everything else in this file is coverage; this is the line
    // that fails on the run that adds an ungoverned channel, instead of waiting
    // for someone to notice a list is short.
    expect(profileScopedChannels().sort()).toEqual(
      MATRIX.map((row) => row.channel).sort(),
    );
  });

  describe.each(MATRIX)('$channel', ({ channel, request }) => {
    it('the fixture is a request the contract accepts', () => {
      // The precondition for every denial below. Handlers parse before they
      // authorize, so a fixture the schema rejects denies for the wrong reason
      // and the row passes having proved nothing. Asserted, not assumed.
      const schema = (
        ipcSchemas as Record<
          string,
          | {
              request: {
                safeParse: (v: unknown) => {
                  success: boolean;
                  error?: unknown;
                };
              };
            }
          | undefined
        >
      )[channel];
      if (!schema) throw new Error(`no request schema for ${channel}`);
      const result = schema.request.safeParse(request(OTHER_PROFILE));
      expect(
        result.success,
        `fixture rejected by the contract: ${JSON.stringify(result.error)}`,
      ).toBe(true);
    });

    it('refuses a profile the user has not selected', async () => {
      const h = harness(SELECTED_PROFILE);
      const outcome = await invoke(h, channel, request(OTHER_PROFILE));
      expect(outcome.ok, 'handler admitted an unselected profile').toBe(false);
      expect(refusalCode((outcome as { error: unknown }).error)).toBe(
        'CALIBRATION_PROFILE_MISMATCH',
      );
    });

    it('refuses when no server profile is selected', async () => {
      const h = harness(null);
      const outcome = await invoke(h, channel, request(SELECTED_PROFILE));
      expect(outcome.ok, 'handler acted with no profile selected').toBe(false);
      expect(refusalCode((outcome as { error: unknown }).error)).toBe(
        'CALIBRATION_PROFILE_MISMATCH',
      );
    });

    it('refuses before reaching the credential or the network', async () => {
      // A refusal that happens after the token was fetched and the request sent
      // is not a refusal. This is the ordering assertion, and it is why the
      // fake records rather than merely resolves.
      const h = harness(SELECTED_PROFILE);
      await invoke(h, channel, request(OTHER_PROFILE));
      expect(h.downstream).toEqual([]);
    });

    it('discloses neither the credential nor the server it would have reached', async () => {
      const h = harness(SELECTED_PROFILE);
      const outcome = await invoke(h, channel, request(OTHER_PROFILE));
      const rendered = JSON.stringify({
        message: String((outcome as { error: unknown }).error),
        error: outcome,
      });
      expect(rendered).not.toContain(SECRET_TOKEN);
      expect(rendered).not.toContain(SECRET_BASE_URL);
    });

    it('rejects an unknown request field rather than ignoring it', async () => {
      // The escalation criterion. `.strict()` is asserted per channel because
      // a single `.passthrough()` added to one request schema is invisible in
      // review and hands the renderer a field the handler may later read.
      const h = harness(SELECTED_PROFILE);
      const smuggled = {
        ...(request(SELECTED_PROFILE) as Record<string, unknown>),
        __proto_escalation: true,
      };
      const outcome = await invoke(h, channel, smuggled);
      expect(outcome.ok, 'handler accepted an unknown field').toBe(false);
    });
  });

  describe('the diagnostic that is deliberately not profile-scoped', () => {
    // The fence added to `calibration:getDiagnostics` for #157 is conditional,
    // and a conditional fence is easy to "fix" into an unconditional one that
    // quietly deletes the feature. This is the half that must keep working:
    // diagnostics answer with no profile named and none selected, because
    // "nothing is selected" is the diagnosis someone is running this to get.
    it('still answers when no profileId is named and none is selected', async () => {
      const h = harness(null);
      const outcome = await invoke(h, IpcChannel.CalibrationGetDiagnostics, {});
      expect(outcome.ok, 'the no-profile diagnosis stopped answering').toBe(
        true,
      );
    });

    it('still answers when no profileId is named and one is selected', async () => {
      const h = harness(SELECTED_PROFILE);
      const outcome = await invoke(h, IpcChannel.CalibrationGetDiagnostics, {});
      expect(outcome.ok).toBe(true);
    });
  });

  describe('what this process does not gate, recorded so it cannot be assumed', () => {
    it('reports capability and scope state on getAvailability alone', () => {
      // Characterization, not aspiration. #157 asks for denial under "missing
      // scope" and "capability flag absent". On the desktop these are
      // negotiated once by `calibration:getAvailability` and consulted by no
      // data channel: no calibration *request* carries a scope or capability
      // field, and no other calibration *response* reports one. There is
      // nothing for a handler to gate on, which is why no `it.each` above
      // asserts a scope denial — it could only ever pass. Enforcement is the
      // server's, tracked for live confirmation in #138.
      //
      // This fails when a second channel starts reporting capability state,
      // which is the first move anyone makes towards a real desktop-side gate.
      // Whoever does that should be sent here to grow the matrix from two
      // conditions to four rather than find this file afterwards.
      const reportsCapabilityState = Object.entries(ipcSchemas)
        .filter(([channel]) => channel.startsWith('calibration:'))
        .filter(([, pair]) => {
          const shape = (
            (pair as { response: unknown }).response as
              { shape?: Record<string, unknown> } | undefined
          )?.shape;
          if (!shape) return false;
          return (
            Object.prototype.hasOwnProperty.call(shape, 'capabilityFlags') ||
            Object.prototype.hasOwnProperty.call(shape, 'grantedScopes')
          );
        })
        .map(([channel]) => channel);

      expect(reportsCapabilityState).toEqual([
        IpcChannel.CalibrationGetAvailability,
      ]);

      const requestsCarryingScope = Object.entries(ipcSchemas)
        .filter(([channel]) => channel.startsWith('calibration:'))
        .filter(([, pair]) => {
          const shape = (
            (pair as { request: unknown }).request as
              { shape?: Record<string, unknown> } | undefined
          )?.shape;
          if (!shape) return false;
          return (
            Object.prototype.hasOwnProperty.call(shape, 'scopes') ||
            Object.prototype.hasOwnProperty.call(shape, 'capabilityFlags')
          );
        })
        .map(([channel]) => channel);

      expect(requestsCarryingScope).toEqual([]);
    });
  });
});
