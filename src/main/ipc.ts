import path from 'node:path';
import { rm } from 'node:fs/promises';
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
  normalizeCalibrationReasonCode,
  normalizeCalibrationMissingInput,
  CALIBRATION_SERVER_CONTRADICTION_CODE,
  CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE,
  CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE,
  CALIBRATION_EXPLANATION_TRUNCATED_CODE,
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

/**
 * Turns a failed calibration-candidate request into an operator-facing
 * diagnosis.
 *
 * Each branch names a *different* remedy, which is the whole point: an empty
 * printer list previously looked the same whether the operator needed to sign
 * in, be granted a permission, upgrade the server, configure a server
 * dependency, or simply had no eligible printer. Only server-supplied codes and
 * this module's own literals are used — no server-controlled prose, no URLs and
 * no filesystem paths are echoed.
 */
function classifyDiscoveryFailure(
  error: unknown,
): CalibrationProfileDiscoveryDiagnostic {
  if (!(error instanceof CalibrationHttpError)) {
    return {
      kind: 'unreachable',
      message: 'PrintFarmer could not be reached to list calibration printers.',
      serverCode: null,
    };
  }
  // The server's ProblemDetails extension code is in-process-only by the #177
  // disposition, so it is deliberately NOT forwarded to the renderer here.
  // Only this module's own literals cross the boundary.
  const serverCode = null;
  switch (error.code) {
    case 'authentication':
      return {
        kind: 'unauthenticated',
        message:
          'Sign in to PrintFarmer again: this session is not authenticated for calibration.',
        serverCode,
      };
    case 'authorization':
    case 'forbidden':
      return {
        kind: 'forbidden',
        message:
          'This PrintFarmer account lacks the calibration read permission. Ask a farm admin to grant it.',
        serverCode,
      };
    case 'notFound':
      return {
        kind: 'routeUnavailable',
        message:
          'This PrintFarmer server does not expose the calibration candidate endpoint. Upgrade the server to a build that supports calibration.',
        serverCode,
      };
    case 'profileServiceUnavailable':
      return {
        kind: 'profileResolverUnavailable',
        message:
          'PrintFarmer cannot reach its upstream OrcaSlicer profile resolver, so it cannot resolve calibration profiles. This is a server configuration issue.',
        serverCode,
      };
    case 'printerStatusUnavailable':
      return {
        kind: 'serverDependencyUnavailable',
        message:
          'PrintFarmer could not read live printer status, so calibration candidates are unavailable right now.',
        serverCode,
      };
    case 'workerUnavailable':
      return {
        kind: 'serverDependencyUnavailable',
        message:
          'A PrintFarmer service required for calibration is unavailable.',
        serverCode,
      };
    case 'invalidResponse':
      return {
        kind: 'malformedResponse',
        message:
          'PrintFarmer returned a calibration response this version cannot read.',
        serverCode,
      };
    default:
      return {
        kind: 'unreachable',
        message: 'PrintFarmer could not list calibration printers.',
        serverCode,
      };
  }
}
import {
  REQUIRED_FIRMWARE_FAMILY,
  REQUIRED_SLICER_ENGINE,
  isExplicitCalibrationEligibilityComplete,
  missingCalibrationFlags,
  prepareCalibrationWorkspaceSave,
  projectCalibrationEligibility,
  projectCalibrationPrinterContext,
  projectPrintFarmerOrcaProfile,
  supportsKlipper,
  supportsOrcaSlicer,
  type RemoteCalibrationPrinterCandidate,
} from './calibrationWire.js';
import {
  CalibrationPhotoApprovalStore,
  cleanupStaleCalibrationPhotoTemps,
  stagePrivateCalibrationPhoto,
} from './calibrationPhotos.js';
import { resolveCalibrationWorkspaceFreshness } from './calibrationFreshness.js';
import {
  evaluateCalibrationActionGate,
  type CalibrationGateResult,
  type CalibrationGatedAction,
} from './calibrationActionGate.js';
import { CalibrationSelectionCache } from './calibrationSelectionCache.js';
import { BedClearAcknowledgementLedger } from './calibrationBedClearLedger.js';
import { CalibrationCapabilityRefresher } from './calibrationCapabilityRefresh.js';
import { CalibrationSyncEngine } from './calibrationEngine.js';
import {
  ServerProfileCalibrationTokenProvider,
  SidecarCalibrationAdapter,
  supportsConflictResolution,
} from './calibrationService.js';
import {
  discoverLocalOrcaFilamentProfiles,
  findLocalOrcaProfileRaw,
  listLocalOrcaFilamentProfiles,
} from './orcaProfileDiscovery.js';
import { generateOrcaProfile } from './orcaProfileGenerator.js';
import type { OrcaPatchEntry } from './orcaProfileGenerator.js';
import {
  installOrcaProfileWindows,
  restoreOrcaProfileWindows,
  verifyExportedProfile,
  canonicalizeSaveTarget,
  cacheGeneratedProfile,
  getCachedProfile,
  clearProfileCache,
  OrcaInstallError,
} from './orcaProfileInstall.js';
import {
  LegacyBackupApprovalStore,
  runLegacyBackupPreflight,
  executeLegacyBackupImport,
  mapImportError,
} from './calibrationImportV4.js';
import type { PreflightResult } from './calibrationImportV4.js';
import { LegacyBackupProjectOutcome } from '@shared/ipc';
import { CalibrationAssetManifestService } from './calibrationAssetManifest.js';
import {
  emitCalibrationLog,
  describeCalibrationFailure,
} from './calibrationLog.js';
import type { CalibrationCorrelationOrigin } from './calibrationLog.js';
import { calibrationCorrelation } from './calibrationCorrelation.js';
import { calibrationDiagnostics } from './calibrationDiagnostics.js';

declare const __PRINTFARMER_E2E_BUILD__: boolean;

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
 * Every code the renderer will be given for a printer this client refuses.
 *
 * The list is guaranteed non-empty. An ineligible printer with nothing to say
 * is the failure mode this whole contract exists to remove: the operator sees
 * a refusal, has no idea which of a dozen preconditions failed, and has
 * nothing to quote in a bug report. Three sources feed it, in order of what
 * they explain:
 *
 * 1. The server contradicting itself, either way round.
 * 2. The server's own reasons, each mapped onto the catalogue.
 * 3. Failing both — a response that is coherent and reason-free, yet does not
 *    name the Klipper/OrcaSlicer identities eligibility requires — the fact
 *    that this client could not verify what the server asserted.
 *
 * The third exists because the first two can legitimately produce nothing at
 * all, and an empty list is not an explanation.
 */
export function explainIneligibility(
  printer: Pick<
    RemoteCalibrationPrinterCandidate,
    'serverIncoherence' | 'rejectionReasons' | 'explanationTruncated'
  >,
): string[] {
  const incoherence =
    printer.serverIncoherence === 'contradiction'
      ? [CALIBRATION_SERVER_CONTRADICTION_CODE]
      : printer.serverIncoherence === 'unexplainedRefusal'
        ? [CALIBRATION_SERVER_UNEXPLAINED_REFUSAL_CODE]
        : [];
  const codes = [
    ...incoherence,
    ...printer.rejectionReasons.map((reason) =>
      normalizeCalibrationReasonCode(reason.code),
    ),
    // Declared last so it reads as a footnote on the list above it, and
    // included in the bound so a truncated contradictory printer at the cap
    // still fits.
    ...(printer.explanationTruncated
      ? [CALIBRATION_EXPLANATION_TRUNCATED_CODE]
      : []),
  ];
  return codes.length > 0 ? codes : [CALIBRATION_ELIGIBILITY_UNVERIFIED_CODE];
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
  const calibrationPhotoApprovals = new CalibrationPhotoApprovalStore();
  const legacyBackupApprovals = new LegacyBackupApprovalStore();
  const calibrationPhotoRoot = path.join(
    app.getPath('userData'),
    'calibration-photos',
  );
  void cleanupStaleCalibrationPhotoTemps(calibrationPhotoRoot).catch(
    (error: unknown) => {
      emitCalibrationLog({
        level: 'error',
        component: 'calibration.photo',
        event: 'photo.staleTemporaryCleanupFailed',
        ...describeCalibrationFailure(error),
        outcome: 'failed',
      });
    },
  );
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
  // Asset manifest service for external calibration assets (issue #54).
  const calibrationAssetManifest = new CalibrationAssetManifestService();
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
   * Proof that an operator confirmed a clear bed. Minted only after this process
   * has seen the server report the job as awaiting acknowledgement.
   */
  const bedClearLedger = new BedClearAcknowledgementLedger();
  /** Bounded capability re-read after the server refuses an operation. */
  const capabilityRefresher = new CalibrationCapabilityRefresher();

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

  /** Returned when calibration state was discarded mid-verification. */
  const SELECTION_CHANGED_DURING_VERIFICATION: CalibrationGateResult = {
    allowed: false,
    code: 'selectionChanged',
    message:
      'The selected PrintFarmer profile changed while this action was being verified, so it was not performed.',
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
    } else {
      selectionCache.forgetProfile(profileId);
      capabilityRefresher.forgetProfile(profileId);
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

  /** Whether a thrown error is the server refusing on authorisation grounds. */
  const isForbidden = (error: unknown): boolean =>
    error instanceof CalibrationHttpError &&
    (error.code === 'authorization' || error.code === 'forbidden');

  /** Appended when a refusal means the cached permissions may be stale. */
  const ACCESS_MAY_HAVE_CHANGED =
    'Your calibration access may have changed. Reconnect or sign in again, then retry.';

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
        if (fencedProfileId !== null && isForbidden(error)) {
          await noteCalibrationForbidden(fencedProfileId);
        }
        throw error;
      }
    });
  };

  /**
   * Verify a mutating or machine-moving action against authoritative evidence
   * *before* anything is dispatched.
   *
   * The context is re-read from the server unless this process observed the very
   * same printer *and* configuration revision moments ago. Reusing that
   * observation matters: without it the backend profile resolver was called
   * twice for a single operator action, once to render the selection and once to
   * authorise it.
   *
   * A gate failure returns a refusal instead of throwing so each handler can
   * shape it into its own response union.
   */
  const gateCalibrationAction = async (
    action: CalibrationGatedAction,
    selectedId: string,
    binding: {
      printerId: string;
      configurationRevision: number | null;
      snapshotId: string | null;
      toolId: string | null;
    },
    operatorAcknowledgement?: boolean,
    options: { readonly bypassContextCache?: boolean } = {},
  ): Promise<CalibrationGateResult> => {
    const entryEpoch = calibrationStateEpoch;
    const acknowledgement =
      operatorAcknowledgement === undefined ? {} : { operatorAcknowledgement };
    const evidenceFor = (): {
      grantedScopes: readonly string[] | null;
      flags: {
        calibrationApiEnabled: boolean;
        calibrationGenerationEnabled: boolean;
      };
    } | null => {
      // Re-read rather than close over a captured object. The snapshot can be
      // discarded during the await below, and evaluating against the value that
      // was current when verification *started* is exactly the stale-positive
      // decision this interlock exists to prevent.
      const capability = calibrationDiagnostics.capabilitySnapshot(selectedId);
      return capability === null
        ? null
        : { grantedScopes: capability.grantedScopes, flags: capability.flags };
    };
    // Cheap refusals first: none of these needs the network, so an unauthorised
    // or disabled action never causes a request at all.
    const preflight = evaluateCalibrationActionGate({
      action,
      capability: evidenceFor(),
      // Context is supplied below; this pass exists to refuse on permission and
      // capability without paying for a round trip.
      context: null,
      binding: null,
      ...acknowledgement,
    });
    if (
      !preflight.allowed &&
      preflight.code !== 'contextUnavailable' &&
      preflight.code !== 'bindingMismatch'
    ) {
      return preflight;
    }
    let context =
      options.bypassContextCache === true
        ? // Dispatch re-reads authoritatively, never from the 30-second
          // observation window. That window is a convenience for rendering a
          // selection; a machine is about to move, and a configuration or
          // eligibility change inside those seconds is exactly the case where
          // acting on a remembered answer is wrong. The server remains the final
          // revalidator, but this client must not be the one to skip the check.
          null
        : selectionCache.context(
            selectedId,
            binding.printerId,
            binding.configurationRevision ?? undefined,
          );
    if (context === null) {
      try {
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        context = await calibrationHttp.getPrinterContext(
          selectedId,
          ctx.profile.baseUrl,
          binding.printerId,
          AbortSignal.timeout(10_000),
          binding.configurationRevision ?? undefined,
        );
        // Only cache what is still relevant. A write here after a switch would
        // repopulate a cache that was deliberately emptied.
        if (calibrationStateEpoch === entryEpoch) {
          selectionCache.rememberContext(selectedId, context);
        }
      } catch (error) {
        // A 403 here is the server refusing this account's context read, and it
        // must invalidate exactly as any other refusal does. This catch converts
        // the exception into a refusal, so nothing reaches the central wrapper —
        // without this the one path where a mutation is *about* to happen was
        // the one path that never corrected its evidence.
        if (isForbidden(error)) await noteCalibrationForbidden(selectedId);
        return {
          allowed: false,
          code: 'contextUnavailable',
          message:
            'The authoritative printer context could not be read, so this action cannot be verified.',
        };
      }
    }
    if (calibrationStateEpoch !== entryEpoch) {
      return SELECTION_CHANGED_DURING_VERIFICATION;
    }
    return evaluateCalibrationActionGate({
      action,
      capability: evidenceFor(),
      context,
      binding,
      ...acknowledgement,
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

  /** Maps a gate refusal onto the calibration API error vocabulary. */
  const gateRefusalToApiError = (
    gate: CalibrationGateResult,
  ): {
    code: 'forbidden' | 'printerContextStale' | 'syncRequired';
    message: string;
    retryable: boolean;
    retryAfterSeconds: null;
  } => ({
    code:
      gate.code === 'permissionDenied' ||
      gate.code === 'capabilityDisabled' ||
      gate.code === 'capabilityUnknown' ||
      gate.code === 'safetyNotAssured'
        ? 'forbidden'
        : gate.code === 'contextStale' ||
            gate.code === 'bindingMismatch' ||
            gate.code === 'selectionChanged' ||
            gate.code === 'contextIncomplete'
          ? 'printerContextStale'
          : 'syncRequired',
    message: gate.message ?? 'This calibration action is not permitted.',
    retryable: gate.code === 'contextUnavailable',
    retryAfterSeconds: null,
  });

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
    legacyBackupApprovals.clear();
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

  registerCalibrationHandler(IpcChannel.OpenCalibrationPhoto, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Select calibration photo',
      properties: ['openFile' as const],
      filters: [
        {
          name: 'Calibration photos',
          extensions: ['jpg', 'jpeg', 'png', 'webp'],
        },
      ],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const selectedPath =
      result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0]!;
    const response = selectedPath
      ? {
          approvalId: calibrationPhotoApprovals.approve(
            selectedPath,
            event.sender.id,
          ),
        }
      : null;
    return ipcSchemas[IpcChannel.OpenCalibrationPhoto].response.parse(response);
  });

  // --- CalibrationPickLegacyBackupV4: native file picker + local preflight ---
  // The renderer never receives a filesystem path; it only gets an approvalId
  // and the bounded preflight summary. Preflight does not contact the backend.

  ipcMain.handle(IpcChannel.CalibrationPickLegacyBackupV4, async (event) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: 'Open PrintFarmer Calibration Backup',
      properties: ['openFile' as const],
      filters: [
        {
          name: 'Calibration backup',
          extensions: ['pfdbak', 'json'],
        },
      ],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);

    const selectedPath =
      result.canceled || result.filePaths.length === 0
        ? null
        : result.filePaths[0]!;

    if (!selectedPath) {
      return ipcSchemas[
        IpcChannel.CalibrationPickLegacyBackupV4
      ].response.parse({ status: 'cancelled' });
    }

    try {
      const preflight = await runLegacyBackupPreflight(selectedPath);
      const approvalId = legacyBackupApprovals.approve(
        selectedPath,
        event.sender.id,
      );
      return ipcSchemas[
        IpcChannel.CalibrationPickLegacyBackupV4
      ].response.parse({
        status: 'ok',
        approvalId,
        preflight: {
          summary: preflight.summary,
          projectOutcomes: preflight.projectOutcomes,
          importableCount: preflight.importableCount,
          unsupportedCount: preflight.unsupportedCount,
          corruptCount: preflight.corruptCount,
          requiresActionCount: preflight.requiresActionCount,
          warnings: preflight.warnings,
        },
      });
    } catch (error) {
      return ipcSchemas[
        IpcChannel.CalibrationPickLegacyBackupV4
      ].response.parse({
        status: 'error',
        error: mapImportError(error),
      });
    }
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
          },
        );
      }

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
        const missingFlags = missingCalibrationFlags(caps);
        const firmwareOk = supportsKlipper(caps);
        const slicerOk = supportsOrcaSlicer(caps);
        // Discovery needs exactly one permission: `calibration:read`. Requiring
        // more to *open* the workspace would refuse an operator who is allowed to
        // look but not change, and this check did not exist at all before — the
        // `missingScopes` reason was declared and never once emitted, so an
        // unauthorised account saw an empty printer list and no explanation.
        // Create, update, generate and queue actions are gated separately, each by
        // its own exact permission, in the action interlock.
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
          },
        );
      } catch (error) {
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
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const printers = await calibrationHttp.getPrinters(
        selectedId,
        ctx.profile.baseUrl,
        signal,
      );
      return ipcSchemas[IpcChannel.CalibrationListPrinters].response.parse({
        printers: printers.printers.map((printer) => {
          const eligibility = projectCalibrationEligibility(printer);
          return {
            printerId: printer.printerId,
            displayName: printer.displayName,
            printerModel: printer.printerModel,
            firmwareCompatible:
              isExplicitCalibrationEligibilityComplete(printer),
            orcaProfileId: printer.orcaProfileId,
            isOnline: printer.isOnline,
            updatedAt: printer.updatedAt,
            // Carried so an ineligible printer can explain itself. Codes only,
            // and each is checked against the known catalogue before it
            // crosses the boundary, so an unfamiliar or hostile "code" cannot
            // arrive at the renderer as arbitrary text.
            rejectionReasonCodes:
              eligibility === null ? explainIneligibility(printer) : [],
            missingInputs:
              eligibility === null
                ? printer.missingInputs.map(normalizeCalibrationMissingInput)
                : [],
            // Only an explicit `true` promotes a candidate to a full
            // evaluation. An older server that omits the field is reporting
            // nothing, and treating silence as a completed profile evaluation
            // would let the candidate screen stand in for the authoritative
            // context it deliberately does not perform.
            evaluationScope:
              printer.profilesEvaluated === true ? 'full' : 'preliminary',
            eligibility,
          };
        }),
        printersTruncated: printers.truncated,
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
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const context = await calibrationHttp.getPrinterContext(
        selectedId,
        ctx.profile.baseUrl,
        request.printerId,
        signal,
      );
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
    IpcChannel.CalibrationListProjects,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListProjects].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const states = await sidecar.listCalibrationWorkspaceStates(selectedId);
      const unhydratedProjects =
        await sidecar.listCalibrationUnhydratedProjects(selectedId);
      return ipcSchemas[IpcChannel.CalibrationListProjects].response.parse({
        projects: [
          ...states.map((state) => ({
            projectId: state.projectId,
            profileId: state.profileId,
            printerId: state.printerId,
            displayName: state.displayName,
            status: state.status,
            stepCount: state.totalStepCount,
            completedStepCount: state.completedStepCount,
            hasConflicts: state.hasConflicts,
            isSynced: state.isSynced,
            isPrinterContextFresh: state.isPrinterContextFresh,
            remoteProjectId: state.remoteProjectId,
            baseRevision: state.baseRevision,
            recoveryState: null,
            createdAt: state.createdAt,
            updatedAt: state.updatedAt,
          })),
          ...unhydratedProjects.map((project) => ({
            projectId: project.projectId,
            profileId: project.profileId,
            printerId: project.printerId,
            displayName: project.displayName,
            status: project.status,
            stepCount: 0,
            completedStepCount: 0,
            hasConflicts: project.hasConflicts,
            isSynced: project.isSynced,
            isPrinterContextFresh: project.isPrinterContextFresh,
            remoteProjectId: project.remoteProjectId,
            baseRevision: project.baseRevision,
            recoveryState: project.recoveryState,
            createdAt: project.createdAt,
            updatedAt: project.updatedAt,
          })),
        ],
      });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetProject,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetProject].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const signal = AbortSignal.timeout(15_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const project = await calibrationHttp.getProject(
        selectedId,
        ctx.profile.baseUrl,
        request.projectId,
        signal,
      );
      if (!project) {
        throw Object.assign(new Error('Calibration project not found.'), {
          code: 'CALIBRATION_NOT_FOUND',
        });
      }
      const steps = await calibrationHttp.getProjectSteps(
        selectedId,
        ctx.profile.baseUrl,
        request.projectId,
        signal,
      );
      const boundContext = await calibrationHttp.getPrinterContext(
        selectedId,
        ctx.profile.baseUrl,
        project.printerId,
        signal,
      );
      const conflicts =
        await calibrationSidecarAdapter.listCalibrationConflicts(
          selectedId,
          request.projectId,
        );
      const pendingCount =
        await calibrationSidecarAdapter.countCalibrationPendingOperations(
          selectedId,
          request.projectId,
        );
      const printerFresh =
        await calibrationSidecarAdapter.isPrinterContextFresh(
          selectedId,
          request.projectId,
        );
      const projectedContext = projectCalibrationPrinterContext(boundContext);
      const effectivePrinterFresh = printerFresh && projectedContext.isCurrent;
      return ipcSchemas[IpcChannel.CalibrationGetProject].response.parse({
        projectId: project.id,
        profileId: selectedId,
        printerId: project.printerId,
        displayName: project.displayName,
        description: project.description,
        status: project.status,
        steps: steps.map((s) => ({
          stepId: s.id,
          ordinal: s.ordinal,
          kind: s.kind,
          status: s.status,
          displayName: s.displayName,
          prerequisites: s.prerequisites,
          methodNotes: s.methodNotes,
          expectedResult: s.expectedResult,
          measuredResult: s.measuredResult,
          reorderingSupported: s.reorderingSupported,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        })),
        printerContext: {
          ...projectedContext,
          isCurrent: effectivePrinterFresh,
        },
        hasConflicts: conflicts.length > 0,
        isSynced: pendingCount === 0,
        isPrinterContextFresh: effectivePrinterFresh,
        remoteProjectId: project.id,
        baseRevision: project.revision,
        changeFeedCursor: null,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationSaveDraft,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSaveDraft].request.parse(rawRequest);
      await requireSelectedCalibrationProfile(request.profileId);
      throw Object.assign(
        new Error(
          'calibration:saveDraft is deprecated; save the complete workspace state instead.',
        ),
        { code: 'CALIBRATION_SAVE_DRAFT_DEPRECATED' },
      );
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationListAttempts,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListAttempts].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const attempts = await calibrationHttp.getProjectAttempts(
        selectedId,
        ctx.profile.baseUrl,
        request.projectId,
        request.stepId,
        signal,
      );
      return ipcSchemas[IpcChannel.CalibrationListAttempts].response.parse({
        attempts: attempts.map((attempt) => ({
          attemptId: attempt.id,
          stepId: attempt.stepId,
          projectId: attempt.projectId,
          profileId: selectedId,
          attemptNumber: attempt.attemptNumber,
          measuredValue: attempt.measuredValue,
          measuredUnit: attempt.measuredUnit,
          isSelected: attempt.isSelected,
          printerContextSnapshotHash: attempt.printerContextSnapshotHash,
          remoteAttemptId: attempt.id,
          remoteRevision: attempt.revision,
          createdAt: attempt.createdAt,
        })),
      });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetAttempt,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetAttempt].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const attempt = await calibrationHttp.getAttempt(
        selectedId,
        ctx.profile.baseUrl,
        request.attemptId,
        signal,
      );
      if (!attempt) {
        throw Object.assign(new Error('Calibration attempt not found.'), {
          code: 'CALIBRATION_NOT_FOUND',
        });
      }
      return ipcSchemas[IpcChannel.CalibrationGetAttempt].response.parse({
        attemptId: attempt.id,
        stepId: attempt.stepId,
        projectId: attempt.projectId,
        profileId: selectedId,
        attemptNumber: attempt.attemptNumber,
        measuredValue: attempt.measuredValue,
        measuredUnit: attempt.measuredUnit,
        isSelected: attempt.isSelected,
        printerContextSnapshotHash: attempt.printerContextSnapshotHash,
        remoteAttemptId: attempt.id,
        remoteRevision: attempt.revision,
        createdAt: attempt.createdAt,
      });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationStagePhoto,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStagePhoto].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const approvedPath = calibrationPhotoApprovals.consume(
        request.approvalId,
        event.sender.id,
      );
      await cleanupStaleCalibrationPhotoTemps(calibrationPhotoRoot);
      const staged = await stagePrivateCalibrationPhoto(
        approvedPath,
        calibrationPhotoRoot,
        selectedId,
        request.photoId,
      );

      const now = new Date().toISOString();
      try {
        const photo = await sidecar.stageCalibrationPhoto({
          photoId: request.photoId,
          attemptId: request.attemptId,
          stageId: request.stageId,
          projectId: request.projectId,
          profileId: selectedId,
          contentHash: staged.contentHash,
          mimeType: staged.mimeType,
          byteSize: staged.bytes.byteLength,
          localPath: staged.localPath,
          stagedAt: now,
          caption: request.caption,
          order: request.order,
        });
        return ipcSchemas[IpcChannel.CalibrationStagePhoto].response.parse(
          photo,
        );
      } catch (error) {
        if (staged.created) {
          await rm(staged.localPath, { force: true }).catch(() => undefined);
        }
        throw error;
      }
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

  registerCalibrationHandler(
    IpcChannel.CalibrationResolveConflict,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationResolveConflict].request.parse(
          rawRequest,
        );
      await requireSelectedCalibrationProfile(request.profileId);
      // Same predicate that decides CalibrationConflict.availableResolutions.
      // If this handler refused on its own hard-coded assumption, the two could
      // disagree -- the UI offering actions this channel rejects, or the
      // reverse. One fact, two readers.
      //
      // Checked before the permission gate deliberately: "this build cannot
      // resolve conflicts at all" is a more specific and more actionable answer
      // than "you may not write", and putting the generic refusal first would
      // replace a precise diagnosis with a vague one.
      if (!supportsConflictResolution(calibrationSidecarAdapter)) {
        throw Object.assign(
          new Error(
            'Conflict resolution is unavailable until the authoritative resolution RPC is present.',
          ),
          { code: 'CALIBRATION_CONFLICT_RESOLUTION_UNAVAILABLE' },
        );
      }
      // Deliberately not gated on a server permission. Resolving a conflict
      // writes the chosen side to the local sidecar store; nothing reaches
      // PrintFarmer until the outbox is applied, and `CalibrationSyncNow` — the
      // channel that actually pushes — is gated there. Refusing here as well
      // would stop an operator with read-only farm access from tidying their own
      // local state, and would refuse before capabilities have been negotiated
      // at all on a workspace opened offline.
      //
      // Parsed on the way out, as the sibling list channel above already does
      // and as 130-odd handlers in this file do. Without it this channel is the
      // one place a value that violates CalibrationConflict reaches the renderer
      // unremarked -- which is how an epoch-seconds `resolvedAt` travelled past
      // a `.datetime()` declaration (#363). The contract is only a contract
      // where something reads it.
      return ipcSchemas[IpcChannel.CalibrationResolveConflict].response.parse(
        await calibrationSidecarAdapter.resolveCalibrationConflict(request),
      );
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
        // The engine emits the sync record and records the diagnostics
        // outcome: it is the only layer that still holds the typed error code.
        const result = await calibrationEngine.syncNow(
          selectedId,
          request.projectId ?? null,
          controller.signal,
        );
        // Read that typed code back rather than parsing the operator-facing
        // message. `syncNow` converts a `CalibrationHttpError` into a failed
        // status, so nothing throws for the channel wrapper to catch, and a 403
        // from `/api/calibration-sync/apply` would otherwise leave the positive
        // update permission active and the workspace still offering sync.
        //
        // The outbox operation is not replayed. Correcting the evidence is a
        // read; pushing the operator's queued changes again is not, and doing it
        // because a permission check changed its mind would act on their behalf.
        const syncErrorCode =
          calibrationDiagnostics.lastSyncSnapshot()?.errorCode ?? null;
        if (
          result.phase === 'failed' &&
          (syncErrorCode === 'authorization' || syncErrorCode === 'forbidden')
        ) {
          const staleAccess = await noteCalibrationForbidden(selectedId);
          return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
            ...result,
            error: staleAccess
              ? `${result.error ?? 'Calibration synchronization was refused.'} ${ACCESS_MAY_HAVE_CHANGED}`
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

  // Generation, queue, bed-clear, and print start require all mutations to be
  // synchronized and printer context to be freshly validated before proceeding.

  registerCalibrationHandler(
    IpcChannel.CalibrationStartGeneration,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStartGeneration].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      // Interlock first: a refusal must cost no network call and must never
      // leave a half-started flow behind. Previously nothing here checked
      // permission, capability or binding at all — the only gate was the
      // server's own refusal, which necessarily arrives after the request.
      const actionEpoch = calibrationStateEpoch;
      const gate = await gateCalibrationAction(
        'generate',
        selectedId,
        request.binding,
      );
      if (!gate.allowed) {
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'error',
            error: { ...gateRefusalToApiError(gate), reference: null },
          },
        );
      }
      // Check prerequisites via engine.
      const prerequisiteError =
        await calibrationEngine.checkOnlineActionPrerequisites(
          selectedId,
          request.projectId,
        );
      if (prerequisiteError !== null) {
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'error',
            error: {
              code: 'syncRequired',
              message: prerequisiteError,
              retryable: true,
              retryAfterSeconds: null,
              reference: null,
            },
          },
        );
      }
      const signal = AbortSignal.timeout(30_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      // Mint the flow here: this is the user-initiated start of the operation.
      // The later stages resolve it through the orchestration and job IDs.
      const correlationId = calibrationCorrelation.beginFlow({
        attempt: request.attemptId,
        operation: request.operationId,
      });
      const correlationOrigin = 'flowStart' as const;
      const startedAt = Date.now();
      emitCalibrationLog({
        level: 'info',
        component: 'calibration.http',
        event: 'generation.requested',
        correlationId,
        correlationOrigin,
        operationId: request.operationId,
        profileId: selectedId,
        projectId: request.projectId,
        attemptId: request.attemptId,
      });
      // Re-verified immediately before dispatch. The gate checks at the end of
      // its own work, but a prerequisite query, an authentication and a
      // correlation begin all happen afterwards, and a profile switch during
      // *those* would otherwise still reach the wire.
      if (!calibrationStateUnchanged(actionEpoch, selectedId, 'generate')) {
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'error',
            error: {
              ...gateRefusalToApiError(SELECTION_CHANGED_DURING_VERIFICATION),
              reference: null,
            },
          },
        );
      }
      try {
        const result = await calibrationHttp.startGeneration(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          request.attemptId,
          request.method,
          request.definitionVersion,
          request.options,
          request.operationId,
          request.baseRevision,
          signal,
        );
        calibrationCorrelation.bind('orchestration', result.id, correlationId);
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'generation.submitted',
          correlationId,
          correlationOrigin,
          operationId: request.operationId,
          profileId: selectedId,
          projectId: request.projectId,
          attemptId: request.attemptId,
          orchestrationId: result.id,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'submitted',
            orchestrationId: result.id,
          },
        );
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'generation.requested',
          correlationId,
          correlationOrigin,
          operationId: request.operationId,
          profileId: selectedId,
          projectId: request.projectId,
          attemptId: request.attemptId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        // A refusal means the permissions this action was gated against may be
        // stale. Re-read them so the workspace stops offering what the server
        // will keep refusing — and do not replay the generation, which is the
        // operator's decision to make.
        const staleAccess = isForbidden(error)
          ? await noteCalibrationForbidden(selectedId)
          : false;
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(correlationId)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error ? error.message : 'Generation failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'error',
            error: staleAccess
              ? {
                  ...apiError,
                  message: `${apiError.message} ${ACCESS_MAY_HAVE_CHANGED}`,
                }
              : apiError,
          },
        );
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetOrchestrationStatus,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetOrchestrationStatus].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const signal = AbortSignal.timeout(15_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      // Resolves the ID minted at the generation request. `resolveOrBegin`
      // rather than `resolve` so a poll that follows an app restart still
      // carries an ID a runbook can grep, instead of a hole.
      const { correlationId, origin: correlationOrigin } =
        calibrationCorrelation.resolveOrBeginWithOrigin([
          ['orchestration', request.orchestrationId],
        ]);
      const startedAt = Date.now();
      try {
        const remote = await calibrationHttp.getOrchestrationStatus(
          selectedId,
          ctx.profile.baseUrl,
          request.orchestrationId,
          signal,
        );
        // The server echoes the operationId that started this orchestration;
        // binding it keeps the two searchable from one another.
        if (remote.operationId !== null) {
          calibrationCorrelation.bind(
            'operation',
            remote.operationId,
            correlationId,
          );
        }
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'orchestration.polled',
          correlationId,
          correlationOrigin,
          operationId: remote.operationId,
          profileId: selectedId,
          projectId: remote.projectId,
          attemptId: remote.attemptId,
          orchestrationId: remote.id,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationGetOrchestrationStatus
        ].response.parse({
          status: 'ok',
          orchestration: {
            id: remote.id,
            projectId: remote.projectId,
            attemptId: remote.attemptId,
            operationId: remote.operationId,
            status: remote.status,
            currentStep: remote.currentStep,
            revision: remote.revision,
            retryCount: remote.retryCount,
            nextRetryAtUtc: remote.nextRetryAtUtc,
            stepStartedAtUtc: remote.stepStartedAtUtc,
            lastErrorCode: remote.lastErrorCode,
            problems: remote.problems,
            model3DId: remote.model3DId,
            sliceJobId: remote.sliceJobId,
            workerId: remote.workerId,
            sourceArtifactId: remote.sourceArtifactId,
            finalArtifactId: remote.finalArtifactId,
            gcodeFileId: remote.gcodeFileId,
            specificationSha256: remote.specificationSha256,
            planManifestSha256: remote.planManifestSha256,
            gcodeSha256: remote.gcodeSha256,
            manifestSha256: remote.manifestSha256,
            generatorVersion: remote.generatorVersion,
            slicerContainerDigest: remote.slicerContainerDigest,
            slicerBinarySha256: remote.slicerBinarySha256,
            statusRoute: remote.statusRoute,
            createdAtUtc: remote.createdAtUtc,
            updatedAtUtc: remote.updatedAtUtc,
            completedAtUtc: remote.completedAtUtc,
          },
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'orchestration.polled',
          correlationId,
          correlationOrigin,
          profileId: selectedId,
          orchestrationId: request.orchestrationId,
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
                    : 'Orchestration status fetch failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        return ipcSchemas[
          IpcChannel.CalibrationGetOrchestrationStatus
        ].response.parse({
          status: 'error',
          error: apiError,
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationGetQueueState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetQueueState].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      const prerequisiteError =
        await calibrationEngine.checkOnlineActionPrerequisites(
          selectedId,
          request.projectId,
        );
      if (prerequisiteError !== null) {
        return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: prerequisiteError,
            retryable: true,
            retryAfterSeconds: null,
            reference: null,
          },
        });
      }
      // If no jobId provided, there is no job to look up.
      if (!request.jobId) {
        return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
          status: 'error',
          error: {
            code: 'jobNotFound',
            message: 'No job ID provided — no queue job to look up.',
            retryable: false,
            retryAfterSeconds: null,
            reference: null,
          },
        });
      }
      const signal = AbortSignal.timeout(15_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      // A queue job is often seen here for the first time: the generation stage
      // binds the attempt, and the server only names the job later. So resolve
      // through the job if it is already known, and otherwise defer minting
      // until the response reveals the attempt this job belongs to — minting
      // eagerly would split one flow across two correlation IDs.
      let correlationId = calibrationCorrelation.resolve('job', request.jobId);
      let correlationOrigin: CalibrationCorrelationOrigin =
        correlationId === null ? 'resumed' : 'continued';
      const flowId = (): string => {
        if (correlationId !== null) return correlationId;
        const resolved = calibrationCorrelation.resolveOrBeginWithOrigin([
          ['job', request.jobId ?? null],
        ]);
        correlationId = resolved.correlationId;
        correlationOrigin = resolved.origin;
        return correlationId;
      };
      const startedAt = Date.now();
      try {
        const remote = await calibrationHttp.getQueueJob(
          selectedId,
          ctx.profile.baseUrl,
          request.jobId,
          signal,
        );
        if (remote === null) {
          emitCalibrationLog({
            level: 'warn',
            component: 'calibration.http',
            event: 'queue.stateRead',
            correlationId: flowId(),
            correlationOrigin,
            dispatchId: request.jobId,
            profileId: selectedId,
            projectId: request.projectId,
            outcome: 'failed',
            errorCode: 'jobNotFound',
            durationMs: Date.now() - startedAt,
          });
          return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse(
            {
              status: 'error',
              error: {
                code: 'jobNotFound',
                message: `Queue job ${request.jobId} does not exist.`,
                retryable: false,
                retryAfterSeconds: null,
                reference: null,
              },
            },
          );
        }
        // The attempt binding ties the queue job back to the flow that
        // generated it, so a job seen first here still resolves later stages.
        const resolved = calibrationCorrelation.resolveOrBeginWithOrigin([
          ['job', remote.id],
          ['attempt', remote.calibrationAttemptId],
        ]);
        correlationId = resolved.correlationId;
        correlationOrigin = resolved.origin;
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'queue.stateRead',
          correlationId,
          correlationOrigin,
          dispatchId: remote.id,
          dispatchRevision: remote.dispatchStateRowVersion,
          profileId: selectedId,
          projectId: remote.calibrationProjectId,
          attemptId: remote.calibrationAttemptId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
          status: 'ok',
          job: {
            jobId: remote.id,
            jobKind: remote.jobKind,
            rowVersion: remote.rowVersion,
            dispatchStateRowVersion: remote.dispatchStateRowVersion,
            status: remote.status,
            dispatchAttemptOutcome: remote.dispatchResult?.outcome ?? null,
            bedClearState: remote.bedClearState,
            gcodeFileId: remote.gcodeFileId,
            assignedPrinterId: remote.assignedPrinterId,
            calibrationProjectId: remote.calibrationProjectId,
            calibrationAttemptId: remote.calibrationAttemptId,
            pinnedPrinterConfigRevision: remote.pinnedPrinterConfigRevision,
            priority: remote.priority,
            queuePosition: remote.queuePosition,
            updatedAt: remote.updatedAt,
          },
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'queue.stateRead',
          correlationId: flowId(),
          correlationOrigin,
          dispatchId: request.jobId,
          profileId: selectedId,
          projectId: request.projectId,
          outcome: 'failed',
          durationMs: Date.now() - startedAt,
          ...describeCalibrationFailure(error),
        });
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError(flowId())
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Queue job lookup failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: flowId(),
              };
        return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
          status: 'error',
          error: apiError,
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationAcknowledgeBedClear,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationAcknowledgeBedClear].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      // Bed-clear acknowledgement is a transactional operation scoped to a
      // specific queue job — the prerequisite sync check is not applicable here.
      // The interlock still applies: this call releases a job for dispatch, so
      // it is the last point at which permission, capability and
      // printer/revision binding can be verified before the machine moves.
      //
      // Permissions are checked *first*, before the job is even read. This
      // module promises to fail closed before dispatch, and an account that may
      // not acknowledge or start a job has no business issuing the queue read
      // either — that read is itself an authorised operation, and performing it
      // to decide whether the caller is authorised has the order backwards.
      const actionEpoch = calibrationStateEpoch;
      const queuePermission = gateCalibrationPermission(
        'acknowledgeBedClear',
        selectedId,
      );
      if (!queuePermission.allowed) {
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: { ...gateRefusalToApiError(queuePermission), reference: null },
        });
      }

      // The operator's confirmation is established here rather than taken from
      // the renderer. Main asks the server for the job and mints a single-use,
      // short-lived ledger record only if the server itself reports a job this
      // dispatch may legitimately release. A renderer cannot manufacture that
      // observation, which is precisely why the earlier
      // `operatorAcknowledgedBedClear: true` flag was worthless: the party being
      // gated was asserting its own precondition.
      const acknowledgementBinding = {
        profileId: selectedId,
        printerId: request.printerId,
        configurationRevision: request.expectedPrinterConfigRevision ?? null,
        jobId: request.jobId,
        projectId: null,
        attemptId: null,
        operationId: request.operationId,
      };
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      let observedJob: Awaited<
        ReturnType<typeof calibrationHttp.getQueueJob>
      > | null = null;
      try {
        observedJob = await calibrationHttp.getQueueJob(
          selectedId,
          ctx.profile.baseUrl,
          request.jobId,
          AbortSignal.timeout(10_000),
        );
      } catch {
        observedJob = null;
      }
      // Every condition is explicit, and an omitted field is a refusal.
      //
      // `bedClearState` used to be accepted as `null`, which is what the current
      // `GET /api/job-queue/{id}` returns because the read model omits the
      // member entirely (PrintFarmer#1465). Treating that silence as `None`
      // meant *any* job assigned to the printer could mint the ledger, so the
      // fail-closed preflight this module advertises was not real: the server's
      // own refusal was still the only thing protecting dispatch. An absent
      // state is now a refusal, which is the honest reading of "the server did
      // not say".
      //
      // `Acknowledged` is likewise no longer accepted. Honouring it needs the
      // command identity that would prove a replay is the *same* acknowledgement
      // rather than a second one, and that identity does not exist on the wire
      // until #1465 lands. Once it does, this should require FilamentCalibration
      // kind, the exact printer, calibration lineage and pinned configuration
      // revision, a dispatchable status, and either an explicit `None` or an
      // `Acknowledged` whose command ID matches.
      const serverSaysAwaitingBedClear =
        observedJob !== null &&
        observedJob.assignedPrinterId === request.printerId &&
        // A queue holds more than calibration work; only a calibration job may
        // be released through a calibration acknowledgement.
        observedJob.jobKind === 'FilamentCalibration' &&
        observedJob.bedClearState === 'None';
      if (serverSaysAwaitingBedClear) {
        bedClearLedger.record(acknowledgementBinding);
      }
      const gate = await gateCalibrationAction(
        'acknowledgeBedClear',
        selectedId,
        {
          printerId: request.printerId,
          configurationRevision: request.expectedPrinterConfigRevision ?? null,
          snapshotId: null,
          toolId: null,
        },
        // Single-use: a replayed dispatch finds nothing left to consume.
        bedClearLedger.consume(acknowledgementBinding),
        // The machine is about to move: read the context fresh rather than from
        // the selection observation window.
        { bypassContextCache: true },
      );
      if (!gate.allowed) {
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: { ...gateRefusalToApiError(gate), reference: null },
        });
      }
      const signal = AbortSignal.timeout(15_000);
      const { correlationId, origin: correlationOrigin } =
        calibrationCorrelation.resolveOrBeginWithOrigin([
          ['job', request.jobId],
          ['operation', request.operationId],
        ]);
      const startedAt = Date.now();
      if (
        !calibrationStateUnchanged(
          actionEpoch,
          selectedId,
          'acknowledgeBedClear',
        )
      ) {
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: {
            ...gateRefusalToApiError(SELECTION_CHANGED_DURING_VERIFICATION),
            reference: null,
          },
        });
      }
      try {
        const result = await calibrationHttp.acknowledgeBedClearAndStart(
          selectedId,
          ctx.profile.baseUrl,
          request.jobId,
          request.printerId,
          request.operationId,
          request.rowVersion,
          request.dispatchStateRowVersion,
          request.expectedPrinterConfigRevision,
          signal,
        );
        if (result.kind === 'revisionConflict') {
          emitCalibrationLog({
            level: 'warn',
            component: 'calibration.http',
            event: 'bedClear.revisionConflict',
            correlationId,
            correlationOrigin,
            operationId: request.operationId,
            dispatchId: request.jobId,
            dispatchRevision: result.dispatchStateETag,
            profileId: selectedId,
            outcome: 'failed',
            errorCode: 'dispatchRevisionConflict',
            durationMs: Date.now() - startedAt,
          });
          return ipcSchemas[
            IpcChannel.CalibrationAcknowledgeBedClear
          ].response.parse({
            status: 'revisionConflict',
            jobRowVersion: result.jobETag,
            dispatchStateRowVersion: result.dispatchStateETag,
          });
        }
        emitCalibrationLog({
          level: 'info',
          component: 'calibration.http',
          event: 'bedClear.acknowledged',
          correlationId,
          correlationOrigin,
          operationId: request.operationId,
          dispatchId: request.jobId,
          dispatchRevision: result.dispatchStateETag,
          profileId: selectedId,
          outcome: 'ok',
          durationMs: Date.now() - startedAt,
        });
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'ok',
          jobRowVersion: result.jobETag,
          dispatchStateRowVersion: result.dispatchStateETag,
        });
      } catch (error) {
        emitCalibrationLog({
          level: 'error',
          component: 'calibration.http',
          event: 'bedClear.acknowledged',
          correlationId,
          correlationOrigin,
          operationId: request.operationId,
          dispatchId: request.jobId,
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
                  error instanceof Error ? error.message : 'Bed-clear failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: correlationId,
              };
        const staleAccess = isForbidden(error)
          ? await noteCalibrationForbidden(selectedId)
          : false;
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: staleAccess
            ? {
                ...apiError,
                message: `${apiError.message} ${ACCESS_MAY_HAVE_CHANGED}`,
              }
            : apiError,
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationStartPrint,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStartPrint].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
      // Enqueuing a calibration print leads to machine movement once the job is
      // dispatched, so it is gated on the same authoritative evidence as any
      // other machine-moving action. `assignedPrinterId` and
      // `pinnedPrinterConfigRevision` already named the binding; they are now
      // actually verified against the server rather than merely forwarded.
      const actionEpoch = calibrationStateEpoch;
      const gate = await gateCalibrationAction('startPrint', selectedId, {
        printerId: request.assignedPrinterId,
        configurationRevision: request.pinnedPrinterConfigRevision,
        snapshotId: null,
        toolId: null,
      });
      if (!gate.allowed) {
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'error',
          error: { ...gateRefusalToApiError(gate), reference: null },
        });
      }
      const prerequisiteError =
        await calibrationEngine.checkOnlineActionPrerequisites(
          selectedId,
          request.projectId,
        );
      if (prerequisiteError !== null) {
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: prerequisiteError,
            retryable: true,
            retryAfterSeconds: null,
          },
        });
      }
      const signal = AbortSignal.timeout(30_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      if (!calibrationStateUnchanged(actionEpoch, selectedId, 'startPrint')) {
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'error',
          error: gateRefusalToApiError(SELECTION_CHANGED_DURING_VERIFICATION),
        });
      }
      try {
        const result = await calibrationHttp.createQueueJob(
          selectedId,
          ctx.profile.baseUrl,
          {
            gcodeFileId: request.gcodeFileId,
            assignedPrinterId: request.assignedPrinterId,
            operationId: request.operationId,
            calibrationProjectId: request.projectId,
            calibrationAttemptId: request.attemptId,
            calibrationOrchestrationId: request.orchestrationId,
            pinnedPrinterConfigRevision: request.pinnedPrinterConfigRevision,
            gcodeContentSha256: request.gcodeContentSha256,
            specificationSha256: request.specificationSha256,
            machineProfileSha256: request.machineProfileSha256,
            processProfileSha256: request.processProfileSha256,
            filamentProfileSha256: request.filamentProfileSha256,
            printerConfigSnapshotSha256: request.printerConfigSnapshotSha256,
            requiredFirmwareFamily: request.requiredFirmwareFamily,
            requiredGcodeDialect: request.requiredGcodeDialect,
            requiredSlicerEngine: request.requiredSlicerEngine,
            requiredSlicerDistribution: request.requiredSlicerDistribution,
            requiredSlicerVersion: request.requiredSlicerVersion,
            requiredSlicerContainerDigest:
              request.requiredSlicerContainerDigest,
          },
          signal,
        );
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'ok',
          jobId: result.jobId,
          rowVersion: result.rowVersion,
          dispatchStateRowVersion: result.dispatchStateRowVersion,
          replayed: result.replayed,
        });
      } catch (error) {
        const staleAccess = isForbidden(error)
          ? await noteCalibrationForbidden(selectedId)
          : false;
        const apiError =
          error instanceof CalibrationHttpError
            ? // No reference: this handler neither begins a correlated flow nor
              // emits a failure log, so any id minted here would appear in no
              // record and resolve to nothing when quoted (#177).
              error.toApiError(null)
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Print start failed.',
                retryable: false,
                retryAfterSeconds: null,
                reference: null,
              };
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'error',
          error: staleAccess
            ? {
                ...apiError,
                message: `${apiError.message} ${ACCESS_MAY_HAVE_CHANGED}`,
              }
            : apiError,
        });
      }
    },
  );

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
        ].response.parse({ status: 'error', error: apiError });
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
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // --- External calibration asset manifest (issue #54) ---------------------

  registerCalibrationHandler(
    IpcChannel.CalibrationGetAssetManifest,
    async () => {
      try {
        const manifest = await calibrationAssetManifest.load();
        return ipcSchemas[
          IpcChannel.CalibrationGetAssetManifest
        ].response.parse(manifest);
      } catch (error) {
        return ipcSchemas[
          IpcChannel.CalibrationGetAssetManifest
        ].response.parse({
          status: 'error',
          message:
            error instanceof Error ? error.message : 'Manifest load failed.',
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationPickAssetFile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationPickAssetFile].request.parse(
          rawRequest,
        );
      try {
        const result = await calibrationAssetManifest.pickFile(
          request.allowedExtensions,
          request.title,
        );
        return ipcSchemas[IpcChannel.CalibrationPickAssetFile].response.parse(
          result,
        );
      } catch (error) {
        return ipcSchemas[IpcChannel.CalibrationPickAssetFile].response.parse({
          status: 'error',
          message:
            error instanceof Error ? error.message : 'File picker failed.',
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationValidateAssetFile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationValidateAssetFile].request.parse(
          rawRequest,
        );
      try {
        const result = await calibrationAssetManifest.validateFile(
          request.approvalId,
          request.method,
        );
        return ipcSchemas[
          IpcChannel.CalibrationValidateAssetFile
        ].response.parse(result);
      } catch (error) {
        return ipcSchemas[
          IpcChannel.CalibrationValidateAssetFile
        ].response.parse({
          status: 'error',
          message:
            error instanceof Error ? error.message : 'Asset validation failed.',
        });
      }
    },
  );

  // --- Allowlisted external navigation for manifest URLs (criterion 14) ----
  registerCalibrationHandler(
    IpcChannel.CalibrationOpenManifestUrl,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationOpenManifestUrl].request.parse(
          rawRequest,
        );
      // Validate the URL against the source URLs declared in the versioned
      // asset manifest. Only URLs that actually appear as a reviewed sourceUrl
      // entry are allowed — this is a genuine allowlist, not a scheme heuristic.
      const isAllowed = await calibrationAssetManifest.isManifestSourceUrl(
        request.url,
      );
      if (!isAllowed) {
        return ipcSchemas[IpcChannel.CalibrationOpenManifestUrl].response.parse(
          {
            status: 'error',
            message:
              'URL is not in the approved calibration asset manifest source list.',
          },
        );
      }
      const { shell } = await import('electron');
      await shell.openExternal(request.url);
      return ipcSchemas[IpcChannel.CalibrationOpenManifestUrl].response.parse({
        status: 'ok',
      });
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
      const profileContext = await profiles.getAuthenticatedContext(selectedId);
      const signal = AbortSignal.timeout(15_000);
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
        const scan = await listLocalOrcaFilamentProfiles({
          limit: LOCAL_PROFILE_EXEMPLAR_LIMIT,
        }).catch(() => ({
          installFound: false,
          profiles: [] as Array<{
            name: string;
            source: 'systemInstall' | 'userImported';
            material: string | null;
          }>,
        }));
        const localDiscovery = !scan.installFound
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

      // Resolution is scoped to the one printer the operator selected. Earlier
      // builds listed every candidate and then fetched a context *and* ran a
      // full local OrcaSlicer scan per printer, so the cost grew with farm size
      // and snapshots were pulled for printers nobody asked about. The candidate
      // list is still fetched — exactly once — because eligibility is the
      // server's to decide and must never be inferred from a model name.
      let candidates: Awaited<
        ReturnType<typeof calibrationHttp.getPrinters>
      >['printers'];
      try {
        candidates = (
          await calibrationHttp.getPrinters(
            selectedId,
            profileContext.profile.baseUrl,
            signal,
          )
        ).printers;
      } catch (error) {
        // Discovery is usually where a revoked permission is noticed first, so
        // the cached snapshot is re-read here too — without retrying the
        // listing, which the operator can repeat themselves.
        const classified = classifyDiscoveryFailure(error);
        if (isForbidden(error)) await noteCalibrationForbidden(selectedId);
        return answer({
          discovery: isForbidden(error)
            ? {
                ...classified,
                message: `${classified.message} ${ACCESS_MAY_HAVE_CHANGED}`,
              }
            : classified,
          ...(await diagnoseLocalInstallWithoutContext()),
        });
      }

      const candidate = candidates.find(
        (entry) => entry.printerId === printerId,
      );
      if (candidate === undefined) {
        return answer({
          discovery: {
            kind:
              candidates.length === 0
                ? 'noEligiblePrinters'
                : 'selectedPrinterNotACandidate',
            message:
              candidates.length === 0
                ? 'The server returned no calibration candidate printers for this account.'
                : 'PrintFarmer no longer lists the selected printer as a calibration candidate. Choose a printer again.',
            serverCode: null,
          },
          ...(await diagnoseLocalInstallWithoutContext()),
        });
      }

      if (
        !candidate.isOnline ||
        // The server's own verdict, not merely that the eligibility object
        // parsed. `isExplicitCalibrationEligibilityComplete` is true for a
        // candidate carrying `eligible: false` with valid reasons — it means
        // "well-formed", not "permitted" — so checking it alone let a renderer
        // bypass resolve a printer the server had explicitly refused.
        candidate.eligible !== true ||
        candidate.rejectionReasons.length > 0 ||
        candidate.missingInputs.length > 0 ||
        !isExplicitCalibrationEligibilityComplete(candidate)
      ) {
        // The renderer blocks continuation on an ineligible printer, so this is
        // defence in depth rather than the primary gate. Refusing here keeps a
        // context request off the wire for a printer the server already refused.
        return answer({
          discovery: {
            kind: 'noProfilesForSelectedPrinter',
            message:
              'PrintFarmer does not consider the selected printer eligible for calibration, so no profile was resolved for it.',
            serverCode: null,
          },
        });
      }

      let context: Awaited<
        ReturnType<typeof calibrationHttp.getPrinterContext>
      >;
      try {
        context = await calibrationHttp.getPrinterContext(
          selectedId,
          profileContext.profile.baseUrl,
          printerId,
          signal,
          request.configurationRevision,
        );
      } catch (error) {
        const classified = classifyDiscoveryFailure(error);
        // A context failure describes one printer. It must never be reported in
        // a way the renderer could render as "there are no printers": the list
        // the operator selected from is still valid and still on screen.
        return answer({
          discovery:
            classified.kind === 'profileResolverUnavailable'
              ? classified
              : {
                  kind: 'selectedPrinterContextUnavailable',
                  message: classified.message,
                  serverCode: classified.serverCode,
                },
          ...(await diagnoseLocalInstallWithoutContext()),
        });
      }

      const configurationRevision = context.configurationRevision;
      const pfEntry = projectPrintFarmerOrcaProfile(candidate, context);
      // Bound to this printer's exact profile name, nozzle and content hash.
      // The server's GUID identifies the profile; only the name can be matched
      // against a file in the local OrcaSlicer installation, and the two are
      // never interchanged. One traversal answers both "did it match" and, on a
      // miss, "why not".
      const local = await discoverLocalOrcaFilamentProfiles(context).catch(
        () => ({
          entries: [] as Awaited<
            ReturnType<typeof discoverLocalOrcaFilamentProfiles>
          >['entries'],
          diagnostic: {
            installFound: false,
            enumeratedFileCount: 0,
            parsedFileCount: 0,
            exemplars: [] as readonly string[],
          },
        }),
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

      return answer({
        profiles: resolved,
        configurationRevision,
        discovery:
          pfEntry === null
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
              },
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

  registerCalibrationHandler(
    IpcChannel.CalibrationExportOrcaProfile,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationExportOrcaProfile].request.parse(
          rawRequest,
        );
      // Retrieve the cached generated profile that was produced by a prior
      // CalibrationGenerateOrcaProfile call with this operationId. The renderer
      // cannot supply arbitrary profile bytes; they must originate from the
      // main-process generation step.
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
          const canonicalDest = await canonicalizeSaveTarget(
            saveResult.filePath,
          );
          // Write exact bytes.
          const { writeFile } = await import('node:fs/promises');
          await writeFile(canonicalDest, cached.generatedJson, 'utf8');
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

  ipcMain.handle(
    IpcChannel.CalibrationImportLegacyBackupV4,
    async (event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationImportLegacyBackupV4].request.parse(
          rawRequest,
        );
      // Security: verify profile identity before any file access.
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );

      // Consume the approval — this resolves the approvalId to a file path and
      // removes it from the store (single-use). If expired or wrong owner, throws.
      let filePath: string;
      try {
        filePath = legacyBackupApprovals.consume(
          request.approvalId,
          event.sender.id,
        );
      } catch (error) {
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'error',
          error: mapImportError(error),
        });
      }

      // Re-run preflight to get the parsed backup structure (the approval store
      // only remembers the path, not the parsed content, to avoid memory leaks).
      let preflight: PreflightResult;
      try {
        preflight = await runLegacyBackupPreflight(filePath);
      } catch (error) {
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'error',
          error: mapImportError(error),
        });
      }

      if (preflight.parsedBackup === null) {
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'error',
          error: {
            code: 'invalidData',
            message: 'Backup preflight failed; no valid data to import.',
            retryable: false,
            retryAfterSeconds: null,
            reference: null,
          },
        });
      }

      // Validate printer mappings: every importable project that requires
      // mapping must have an explicit entry.
      type ProjectOutcome = z.infer<typeof LegacyBackupProjectOutcome>;
      const allOutcomes: ProjectOutcome[] = preflight.projectOutcomes;
      const requiringMapping = allOutcomes.filter(
        (o: ProjectOutcome) =>
          o.requiresPrinterMapping &&
          (o.outcome === 'importable' || o.outcome === 'requiresAction'),
      );
      const providedMappingIds = new Set(
        request.printerMappings.map((m) => m.legacyProjectId),
      );
      const missingMappings = requiringMapping.filter(
        (o: ProjectOutcome) => !providedMappingIds.has(o.legacyProjectId),
      );
      if (missingMappings.length > 0) {
        const missingIds = missingMappings
          .slice(0, 5)
          .map((o: ProjectOutcome) => o.legacyProjectId)
          .join(', ');
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'error',
          error: {
            code: 'invalidData',
            message: `Missing explicit printer/toolhead mappings for ${missingMappings.length} project(s): ${missingIds}`,
            retryable: false,
            retryAfterSeconds: null,
            reference: null,
          },
        });
      }

      // Execute the authenticated backend import.
      const signal = AbortSignal.timeout(120_000);
      let authCtx: Awaited<ReturnType<typeof profiles.getAuthenticatedContext>>;
      try {
        authCtx = await profiles.getAuthenticatedContext(selectedId);
      } catch (error) {
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'error',
          error: mapImportError(error),
        });
      }

      try {
        const result = await executeLegacyBackupImport(
          selectedId,
          authCtx.profile.baseUrl,
          preflight.parsedBackup,
          preflight.summary.fileHash,
          request.printerMappings,
          request.operationId,
          signal,
          { tokens: calibrationTokens },
        );
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'ok',
          summary: result.summary,
          importedProjectCount: result.importedProjectCount,
          projectResults: result.projectResults,
        });
      } catch (error) {
        return ipcSchemas[
          IpcChannel.CalibrationImportLegacyBackupV4
        ].response.parse({
          status: 'error',
          error: mapImportError(error),
        });
      }
    },
  );

  // --- Upstream Orca filament profiles (issue #55) -------------------------

  /**
   * Map from WorkspaceRecommendation.values[].key to OrcaSlicer field names.
   * This mirrors the PATCH_MAPPINGS in the renderer domain but lives in main
   * so the main process can build the patch from sidecar workspace state.
   */
  const WORKSPACE_TO_ORCA_KEY: Readonly<Record<string, string>> = {
    nozzle_temperature: 'nozzle_temperature',
    filament_flow_ratio: 'filament_flow_ratio',
    enable_pressure_advance: 'enable_pressure_advance',
    pressure_advance: 'pressure_advance',
    retraction_length: 'filament_retraction_length',
    filament_max_volumetric_speed: 'filament_max_volumetric_speed',
    filament_shrink: 'filament_shrink',
    filament_shrinkage_compensation_z: 'filament_shrinkage_compensation_z',
  };

  const SUPPORTED_ORCA_KEYS = new Set([
    'nozzle_temperature',
    'filament_flow_ratio',
    'enable_pressure_advance',
    'pressure_advance',
    'filament_retraction_length',
    'filament_max_volumetric_speed',
    'filament_shrink',
    'filament_shrinkage_compensation_z',
  ]);

  registerCalibrationHandler(
    IpcChannel.CalibrationGenerateOrcaProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGenerateOrcaProfile].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );

      // Read workspace state from sidecar.
      let workspaceStateRaw: unknown;
      try {
        workspaceStateRaw = await sidecar.getCalibrationWorkspaceState(
          selectedId,
          request.projectId,
        );
      } catch (err) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message:
              err instanceof Error
                ? err.message
                : 'Could not read workspace state.',
            retryable: true,
          },
        });
      }

      if (!workspaceStateRaw) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message: 'Calibration project not found.',
            retryable: false,
          },
        });
      }

      // Validate and extract workspace state.
      const stateRecord =
        ipcSchemas[IpcChannel.CalibrationGetWorkspaceState].response.safeParse(
          workspaceStateRaw,
        );
      if (!stateRecord.success || !stateRecord.data) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message: 'Workspace state is invalid or corrupt.',
            retryable: false,
          },
        });
      }

      const wsPayload = stateRecord.data.workspaceState;
      const domainState = wsPayload.domainState;
      // The on-disk lookup key is the profile *name*, never the identity. For a
      // PrintFarmer-sourced base profile the identity is a server GUID that
      // appears in no OrcaSlicer file, so searching by it always reported the
      // base profile missing.
      const orcaProfileLookupName = resolveOrcaBaseProfileLookupName(
        wsPayload.selectedBaseProfile,
      );

      // Build calibration patch entries from completed attempts.
      const patchEntries: OrcaPatchEntry[] = [];
      const stageOrder: string[] = [
        'temperature',
        'flowPass2',
        'flowPass1',
        'pressureAdvance',
        'retraction',
        'maximumVolumetricSpeed',
        'shrinkage',
      ];
      const attemptsByStage = new Map<
        string,
        (typeof domainState.attempts)[number]
      >();
      for (const attempt of domainState.attempts) {
        if (attempt.status !== 'completed' || !attempt.recommendation) continue;
        const existing = attemptsByStage.get(attempt.stageId);
        // Prefer later attempts (higher ordinal) for each stage.
        if (!existing || attempt.ordinal > existing.ordinal) {
          attemptsByStage.set(attempt.stageId, attempt);
        }
      }
      for (const stageId of stageOrder) {
        const attempt = attemptsByStage.get(stageId);
        if (!attempt?.recommendation) continue;
        for (const val of attempt.recommendation.values) {
          const orcaKey = WORKSPACE_TO_ORCA_KEY[val.key];
          if (!orcaKey || !SUPPORTED_ORCA_KEYS.has(orcaKey)) continue;
          // Convert boolean values to numbers (0/1) for the patch entry schema.
          const numericValue: number | string =
            typeof val.value === 'boolean' ? (val.value ? 1 : 0) : val.value;
          patchEntries.push({
            key: orcaKey as Parameters<
              typeof generateOrcaProfile
            >[1][number]['key'],
            value: numericValue,
            sourceStageId: attempt.stageId,
            sourceAttemptId: attempt.attemptId,
            sourceObservationId: attempt.selectedObservationId ?? '',
          });
        }
      }

      if (patchEntries.length === 0) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message:
              'No completed calibration attempts with recommendations found. Complete at least one calibration stage before generating a profile.',
            retryable: false,
          },
        });
      }

      // Find the local base profile, by name rather than by identity.
      if (orcaProfileLookupName === null) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'baseProfileMissing',
            message:
              'This calibration project recorded a PrintFarmer base profile without its OrcaSlicer profile name, so it cannot be located on disk. Re-select the base profile to repair the project.',
            retryable: false,
          },
        });
      }
      const localProfile = await findLocalOrcaProfileRaw(orcaProfileLookupName);
      if (!localProfile) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'baseProfileMissing',
            message: `Local OrcaSlicer base profile "${orcaProfileLookupName}" was not found. Ensure OrcaSlicer is installed and the profile exists.`,
            retryable: false,
          },
        });
      }

      // Generate the patched profile.
      const snapshotId = domainState.binding.snapshot.snapshotId;
      const result = generateOrcaProfile(
        localProfile.resolvedRaw,
        patchEntries,
        request.projectId,
        snapshotId,
      );

      // Cache the result by operationId for subsequent export/install calls.
      cacheGeneratedProfile(request.operationId, {
        generatedJson: result.generatedJson,
        profileJsonHash: result.profileJsonHash,
        displayName: result.displayName,
        safeFilename: result.safeFilename,
        cachedAt: Date.now(),
      });

      return ipcSchemas[
        IpcChannel.CalibrationGenerateOrcaProfile
      ].response.parse({
        status: 'ok',
        displayName: result.displayName,
        safeFilename: result.safeFilename,
        profileJsonHash: result.profileJsonHash,
        patchedFieldCount: result.patchedFieldCount,
        warnings: result.warnings,
      });
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationInstallOrcaProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationInstallOrcaProfile].request.parse(
          rawRequest,
        );
      await requireSelectedCalibrationProfile(request.profileId);

      // Local-only authorisation, deliberately separate from the server action
      // interlock. Installing writes to this machine's OrcaSlicer directory and
      // sends nothing to PrintFarmer, so a server permission is not the relevant
      // authority. What matters is the same selection fencing applied above plus
      // the platform and root guards below, which run before any filesystem
      // write. Gating this on a server permission would refuse an operator with
      // read-only farm access the right to manage their own local install.
      if (process.platform !== 'win32') {
        return ipcSchemas[
          IpcChannel.CalibrationInstallOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'unsupportedPlatform',
            message:
              'Direct profile installation is only supported on Windows. Use export on macOS.',
            retryable: false,
          },
        });
      }

      const cached = getCachedProfile(request.operationId);
      if (!cached) {
        return ipcSchemas[
          IpcChannel.CalibrationInstallOrcaProfile
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

      if (cached.profileJsonHash !== request.confirmedProfileJsonHash) {
        return ipcSchemas[
          IpcChannel.CalibrationInstallOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'verificationFailed',
            message:
              'Confirmed hash does not match the generated profile. Regenerate the profile.',
            retryable: false,
          },
        });
      }

      try {
        const installResult = await installOrcaProfileWindows(
          cached.generatedJson,
          cached.profileJsonHash,
          cached.safeFilename,
          request.operationId,
        );
        return ipcSchemas[
          IpcChannel.CalibrationInstallOrcaProfile
        ].response.parse({
          status: 'ok',
          installedHash: installResult.installedHash,
          backupHash: installResult.backupHash,
        });
      } catch (err) {
        if (err instanceof OrcaInstallError) {
          return ipcSchemas[
            IpcChannel.CalibrationInstallOrcaProfile
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
          IpcChannel.CalibrationInstallOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'internalError',
            message:
              err instanceof Error ? err.message : 'Installation failed.',
            retryable: false,
          },
        });
      }
    },
  );

  registerCalibrationHandler(
    IpcChannel.CalibrationRestoreOrcaProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationRestoreOrcaProfile].request.parse(
          rawRequest,
        );
      await requireSelectedCalibrationProfile(request.profileId);

      if (process.platform !== 'win32') {
        return ipcSchemas[
          IpcChannel.CalibrationRestoreOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'unsupportedPlatform',
            message: 'Profile restore is only supported on Windows.',
            retryable: false,
          },
        });
      }

      try {
        const { getWindowsOrcaInstallRoot, findBackupByOperationId } =
          await import('./orcaProfileInstall.js');
        const installRoot = getWindowsOrcaInstallRoot();
        // Locate the backup this specific operation produced from its
        // durable on-disk metadata record. This does not depend on
        // profileCache/getCachedProfile — that in-memory, process-lifetime,
        // MAX_CACHE_ENTRIES-bounded cache does not survive an app restart
        // or later-install eviction (#208) — and it does not use the backup
        // hash to resolve *identity* (two different profiles can share a
        // backup hash if their prior bytes happened to be byte-identical),
        // nor does it reverse-parse safeFilename out of the backup's own
        // filename (which can legitimately contain the literal substring
        // `.bak-`). The hash the caller supplies is still the safety check:
        // it is re-verified inside restoreOrcaProfileWindows before
        // anything is written.
        const located = await findBackupByOperationId(
          installRoot,
          request.operationId,
        );

        if (!located) {
          return ipcSchemas[
            IpcChannel.CalibrationRestoreOrcaProfile
          ].response.parse({
            status: 'error',
            error: {
              code: 'pathRestricted',
              message:
                'No backup record found for this operationId in the OrcaSlicer user directory. The backup may already have been restored, removed, or the install predates this metadata format.',
              retryable: false,
            },
          });
        }

        const restoreResult = await restoreOrcaProfileWindows(
          located.backupPath,
          request.backupHash,
          located.safeFilename,
        );
        return ipcSchemas[
          IpcChannel.CalibrationRestoreOrcaProfile
        ].response.parse({
          status: 'ok',
          restoredHash: restoreResult.restoredHash,
        });
      } catch (err) {
        if (err instanceof OrcaInstallError) {
          return ipcSchemas[
            IpcChannel.CalibrationRestoreOrcaProfile
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
          IpcChannel.CalibrationRestoreOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'rollbackFailed',
            message: err instanceof Error ? err.message : 'Restore failed.',
            retryable: false,
          },
        });
      }
    },
  );
  // --- End Printer Calibration transport handlers --------------------------

  return async () => {
    calibrationPhotoApprovals.clear();
    await cleanupStaleCalibrationPhotoTemps(calibrationPhotoRoot).catch(
      () => undefined,
    );
    await retargetArtifacts.disposeAll();
    if (!sharedSidecar) {
      sidecar.dispose();
      profiles.clearTokens();
    }
  };
}
