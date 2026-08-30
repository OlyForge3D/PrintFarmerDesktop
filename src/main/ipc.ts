import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  type WebContents,
} from 'electron';
import { z } from 'zod';
import {
  AppInfoResponse,
  IPC_CONTRACT_VERSION,
  IpcChannel,
  ListModelsResponse,
  ipcSchemas,
  type OpenModelFileResponse,
  type OpenFolderResponse,
  type SidecarPingResponse,
  type CalibrationProfileDiscoveryDiagnostic,
  CALIBRATION_PERMISSIONS,
  hasCalibrationPermission,
  resolveOrcaBaseProfileLookupName,
  CalibrationPrinterCandidate,
  type OrcaProfileOperationError,
  type CalibrationFilamentMeasurement,
  PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C,
} from '@shared/ipc';
import {
  SidecarClient,
  spawnSidecarChannel,
  type ChannelFactory,
} from './sidecar.js';
import { ServerProfileService } from './serverProfiles.js';
import {
  TargetProfileNativeError,
  TargetProfileService,
  TargetProfileUnavailableError,
} from './targetProfiles.js';
import { RetargetArtifactService, type Dialogs } from './retargetArtifacts.js';
import { SceneCacheService } from './sceneCache.js';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
} from './calibrationHttp.js';

/**
 * How many local profile names a diagnostic carries to the renderer.
 *
 * The renderer needs enough to show that profiles were genuinely read; it has
 * never needed the whole install. Shipping up to two thousand names across the
 * IPC boundary made a diagnostic message cost more than the lookup it explained.
 */
const LOCAL_PROFILE_EXEMPLAR_LIMIT = 5;

import {
  REQUIRED_FIRMWARE_FAMILY,
  REQUIRED_SLICER_ENGINE,
  isExplicitCalibrationEligibilityComplete,
  missingCalibrationFlags,
  doesCalibrationWorkspacePayloadMatchContext,
  prepareCalibrationWorkspaceSave,
  projectCalibrationPrinterContext,
  projectPrintFarmerOrcaProfileResult,
  supportsKlipper,
  supportsOrcaSlicer,
  type RemoteCalibrationCapabilities,
  type RemoteCalibrationPrinterCandidate,
} from './calibrationWire.js';
import { resolveCalibrationWorkspaceFreshness } from './calibrationFreshness.js';
import {
  evaluateCalibrationActionGate,
  type CalibrationGateResult,
  type CalibrationGatedAction,
} from './calibrationActionGate.js';
import { CalibrationSelectionCache } from './calibrationSelectionCache.js';
import { FilamentWizardStateStore } from './calibrationFilamentWizardState.js';
import { BedClearAcknowledgementLedger } from './calibrationBedClearLedger.js';
import { CalibrationCapabilityRefresher } from './calibrationCapabilityRefresh.js';
import {
  CalibrationAuthRecovery,
  type CalibrationAuthRecoveryOutcome,
} from './calibrationAuthRecovery.js';
import { CalibrationSyncEngine } from './calibrationEngine.js';
import {
  ServerProfileCalibrationTokenProvider,
  SidecarCalibrationAdapter,
} from './calibrationService.js';
import {
  discoverLocalOrcaFilamentProfiles,
  findLocalOrcaProfileRaw,
  listLocalOrcaFilamentProfiles,
} from './orcaProfileDiscovery.js';
import {
  verifyExportedProfile,
  writeExportedProfileNoFollow,
  canonicalizeSaveTarget,
  getCachedProfile,
  clearProfileCache,
  type CachedProfile,
  OrcaInstallError,
} from './orcaProfileInstall.js';
import {
  emitCalibrationLog,
  describeCalibrationFailure,
} from './calibrationLog.js';
import type { CalibrationCorrelationOrigin } from './calibrationLog.js';
import { calibrationCorrelation } from './calibrationCorrelation.js';
import { calibrationDiagnostics } from './calibrationDiagnostics.js';
import { applyFilamentMeasurement } from './filamentMeasurementWriteBack.js';
import {
  computeSlicePollHint,
  classifySliceJobTerminalOutcome,
  SLICE_POLL_MAX_ATTEMPTS,
} from './calibrationSlicePoll.js';

declare const __PRINTFARMER_E2E_BUILD__: boolean;

/**
 * Translates a renderer-supplied {@link CalibrationFilamentMeasurement} into
 * the `calibrationKind`/`method`/`specification`/`measurements` shape the
 * server's attempt-create and observation-append routes expect (#795).
 *
 * `method` is passed straight through unchanged: the desktop's
 * `CalibrationFilamentMeasurement.method` literals
 * (`flow_rate_pass_1`/`flow_rate_pass_2`/`flow_rate_yolo_recommended`/
 * `flow_rate_yolo_perfectionist`/`temperature_tower`/`max_volumetric_speed`/
 * `pressure_advance_tower`/`retraction`) already match PrintFarmer's
 * `CalibrationMethods.ToWireName(...)` output verbatim — verified via
 * `CalibrationMethodClassification.cs` at PrintFarmer commit
 * `20630b47d593f90c6bc0c9ade4a1525a74d2b283`. `calibrationKind` is the
 * server's coarser grouping (`CalibrationMethodKinds.ToKind(method)`), which
 * has no desktop-side equivalent and must be derived here.
 *
 * `specification` is populated only for the two methods whose
 * `CalibrationMethodGuidanceCatalog.ForMethod(...).SetupInputs` declares
 * required setup fields (`temperature_tower`, `max_volumetric_speed`). The
 * desktop's wizard has no setup step that collects a real operator-chosen
 * sweep for either yet, so the full server-declared legal range is sent as a
 * documented approximation — see the doc comment on
 * `CalibrationHttpClient.createAttempt`.
 *
 * `measurements` carries exactly the one semantic key
 * `CalibrationMeasurementRanges.ForKind` validates/merges for that kind.
 * `temperature_tower` measures two values
 * (`nozzleTemperature`/`nozzleTemperatureInitialLayer`) but the server's
 * `temperature` kind has only one measurement key; the steady-state
 * `nozzleTemperature` is submitted and `nozzleTemperatureInitialLayer` is
 * not (it has no server-side calibration-kind equivalent — it still feeds
 * the parallel live-clone write-back in `filamentMeasurementWriteBack.ts`,
 * which continues for slicing continuity).
 *
 * Exported for direct testing; the IPC handler delegates to this function.
 */
export function mapFilamentMeasurementToObservation(
  measurement: CalibrationFilamentMeasurement,
): {
  calibrationKind: string;
  method: string;
  specification: Record<string, number>;
  measurements: Record<string, number>;
} {
  switch (measurement.method) {
    case 'flow_rate_pass_1':
    case 'flow_rate_pass_2':
    case 'flow_rate_yolo_recommended':
    case 'flow_rate_yolo_perfectionist':
      return {
        calibrationKind: 'flow',
        method: measurement.method,
        specification: {},
        measurements: { flow_ratio: measurement.filamentFlowRatio },
      };
    case 'temperature_tower':
      return {
        calibrationKind: 'temperature',
        method: measurement.method,
        specification: {
          start_temperature_c: 150,
          end_temperature_c: PRINTFARMER_NOZZLE_TEMPERATURE_MAX_C,
        },
        measurements: { temperature_c: measurement.nozzleTemperature },
      };
    case 'max_volumetric_speed':
      return {
        calibrationKind: 'max_volumetric_speed',
        method: measurement.method,
        specification: {
          sweep_start_mm3_s: 1,
          sweep_end_mm3_s: 60,
        },
        measurements: {
          max_volumetric_speed_mm3_s: measurement.maxVolumetricSpeed,
        },
      };
    case 'pressure_advance_tower':
      return {
        calibrationKind: 'pressure_advance',
        method: measurement.method,
        specification: {},
        measurements: { pressure_advance: measurement.pressureAdvance },
      };
    case 'retraction':
      return {
        calibrationKind: 'retraction',
        method: measurement.method,
        specification: {},
        measurements: { retraction_length_mm: measurement.retractionLength },
      };
  }
}

/**
 * Detects sequence gaps in a queue-change-feed event page.
 *
 * The server allocates `sequence` values monotonically in the same database
 * transaction as each outbox-event write (`QueueDispatchOutbox.Sequence`).
 * A gap means the server has events the client did not receive; the caller
 * must discard any cached change-feed state and refetch job state over REST.
 *
 * Three distinct cases:
 *
 * - **Cursor gap** — `events[0].sequence !== afterSequence + 1`: at least one
 *   event between the poll cursor and the first returned event is absent.
 * - **Internal gap** — any `events[i].sequence !== events[i-1].sequence + 1`:
 *   non-contiguous events within the page.
 * - **Contiguous** (no gap) — the page begins immediately after the cursor and
 *   every adjacent pair differs by exactly 1.
 *
 * Exported for direct testing; the IPC handler delegates to this function.
 */
export function detectQueueChangeFeedGap(
  events: readonly { sequence: number }[],
  afterSequence: number,
): boolean {
  const firstEvent = events[0];
  if (firstEvent !== undefined && firstEvent.sequence !== afterSequence + 1) {
    return true;
  }
  for (let i = 1; i < events.length; i++) {
    const cur = events[i];
    const prev = events[i - 1];
    if (
      cur !== undefined &&
      prev !== undefined &&
      cur.sequence !== prev.sequence + 1
    ) {
      return true;
    }
  }
  return false;
}

const automatedSaveDialogs = z
  .array(
    z
      .object({
        canceled: z.boolean(),
        filePath: z.string().max(4096),
      })
      .strict()
      .superRefine((value, context) => {
        if (!value.canceled && value.filePath.length === 0) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'A non-canceled save response requires a file path.',
          });
        }
      }),
  )
  .max(10);
const automatedOpenDialogs = z.array(z.string().max(4096)).max(10);

function retargetDialogs(): Dialogs {
  if (
    typeof __PRINTFARMER_E2E_BUILD__ === 'undefined' ||
    !__PRINTFARMER_E2E_BUILD__ ||
    process.env.PRINTFARMER_E2E !== '1'
  ) {
    return dialog;
  }

  const saves = automatedSaveDialogs.parse(
    JSON.parse(process.env.PRINTFARMER_E2E_SAVE_DIALOGS ?? '[]'),
  );
  const openPaths = automatedOpenDialogs.parse(
    process.env.PRINTFARMER_E2E_OPEN_DIALOGS
      ? JSON.parse(process.env.PRINTFARMER_E2E_OPEN_DIALOGS)
      : process.env.PRINTFARMER_E2E_OPEN_DIALOG
        ? [process.env.PRINTFARMER_E2E_OPEN_DIALOG]
        : [],
  );
  let saveIndex = 0;
  let openIndex = 0;
  return {
    showSaveDialog: () =>
      Promise.resolve(saves[saveIndex++] ?? { canceled: true, filePath: '' }),
    showOpenDialog: () => {
      const openPath = openPaths[openIndex++];
      return Promise.resolve(
        openPath
          ? { canceled: false, filePaths: [openPath] }
          : { canceled: true, filePaths: [] },
      );
    },
  };
}

/**
 * Maps a target-profile failure onto a renderer-visible envelope.
 *
 * Three arms, and the third one is the point. `sidecarUnavailable` used to be
 * the `else`, so it was returned for the fault that genuinely is a sidecar
 * problem *and* for every fault that is not — including a rejected
 * `retargetReady`, which is the temp-root reaper failing on ordinary
 * filesystem contention. The operator was told the profile bundle was missing
 * and advised to reinstall, which cannot clear a stale temp directory.
 *
 * An `else` means "I do not know what this is". It must not render as "I know
 * exactly what this is", so the unclassified arm reports `internalError` and
 * says the cause is unidentified. That loses no information the old envelope
 * carried — it never knew the cause either — and it misdirects nobody.
 */
/**
 * The envelope for a `retargetReady` rejection, which is the temp-root reaper
 * failing — a workspace fault, not a profile fault.
 *
 * `RetargetPreflight` isolates this await and named the workspace in its
 * message, and on that basis was recorded as already correct; the two profile
 * channels shared one `catch` with the profile load and so inherited the
 * profile diagnosis instead. But the message was only half the envelope:
 * `RetargetPreflight` went on returning `code: 'sidecarUnavailable'` for the
 * same fault until #404. Checking the human-readable half certified the site,
 * because that half was right — the machine-readable half was never compared.
 *
 * The code is `internalError` rather than `sidecarUnavailable` because the
 * sidecar is not implicated: the message carries the cause, and the code
 * declines to claim a classification the enum does not have.
 */
function retargetWorkspaceFailure() {
  return {
    domain: 'electron' as const,
    code: 'internalError' as const,
    message: 'The retarget workspace could not be prepared.',
    action:
      'Restart the application and try again. Reinstalling does not help: the profile bundle is not implicated.',
    part: null,
    setting: null,
  };
}

function targetProfileFailure(error: unknown) {
  if (error instanceof TargetProfileNativeError) return error.failure;
  if (error instanceof TargetProfileUnavailableError) {
    return {
      domain: 'electron' as const,
      code: 'sidecarUnavailable' as const,
      message: 'Snapmaker U1 profiles could not be loaded.',
      action:
        'Restart the application; reinstall it if the profile bundle remains unavailable.',
      part: null,
      setting: null,
    };
  }
  return {
    domain: 'electron' as const,
    code: 'internalError' as const,
    message: 'Snapmaker U1 profiles could not be loaded.',
    action:
      'Restart the application. The cause was not identified; collect the application logs before reinstalling, because a reinstall does not clear a stale retarget workspace.',
    part: null,
    setting: null,
  };
}
import { createUploadJobService, type UploadJobService } from './uploadJobs.js';
import { RootApprovalStore } from './rootApprovals.js';

export function createLoadSceneHandler(
  authorizeFile: (requestedPath: string) => Promise<string>,
  sceneCache: Pick<SceneCacheService, 'loadScene'>,
) {
  return async (_event: unknown, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.LoadScene].request.parse(rawRequest);
    const approvedPath = await authorizeFile(request.path);
    return sceneCache.loadScene(approvedPath);
  };
}

/**
 * Register all IPC handlers. Incoming payloads are validated against their Zod
 * request schemas before handlers run. Responses are validated at their trust
 * boundaries before being returned to the renderer; scene-cache hits are
 * validated when read from disk and sidecar scenes when received. Invalid data
 * from a compromised renderer or external process is rejected rather than
 * trusted.
 *
 * @param channelFactory - Optional sidecar transport override, primarily for
 *   tests. Defaults to spawning the real `model-core` process.
 */
export function registerIpcHandlers(
  channelFactory?: ChannelFactory,
  profileService?: ServerProfileService,
  sharedSidecar?: SidecarClient,
  sharedRetargetSidecar?: SidecarClient,
  uploadJobService?: UploadJobService,
  rootApprovalStore?: RootApprovalStore,
  sharedSceneCache?: SceneCacheService,
): () => Promise<void> {
  const sidecar =
    sharedSidecar ?? new SidecarClient(channelFactory ?? spawnSidecarChannel);
  const retargetSidecar = sharedRetargetSidecar ?? sidecar;
  const profiles =
    profileService ??
    new ServerProfileService({
      userDataPath: app.getPath('userData'),
      secretStorage: safeStorage,
    });
  const approvals =
    rootApprovalStore ??
    new RootApprovalStore({ userDataPath: app.getPath('userData') });
  const sceneCache =
    sharedSceneCache ??
    new SceneCacheService({
      userDataPath: app.getPath('userData'),
      sidecar,
    });
  // Eager initialization starts the sidecar so obsolete recipe namespaces are
  // evicted before the first scene request.
  void sceneCache.initialize().catch((error: unknown) => {
    emitCalibrationLog({
      level: 'error',
      component: 'calibration.sidecar',
      event: 'sceneCache.startupInvalidationFailed',
      ...describeCalibrationFailure(error),
      outcome: 'failed',
    });
  });
  const targetProfiles = new TargetProfileService({
    userDataPath: app.getPath('userData'),
    sidecar: retargetSidecar,
  });
  const retargetDialogService = retargetDialogs();
  const retargetArtifacts = new RetargetArtifactService({
    sidecar: retargetSidecar,
    profiles: targetProfiles,
    dialogs: retargetDialogService,
  });
  const retargetReady = retargetArtifacts.initialize();
  // The three IPC handlers below await `retargetReady`, but the first of those
  // awaits happens when the renderer first retargets — minutes after startup, or
  // never in a session where nobody does. Until an awaiter attaches a handler,
  // Node treats a rejection here as unhandled and can terminate the main
  // process.
  //
  // The specific cause that motivated this — `EPERM: rmdir` escaping the stale
  // instance sweep, which exited the #159 suite non-zero with every test
  // passing — was fixed at the source in `initialize()` (issue #229), so that
  // rejection no longer reaches here. This handler stays because the window it
  // closes is structural, not specific to that one cause: `initialize()` still
  // creates directories and writes a marker, and any of that can fail.
  //
  // Attaching the handler here closes that window without swallowing anything —
  // `retargetReady` still rejects for its awaiters, so a retarget attempted
  // after a failed initialize reports the failure to the renderer as before.
  void retargetReady.catch((error: unknown) => {
    emitCalibrationLog({
      level: 'error',
      component: 'calibration.sidecar',
      event: 'retargetArtifacts.startupInitializationFailed',
      ...describeCalibrationFailure(error),
      outcome: 'failed',
    });
  });
  let targetProfilesInitialized = false;
  const refreshTargetProfiles = async () => {
    if (!targetProfilesInitialized) {
      await targetProfiles.initialize();
      targetProfilesInitialized = true;
      return targetProfiles.catalog();
    }
    return targetProfiles.refresh();
  };
  const retargetOwnerCleanup = new WeakSet<WebContents>();
  const approvedPickerFiles = new Set<string>();
  const authorizeRendererFile = async (
    requestedPath: string,
  ): Promise<string> => {
    const canonicalPath = await approvals.canonicalizePickerFile(requestedPath);
    if (approvedPickerFiles.has(canonicalPath)) return canonicalPath;
    return (await approvals.authorizeFile(requestedPath)).canonicalPath;
  };
  const resetApprovedRootsAndArtifacts = async (): Promise<void> => {
    await approvals.reset();
    approvedPickerFiles.clear();
    await sceneCache.purge();
    await retargetArtifacts.disposeArtifacts();
  };
  const uploads =
    uploadJobService ??
    createUploadJobService(
      app.getPath('userData'),
      sidecar,
      profiles,
      approvals,
    );
  void uploads.initialize().catch(() => undefined);

  // --- Calibration services (issue #52) -------------------------------------
  // Instantiate the HTTP client and sync engine here using the shared profile
  // service. These are the real, operational services — not stubs.
  const calibrationTokens = new ServerProfileCalibrationTokenProvider(profiles);
  const calibrationHttp = new CalibrationHttpClient(calibrationTokens);
  const calibrationSidecarAdapter = new SidecarCalibrationAdapter(sidecar);
  const calibrationEngine = new CalibrationSyncEngine(
    calibrationHttp,
    calibrationSidecarAdapter,
    {
      list: () => profiles.list(),
      getAuthenticatedContext: async (profileId: string) => {
        const ctx = await profiles.getAuthenticatedContext(profileId);
        return {
          baseUrl: ctx.profile.baseUrl,
          binding: ctx.serverBinding,
        };
      },
    },
  );
  // Active sync-abort controller: one controller per outstanding sync.
  const activeSyncControllers = new Map<string, AbortController>();

  const requireSelectedCalibrationProfile = async (
    requestedProfileId: string,
  ): Promise<string> => {
    const listed = await profiles.list();
    if (
      listed.selectedProfileId === null ||
      requestedProfileId !== listed.selectedProfileId
    ) {
      throw Object.assign(
        new Error('Calibration request does not match the selected profile.'),
        { code: 'CALIBRATION_PROFILE_MISMATCH' },
      );
    }
    return listed.selectedProfileId;
  };

  /**
   * Recent observations of what the operator selected. Never authoritative:
   * a miss just means the value is fetched again.
   */
  const selectionCache = new CalibrationSelectionCache();
  /**
   * On-disk restart-resilience bookmark for the filament calibration wizard
   * (issue #754). See `calibrationFilamentWizardState.ts` for why this is a
   * main-process JSON store rather than a sidecar table.
   */
  const filamentWizardStateStore = new FilamentWizardStateStore(
    app.getPath('userData'),
  );
  /**
   * Proof that an operator confirmed a clear bed. Minted only after this process
   * has seen the server report the job as awaiting acknowledgement.
   */
  const bedClearLedger = new BedClearAcknowledgementLedger();
  /** Bounded capability re-read after the server refuses an operation. */
  const capabilityRefresher = new CalibrationCapabilityRefresher();
  /** Bounded re-exchange after the server rejects this profile's token. */
  const authRecovery =
    new CalibrationAuthRecovery<RemoteCalibrationCapabilities>();

  /**
   * Monotonic counter for everything that invalidates in-flight calibration
   * decisions: a profile switch, a delete, a 403-driven discard, teardown.
   *
   * Verification awaits an authoritative context read, so a decision can be
   * correct when it starts and wrong when it returns. A plain "is the selected
   * id still A" check is not enough — A → B → A during the await passes it while
   * everything the decision rested on has been discarded twice over. A counter
   * that only ever advances cannot be fooled that way.
   */
  let calibrationStateEpoch = 0;

  /**
   * Cancel every sync in flight, because none of them is still authorised.
   *
   * A profile switch or a refusal invalidates the outbox push that is already
   * running for the previous profile, and letting it continue would keep
   * mutating a farm the operator has moved away from — or one that has just
   * refused this account.
   */
  const abortActiveCalibrationSyncs = (): void => {
    for (const controller of activeSyncControllers.values()) {
      controller.abort();
    }
    activeSyncControllers.clear();
  };

  /**
   * Discard every piece of calibration state tied to a server profile.
   *
   * All four of these are evidence about one farm and one account: negotiated
   * permissions and flags, recently observed printer contexts and candidates, a
   * bed-clear acknowledgement, and a refusal cooldown. None of it survives a
   * change of selected profile, because each could otherwise let one farm's
   * answer authorise an action against another.
   *
   * `profileId` narrows the scoped stores when a specific profile is known;
   * the capability snapshot and ledger are cleared outright, because a
   * mis-scoped clear that leaves evidence behind fails open, and clearing more
   * than strictly necessary only costs a re-negotiation.
   */
  const forgetCalibrationProfileState = (profileId?: string): void => {
    calibrationStateEpoch += 1;
    calibrationDiagnostics.clearCapabilities();
    bedClearLedger.clear();
    clearProfileCache();
    abortActiveCalibrationSyncs();
    if (profileId === undefined) {
      selectionCache.clear();
      capabilityRefresher.clear();
      authRecovery.clear();
    } else {
      selectionCache.forgetProfile(profileId);
      capabilityRefresher.forgetProfile(profileId);
      authRecovery.forgetProfile(profileId);
    }
  };

  /**
   * Re-negotiate capabilities once after a refusal, without replaying anything.
   *
   * A 403 says the snapshot the gate consulted is out of date. Re-reading it
   * keeps the app from offering actions that will keep failing while insisting
   * they should work. The refused action is deliberately *not* retried: a read
   * is safe to repeat on the operator's behalf, and a create, generate, queue or
   * dispatch is not.
   */
  const noteCalibrationForbidden = async (
    selectedId: string,
  ): Promise<boolean> => {
    // Invalidate *everything* a refusal contradicts, unconditionally and before
    // the bounded refresh is even considered.
    //
    // Clearing only the capability snapshot left three holes. The action epoch
    // did not advance, so a verification already in flight would re-read the
    // freshly refreshed positive capability and dispatch even though it predated
    // the refusal. A previously minted bed-clear acknowledgement survived a
    // refusal that plainly bore on it. And a remembered printer context stayed
    // usable. None of that is evidence a 403 leaves intact.
    //
    // The refresher's cooldown is deliberately *not* reset: it bounds the
    // transport, and clearing it here would turn rapid refusals into unbounded
    // capability fetches.
    calibrationStateEpoch += 1;
    calibrationDiagnostics.clearCapabilities();
    bedClearLedger.clear();
    selectionCache.forgetProfile(selectedId);
    abortActiveCalibrationSyncs();
    const outcome = await capabilityRefresher.noteForbidden(
      selectedId,
      async () => {
        const negotiationToken =
          calibrationDiagnostics.beginCapabilityNegotiation();
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const caps = await calibrationHttp.getCapabilities(
          selectedId,
          ctx.profile.baseUrl,
          AbortSignal.timeout(10_000),
        );
        calibrationDiagnostics.recordCapabilities(
          negotiationToken,
          selectedId,
          caps,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'capabilities.negotiated',
          profileId: selectedId,
          outcome: 'ok',
        });
      },
    );
    return outcome.accessMayHaveChanged;
  };

  /**
   * Re-establish identity once after the server rejects this profile's token.
   *
   * A 401 is not a refusal of the operator's rights; it says the JWT is no
   * longer valid, which happens on its own every fifteen minutes and again the
   * moment an administrator forces a revocation. Everything derived from that
   * token is discarded — capabilities, remembered contexts, a bed-clear
   * acknowledgement, in-flight outbox pushes — and the action epoch advances so
   * a verification already in flight cannot dispatch on evidence that predates
   * the rejection.
   *
   * The API key is then re-exchanged exactly once and capabilities re-read, so
   * the gate is evaluated against whatever principal the *new* token resolves
   * to. Nothing is replayed: a fresh principal is precisely the case where
   * silently repeating a queue or dispatch would act for the operator without
   * being asked.
   */
  const noteCalibrationUnauthenticated = async (
    selectedId: string,
    options: { reauthenticate?: boolean } = {},
  ): Promise<CalibrationAuthRecoveryOutcome<RemoteCalibrationCapabilities>> => {
    calibrationStateEpoch += 1;
    calibrationDiagnostics.clearCapabilities();
    bedClearLedger.clear();
    clearProfileCache();
    selectionCache.forgetProfile(selectedId);
    abortActiveCalibrationSyncs();
    if (options.reauthenticate === false) {
      return {
        status: 'exchangeFailed',
        attempted: false,
        authenticated: false,
        evidence: null,
      };
    }
    return authRecovery.noteUnauthenticated(selectedId, async () => {
      let baseUrl: string;
      try {
        // forceRefresh: exchange the configured API key for a new JWT rather
        // than reusing the cached one the server just rejected.
        const refreshed = await calibrationTokens.getAuthenticatedContext(
          selectedId,
          undefined,
          true,
        );
        baseUrl = refreshed.baseUrl;
      } catch {
        return { status: 'exchangeFailed', evidence: null };
      }
      // Capabilities are read against the new token *before* the workspace is
      // told it is authenticated again, because the key may now resolve to a
      // different principal with different rights.
      const negotiationToken =
        calibrationDiagnostics.beginCapabilityNegotiation();
      let caps: RemoteCalibrationCapabilities;
      try {
        caps = await calibrationHttp.getCapabilities(
          selectedId,
          baseUrl,
          AbortSignal.timeout(10_000),
        );
        calibrationDiagnostics.recordCapabilities(
          negotiationToken,
          selectedId,
          caps,
        );
      } catch (error) {
        // A second 401, from the read taken immediately after a successful
        // exchange, terminates recovery. Recursing here is how a revoked key
        // turns into an exchange storm.
        if (isUnauthenticated(error)) {
          return { status: 'stillUnauthenticated', evidence: null };
        }
        return { status: 'exchangeFailed', evidence: null };
      }
      emitCalibrationLog({
        level: 'info',
        component: 'calibration.http',
        event: 'capabilities.negotiated',
        profileId: selectedId,
        outcome: 'ok',
      });
      return { status: 'reauthenticated', evidence: caps };
    });
  };

  /** Whether a thrown error is the server refusing on authorisation grounds. */
  const isForbidden = (error: unknown): boolean =>
    error instanceof CalibrationHttpError &&
    (error.code === 'authorization' || error.code === 'forbidden');

  /**
   * Whether a thrown error is the server rejecting the token itself.
   *
   * Keyed on the status rather than the code, because `authentication` is also
   * raised locally when the server profile is removed or re-bound mid-request.
   * Those discard evidence too, but they are not something a re-exchange fixes.
   */
  const isUnauthenticated = (error: unknown): boolean =>
    error instanceof CalibrationHttpError && error.status === 401;

  /**
   * Single entry point for "the server would not let this through".
   *
   * Every calibration path funnels its authorisation and authentication
   * failures here so the two can never diverge: each new channel would
   * otherwise have to remember both, and the ones that convert their error into
   * a response kept forgetting.
   */
  const noteCalibrationAccessFailure = async (
    selectedId: string,
    error: unknown,
  ): Promise<{ staleAccess: boolean; reauthenticationRequired: boolean }> =>
    applyCalibrationAccessFailure(
      selectedId,
      isUnauthenticated(error)
        ? 'unauthenticated'
        : isForbidden(error)
          ? 'forbidden'
          : 'none',
    );

  /**
   * The same invalidation, reached from a typed result code rather than a
   * thrown error — synchronization reports its authorization outcome instead of
   * raising it, and must not therefore get a weaker response.
   */
  const applyCalibrationAccessFailure = async (
    selectedId: string,
    kind: 'unauthenticated' | 'forbidden' | 'none',
  ): Promise<{ staleAccess: boolean; reauthenticationRequired: boolean }> => {
    if (kind === 'unauthenticated') {
      const outcome = await noteCalibrationUnauthenticated(selectedId);
      return {
        staleAccess: true,
        reauthenticationRequired: !outcome.authenticated,
      };
    }
    if (kind === 'forbidden') {
      const staleAccess = await noteCalibrationForbidden(selectedId);
      return { staleAccess, reauthenticationRequired: false };
    }
    return { staleAccess: false, reauthenticationRequired: false };
  };

  /** Appended when a refusal means the cached permissions may be stale. */
  const ACCESS_MAY_HAVE_CHANGED =
    'Your calibration access may have changed. Reconnect or sign in again, then retry.';

  /** Appended when the session expired or was revoked and must be re-established. */
  const REAUTHENTICATION_REQUIRED =
    'Your PrintFarmer session expired or was revoked. Reconnect to sign in again, then retry.';

  /** Guidance for whichever way the server rejected the request. */
  const accessFailureGuidance = (failure: {
    staleAccess: boolean;
    reauthenticationRequired: boolean;
  }): string =>
    failure.reauthenticationRequired
      ? REAUTHENTICATION_REQUIRED
      : failure.staleAccess
        ? ACCESS_MAY_HAVE_CHANGED
        : '';

  /**
   * Minimal shape used to fence a request on the selected server profile.
   *
   * Deliberately independent of every channel's own schema. Each handler used
   * to strict-parse its full payload *before* checking the profile, which made
   * cross-profile refusal a downstream consequence of validation succeeding:
   * add a required field to a request and every cross-profile test for that
   * channel starts failing on a validation error instead, reporting a refusal
   * that the profile check never actually performed. Fencing first keeps
   * "this request is for a profile you do not have selected" a separate and
   * unconditional answer.
   */
  const CalibrationProfileFence = z
    .object({ profileId: z.string().uuid() })
    .passthrough();

  /**
   * Register a calibration IPC handler behind the profile fence.
   *
   * Channels whose payload carries no `profileId` (availability negotiation,
   * for instance) pass through untouched; they have no profile to fence on.
   */
  const registerCalibrationHandler = (
    channel: string,
    handler: (
      event: Parameters<Parameters<typeof ipcMain.handle>[1]>[0],
      rawRequest: unknown,
    ) => unknown,
  ): void => {
    ipcMain.handle(channel, async (event, rawRequest: unknown) => {
      const fenced = CalibrationProfileFence.safeParse(rawRequest);
      const fencedProfileId = fenced.success ? fenced.data.profileId : null;
      if (fencedProfileId !== null) {
        await requireSelectedCalibrationProfile(fencedProfileId);
      }
      try {
        return await handler(event, rawRequest);
      } catch (error) {
        // Centralised so a refusal on *any* calibration channel invalidates the
        // cached permissions, including channels that only read. Handling this
        // per action left a new hole every time a channel was added: a 403 from
        // a context read or a queue poll would leave a positive snapshot in
        // place and the workspace still offering actions the server had just
        // refused.
        //
        // Channels that deliberately convert the exception into a response —
        // sync, profile resolution — keep their own explicit handling, because
        // nothing reaches here for them to catch.
        //
        // The error is rethrown unchanged, and nothing is replayed: correcting
        // the evidence is a read, and repeating the caller's action is not.
        // This covers both ways the server can reject — a refused action and a
        // rejected token — because a channel that remembered only one of them
        // is exactly the hole this wrapper exists to close.
        if (fencedProfileId !== null) {
          await noteCalibrationAccessFailure(fencedProfileId, error);
        }
        throw error;
      }
    });
  };

  /**
   * Confirm nothing invalidating happened between verification and dispatch.
   *
   * Called immediately before each mutating request. The gate re-checks at the
   * end of its own work, but a handler does more afterwards — a prerequisite
   * query, a correlation begin — and a switch during *that* would otherwise
   * still reach the wire.
   */
  const calibrationStateUnchanged = (
    entryEpoch: number,
    selectedId: string,
    action: CalibrationGatedAction,
  ): boolean =>
    calibrationStateEpoch === entryEpoch &&
    // Re-evaluates the *verdict*, not merely whether some snapshot exists. A
    // concurrent availability negotiation can replace the evidence with fewer
    // permissions or a disabled flag without any invalidation event, and a
    // non-null check would happily pass on the narrower grant the action was
    // never verified against.
    gateCalibrationPermission(action, selectedId).allowed;

  /**
   * Refuse a mutating action on permission and capability alone.
   *
   * For boundaries that mutate server state but are not scoped to one printer —
   * pushing the outbox, resolving a conflict — where a printer/revision binding
   * has no meaning. Costs no network call, so a refusal here happens strictly
   * before anything is dispatched.
   */
  const gateCalibrationPermission = (
    action: CalibrationGatedAction,
    selectedId: string,
  ): CalibrationGateResult => {
    const capability = calibrationDiagnostics.capabilitySnapshot(selectedId);
    const result = evaluateCalibrationActionGate({
      action,
      capability:
        capability === null
          ? null
          : {
              grantedScopes: capability.grantedScopes,
              flags: capability.flags,
            },
      context: null,
      binding: null,
    });
    // Only the permission and capability verdicts are meaningful here; the
    // context and binding refusals below them are artefacts of passing null.
    if (
      !result.allowed &&
      (result.code === 'capabilityUnknown' ||
        result.code === 'permissionDenied' ||
        result.code === 'capabilityDisabled')
    ) {
      return result;
    }
    return { allowed: true, code: null, message: null };
  };

  app.on('will-quit', () => {
    calibrationEngine.dispose();
    // These outlive individual requests, so they are cleared explicitly rather
    // than left to process teardown. A bed-clear acknowledgement in particular
    // is a claim about a machine's physical state and must not be reachable by
    // anything that runs after the app has decided to stop.
    forgetCalibrationProfileState();
    for (const controller of activeSyncControllers.values()) {
      controller.abort();
    }
    activeSyncControllers.clear();
    uploads.dispose();
    clearProfileCache();
  });

  function retargetElectronError(
    code: 'invalidRequest' | 'profileImportFailed',
  ): {
    domain: 'electron';
    code: 'invalidRequest' | 'profileImportFailed';
    message: string;
    action: string;
    part: null;
    setting: null;
  } {
    return {
      domain: 'electron',
      code,
      message:
        code === 'profileImportFailed'
          ? 'The selected profile is not a valid editable Snapmaker U1 3MF.'
          : 'The retarget request is no longer valid.',
      action: 'Try the operation again.',
      part: null,
      setting: null,
    };
  }

  const activeSyncContext = async (): Promise<{
    profileId: string;
    binding: string;
  } | null> => {
    const listed = await profiles.list();
    const profile = listed.profiles.find(
      (candidate) => candidate.id === listed.selectedProfileId,
    );
    if (
      !profile ||
      profile.status !== 'connected' ||
      !profile.availability.librarySync.available
    ) {
      return null;
    }
    const context = await profiles.getPersistedSyncBinding(profile.id);
    await sidecar.bindSyncProfile(
      profile.id,
      context.binding,
      Math.floor(Date.now() / 1000),
    );
    return { profileId: profile.id, binding: context.binding };
  };

  ipcMain.handle(IpcChannel.AppInfo, () => {
    const response: AppInfoResponse = {
      contractVersion: IPC_CONTRACT_VERSION,
      appVersion: app.getVersion(),
      platform: process.platform as 'win32' | 'darwin' | 'linux',
      electronVersion: process.versions.electron,
    };
    return ipcSchemas[IpcChannel.AppInfo].response.parse(response);
  });

  ipcMain.handle(
    IpcChannel.SidecarPing,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.SidecarPing].request.parse(rawRequest);
      // Probe the live sidecar. A failed handshake is reported as not-ok with a
      // null version rather than throwing, so the renderer can show a degraded
      // state instead of an error dialog.
      let sidecarVersion: string | null = null;
      let ok = false;
      let sceneCacheRecipe: string | undefined;
      try {
        const handshake = await sidecar.handshake();
        sidecarVersion = handshake.sidecarVersion;
        sceneCacheRecipe = handshake.sceneCacheRecipe;
        ok = true;
      } catch {
        ok = false;
      }
      // Adoption is deliberately outside the health `try`: a cache failure is
      // not a sidecar failure, and running it inside let a healthy sidecar be
      // reported as down (#84 review, N9). Its own guard is what makes that
      // separation total rather than positional - without it the handler
      // rejects instead of reporting health, which is a worse outcome than the
      // one the move fixed. Startup adoption is guarded the same way above.
      if (ok) {
        try {
          await sceneCache.adoptRecipe(sceneCacheRecipe);
        } catch (error) {
          emitCalibrationLog({
            level: 'error',
            component: 'calibration.sidecar',
            event: 'sceneCache.recipeAdoptionFailed',
            ...describeCalibrationFailure(error),
            outcome: 'failed',
          });
        }
      }
      const response: SidecarPingResponse = {
        ok,
        nonce: request.nonce,
        sidecarVersion,
      };
      return ipcSchemas[IpcChannel.SidecarPing].response.parse(response);
    },
  );

  ipcMain.handle(IpcChannel.RetargetListProfiles, async () => {
    try {
      await retargetReady;
    } catch {
      return ipcSchemas[IpcChannel.RetargetListProfiles].response.parse({
        status: 'error',
        error: retargetWorkspaceFailure(),
      });
    }
    try {
      return ipcSchemas[IpcChannel.RetargetListProfiles].response.parse({
        status: 'ok',
        value: await refreshTargetProfiles(),
      });
    } catch (error) {
      return ipcSchemas[IpcChannel.RetargetListProfiles].response.parse({
        status: 'error',
        error: targetProfileFailure(error),
      });
    }
  });

  ipcMain.handle(IpcChannel.RetargetImportProfile, async (event) => {
    try {
      await retargetReady;
    } catch {
      return ipcSchemas[IpcChannel.RetargetImportProfile].response.parse({
        status: 'error',
        error: retargetWorkspaceFailure(),
      });
    }
    try {
      if (!targetProfilesInitialized) {
        await refreshTargetProfiles();
      }
    } catch (error) {
      return ipcSchemas[IpcChannel.RetargetImportProfile].response.parse({
        status: 'error',
        error: targetProfileFailure(error),
      });
    }
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner) {
      return ipcSchemas[IpcChannel.RetargetImportProfile].response.parse({
        status: 'error',
        error: retargetElectronError('invalidRequest'),
      });
    }
    const picked = await retargetDialogService.showOpenDialog(owner, {
      title: 'Import Snapmaker U1 reference',
      properties: ['openFile'],
      filters: [{ name: 'Editable Snapmaker U1 3MF', extensions: ['3mf'] }],
    });
    if (picked.canceled || picked.filePaths.length !== 1) {
      return ipcSchemas[IpcChannel.RetargetImportProfile].response.parse({
        status: 'canceled',
      });
    }
    try {
      const result = await targetProfiles.importFile(picked.filePaths[0]!);
      return ipcSchemas[IpcChannel.RetargetImportProfile].response.parse({
        status: 'ok',
        ...result,
      });
    } catch {
      return ipcSchemas[IpcChannel.RetargetImportProfile].response.parse({
        status: 'error',
        error: retargetElectronError('profileImportFailed'),
      });
    }
  });

  ipcMain.handle(
    IpcChannel.RetargetPreflight,
    async (event, rawRequest: unknown) => {
      try {
        await retargetReady;
      } catch {
        return ipcSchemas[IpcChannel.RetargetPreflight].response.parse({
          status: 'error',
          error: retargetWorkspaceFailure(),
        });
      }
      const request =
        ipcSchemas[IpcChannel.RetargetPreflight].request.parse(rawRequest);
      if (!retargetOwnerCleanup.has(event.sender)) {
        retargetOwnerCleanup.add(event.sender);
        const ownerId = event.sender.id;
        event.sender.once('destroyed', () => {
          // `disposeOwner()` is the same reaper as `initialize()` (#178) and
          // fails the same way on filesystem contention. It is invoked from a
          // `'destroyed'` listener, so unlike `retargetReady` there is never a
          // later awaiter to receive the rejection — the handler here is the
          // only one this call can ever get.
          void retargetArtifacts
            .disposeOwner(ownerId)
            .catch((error: unknown) => {
              emitCalibrationLog({
                level: 'error',
                component: 'calibration.sidecar',
                event: 'retargetArtifacts.ownerDisposalFailed',
                ...describeCalibrationFailure(error),
                outcome: 'failed',
              });
            });
        });
      }
      const response = await retargetArtifacts.preflight(
        event.sender.id,
        request,
      );
      return ipcSchemas[IpcChannel.RetargetPreflight].response.parse(response);
    },
  );
  ipcMain.handle(
    IpcChannel.RetargetBuild,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RetargetBuild].request.parse(rawRequest);
      const response = await retargetArtifacts.build(event.sender.id, request);
      return ipcSchemas[IpcChannel.RetargetBuild].response.parse(response);
    },
  );
  ipcMain.handle(
    IpcChannel.RetargetLoadScene,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RetargetLoadScene].request.parse(rawRequest);
      const response = await retargetArtifacts.loadScene(
        event.sender.id,
        request,
      );
      return ipcSchemas[IpcChannel.RetargetLoadScene].response.parse(response);
    },
  );
  ipcMain.handle(
    IpcChannel.RetargetSaveAs,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RetargetSaveAs].request.parse(rawRequest);
      const owner = BrowserWindow.fromWebContents(event.sender);
      const response = owner
        ? await retargetArtifacts.saveAs(event.sender.id, request.token, owner)
        : { status: 'error', error: retargetElectronError('invalidRequest') };
      return ipcSchemas[IpcChannel.RetargetSaveAs].response.parse(response);
    },
  );
  ipcMain.handle(
    IpcChannel.RetargetDispose,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RetargetDispose].request.parse(rawRequest);
      const response = await retargetArtifacts.disposeForOwner(
        event.sender.id,
        request.token,
      );
      return ipcSchemas[IpcChannel.RetargetDispose].response.parse(response);
    },
  );

  ipcMain.handle(
    IpcChannel.LoadScene,
    createLoadSceneHandler(authorizeRendererFile, sceneCache),
  );

  ipcMain.handle(
    IpcChannel.ExtractVendorMetadata,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.ExtractVendorMetadata].request.parse(rawRequest);
      const approvedPath = await authorizeRendererFile(request.path);
      const raw = await sidecar.extractVendorMetadata(approvedPath);
      return ipcSchemas[IpcChannel.ExtractVendorMetadata].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.ExtractVendorPlateThumbnails,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.ExtractVendorPlateThumbnails].request.parse(
          rawRequest,
        );
      const approvedPath = await authorizeRendererFile(request.path);
      const raw = await sidecar.extractVendorPlateThumbnails(approvedPath);
      return ipcSchemas[IpcChannel.ExtractVendorPlateThumbnails].response.parse(
        raw,
      );
    },
  );

  ipcMain.handle(
    IpcChannel.RenderThumbnail,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RenderThumbnail].request.parse(rawRequest);
      const approvedPath = await authorizeRendererFile(request.path);
      const raw = await sidecar.renderThumbnail(approvedPath, request.size);
      return ipcSchemas[IpcChannel.RenderThumbnail].response.parse(raw);
    },
  );

  ipcMain.handle(IpcChannel.ScanRoot, async (_event, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.ScanRoot].request.parse(rawRequest);
    const approvedPath = await approvals.resolve(request.approvalId);
    const raw = await sidecar.scanRoot(request.rootId, approvedPath);
    return ipcSchemas[IpcChannel.ScanRoot].response.parse(raw);
  });

  ipcMain.handle(
    IpcChannel.PreviewImport,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.PreviewImport].request.parse(rawRequest);
      const approvedPath = await approvals.resolve(request.approvalId);
      const raw = await sidecar.previewImport(approvedPath);
      return ipcSchemas[IpcChannel.PreviewImport].response.parse(raw);
    },
  );

  ipcMain.handle(IpcChannel.ImportRoot, async (_event, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.ImportRoot].request.parse(rawRequest);
    const approvedPath = await approvals.resolve(request.approvalId);
    const raw = await sidecar.importRoot(
      request.rootId,
      approvedPath,
      request.rules,
      request.commonTags,
    );
    return ipcSchemas[IpcChannel.ImportRoot].response.parse(raw);
  });

  ipcMain.handle(IpcChannel.ListModels, async () => {
    const raw = await sidecar.listModels();
    const models = ListModelsResponse.parse(raw);
    const filtered = await Promise.all(
      models.map(async (model) => ({
        ...model,
        locations: await Promise.all(
          model.locations.map(async (location) => {
            if (!location.available) {
              return {
                ...location,
                path: path.basename(location.path),
                available: false,
              };
            }
            try {
              const approved = await approvals.authorizeFile(location.path);
              return { ...location, path: approved.canonicalPath };
            } catch {
              return {
                ...location,
                path: path.basename(location.path),
                available: false,
              };
            }
          }),
        ),
      })),
    );
    return ipcSchemas[IpcChannel.ListModels].response.parse(filtered);
  });

  ipcMain.handle(IpcChannel.ResetCatalog, async () => {
    const raw = await sidecar.resetCatalog();
    const response = ipcSchemas[IpcChannel.ResetCatalog].response.parse(raw);
    await resetApprovedRootsAndArtifacts();
    return response;
  });

  ipcMain.handle(IpcChannel.ListFavorites, async () => {
    const raw = await sidecar.listFavorites();
    return ipcSchemas[IpcChannel.ListFavorites].response.parse(raw);
  });

  ipcMain.handle(
    IpcChannel.AddFavorite,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.AddFavorite].request.parse(rawRequest);
      const raw = await sidecar.addFavorite(request.hash);
      return ipcSchemas[IpcChannel.AddFavorite].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.RemoveFavorite,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RemoveFavorite].request.parse(rawRequest);
      const raw = await sidecar.removeFavorite(request.hash);
      return ipcSchemas[IpcChannel.RemoveFavorite].response.parse(raw);
    },
  );

  ipcMain.handle(IpcChannel.ListTags, async () => {
    const raw = await sidecar.listTags();
    return ipcSchemas[IpcChannel.ListTags].response.parse(raw);
  });

  ipcMain.handle(
    IpcChannel.TagsForModel,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.TagsForModel].request.parse(rawRequest);
      const raw = await sidecar.tagsForModel(request.hash);
      return ipcSchemas[IpcChannel.TagsForModel].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.AddModelTag,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.AddModelTag].request.parse(rawRequest);
      const raw = await sidecar.addModelTag(request.hash, request.name);
      return ipcSchemas[IpcChannel.AddModelTag].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.RemoveModelTag,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RemoveModelTag].request.parse(rawRequest);
      const raw = await sidecar.removeModelTag(request.hash, request.tagId);
      return ipcSchemas[IpcChannel.RemoveModelTag].response.parse(raw);
    },
  );

  ipcMain.handle(IpcChannel.ListCollections, async () => {
    const raw = await sidecar.listCollections();
    return ipcSchemas[IpcChannel.ListCollections].response.parse(raw);
  });

  ipcMain.handle(
    IpcChannel.CollectionsForModel,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CollectionsForModel].request.parse(rawRequest);
      const raw = await sidecar.collectionsForModel(request.hash);
      return ipcSchemas[IpcChannel.CollectionsForModel].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.CreateCollection,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CreateCollection].request.parse(rawRequest);
      const context = await activeSyncContext();
      const raw = context
        ? await sidecar.createCollectionWithSync(
            request.name,
            context.profileId,
            context.binding,
            Math.floor(Date.now() / 1000),
          )
        : await sidecar.createCollection(request.name);
      return ipcSchemas[IpcChannel.CreateCollection].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.DeleteCollection,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.DeleteCollection].request.parse(rawRequest);
      const context = await activeSyncContext();
      const raw = context
        ? await sidecar.deleteCollectionWithSync(
            request.id,
            context.profileId,
            context.binding,
            Math.floor(Date.now() / 1000),
          )
        : await sidecar.deleteCollection(request.id);
      return ipcSchemas[IpcChannel.DeleteCollection].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.AddModelToCollection,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.AddModelToCollection].request.parse(rawRequest);
      const context = await activeSyncContext();
      const raw = context
        ? await sidecar.addModelToCollectionWithSync(
            request.collectionId,
            request.hash,
            context.profileId,
            context.binding,
            Math.floor(Date.now() / 1000),
          )
        : await sidecar.addModelToCollection(
            request.collectionId,
            request.hash,
          );
      return ipcSchemas[IpcChannel.AddModelToCollection].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.RemoveModelFromCollection,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RemoveModelFromCollection].request.parse(
          rawRequest,
        );
      const context = await activeSyncContext();
      const raw = context
        ? await sidecar.removeModelFromCollectionWithSync(
            request.collectionId,
            request.hash,
            context.profileId,
            context.binding,
            Math.floor(Date.now() / 1000),
          )
        : await sidecar.removeModelFromCollection(
            request.collectionId,
            request.hash,
          );
      return ipcSchemas[IpcChannel.RemoveModelFromCollection].response.parse(
        raw,
      );
    },
  );

  ipcMain.handle(IpcChannel.OpenFolder, async (event) => {
    // Same trust model as OpenModelFile: the renderer can only ask us to show
    // the OS picker; we return only the directory the user explicitly chose.
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Add model folder',
      properties: ['openDirectory' as const],
    };
    const result =
      retargetDialogService === dialog
        ? owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options)
        : owner
          ? await retargetDialogService.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);

    const selectedPath =
      result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0]!;
    const approval = selectedPath
      ? await approvals.approveFromPicker(selectedPath)
      : null;
    const selected = approval
      ? { path: approval.canonicalPath, approvalId: approval.id }
      : null;
    const response: OpenFolderResponse = selected;
    return ipcSchemas[IpcChannel.OpenFolder].response.parse(response);
  });

  ipcMain.handle(IpcChannel.OpenModelFile, async (event) => {
    // The renderer cannot name a path; it can only ask us to show the OS file
    // picker, and we return only what the user explicitly selected.
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Open 3D model',
      properties: ['openFile' as const],
      filters: [
        { name: '3D models', extensions: ['stl', '3mf', 'obj'] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);

    const selectedPath =
      result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0]!;
    const canonicalPath = selectedPath
      ? await approvals.canonicalizePickerFile(selectedPath)
      : null;
    if (canonicalPath) {
      approvedPickerFiles.add(canonicalPath);
    }
    const approvalId = canonicalPath ? randomUUID() : null;
    const selected =
      canonicalPath && approvalId ? { path: canonicalPath, approvalId } : null;
    const response: OpenModelFileResponse = selected;
    return ipcSchemas[IpcChannel.OpenModelFile].response.parse(response);
  });

  ipcMain.handle(IpcChannel.ListServerProfiles, async () => {
    const response = await profiles.list();
    return ipcSchemas[IpcChannel.ListServerProfiles].response.parse(response);
  });

  ipcMain.handle(
    IpcChannel.TestServerProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.TestServerProfile].request.parse(rawRequest);
      const response = await profiles.test(request);
      return ipcSchemas[IpcChannel.TestServerProfile].response.parse(response);
    },
  );

  ipcMain.handle(
    IpcChannel.SaveServerProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.SaveServerProfile].request.parse(rawRequest);
      // Updating a profile in place preserves its UUID while changing the
      // server URL, credential or principal behind it. Profile-scoped evidence
      // must be stranded before that same ID can name the replacement binding.
      if (request.id !== undefined) {
        forgetCalibrationProfileState(request.id);
      }
      const response = await profiles.save(request);
      return ipcSchemas[IpcChannel.SaveServerProfile].response.parse(response);
    },
  );

  ipcMain.handle(
    IpcChannel.SelectServerProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.SelectServerProfile].request.parse(rawRequest);
      // Everything observed for calibration describes one farm and one account.
      // Selecting a different profile makes all of it wrong, and wrong in the
      // dangerous direction: a permissive snapshot left in place would let the
      // previous farm's permissions authorise a mutation against the new one
      // while its own negotiation is still in flight or has failed.
      //
      // Cleared before the switch, so there is no instant at which the new
      // selection is current and the old evidence is still readable.
      forgetCalibrationProfileState();
      const response = await profiles.select(request.id);
      return ipcSchemas[IpcChannel.SelectServerProfile].response.parse(
        response,
      );
    },
  );

  ipcMain.handle(
    IpcChannel.DeleteServerProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.DeleteServerProfile].request.parse(rawRequest);
      // A deleted profile may also have been the selected one, and deletion can
      // change which profile is selected. Forgetting unconditionally is correct
      // either way: nothing observed for a profile that no longer exists is
      // usable, and keeping it could only ever authorise something.
      forgetCalibrationProfileState(request.id);
      const response = await profiles.delete(request.id);
      return ipcSchemas[IpcChannel.DeleteServerProfile].response.parse(
        response,
      );
    },
  );

  ipcMain.handle(
    IpcChannel.StartUploadJob,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.StartUploadJob].request.parse(rawRequest);
      const response = await uploads.start(request);
      return ipcSchemas[IpcChannel.StartUploadJob].response.parse(response);
    },
  );

  ipcMain.handle(IpcChannel.ListUploadJobs, async () => {
    const response = await uploads.list();
    return ipcSchemas[IpcChannel.ListUploadJobs].response.parse(response);
  });

  for (const [channel, action] of [
    [IpcChannel.PauseUploadJob, (id: string) => uploads.pause(id)],
    [IpcChannel.ResumeUploadJob, (id: string) => uploads.resume(id)],
    [IpcChannel.CancelUploadJob, (id: string) => uploads.cancel(id)],
    [IpcChannel.RetryUploadJob, (id: string) => uploads.retry(id)],
    [
      IpcChannel.ConfirmLegacyUploadRetry,
      (id: string) => uploads.confirmLegacyRetry(id),
    ],
  ] as const) {
    ipcMain.handle(channel, async (_event, rawRequest: unknown) => {
      const request = ipcSchemas[channel].request.parse(rawRequest);
      const response = await action(request.jobId);
      return ipcSchemas[channel].response.parse(response);
    });
  }

  ipcMain.handle(
    IpcChannel.RemoveUploadJob,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RemoveUploadJob].request.parse(rawRequest);
      const response = await uploads.remove(request.jobId);
      return ipcSchemas[IpcChannel.RemoveUploadJob].response.parse(response);
    },
  );

  ipcMain.handle(IpcChannel.ResetUploadJobs, async () => {
    const response = await uploads.reset();
    return ipcSchemas[IpcChannel.ResetUploadJobs].response.parse(response);
  });

  ipcMain.handle(IpcChannel.ResetApprovedRoots, async () => {
    // The shared reset clears both grant sources — persisted root approvals and
    // the in-memory picker allowlist — and each is pinned by an independent
    // authorization test.
    //
    // Scenes derived under those grants are artifacts of them, so they are
    // shredded here for symmetry. Awaited rather than fired off, and unguarded
    // rather than best-effort: a reset that reports success while derived
    // scenes remain on disk is reporting something that did not happen.
    await resetApprovedRootsAndArtifacts();
    return ipcSchemas[IpcChannel.ResetApprovedRoots].response.parse({
      reset: true,
    });
  });

  // --- Printer Calibration transport handlers (issue #52) -----------------
  //
  // Real implementations backed by CalibrationHttpClient +
  // CalibrationSyncEngine. Every request is validated before acting.
  // The renderer never receives credentials, raw JWT tokens, or arbitrary
  // file/network primitives. All HTTP routes are fixed in calibrationHttp.ts.

  registerCalibrationHandler(
    IpcChannel.CalibrationGetAvailability,
    async () => {
      // Real capability negotiation: fetch the calibration capabilities endpoint
      // from the selected server profile and validate the flags calibration
      // cannot run without. Optional feature switches (photos, generation) are
      // reported through `capabilityFlags` so the workspace can narrow what it
      // offers rather than refusing to open.
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse(
          {
            available: false,
            unavailableReason: 'noProfile',
            unavailableDetail: 'No server profile is selected.',
            negotiatedApiVersion: null,
            negotiatedSchemaVersion: null,
            capabilityFlags: null,
            grantedScopes: null,
            offlineEditingEnabled: false,
            serverUnavailableReasons: [],
          },
        );
      }

      const projectAvailability = (caps: RemoteCalibrationCapabilities) => {
        const missingFlags = missingCalibrationFlags(caps);
        const firmwareOk = supportsKlipper(caps);
        const slicerOk = supportsOrcaSlicer(caps);
        // Discovery needs exactly one permission: `calibration:read`. Requiring
        // more to *open* the workspace would refuse an operator who is allowed to
        // look but not change. Create, update, generate and queue actions remain
        // gated separately, each by its own exact permission.
        const readPermitted = hasCalibrationPermission(
          caps.grantedScopes,
          CALIBRATION_PERMISSIONS.read,
        );

        if (!readPermitted) {
          return ipcSchemas[
            IpcChannel.CalibrationGetAvailability
          ].response.parse({
            available: false,
            unavailableReason: 'missingScopes',
            unavailableDetail: `This PrintFarmer account does not grant ${CALIBRATION_PERMISSIONS.read}, which is required to list printers for calibration. Ask a farm administrator to grant it.`,
            negotiatedApiVersion: caps.apiVersion,
            negotiatedSchemaVersion: caps.schemaVersion,
            capabilityFlags: caps.flags,
            grantedScopes: caps.grantedScopes,
            offlineEditingEnabled: false,
            serverUnavailableReasons: caps.unavailableReasons,
          });
        }

        if (missingFlags.length > 0 || !firmwareOk || !slicerOk) {
          return ipcSchemas[
            IpcChannel.CalibrationGetAvailability
          ].response.parse({
            available: false,
            unavailableReason: !firmwareOk
              ? 'unsupportedFirmware'
              : !slicerOk
                ? 'unsupportedSlicer'
                : 'missingCapabilityFlags',
            unavailableDetail: !firmwareOk
              ? `Server does not advertise ${REQUIRED_FIRMWARE_FAMILY} firmware and G-code dialect support for calibration.`
              : !slicerOk
                ? `Server does not advertise a supported ${REQUIRED_SLICER_ENGINE} engine for calibration.`
                : `Server has not enabled calibration capabilities required to run calibration at all: ${missingFlags.join(', ')}.`,
            negotiatedApiVersion: caps.apiVersion,
            negotiatedSchemaVersion: caps.schemaVersion,
            capabilityFlags: caps.flags,
            grantedScopes: caps.grantedScopes,
            offlineEditingEnabled: caps.flags.calibrationOfflineDraftEnabled,
            serverUnavailableReasons: caps.unavailableReasons,
          });
        }

        return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse(
          {
            available: true,
            unavailableReason: null,
            unavailableDetail: null,
            negotiatedApiVersion: caps.apiVersion,
            negotiatedSchemaVersion: caps.schemaVersion,
            capabilityFlags: caps.flags,
            grantedScopes: caps.grantedScopes,
            offlineEditingEnabled: caps.flags.calibrationOfflineDraftEnabled,
            // Passed through even when calibration is available so the
            // renderer can still surface a disabled feature the operator
            // will hit later (e.g. `calibrationGeneration` off).
            serverUnavailableReasons: caps.unavailableReasons,
          },
        );
      };

      const signal = AbortSignal.timeout(10_000);
      // Cleared *before* the fetch, not after it. The window between starting a
      // negotiation and failing it is exactly when a gate would otherwise read
      // the previously selected profile's snapshot and authorise a mutation
      // against this one. Clearing first means a fetch that fails, times out or
      // is refused leaves no evidence at all, which is the fail-closed answer.
      const negotiationToken =
        calibrationDiagnostics.beginCapabilityNegotiation();
      try {
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const caps = await calibrationHttp.getCapabilities(
          selectedId,
          ctx.profile.baseUrl,
          signal,
        );
        // Snapshot the negotiation so diagnostics can report capability health
        // without a network call — which is exactly when it is needed. Bound to
        // the profile it describes and to the negotiation that asked, so neither
        // another profile's gate nor a completion that has been overtaken can
        // read or write it.
        calibrationDiagnostics.recordCapabilities(
          negotiationToken,
          selectedId,
          caps,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'capabilities.negotiated',
          profileId: selectedId,
          outcome: 'ok',
        });
        return projectAvailability(caps);
      } catch (error) {
        // A refusal is not a legacy server. Mapping every non-404 onto
        // `legacyServer` told an operator whose access had been revoked that their
        // PrintFarmer was too old, and skipped the invalidation a refusal
        // demands. Auth failures are classified as what they are and run the same
        // non-replaying state discard as every other 403 — without recursing into
        // a capability refresh, since the capability endpoint is what just refused.
        if (isUnauthenticated(error)) {
          // An expired or revoked token is recoverable without the operator
          // doing anything, so recovery is attempted once. Its own capability
          // read is what settles the answer; it cannot recurse, because a second
          // 401 terminates it.
          const outcome = await noteCalibrationUnauthenticated(selectedId);
          if (outcome.authenticated && outcome.evidence !== null) {
            return projectAvailability(outcome.evidence);
          }
          return ipcSchemas[
            IpcChannel.CalibrationGetAvailability
          ].response.parse({
            available: false,
            unavailableReason: 'sessionExpired',
            unavailableDetail: `PrintFarmer rejected this session's credentials. ${REAUTHENTICATION_REQUIRED}`,
            negotiatedApiVersion: null,
            negotiatedSchemaVersion: null,
            capabilityFlags: null,
            grantedScopes: null,
            offlineEditingEnabled: false,
            serverUnavailableReasons: [],
          });
        }
        if (isForbidden(error)) {
          calibrationStateEpoch += 1;
          calibrationDiagnostics.clearCapabilities();
          bedClearLedger.clear();
          clearProfileCache();
          selectionCache.forgetProfile(selectedId);
          abortActiveCalibrationSyncs();
          return ipcSchemas[
            IpcChannel.CalibrationGetAvailability
          ].response.parse({
            available: false,
            unavailableReason: 'missingScopes',
            unavailableDetail: `PrintFarmer refused this session's calibration capability request. ${ACCESS_MAY_HAVE_CHANGED}`,
            negotiatedApiVersion: null,
            negotiatedSchemaVersion: null,
            capabilityFlags: null,
            grantedScopes: null,
            offlineEditingEnabled: false,
            serverUnavailableReasons: [],
          });
        }
        const reason =
          error instanceof CalibrationHttpError && error.code === 'notFound'
            ? 'serverVersionTooLow'
            : 'legacyServer';
        const detail =
          error instanceof Error
            ? error.message
            : 'Could not reach calibration capabilities endpoint.';
        return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse(
          {
            available: false,
            unavailableReason: reason,
            unavailableDetail: detail,
            negotiatedApiVersion: null,
            negotiatedSchemaVersion: null,
            capabilityFlags: null,
            grantedScopes: null,
            offlineEditingEnabled: false,
            serverUnavailableReasons: [],
          },
        );
      }
    },
  );

  // Calibration channels that require a valid server profile and IPC request.
  // Each validates its request schema before dispatching.

  registerCalibrationHandler(
    IpcChannel.CalibrationListPrinters,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListPrinters].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const entryEpoch = calibrationStateEpoch;
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const printers = await calibrationHttp.getPrinters(
        selectedId,
        ctx.profile.baseUrl,
        signal,
      );
      // Under Path D the server no longer runs an eligibility screen: every
      // printer returned by `GET /api/printers` is a valid candidate. The
      // `CompletePrinterDto` also carries `modelId` directly, so the extra
      // per-printer `/details` round-trip the old candidates route needed is
      // gone with it — the primary list already provides the Guid the
      // renderer's cascading profile picker needs to call
      // `/for-model/{modelId}`. `printerModelId: null` still means "model
      // unknown, permissive fallback" (see the renderer's
      // `profileSelection.ts` for the null-branch rationale).
      //
      // Projected and validated one candidate at a time, for the same reason
      // the wire layer parses them one at a time: the response schema covers
      // the whole list, so a single candidate this projection cannot render
      // would otherwise fail `.parse` and discard every healthy printer with
      // it. A candidate that fails here joins the ones that failed upstream:
      // dropped alone, and counted.
      //
      // Retired/maintenance printers are excluded here rather than shown as
      // "not eligible" — the eligibility surface they used to reason against
      // no longer exists.
      const projected: unknown[] = [];
      const renderableCandidates: RemoteCalibrationPrinterCandidate[] = [];
      let unprojectable = 0;
      for (const printer of printers.printers) {
        if (!printer.isEnabled || printer.inMaintenance) continue;
        const candidate = CalibrationPrinterCandidate.safeParse({
          printerId: printer.printerId,
          displayName: printer.displayName,
          printerModel: printer.printerModel,
          printerModelId: printer.printerModelId,
          isOnline: printer.isOnline,
        });
        if (candidate.success) {
          projected.push(candidate.data);
          renderableCandidates.push(printer);
        } else {
          unprojectable += 1;
        }
      }
      const printersUnreadable = printers.unreadable + unprojectable;
      if (calibrationStateEpoch === entryEpoch) {
        selectionCache.rememberCandidates(selectedId, entryEpoch, {
          candidates: renderableCandidates,
          unreadable: printersUnreadable,
          truncated: printers.truncated,
        });
      }
      return ipcSchemas[IpcChannel.CalibrationListPrinters].response.parse({
        printers: projected,
        printersTruncated: printers.truncated,
        // Both losses are the same loss to the operator: a printer the server
        // named that this client cannot show.
        printersUnreadable,
        fetchedAt: new Date().toISOString(),
      });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetPrinterContext,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetPrinterContext].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const entryEpoch = calibrationStateEpoch;
      const selectedCandidate = selectionCache.selectedCandidate(
        selectedId,
        request.printerId,
        entryEpoch,
      );
      const candidate = selectedCandidate?.candidate ?? null;
      // Under Path D there is no server-side eligibility verdict to gate on:
      // the candidate list already excludes disabled and in-maintenance
      // printers. The remaining preconditions are that the operator did in
      // fact see this printer in the current candidate observation, that it
      // is reachable, and that any `configurationRevision` the caller carried
      // matches whatever the candidate saw. The candidate list under Path D
      // does not expose a revision, so the third clause always short-circuits
      // when the caller supplies one — that is the intended failure mode of
      // the removed `calibration-context` route, surfaced as a selection
      // error rather than a silent 404.
      const candidateConfigurationRevision =
        candidate?.configurationRevision ?? null;
      if (
        candidate === null ||
        !candidate.isOnline ||
        (request.configurationRevision !== undefined &&
          request.configurationRevision !== candidateConfigurationRevision)
      ) {
        throw Object.assign(
          new Error(
            'Select one printer from the current candidate list before loading its context.',
          ),
          { code: 'CALIBRATION_PRINTER_SELECTION_REQUIRED' },
        );
      }
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const context = await calibrationHttp.getPrinterContext(
        selectedId,
        ctx.profile.baseUrl,
        request.printerId,
        signal,
        candidateConfigurationRevision ?? undefined,
      );
      if (
        context.printerId !== request.printerId ||
        (candidateConfigurationRevision !== null &&
          context.configurationRevision !== candidateConfigurationRevision) ||
        selectedCandidate === null ||
        calibrationStateEpoch !== entryEpoch ||
        !selectionCache.rememberSelectedContext(
          selectedId,
          entryEpoch,
          selectedCandidate.generation,
          context,
        )
      ) {
        throw Object.assign(
          new Error(
            'The selected printer or its configuration changed while its context was loading.',
          ),
          { code: 'CALIBRATION_PRINTER_SELECTION_CHANGED' },
        );
      }
      return ipcSchemas[IpcChannel.CalibrationGetPrinterContext].response.parse(
        projectCalibrationPrinterContext(context),
      );
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationListWorkspaceStates,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListWorkspaceStates].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const states = await sidecar.listCalibrationWorkspaceStates(selectedId);
      const unhydratedProjects =
        await sidecar.listCalibrationUnhydratedProjects(selectedId);
      return ipcSchemas[
        IpcChannel.CalibrationListWorkspaceStates
      ].response.parse({ states, unhydratedProjects });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetWorkspaceState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetWorkspaceState].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const state = await sidecar.getCalibrationWorkspaceState(
        selectedId,
        request.projectId,
      );
      return ipcSchemas[IpcChannel.CalibrationGetWorkspaceState].response.parse(
        state,
      );
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSaveWorkspaceState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSaveWorkspaceState].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const rawExisting = await sidecar.getCalibrationWorkspaceState(
        selectedId,
        request.projectId,
      );
      const existing =
        ipcSchemas[IpcChannel.CalibrationGetWorkspaceState].response.parse(
          rawExisting,
        );
      // Only *creating* a workspace is gated here, and only when this is
      // genuinely a creation — decided from the local sidecar rather than from
      // the payload, which the party being gated supplies and could otherwise
      // use to choose which check it faces.
      //
      // Saving an existing workspace is deliberately **not** gated on a server
      // permission. This channel writes the local sidecar and queues the
      // outbox; it dispatches nothing. Capability evidence is process-local, so
      // after an offline restart there is none, and requiring it here would
      // block every draft autosave — breaking the contract that existing
      // offline drafts survive a restart and stay editable. What that editing
      // may change is still constrained: `resolveCalibrationWorkspaceFreshness`
      // below permits a transient offline save only while the binding and base
      // profile are unchanged, and requires an authoritative online context for
      // anything that alters them.
      //
      // `calibration:update` is enforced where the outbox actually reaches the
      // server, in `CalibrationSyncNow`, which is the boundary that mutates it.
      if (existing === null) {
        const permission = gateCalibrationPermission(
          'createProject',
          selectedId,
        );
        if (!permission.allowed) {
          throw Object.assign(
            new Error(
              permission.message ??
                'Creating a calibration project is not permitted.',
            ),
            { code: 'CALIBRATION_FORBIDDEN' },
          );
        }
      }
      const printerContextFresh = await resolveCalibrationWorkspaceFreshness(
        request,
        existing,
        async () => {
          const signal = AbortSignal.timeout(10_000);
          const profileContext =
            await profiles.getAuthenticatedContext(selectedId);
          return calibrationHttp.getPrinterContext(
            selectedId,
            profileContext.profile.baseUrl,
            request.printerId,
            signal,
          );
        },
      );
      const state = await sidecar.saveCalibrationWorkspaceState(
        prepareCalibrationWorkspaceSave(
          request,
          selectedId,
          printerContextFresh,
        ),
      );
      return ipcSchemas[
        IpcChannel.CalibrationSaveWorkspaceState
      ].response.parse({ state, queued: true });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSyncNow,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const syncEpoch = calibrationStateEpoch;
      // Sync applies the local outbox to the server. It mutates, so it is gated
      // before any controller is created or any request is sent.
      const permission = gateCalibrationPermission('sync', selectedId);
      if (!permission.allowed) {
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
          phase: 'failed',
          profileId: selectedId,
          projectId: request.projectId ?? null,
          pushedOperations: 0,
          pulledChanges: 0,
          conflictCount: 0,
          cursor: null,
          error:
            permission.message ??
            'Calibration synchronization is not permitted.',
        });
      }
      // A sync can push a locally queued mutation, so each included workspace is
      // re-bound to one exact authoritative context before the sidecar is allowed
      // to dispatch anything. Old/offline drafts remain editable, but cannot sync
      // until they carry the exact machine/process/filament profile triple.
      const rawStates =
        request.projectId === undefined
          ? await sidecar.listCalibrationWorkspaceStates(selectedId)
          : [
              await sidecar.getCalibrationWorkspaceState(
                selectedId,
                request.projectId,
              ),
            ];
      const states = rawStates
        .map((rawState) =>
          ipcSchemas[
            IpcChannel.CalibrationGetWorkspaceState
          ].response.safeParse(rawState),
        )
        .map((parsed) => (parsed.success ? parsed.data : null));
      if (
        states.some((state) => state === null) ||
        (request.projectId !== undefined && states.length !== 1)
      ) {
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
          phase: 'failed',
          profileId: selectedId,
          projectId: request.projectId ?? null,
          pushedOperations: 0,
          pulledChanges: 0,
          conflictCount: 0,
          cursor: null,
          error:
            'Calibration synchronization requires a valid local workspace state.',
        });
      }
      const profileContext = await profiles.getAuthenticatedContext(selectedId);
      try {
        for (const state of states) {
          if (state === null) continue;
          const binding = state.workspaceState.domainState.binding;
          const currentContext = await calibrationHttp.getPrinterContext(
            selectedId,
            profileContext.profile.baseUrl,
            binding.printer.backendPrinterId,
            AbortSignal.timeout(15_000),
            binding.printer.printerConfigurationRevision,
          );
          if (
            !doesCalibrationWorkspacePayloadMatchContext(
              state.workspaceState,
              currentContext,
            )
          ) {
            return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
              phase: 'failed',
              profileId: selectedId,
              projectId: request.projectId ?? null,
              pushedOperations: 0,
              pulledChanges: 0,
              conflictCount: 0,
              cursor: null,
              error:
                'Calibration synchronization was refused because the authoritative printer or profile binding changed.',
            });
          }
        }
      } catch (error) {
        await noteCalibrationAccessFailure(selectedId, error);
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
          phase: 'failed',
          profileId: selectedId,
          projectId: request.projectId ?? null,
          pushedOperations: 0,
          pulledChanges: 0,
          conflictCount: 0,
          cursor: null,
          error:
            'Calibration synchronization could not verify the authoritative printer context.',
        });
      }
      if (!calibrationStateUnchanged(syncEpoch, selectedId, 'sync')) {
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
          phase: 'failed',
          profileId: selectedId,
          projectId: request.projectId ?? null,
          pushedOperations: 0,
          pulledChanges: 0,
          conflictCount: 0,
          cursor: null,
          error:
            'Calibration synchronization was cancelled because its authorization state changed during verification.',
        });
      }
      // Cancel any existing sync for this profile.
      const syncKey = `${selectedId}:${request.projectId ?? 'all'}`;
      const existing = activeSyncControllers.get(syncKey);
      if (existing) {
        existing.abort();
        activeSyncControllers.delete(syncKey);
      }
      const controller = new AbortController();
      activeSyncControllers.set(syncKey, controller);
      try {
        // The engine emits the sync record and returns the typed error code for
        // *this* invocation. Reading it from the diagnostics singleton instead
        // was a race: that slot is shared, so two concurrent syncs could make one
        // miss its own refusal or act on the other's.
        const outcome = await calibrationEngine.syncNow(
          selectedId,
          request.projectId ?? null,
          controller.signal,
          () => calibrationStateUnchanged(syncEpoch, selectedId, 'sync'),
        );
        const result = outcome.status;
        // The outbox operation is not replayed. Correcting the evidence is a
        // read; pushing the operator's queued changes again is not, and doing it
        // because a permission check changed its mind would act on their behalf.
        // A rejected token is treated the same way: recovery re-establishes
        // identity, and the operator decides whether to push again.
        const syncFailureKind =
          result.phase !== 'failed'
            ? 'none'
            : outcome.errorCode === 'authorization' ||
                outcome.errorCode === 'forbidden'
              ? 'forbidden'
              : outcome.errorCode === 'authentication'
                ? 'unauthenticated'
                : 'none';
        if (syncFailureKind !== 'none') {
          const accessFailure = await applyCalibrationAccessFailure(
            selectedId,
            syncFailureKind,
          );
          const accessGuidance = accessFailureGuidance(accessFailure);
          return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
            ...result,
            error:
              accessGuidance !== ''
                ? `${result.error ?? 'Calibration synchronization was refused.'} ${accessGuidance}`
                : result.error,
          });
        }
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse(result);
      } finally {
        // Only if it is still ours. A later sync for the same key aborts and
        // replaces this controller, and an unconditional delete here would
        // remove *that* one — leaving the replacement uncancellable by a
        // subsequent profile switch.
        if (activeSyncControllers.get(syncKey) === controller) {
          activeSyncControllers.delete(syncKey);
        }
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetDiagnostics,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetDiagnostics].request.parse(
          rawRequest,
        );
      // Falls back to the selected profile rather than requiring one, so the
      // command still answers when no profile is selected — "no profile" is
      // itself a diagnosis.
      //
      // Not requiring a profile is not the same as accepting whichever one the
      // renderer names, and this handler used to do both (#157). `?? selected`
      // only needs the *fallback*; admitting an arbitrary `profileId` also made
      // this an enumeration oracle, answering with local outbox counts and
      // conflict metadata for profiles the user has not selected — reachable
      // from a renderer that never went near the profile switcher. Every other
      // profile-scoped calibration channel refuses that request; diagnostics
      // read it.
      //
      // The fence is therefore conditional rather than absent: omitting
      // `profileId` still diagnoses the current state, including the state of
      // having nothing selected, while naming a profile that is not the
      // selected one refuses exactly as the other 25 channels do.
      const profileList = await profiles.list();
      if (
        request.profileId !== undefined &&
        request.profileId !== profileList.selectedProfileId
      ) {
        throw Object.assign(
          new Error('Calibration request does not match the selected profile.'),
          { code: 'CALIBRATION_PROFILE_MISMATCH' },
        );
      }
      const profileId = request.profileId ?? profileList.selectedProfileId;
      const diagnostics = await calibrationDiagnostics.collect({
        profileId,
        projectId: request.projectId ?? null,
        outbox: calibrationSidecarAdapter,
      });
      return ipcSchemas[IpcChannel.CalibrationGetDiagnostics].response.parse(
        diagnostics,
      );
    },
  );

  // --- Conflict resolution (issue #762) -------------------------------------
  //
  // Restores the renderer-facing half of conflict resolution that PR #757
  // removed along with the old printer-calibration saga dashboard. The
  // main-process/sidecar/Rust resolve logic was never removed --
  // `calibrationSidecarAdapter.resolveCalibrationConflict` and
  // `.listCalibrationConflicts` (`calibrationService.ts`) already implement
  // both operations; these handlers add profile fencing and re-expose them as
  // IPC channels. Resolving a conflict mutates server state, so it is also
  // gated on `calibration:update` via `gateCalibrationPermission` before
  // dispatch (the same gate `CalibrationSyncNow` uses) -- listing conflicts is
  // a read and is not gated. Per-kind resolution policy (which resolutions are
  // valid for which conflict kind) is enforced in the sidecar's store, not
  // here (see the docstring on `SidecarCalibrationAdapter.resolveCalibrationConflict`).

  registerCalibrationHandler(
    IpcChannel.CalibrationResolveConflict,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationResolveConflict].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      // Resolving a conflict mutates server state (accepts a server revision,
      // records a new local revision, or applies a manual merge), so it is
      // gated the same way `sync` is -- before anything is dispatched.
      const permission = gateCalibrationPermission(
        'resolveConflict',
        selectedId,
      );
      if (!permission.allowed) {
        throw Object.assign(
          new Error(
            permission.message ?? 'Resolving this conflict is not permitted.',
          ),
          { code: 'CALIBRATION_FORBIDDEN' },
        );
      }
      const response =
        await calibrationSidecarAdapter.resolveCalibrationConflict(request);
      return ipcSchemas[IpcChannel.CalibrationResolveConflict].response.parse(
        response,
      );
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationListConflicts,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListConflicts].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const conflicts =
        await calibrationSidecarAdapter.listCalibrationConflicts(
          selectedId,
          request.projectId ?? null,
        );
      return ipcSchemas[IpcChannel.CalibrationListConflicts].response.parse({
        conflicts,
      });
    },
  );

  // Generation, queue, bed-clear, and print start require all mutations to be
  // synchronized and printer context to be freshly validated before proceeding.

  // --- Queue reconciliation (issue #54) ------------------------------------

  registerCalibrationHandler(
    IpcChannel.CalibrationPollQueueChanges,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationPollQueueChanges].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const signal = AbortSignal.timeout(15_000);
      try {
        const page = await calibrationHttp.getQueueChanges(
          selectedId,
          ctx.profile.baseUrl,
          request.afterSequence,
          request.limit ?? 200,
          signal,
        );
        // The cursor compared against is `request.afterSequence` — the cursor
        // THIS process sent — and never `page.afterSequence`, which the server
        // supplies in its own response and nothing ties to the request. A
        // server echoing `events[0].sequence - 1` would otherwise make the
        // cursor-gap check false however many events it skipped, so the one
        // check that exists to catch a skipped page could never fire (#429).
        // The same signature is produced by a merely truncated or
        // mis-paginated response, so this is not only a hostile-server concern.
        const cursorBoundaryGap = detectQueueChangeFeedGap(
          page.events,
          request.afterSequence,
        );
        // `page.nextSequence` is server-supplied and, until here, was adopted
        // by the caller verbatim as the *next* poll cursor with nothing tying
        // it to `page.events`. A server can advance it arbitrarily far beyond
        // the last event actually delivered on this page, silently steering
        // the cursor across responses so the next poll starts well past
        // events that were never sent — and the boundary check above cannot
        // see it, because it only inspects *this* page (#487). Clamp to the
        // highest sequence this response actually delivered (falling back to
        // the request cursor for an empty page), per the rule documented at
        // calibrationWire.ts's `RemoteJobQueueChangeFeedPage` but never
        // enforced. Also refuse to rewind the cursor backward past the one we
        // sent, which would otherwise cause a redelivery loop.
        const lastDeliveredSequence =
          page.events.at(-1)?.sequence ?? request.afterSequence;
        const sequenceAdvancedBeyondDelivered =
          page.nextSequence > lastDeliveredSequence;
        const gapDetected =
          cursorBoundaryGap || sequenceAdvancedBeyondDelivered;
        const nextSequence = Math.min(
          Math.max(page.nextSequence, request.afterSequence),
          lastDeliveredSequence,
        );
        return ipcSchemas[
          IpcChannel.CalibrationPollQueueChanges
        ].response.parse({
          status: 'ok',
          afterSequence: page.afterSequence,
          nextSequence,
          hasMore: page.hasMore,
          gapDetected,
          events: page.events,
        });
      } catch (error) {
        // Converted rather than rethrown, so the channel wrapper never sees
        // this. A refusal must still invalidate the evidence it contradicts —
        // handling it per action left a new hole every time a channel was added.
        // Nothing is replayed.
        const accessFailure = await noteCalibrationAccessFailure(
          selectedId,
          error,
        );
        const accessGuidance = accessFailureGuidance(accessFailure);
        const staleAccess = accessGuidance !== '';
        const apiError =
          error instanceof CalibrationHttpError
            ? // No reference: see the note on the print-start handler (#177).
              error.toApiError(null)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Queue change feed poll failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: null,
              };
        return ipcSchemas[
          IpcChannel.CalibrationPollQueueChanges
        ].response.parse({
          status: 'error',
          error: staleAccess
            ? {
                ...apiError,
                message: `${apiError.message} ${accessGuidance}`,
              }
            : apiError,
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetSubscriptionResources,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationGetSubscriptionResources
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const signal = AbortSignal.timeout(15_000);
      try {
        const resources = await calibrationHttp.getQueueSubscriptionResources(
          selectedId,
          ctx.profile.baseUrl,
          signal,
        );
        return ipcSchemas[
          IpcChannel.CalibrationGetSubscriptionResources
        ].response.parse({
          status: 'ok',
          printerIds: resources.printerIds,
          jobIds: resources.jobIds,
          projectIds: resources.projectIds,
        });
      } catch (error) {
        // Converted rather than rethrown, so the channel wrapper never sees
        // this. A refusal must still invalidate the evidence it contradicts —
        // handling it per action left a new hole every time a channel was added.
        // Nothing is replayed.
        const accessFailure = await noteCalibrationAccessFailure(
          selectedId,
          error,
        );
        const accessGuidance = accessFailureGuidance(accessFailure);
        const staleAccess = accessGuidance !== '';
        const apiError =
          error instanceof CalibrationHttpError
            ? // No reference: see the note on the print-start handler (#177).
              error.toApiError(null)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Subscription resources fetch failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: null,
              };
        return ipcSchemas[
          IpcChannel.CalibrationGetSubscriptionResources
        ].response.parse({
          status: 'error',
          error: staleAccess
            ? {
                ...apiError,
                message: `${apiError.message} ${accessGuidance}`,
              }
            : apiError,
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationListOrcaProfiles,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const entryEpoch = calibrationStateEpoch;
      const printerId = request.printerId;

      /**
       * Answer shape used by every early return below. Echoing the printer and
       * revision is what lets the renderer discard a late reply for a printer
       * it is no longer showing.
       */
      const answer = (
        overrides: Partial<{
          profiles: unknown[];
          configurationRevision: number | null;
          discovery: CalibrationProfileDiscoveryDiagnostic;
          printersUnreadable: number;
          printersTruncated: boolean;
          localProfiles: unknown[];
          localDiscovery: { kind: string; message: string };
        }>,
      ): unknown =>
        ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].response.parse({
          profiles: [],
          printerId,
          configurationRevision: request.configurationRevision ?? null,
          localProfiles: [],
          localDiscovery: {
            kind: 'ok',
            message: 'Local OrcaSlicer profile scan completed.',
          },
          printersUnreadable: 0,
          printersTruncated: false,
          ...overrides,
        });

      /**
       * Explain the state of this machine's OrcaSlicer install when the server
       * never named a profile to look for.
       *
       * Reached only when there is no context to bind a lookup to — a server
       * refusal, or a printer the server does not consider a candidate. Once a
       * context exists, the bound lookup reports its own traversal instead, so
       * this never runs as a *second* pass over an install that was already
       * walked. A server refusal still cannot hide a healthy local install,
       * which is the property this scan exists for.
       */
      const diagnoseLocalInstallWithoutContext = async (): Promise<{
        localProfiles: Array<{
          name: string;
          source: 'systemInstall' | 'userImported';
          material: string | null;
        }>;
        localDiscovery: { kind: string; message: string };
      }> => {
        // A scan that throws is not evidence about this machine. Reporting it as
        // `noInstallFound` told operators with a working OrcaSlicer to install
        // OrcaSlicer, and hid permission and I/O faults behind advice that could
        // not fix them.
        let scanFailed = false;
        const scan = await listLocalOrcaFilamentProfiles({
          limit: LOCAL_PROFILE_EXEMPLAR_LIMIT,
        }).catch(() => {
          scanFailed = true;
          return {
            installFound: false,
            readFailureCount: 1,
            profiles: [] as Array<{
              name: string;
              source: 'systemInstall' | 'userImported';
              material: string | null;
            }>,
          };
        });
        const localDiscovery =
          scanFailed ||
          (scan.profiles.length === 0 && scan.readFailureCount > 0)
            ? {
                kind: 'scanFailed',
                // Deliberately no path or system message: this is rendered in
                // the workspace, and a filesystem path is not the operator's to
                // read out of an error string.
                message:
                  'The local OrcaSlicer profile scan could not be completed on this machine. Check that OrcaSlicer’s profile folders are readable, then retry.',
              }
            : !scan.installFound
              ? {
                  kind: 'noInstallFound',
                  message:
                    'No OrcaSlicer installation was found in the standard locations for this operating system.',
                }
              : scan.profiles.length === 0
                ? {
                    kind: 'noProfilesFound',
                    message:
                      'OrcaSlicer is installed but no filament profiles could be read from its profile directories.',
                  }
                : {
                    kind: 'ok',
                    message: 'Local OrcaSlicer profile scan completed.',
                  };
        return { localProfiles: scan.profiles, localDiscovery };
      };

      // Candidate and context reads already happened on the two preceding wizard
      // steps. Reusing their epoch-bound evidence prevents this profile lookup
      // from re-listing the farm or running the exact-triple resolver twice.
      const evidence = selectionCache.evidence(selectedId, entryEpoch);
      const context = selectionCache.selectedContext(
        selectedId,
        printerId,
        entryEpoch,
        request.configurationRevision,
      );
      const candidate = evidence?.candidates.find(
        (entry) => entry.printerId === printerId,
      );
      const printersUnreadable = evidence?.unreadable ?? 0;
      const printersTruncated = evidence?.truncated ?? false;
      if (evidence === null || candidate === undefined) {
        return answer({
          printersUnreadable,
          printersTruncated,
          discovery: {
            kind: 'selectedPrinterNotACandidate',
            message:
              'The selected printer is not present in the current epoch-bound candidate evidence. Choose it again.',
            serverCode: null,
          },
          ...(await diagnoseLocalInstallWithoutContext()),
        });
      }

      if (
        !candidate.isOnline ||
        // Under Path D there is no server-side eligibility verdict; the
        // renderer blocks continuation on an offline printer, so this is
        // defence in depth rather than the primary gate. Retired/maintenance
        // printers were already filtered by the list handler.
        !isExplicitCalibrationEligibilityComplete(candidate)
      ) {
        return answer({
          printersUnreadable,
          printersTruncated,
          discovery: {
            kind: 'noProfilesForSelectedPrinter',
            message:
              'PrintFarmer cannot resolve a calibration profile for the selected printer while it is offline or in maintenance.',
            serverCode: null,
          },
        });
      }

      if (context === null) {
        return answer({
          printersUnreadable,
          printersTruncated,
          discovery: {
            kind: 'selectedPrinterContextUnavailable',
            message:
              'The selected printer context is no longer available under the current action epoch. Select the printer again.',
            serverCode: null,
          },
          ...(await diagnoseLocalInstallWithoutContext()),
        });
      }

      const configurationRevision = context.configurationRevision;
      const pfProjection = projectPrintFarmerOrcaProfileResult(
        candidate,
        context,
      );
      const pfEntry = pfProjection.kind === 'entry' ? pfProjection.entry : null;
      // Bound to this printer's exact profile name, nozzle and content hash.
      // The server's GUID identifies the profile; only the name can be matched
      // against a file in the local OrcaSlicer installation, and the two are
      // never interchanged. One traversal answers both "did it match" and, on a
      // miss, "why not".
      // Same distinction as the context-less diagnosis: a scan that threw has
      // no standing to claim OrcaSlicer is absent from this machine.
      let localScanFailed = false;
      const local = await discoverLocalOrcaFilamentProfiles(context).catch(
        () => {
          localScanFailed = true;
          return {
            entries: [] as Awaited<
              ReturnType<typeof discoverLocalOrcaFilamentProfiles>
            >['entries'],
            diagnostic: {
              installFound: false,
              enumeratedFileCount: 0,
              parsedFileCount: 0,
              exemplars: [] as readonly string[],
              readFailureCount: 1,
            },
          };
        },
      );
      const localEntries = local.entries;

      const resolved = [
        ...(pfEntry === null ? [] : [pfEntry]),
        ...localEntries,
      ];

      const localDiscovery =
        localEntries.length > 0
          ? {
              kind: 'ok',
              message:
                'A local OrcaSlicer profile matching the selected printer was found.',
            }
          : localScanFailed || local.diagnostic.readFailureCount > 0
            ? {
                kind: 'scanFailed',
                message:
                  'The local OrcaSlicer profile scan could not be completed on this machine. Check that OrcaSlicer’s profile folders are readable, then retry.',
              }
            : !local.diagnostic.installFound
              ? {
                  kind: 'noInstallFound',
                  message:
                    'No OrcaSlicer installation was found in the standard locations for this operating system.',
                }
              : local.diagnostic.parsedFileCount === 0
                ? {
                    kind: 'noProfilesFound',
                    message:
                      'OrcaSlicer is installed but no filament profiles could be read from its profile directories.',
                  }
                : {
                    kind: 'noMatchForSelectedPrinter',
                    message:
                      'OrcaSlicer is installed and its profiles were read, but none matches the profile name and nozzle the selected printer reports.',
                  };

      const currentEvidence = selectionCache.evidence(selectedId, entryEpoch);
      if (
        currentEvidence?.generation !== evidence.generation ||
        selectionCache.selectedContext(
          selectedId,
          printerId,
          entryEpoch,
          request.configurationRevision,
        ) === null
      ) {
        return answer({
          printersUnreadable: currentEvidence?.unreadable ?? 0,
          printersTruncated: currentEvidence?.truncated ?? false,
          discovery: {
            kind: 'selectedPrinterContextUnavailable',
            message:
              'The selected printer changed while its local profile was being resolved. Select the printer again.',
            serverCode: null,
          },
          localDiscovery: {
            kind: 'ok',
            message:
              'The local OrcaSlicer scan completed, but its stale selected-printer binding was discarded.',
          },
        });
      }

      const profileDiscovery: CalibrationProfileDiscoveryDiagnostic =
        pfProjection.kind === 'refused'
          ? {
              kind: 'partiallyUnreadable',
              message:
                'PrintFarmer returned a calibration profile for the selected printer, but it did not match the desktop profile contract and was refused.',
              serverCode: null,
            }
          : pfEntry === null
            ? {
                kind: 'noProfilesForSelectedPrinter',
                message:
                  'PrintFarmer returned a context for the selected printer but no profile identity that calibration can bind to.',
                serverCode: null,
              }
            : {
                kind: 'ok',
                message: 'Server profile discovery completed.',
                serverCode: null,
              };
      const candidateLosses = [
        ...(printersUnreadable > 0
          ? [
              `${printersUnreadable} calibration ${
                printersUnreadable === 1 ? 'candidate was' : 'candidates were'
              } unreadable`,
            ]
          : []),
        ...(printersTruncated
          ? ['the preliminary printer list was truncated']
          : []),
      ];
      const qualifiedProfileDiscovery =
        candidateLosses.length === 0
          ? profileDiscovery
          : {
              ...profileDiscovery,
              kind:
                profileDiscovery.kind === 'ok'
                  ? printersUnreadable > 0
                    ? ('partiallyUnreadable' as const)
                    : ('farmTruncated' as const)
                  : profileDiscovery.kind,
              message: `${profileDiscovery.message} ${candidateLosses.join(
                ' and ',
              )}, so candidate evidence for this result is partial.`,
            };

      return answer({
        profiles: resolved,
        configurationRevision,
        printersUnreadable,
        printersTruncated,
        discovery: qualifiedProfileDiscovery,
        // A few names for orientation, never the whole install. The exemplars
        // come from the traversal that already ran.
        localProfiles: local.diagnostic.exemplars.map((name) => ({
          name,
          source: 'systemInstall' as const,
          material: null,
        })),
        localDiscovery,
      });
    },
  );

  /**
   * Verify generated bytes still belong where they are about to be written.
   *
   * Generation binds its output to a server profile, a project, a snapshot and
   * an exact base file. Export and install then run *later*, after a save
   * dialog or a confirmation the operator may sit on for minutes, during which
   * the selected profile can change, the session can expire and the base file
   * can be rewritten. Re-checking here — immediately before the filesystem
   * write, not at handler entry — is what makes the binding load-bearing rather
   * than a record of what was once true.
   *
   * Returns null when the write may proceed, or a typed refusal.
   */
  const verifyGeneratedProfileBinding = async (
    cached: CachedProfile,
    expected: {
      profileId: string;
      projectId: string;
      snapshotId: string;
    },
  ): Promise<OrcaProfileOperationError | null> => {
    if (
      cached.profileId !== expected.profileId ||
      cached.projectId !== expected.projectId ||
      cached.snapshotId !== expected.snapshotId
    ) {
      return {
        code: 'workspaceNotReady',
        message:
          'This profile was generated for a different PrintFarmer profile, calibration project, or printer snapshot. Generate it again from the open project.',
        retryable: false,
      };
    }
    const listed = await profiles.list();
    if (
      listed.selectedProfileId === null ||
      expected.profileId !== listed.selectedProfileId
    ) {
      return {
        code: 'workspaceNotReady',
        message:
          'This profile was generated for a different PrintFarmer profile than the one now selected. Generate it again for the selected profile.',
        retryable: false,
      };
    }
    if (cached.epoch !== calibrationStateEpoch) {
      return {
        code: 'workspaceNotReady',
        message:
          'The calibration session changed after this profile was generated, so it was not written. Generate it again, then retry.',
        retryable: false,
      };
    }

    const verifyWorkspaceBinding =
      async (): Promise<OrcaProfileOperationError | null> => {
        let workspaceStateRaw: unknown;
        try {
          workspaceStateRaw = await sidecar.getCalibrationWorkspaceState(
            cached.profileId,
            cached.projectId,
          );
        } catch {
          return {
            code: 'workspaceNotReady',
            message:
              'The calibration project could not be re-read before writing the generated profile.',
            retryable: true,
          };
        }
        const workspaceState =
          ipcSchemas[
            IpcChannel.CalibrationGetWorkspaceState
          ].response.safeParse(workspaceStateRaw);
        if (
          !workspaceState.success ||
          workspaceState.data === null ||
          workspaceState.data.profileId !== cached.profileId ||
          workspaceState.data.projectId !== cached.projectId
        ) {
          return {
            code: 'workspaceNotReady',
            message:
              'The calibration project binding could not be verified before writing the generated profile.',
            retryable: false,
          };
        }
        const payload = workspaceState.data.workspaceState;
        if (
          payload.domainState.binding.snapshot.snapshotId !==
            cached.snapshotId ||
          resolveOrcaBaseProfileLookupName(payload.selectedBaseProfile) !==
            cached.baseProfileName ||
          payload.selectedBaseProfile.contentHash !== cached.baseContentHash
        ) {
          return {
            code: 'workspaceNotReady',
            message:
              'The calibration project or printer snapshot changed after this profile was generated. Generate it again from the current project.',
            retryable: false,
          };
        }
        return null;
      };
    const workspaceError = await verifyWorkspaceBinding();
    if (workspaceError !== null) return workspaceError;

    // The base file is re-read rather than trusted, because the window between
    // generating and writing is exactly when OrcaSlicer rewrites a profile.
    let currentBase: Awaited<ReturnType<typeof findLocalOrcaProfileRaw>>;
    try {
      currentBase = await findLocalOrcaProfileRaw(cached.baseProfileName);
    } catch {
      return {
        code: 'internalError',
        message:
          'The OrcaSlicer base profile could not be re-read before writing the generated profile.',
        retryable: true,
      };
    }
    if (currentBase === null) {
      return {
        code: 'baseProfileMissing',
        message:
          'The OrcaSlicer base profile no longer exists, so the generated profile was not written. Restore the base or generate again from another profile.',
        retryable: false,
      };
    }
    if (currentBase.contentHash !== cached.baseContentHash) {
      return {
        code: 'baseProfileChanged',
        message:
          'The OrcaSlicer base profile changed after this profile was generated, so it was not written. Generate it again from the current base.',
        retryable: false,
      };
    }
    // The base lookup above awaited filesystem I/O. Re-read the authoritative
    // workspace after it so a rebase that landed during that window cannot be
    // hidden by the still-current process-wide action epoch.
    const changedWorkspace = await verifyWorkspaceBinding();
    if (changedWorkspace !== null) return changedWorkspace;
    if (cached.epoch !== calibrationStateEpoch) {
      return {
        code: 'workspaceNotReady',
        message:
          'The calibration session changed during final profile verification, so no generated bytes were written.',
        retryable: false,
      };
    }
    return null;
  };

  registerCalibrationHandler(
    IpcChannel.CalibrationExportOrcaProfile,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationExportOrcaProfile].request.parse(
          rawRequest,
        );
      // Retrieve the cached generated profile that was produced by a prior
      // generation step for this operationId. The renderer cannot supply
      // arbitrary profile bytes; they must originate from the main-process
      // generation step.
      const cached = getCachedProfile(request.operationId);
      if (!cached) {
        return ipcSchemas[
          IpcChannel.CalibrationExportOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message:
              'No generated profile found for this operation. Generate the profile first.',
            retryable: false,
          },
        });
      }
      if (request.orcaProfileId !== cached.displayName) {
        return ipcSchemas[
          IpcChannel.CalibrationExportOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message:
              'The requested OrcaSlicer profile does not match the generated operation.',
            retryable: false,
          },
        });
      }

      if (process.platform === 'darwin' || process.platform === 'linux') {
        // macOS / Linux: export-only via native save dialog.
        const owner = BrowserWindow.fromWebContents(event.sender);
        if (!owner) {
          return ipcSchemas[
            IpcChannel.CalibrationExportOrcaProfile
          ].response.parse({
            status: 'error',
            error: {
              code: 'internalError',
              message:
                'Could not identify the parent window for the save dialog.',
              retryable: false,
            },
          });
        }
        const saveResult = await dialog.showSaveDialog(owner, {
          title: 'Export OrcaSlicer Filament Profile',
          defaultPath: cached.safeFilename,
          filters: [{ name: 'OrcaSlicer Profile', extensions: ['json'] }],
        });
        if (saveResult.canceled || !saveResult.filePath) {
          return ipcSchemas[
            IpcChannel.CalibrationExportOrcaProfile
          ].response.parse({
            status: 'canceled',
          });
        }
        try {
          // After the dialog, immediately before the write. The operator may
          // have sat on that dialog while the selection changed underneath.
          const expectedBinding = {
            profileId: request.profileId,
            projectId: request.projectId,
            snapshotId: request.snapshotId,
          };
          const stale = await verifyGeneratedProfileBinding(
            cached,
            expectedBinding,
          );
          if (stale !== null) {
            return ipcSchemas[
              IpcChannel.CalibrationExportOrcaProfile
            ].response.parse({ status: 'error', error: stale });
          }
          const canonicalDest = await canonicalizeSaveTarget(
            saveResult.filePath,
          );
          const changedBeforeWrite = await verifyGeneratedProfileBinding(
            cached,
            expectedBinding,
          );
          if (changedBeforeWrite !== null) {
            return ipcSchemas[
              IpcChannel.CalibrationExportOrcaProfile
            ].response.parse({
              status: 'error',
              error: changedBeforeWrite,
            });
          }
          // Write exact bytes.
          await writeExportedProfileNoFollow(
            canonicalDest,
            cached.generatedJson,
          );
          // Verify exact bytes.
          const exportedHash = await verifyExportedProfile(
            canonicalDest,
            cached.profileJsonHash,
          );
          return ipcSchemas[
            IpcChannel.CalibrationExportOrcaProfile
          ].response.parse({
            status: 'ok',
            profileJsonHash: exportedHash,
            displayName: cached.displayName,
          });
        } catch (err) {
          if (err instanceof OrcaInstallError) {
            return ipcSchemas[
              IpcChannel.CalibrationExportOrcaProfile
            ].response.parse({
              status: 'error',
              error: {
                code: err.code,
                message: err.message,
                retryable: err.retryable,
              },
            });
          }
          return ipcSchemas[
            IpcChannel.CalibrationExportOrcaProfile
          ].response.parse({
            status: 'error',
            error: {
              code: 'internalError',
              message: err instanceof Error ? err.message : 'Export failed.',
              retryable: false,
            },
          });
        }
      }

      // Windows: direct installation is handled by CalibrationInstallOrcaProfile.
      // Export on Windows is not directly supported; direct the user to install.
      return ipcSchemas[IpcChannel.CalibrationExportOrcaProfile].response.parse(
        {
          status: 'error',
          error: {
            code: 'unsupportedPlatform',
            message:
              'Use the Install action on Windows to write the profile to OrcaSlicer.',
            retryable: false,
          },
        },
      );
    },
  );

  // --- Path C: Slicer profile picker + calibration-setup -------------------
  // The five profile-listing handlers below plus the setup PUT are the
  // desktop's implementation of PrintFarmer's calibration-setup flow (see
  // decisions/inbox/bishop-calibration-path-c-implementation.md). They exist
  // so that a real printer whose CalibrationMachineProfileId / ProcessProfileId
  // / FilamentProfileId columns are NULL (which is every real printer until an
  // operator runs this wizard) can be driven through the picker → PUT
  // sequence, populating those columns and unblocking eligibility.

  // GET /api/slicer/profiles/extended.
  //
  // The `/extended` endpoint is DB-backed and returns Guids for BOTH system
  // and custom profiles. Handler splits the flat response by `profileType`
  // into three unified `CalibrationSlicerProfileRef[]` arrays. All rows are
  // marked `source: 'system'` because the DB row is the resolved-Guid source
  // of truth for the setup PUT — even a custom-authored profile appears here.
  // The renderer distinguishes ownership via `CalibrationListCustomProfiles`.
  registerCalibrationHandler(
    IpcChannel.CalibrationListExtendedProfiles,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListExtendedProfiles].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin = 'flowStart' as const;
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(10_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const remote = await calibrationHttp.getExtendedProfiles(
          selectedId,
          ctx.profile.baseUrl,
          signal,
        );
        const machineProfiles: unknown[] = [];
        const processProfiles: unknown[] = [];
        const filamentProfiles: unknown[] = [];
        for (const row of remote.profiles) {
          const ref = {
            name: row.name,
            guid: row.id,
            source: 'system' as const,
            displayLabel: null,
            contentSha256: row.contentSha256,
          };
          if (row.profileType === 'machine') machineProfiles.push(ref);
          else if (row.profileType === 'process') processProfiles.push(ref);
          else filamentProfiles.push(ref);
        }
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.extended.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationListExtendedProfiles
        ].response.parse({
          status: 'ok',
          machineProfiles,
          processProfiles,
          filamentProfiles,
          profilesTruncated: remote.truncated,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.extended.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Extended profile list failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationListExtendedProfiles
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // GET /api/slicer/profiles/machine/for-model/{modelId}.
  //
  // Returns names + Guids for the raw for-model list — the handler joins
  // against a fresh `/extended` fetch so the response is the fully-resolved
  // `CalibrationSlicerProfileRef`. The renderer never has to guess a Guid.
  //
  // 404 (no OrcaSlicer alias for the model) is surfaced as `ok` with an
  // empty list and `noModelAlias: true` so the renderer can distinguish
  // "catalog admins must add an alias" from "genuinely nothing to pick".
  registerCalibrationHandler(
    IpcChannel.CalibrationListMachineProfilesForModel,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationListMachineProfilesForModel
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin = 'flowStart' as const;
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(10_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        let raw;
        try {
          raw = await calibrationHttp.getMachineProfilesForModel(
            selectedId,
            ctx.profile.baseUrl,
            request.printerModelId,
            signal,
          );
        } catch (error) {
          if (
            error instanceof CalibrationHttpError &&
            error.code === 'notFound'
          ) {
            emitCalibrationLog({
              level: 'info',
              component: 'calibration.http',
              event: 'profiles.forModel.listed',
              correlationId,
              correlationOrigin,
              profileId: selectedId,
              outcome: 'ok',
              durationMs: Date.now() - startedAt,
            });
            return ipcSchemas[
              IpcChannel.CalibrationListMachineProfilesForModel
            ].response.parse({
              status: 'ok',
              profiles: [],
              noModelAlias: true,
              profilesTruncated: false,
              fetchedAt: new Date().toISOString(),
            });
          }
          throw error;
        }
        // Second call resolves each name to its Guid. The two calls run
        // sequentially rather than in parallel because most operators pick
        // once per session, so latency dominates over responsiveness, and
        // running them serially lets the second short-circuit when the first
        // is empty.
        const guidByName = new Map<string, string>();
        let profilesTruncated = false;
        if (raw.length > 0) {
          const extendedSignal = AbortSignal.timeout(10_000);
          const extended = await calibrationHttp.getExtendedProfiles(
            selectedId,
            ctx.profile.baseUrl,
            extendedSignal,
          );
          profilesTruncated = extended.truncated;
          for (const row of extended.profiles) {
            if (row.profileType === 'machine') {
              guidByName.set(row.name, row.id);
            }
          }
        }
        const projected = raw.map((p) => ({
          name: p.name,
          guid: guidByName.get(p.name) ?? null,
          source: 'system' as const,
          displayLabel:
            p.manufacturer !== '' && p.printerModel !== null
              ? `${p.manufacturer} ${p.printerModel}`
              : (p.printerModel ?? p.manufacturer ?? null),
          contentSha256: null,
        }));
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.forModel.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationListMachineProfilesForModel
        ].response.parse({
          status: 'ok',
          profiles: projected,
          noModelAlias: false,
          profilesTruncated,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.forModel.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Machine profile list failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationListMachineProfilesForModel
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // POST /api/slicer/profiles/process/for-machines.
  //
  // Server-side applicability filter by `compatible_printers`. Handler
  // reuses the same for-model pattern of joining against `/extended` for
  // Guids — process profile Guids are what the setup PUT persists.
  registerCalibrationHandler(
    IpcChannel.CalibrationListProcessProfilesForMachines,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationListProcessProfilesForMachines
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin = 'flowStart' as const;
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(10_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const raw = await calibrationHttp.getProcessProfilesForMachines(
          selectedId,
          ctx.profile.baseUrl,
          request.machineNames,
          signal,
        );
        const guidByName = new Map<string, string>();
        let profilesTruncated = false;
        if (raw.length > 0) {
          const extendedSignal = AbortSignal.timeout(10_000);
          const extended = await calibrationHttp.getExtendedProfiles(
            selectedId,
            ctx.profile.baseUrl,
            extendedSignal,
          );
          profilesTruncated = extended.truncated;
          for (const row of extended.profiles) {
            if (row.profileType === 'process') {
              guidByName.set(row.name, row.id);
            }
          }
        }
        const projected = raw.map((p) => ({
          name: p.name,
          guid: guidByName.get(p.name) ?? null,
          source: 'system' as const,
          displayLabel: p.quality,
          contentSha256: null,
        }));
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.processForMachines.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationListProcessProfilesForMachines
        ].response.parse({
          status: 'ok',
          profiles: projected,
          profilesTruncated,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.processForMachines.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Process profile list failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationListProcessProfilesForMachines
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // POST /api/slicer/profiles/filament/for-machines.
  //
  // Same shape as the process endpoint; distinct only in the Guid resolution
  // pulled from the `filament` subset of `/extended`.
  registerCalibrationHandler(
    IpcChannel.CalibrationListFilamentProfilesForMachines,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationListFilamentProfilesForMachines
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin = 'flowStart' as const;
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(10_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const raw = await calibrationHttp.getFilamentProfilesForMachines(
          selectedId,
          ctx.profile.baseUrl,
          request.machineNames,
          signal,
        );
        const guidByName = new Map<string, string>();
        let profilesTruncated = false;
        if (raw.length > 0) {
          const extendedSignal = AbortSignal.timeout(10_000);
          const extended = await calibrationHttp.getExtendedProfiles(
            selectedId,
            ctx.profile.baseUrl,
            extendedSignal,
          );
          profilesTruncated = extended.truncated;
          for (const row of extended.profiles) {
            if (row.profileType === 'filament') {
              guidByName.set(row.name, row.id);
            }
          }
        }
        const projected = raw.map((p) => ({
          name: p.name,
          guid: guidByName.get(p.name) ?? null,
          source: 'system' as const,
          displayLabel:
            p.manufacturer !== null
              ? `${p.manufacturer} ${p.material}`
              : p.material,
          contentSha256: null,
        }));
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.filamentForMachines.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationListFilamentProfilesForMachines
        ].response.parse({
          status: 'ok',
          profiles: projected,
          profilesTruncated,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.filamentForMachines.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Filament profile list failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationListFilamentProfilesForMachines
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // GET /api/slicer/profiles/custom.
  //
  // Custom profiles come with a Guid Id directly, so no resolution against
  // `/extended` is required. Applicability is enforced on the RENDERER
  // (client-side filter by `printerModelId` for machine, `compatiblePrinters`
  // for process/filament) per §B.2 of the research report — the shape here
  // is the raw list.
  registerCalibrationHandler(
    IpcChannel.CalibrationListCustomProfiles,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListCustomProfiles].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin = 'flowStart' as const;
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(10_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const remote = await calibrationHttp.getCustomProfiles(
          selectedId,
          ctx.profile.baseUrl,
          signal,
        );
        const projected = remote.profiles.map((p) => ({
          id: p.id,
          name: p.name,
          profileType: p.profileType,
          printerModelId: p.printerModelId,
          compatiblePrinters: p.compatiblePrinters,
          createdAt: p.createdAt,
        }));
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.custom.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationListCustomProfiles
        ].response.parse({
          status: 'ok',
          profiles: projected,
          fetchedAt: new Date().toISOString(),
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.custom.listed',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Custom profile list failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationListCustomProfiles
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // --- On-demand system profile identity resolution (issue #766) -----------
  //
  // PrintFarmer#2004 / PR #2008 shipped a non-admin resolve-or-import
  // endpoint: a system profile whose Guid a list call above resolved to
  // `null` (never imported into PrintFarmer's DB) is no longer a permanent
  // dead end — the renderer calls this on demand (today, only at the
  // filament clone step) to resolve the real Guid by name, auto-importing
  // server-side if needed.

  registerCalibrationHandler(
    IpcChannel.CalibrationResolveSystemProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationResolveSystemProfile].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const resolved = await calibrationHttp.resolveProfileForModel(
          selectedId,
          ctx.profile.baseUrl,
          request.printerModelId,
          {
            profileType: request.profileType,
            profileName: request.profileName,
          },
          signal,
        );
        if (resolved.profileId === null) {
          emitCalibrationLog({
            level: 'error',
            component: 'calibration.http',
            event: 'profiles.system.resolved',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
          });
          return ipcSchemas[
            IpcChannel.CalibrationResolveSystemProfile
          ].response.parse({
            status: 'error',
            error: {
              code: 'serverError' as const,
              message:
                resolved.error ?? 'The server could not resolve this profile.',
              retryable: false,
              retryAfterSeconds: null,
              reference: correlationId,
            },
          });
        }
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.system.resolved',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationResolveSystemProfile
        ].response.parse({
          status: 'ok',
          profileId: resolved.profileId,
          imported: resolved.imported,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.system.resolved',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'System profile resolution failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationResolveSystemProfile
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // (calibration:setupPrinter handler removed 2026-08-23. The printer-
  // calibration setup PUT belonged to the printer-eligibility subsystem;
  // the filament-calibration workflow this desktop targets does not persist
  // profile Guids server-side.)

  // --- Server-side CalibrationProject entry point (issue #798) --------------
  //
  // Creates a `CalibrationProject` in Coach mode at calibration start,
  // before any profile clone or local wizard state is written. The renderer
  // gates this call on the server's own `calibrationGenerationEnabled`
  // capability flag (see `store.availability`) before it is ever invoked —
  // this handler is a thin bridge onto `CalibrationHttpClient.createProject`,
  // following the same correlation-logging + error-remapping shape as the
  // slice-pipeline handlers below.

  registerCalibrationHandler(
    IpcChannel.CalibrationCreateProject,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationCreateProject].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const project = await calibrationHttp.createProject(
          selectedId,
          ctx.profile.baseUrl,
          {
            clientId: 'desktop',
            // The renderer-supplied `requestId` is the idempotency key, kept
            // stable by the caller across a retry of the same attempt — do
            // NOT substitute `correlationId` here, which is minted fresh on
            // every invocation and would defeat that idempotency (see the
            // doc comment on `CalibrationHttpClient.createProject`).
            requestId: request.requestId,
            name: request.name,
            printerId: request.printerId,
            filamentProvider: request.filamentProvider,
            filamentProductId: request.filamentProductId,
            filamentProductName: request.filamentProductName,
            filamentMaterial: request.filamentMaterial,
            experienceMode: 'Coach',
          },
          signal,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'projects.created',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[IpcChannel.CalibrationCreateProject].response.parse({
          status: 'ok',
          project: {
            id: project.id,
            name: project.name,
            lifecycleStatus: project.lifecycleStatus,
            experienceMode: project.experienceMode,
            printerId: project.printerId,
            revision: project.revision,
          },
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'projects.created',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Calibration project creation failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[IpcChannel.CalibrationCreateProject].response.parse({
          status: 'error',
          error: apiError,
        });
      }
    },
  );

  // --- Filament calibration slice pipeline (PR #1952) -----------------------
  //
  // Five handlers, one per stage of the OrcaSlicer-wiki workflow the owner
  // described: clone → submit slice → poll → send-to-printer → PUT measured
  // values back. Each handler is a thin bridge onto the transport methods on
  // `CalibrationHttpClient`; the shape of the correlation-logging + error-
  // remapping wrapper is identical to `CalibrationListCustomProfiles` above,
  // deliberately, because that pattern has proven robust for main-side error
  // classification (see `calibrationHttp.toApiError`).
  //
  // The poll-driver helpers live in `calibrationSlicePoll.ts` so the schedule
  // is testable in isolation and independent of any HTTP mock.

  registerCalibrationHandler(
    IpcChannel.CalibrationCloneFilamentProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationCloneFilamentProfile].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const clone = await calibrationHttp.cloneSingleProfile(
          selectedId,
          ctx.profile.baseUrl,
          {
            sourceProfileId: request.sourceProfileId,
            profileType: 'filament',
            name: request.name,
            printerModelId: request.printerModelId ?? null,
            compatiblePrinters: request.compatiblePrinters ?? null,
            idempotencyKey: correlationId,
          },
          signal,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'profiles.custom.cloned',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationCloneFilamentProfile
        ].response.parse({
          status: 'ok',
          clone,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'profiles.custom.cloned',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Filament profile clone failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationCloneFilamentProfile
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSubmitCalibrationSlice,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSubmitCalibrationSlice].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        const signal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        // Upstream expects `slicerProfileJson` as a JSON-encoded *string* of
        // { machineProfileName, processProfileName, filamentProfileName }.
        // We stringify here so the renderer never emits arbitrary JSON through
        // this field — the wire is always a canonical three-name triple.
        const slicerProfileJson = JSON.stringify({
          machineProfileName: request.machineProfileName,
          processProfileName: request.processProfileName,
          filamentProfileName: request.filamentProfileName,
        });
        const job = await calibrationHttp.submitCalibrationSlice(
          selectedId,
          ctx.profile.baseUrl,
          {
            userId: ctx.principalId,
            printerId: request.printerId,
            slicerProfileJson,
            method: request.method,
            ...(request.params !== undefined ? { params: request.params } : {}),
            idempotencyKey: correlationId,
          },
          signal,
        );
        // Bind the returned jobId so subsequent poll / send-to-printer handlers
        // resolve to the same correlation id as the submit that started them.
        calibrationCorrelation.bind('job', job.jobId, correlationId);
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'slice.submitted',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationSubmitCalibrationSlice
        ].response.parse({
          status: 'ok',
          job,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'slice.submitted',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Calibration slice submit failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationSubmitCalibrationSlice
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetSliceJobStatus,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetSliceJobStatus].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const { correlationId, origin: correlationOrigin } =
        calibrationCorrelation.resolveOrBeginWithOrigin([
          ['job', request.jobId],
        ]);
      const startedAt = Date.now();

      // Enforce the poll cap here rather than on the transport layer: if the
      // renderer has already exceeded the cap on a previous call, refuse this
      // one with `sliceJobTimeout` before we make an HTTP request.
      const preHint = computeSlicePollHint(request.pollAttempt - 1);
      if (
        request.pollAttempt > 0 &&
        preHint.cappedOut &&
        request.pollAttempt >= SLICE_POLL_MAX_ATTEMPTS
      ) {
        emitCalibrationLog({
          level: 'warn',
          component: 'calibration.http',
          event: 'slice.polled',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          errorCode: 'sliceJobTimeout',
        });
        return ipcSchemas[
          IpcChannel.CalibrationGetSliceJobStatus
        ].response.parse({
          status: 'error',
          error: {
            code: 'sliceJobTimeout' as const,
            message:
              'Slice job did not reach a terminal status within the poll cap.',
            retryable: false,
            retryAfterSeconds: null,
            reference: correlationId,
          },
        });
      }

      try {
        const signal = AbortSignal.timeout(10_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const snapshot = await calibrationHttp.getSliceJobStatus(
          selectedId,
          ctx.profile.baseUrl,
          request.jobId,
          signal,
        );
        const terminal = classifySliceJobTerminalOutcome(snapshot.status);
        // A terminal snapshot ends the loop; `nextPollDelayMs` is null and
        // the handler layer refuses further polls of a Failed/Cancelled job
        // with `sliceJobFailed` on the *next* attempt (below).
        if (terminal === 'failed') {
          emitCalibrationLog({
            level: 'warn',
            component: 'calibration.http',
            event: 'slice.polled',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            errorCode: 'sliceJobFailed',
          });
        } else {
          emitCalibrationLog({
            level: 'info',
            component: 'calibration.http',
            event: 'slice.polled',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'ok',
            durationMs: Date.now() - startedAt,
          });
        }
        const hint = computeSlicePollHint(request.pollAttempt);
        return ipcSchemas[
          IpcChannel.CalibrationGetSliceJobStatus
        ].response.parse({
          status: 'ok',
          snapshot,
          terminal,
          nextPollDelayMs: terminal !== null ? null : hint.delayMs,
          cappedOut: hint.cappedOut,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'slice.polled',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Slice job status poll failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationGetSliceJobStatus
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSendSliceToPrinter,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSendSliceToPrinter].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const { correlationId, origin: correlationOrigin } =
        calibrationCorrelation.resolveOrBeginWithOrigin([
          ['job', request.jobId],
        ]);
      const startedAt = Date.now();

      // Machine-moving action guard. `startPrint === true` starts a real print
      // on hardware that heats to 300 °C and moves — the schema requires the
      // renderer to supply an explicit `operatorAcknowledgement` in that case.
      // The gate here is structural: no ack, no dispatch. The full ledger
      // integration in `calibrationActionGate.ts` covers the older bed-clear
      // dispatch path; this new send-to-printer channel is deliberately its
      // own guard, because upstream PR #1952 keeps the request out of the
      // calibration-project saga (no saga IDs, no bed-clear ledger record to
      // consume).
      if (request.startPrint && !request.operatorAcknowledgement) {
        emitCalibrationLog({
          level: 'warn',
          component: 'calibration.http',
          event: 'slice.sendToPrinter',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          errorCode: 'forbidden',
        });
        return ipcSchemas[
          IpcChannel.CalibrationSendSliceToPrinter
        ].response.parse({
          status: 'error',
          error: {
            code: 'forbidden' as const,
            message:
              'Send-to-printer with startPrint requires a live operator acknowledgement.',
            retryable: false,
            retryAfterSeconds: null,
            reference: correlationId,
          },
        });
      }

      try {
        const signal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const result = await calibrationHttp.sendSliceToPrinter(
          selectedId,
          ctx.profile.baseUrl,
          request.jobId,
          {
            printerId: request.printerId,
            startPrint: request.startPrint,
            idempotencyKey: correlationId,
          },
          signal,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'slice.sendToPrinter',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationSendSliceToPrinter
        ].response.parse({
          status: 'ok',
          result,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'slice.sendToPrinter',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Send-to-printer failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationSendSliceToPrinter
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationUpdateFilamentProfileMeasurement,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationUpdateFilamentProfileMeasurement
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        // Read-modify-write cycle. `PUT /api/slicer/profiles/custom/{id}`
        // replaces `rawJson` verbatim, so a partial-key measurement update
        // must load the current profile JSON, merge the measured keys onto
        // it, and PUT the merged blob back. Doing the merge on the main
        // side keeps the wire-key vocabulary
        // (`filament_flow_ratio` / `nozzle_temperature` /
        // `nozzle_temperature_initial_layer`) out of the renderer.
        const readSignal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const list = await calibrationHttp.getCustomProfiles(
          selectedId,
          ctx.profile.baseUrl,
          readSignal,
        );
        const current = list.profiles.find(
          (p) => p.id === request.customProfileId,
        );
        if (current === undefined) {
          emitCalibrationLog({
            level: 'warn',
            component: 'calibration.http',
            event: 'slice.updateFilamentProfile',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            errorCode: 'notFound',
          });
          return ipcSchemas[
            IpcChannel.CalibrationUpdateFilamentProfileMeasurement
          ].response.parse({
            status: 'error',
            error: {
              code: 'notFound' as const,
              message: 'Cloned filament profile is no longer present.',
              retryable: false,
              retryAfterSeconds: null,
              reference: correlationId,
            },
          });
        }
        // Structural fence: refuse to write through a system (source)
        // profile. The `/api/slicer/profiles/custom` listing is the
        // desktop's authoritative view of what can be mutated, and the
        // server marks read-only rows with `isSystem: true`. If a buggy
        // server ever returned a system row here, silently corrupting
        // shared filament data would be catastrophic — one operator's
        // spool would rewrite every other operator's baseline. Refuse
        // outright rather than trust the URL.
        if (current.isSystem === true) {
          emitCalibrationLog({
            level: 'error',
            component: 'calibration.http',
            event: 'slice.updateFilamentProfile',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            errorCode: 'invalidData',
          });
          return ipcSchemas[
            IpcChannel.CalibrationUpdateFilamentProfileMeasurement
          ].response.parse({
            status: 'error',
            error: {
              code: 'invalidData' as const,
              message:
                'Cannot write a measurement to a system filament profile. ' +
                'Clone the profile first, then update the clone.',
              retryable: false,
              retryAfterSeconds: null,
              reference: correlationId,
            },
          });
        }
        // Parse the current profile JSON (a bare Orca profile object) and
        // merge the measured keys onto it. If the current profile has no
        // rawJson, start from an empty object — the server treats any valid
        // JSON object as a full replacement.
        let parsed: Record<string, unknown> = {};
        if (current.rawJson !== null && current.rawJson.length > 0) {
          try {
            const candidate: unknown = JSON.parse(current.rawJson);
            if (
              candidate !== null &&
              typeof candidate === 'object' &&
              !Array.isArray(candidate)
            ) {
              parsed = candidate as Record<string, unknown>;
            }
          } catch {
            // Fall through with an empty object; a malformed rawJson is a
            // wire drift the server should surface on the PUT, not
            // something the desktop can recover from silently.
            parsed = {};
          }
        }
        // The merge lives in `filamentMeasurementWriteBack.ts` so it can be
        // asserted directly on the emitted profile rather than only through a
        // reimplementation in a test.
        const merged = applyFilamentMeasurement(parsed, request.measurement);
        const writeSignal = AbortSignal.timeout(15_000);
        const updated = await calibrationHttp.updateCustomProfile(
          selectedId,
          ctx.profile.baseUrl,
          request.customProfileId,
          {
            rawJson: JSON.stringify(merged),
            idempotencyKey: correlationId,
          },
          writeSignal,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'slice.updateFilamentProfile',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationUpdateFilamentProfileMeasurement
        ].response.parse({
          status: 'ok',
          // Narrow the client's 10-field `CustomProfileDto` projection to the
          // 4-field `updated` shape the IPC channel exposes to the renderer.
          // The extra fields (`createdAt`, `updatedAt`, `description`,
          // `rawJson`, `printerModelId`, `compatiblePrinters`) are real on
          // the wire — see `CustomProfileDto` in `CloneProfilesDtos.cs` —
          // but the renderer only needs enough to confirm the write landed
          // on the correct clone. Widening the renderer surface should be a
          // deliberate contract change, not a byproduct of the response
          // schema following the DTO shape.
          updated: {
            id: updated.id,
            name: updated.name,
            profileType: updated.profileType,
            isSystem: updated.isSystem,
          },
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'slice.updateFilamentProfile',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Filament profile measurement update failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationUpdateFilamentProfileMeasurement
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSubmitCalibrationObservation,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationSubmitCalibrationObservation
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        const { calibrationKind, method, specification, measurements } =
          mapFilamentMeasurementToObservation(request.measurement);
        const signal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const attempt = await calibrationHttp.createAttempt(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          {
            clientId: 'desktop',
            // Renderer-supplied idempotency key — kept stable by the caller
            // across a retry of the same submission, mirroring
            // `CalibrationCreateProject`'s handling of `requestId`.
            requestId: request.requestId,
            calibrationKind,
            method,
            specification,
          },
          signal,
        );
        const observation = await calibrationHttp.appendObservation(
          selectedId,
          ctx.profile.baseUrl,
          attempt.id,
          {
            clientId: 'desktop',
            operationId: request.operationId,
            measurements,
          },
          signal,
        );
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'calibration.observationSubmitted',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationSubmitCalibrationObservation
        ].response.parse({
          status: 'ok',
          attemptId: attempt.id,
          observationId: observation.id,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'calibration.observationSubmitted',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Calibration observation submission failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationSubmitCalibrationObservation
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationCompleteCalibrationProject,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationCompleteCalibrationProject
        ].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const correlationId = calibrationCorrelation.beginFlow();
      const correlationOrigin: CalibrationCorrelationOrigin = 'flowStart';
      const startedAt = Date.now();
      try {
        const readSignal = AbortSignal.timeout(15_000);
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const project = await calibrationHttp.getProjectRecord(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          readSignal,
        );
        if (project === null) {
          emitCalibrationLog({
            level: 'warn',
            component: 'calibration.http',
            event: 'calibration.projectCompleted',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            errorCode: 'notFound',
          });
          return ipcSchemas[
            IpcChannel.CalibrationCompleteCalibrationProject
          ].response.parse({
            status: 'error',
            error: {
              code: 'serverError' as const,
              message: 'Calibration project is no longer present.',
              retryable: false,
              retryAfterSeconds: null,
              reference: correlationId,
            },
          });
        }
        const writeSignal = AbortSignal.timeout(15_000);
        const completed = await calibrationHttp.completeProject(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          project.revision,
          writeSignal,
        );
        // Best-effort read-back so the renderer can confirm promotion
        // happened (the "control: completed one appears" acceptance
        // criterion). A failure here does not undo the completion above —
        // the project has already transitioned — so it is swallowed and
        // reported as `promotedProfileId: null` rather than surfaced as an
        // error for the whole channel.
        let promotedProfileId: string | null = null;
        try {
          const draftSignal = AbortSignal.timeout(15_000);
          const draft = await calibrationHttp.getDraftProfile(
            selectedId,
            ctx.profile.baseUrl,
            request.projectId,
            draftSignal,
          );
          promotedProfileId = draft?.promotedProfileId ?? null;
        } catch (draftError) {
          emitCalibrationLog({
            level: 'warn',
            component: 'calibration.http',
            event: 'calibration.draftProfileReadAfterCompletion',
            correlationId,
            correlationOrigin,
            profileId: selectedId,
            outcome: 'failed',
            durationMs: Date.now() - startedAt,
            ...describeCalibrationFailure(draftError),
          });
        }
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'calibration.projectCompleted',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationCompleteCalibrationProject
        ].response.parse({
          status: 'ok',
          lifecycleStatus: completed.lifecycleStatus,
          promotedProfileId,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'calibration.projectCompleted',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Calibration project completion failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationCompleteCalibrationProject
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // --- Filament calibration wizard restart resilience (issue #754) ---------
  //
  // Local-only: these three channels never touch `calibrationHttp` or the
  // sidecar. They read and write `filamentWizardStateStore`, the on-disk JSON
  // bookmark described in `calibrationFilamentWizardState.ts`.

  registerCalibrationHandler(
    IpcChannel.CalibrationGetFilamentWizardState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetFilamentWizardState].request.parse(
          rawRequest,
        );
      await requireSelectedCalibrationProfile(request.profileId);
      const state = await filamentWizardStateStore.read(request.profileId);
      return ipcSchemas[
        IpcChannel.CalibrationGetFilamentWizardState
      ].response.parse(state);
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSaveFilamentWizardState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSaveFilamentWizardState].request.parse(
          rawRequest,
        );
      await requireSelectedCalibrationProfile(request.profileId);
      await filamentWizardStateStore.write(request.profileId, request.state);
      return ipcSchemas[
        IpcChannel.CalibrationSaveFilamentWizardState
      ].response.parse({ saved: true });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationClearFilamentWizardState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[
          IpcChannel.CalibrationClearFilamentWizardState
        ].request.parse(rawRequest);
      await requireSelectedCalibrationProfile(request.profileId);
      const cleared = await filamentWizardStateStore.clear(request.profileId);
      return ipcSchemas[
        IpcChannel.CalibrationClearFilamentWizardState
      ].response.parse({ cleared });
    },
  );

  // --- End Printer Calibration transport handlers --------------------------

  return async () => {
    await retargetArtifacts.disposeAll();
    if (!sharedSidecar) {
      sidecar.dispose();
      profiles.clearTokens();
    }
  };
}
