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
} from './calibrationWire.js';
import {
  CalibrationPhotoApprovalStore,
  cleanupStaleCalibrationPhotoTemps,
  stagePrivateCalibrationPhoto,
} from './calibrationPhotos.js';
import { resolveCalibrationWorkspaceFreshness } from './calibrationFreshness.js';
import { CalibrationSyncEngine } from './calibrationEngine.js';
import {
  ServerProfileCalibrationTokenProvider,
  SidecarCalibrationAdapter,
  supportsConflictResolution,
} from './calibrationService.js';
import {
  discoverLocalOrcaFilamentProfiles,
  findLocalOrcaProfileRaw,
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
 * `RetargetPreflight` already isolates this await and names the workspace in
 * its message; the two profile channels shared one `catch` with the profile
 * load and so inherited the profile diagnosis instead. The code is
 * `internalError` rather than `sidecarUnavailable` because the sidecar is not
 * implicated: the message carries the cause, and the code declines to claim a
 * classification the enum does not have.
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
  // process. `initialize()` reaps stale instance directories, so it rejects on
  // ordinary filesystem contention: this is the call that threw `EPERM: rmdir`
  // and exited the #159 suite non-zero with every test passing.
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

  app.on('will-quit', () => {
    calibrationEngine.dispose();
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
          error: {
            domain: 'electron',
            code: 'sidecarUnavailable',
            message: 'The retarget workspace could not be prepared.',
            action: 'Restart the application and try again.',
            part: null,
            setting: null,
          },
        });
      }
      const request =
        ipcSchemas[IpcChannel.RetargetPreflight].request.parse(rawRequest);
      if (!retargetOwnerCleanup.has(event.sender)) {
        retargetOwnerCleanup.add(event.sender);
        const ownerId = event.sender.id;
        event.sender.once('destroyed', () => {
          void retargetArtifacts.disposeOwner(ownerId);
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

  ipcMain.handle(IpcChannel.OpenCalibrationPhoto, async (event) => {
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

  ipcMain.handle(IpcChannel.CalibrationGetAvailability, async () => {
    // Real capability negotiation: fetch the calibration capabilities endpoint
    // from the selected server profile and validate the flags calibration
    // cannot run without. Optional feature switches (photos, generation) are
    // reported through `capabilityFlags` so the workspace can narrow what it
    // offers rather than refusing to open.
    const profileList = await profiles.list();
    const selectedId = profileList.selectedProfileId;
    if (!selectedId) {
      return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse({
        available: false,
        unavailableReason: 'noProfile',
        unavailableDetail: 'No server profile is selected.',
        negotiatedApiVersion: null,
        negotiatedSchemaVersion: null,
        capabilityFlags: null,
        grantedScopes: null,
        offlineEditingEnabled: false,
      });
    }

    const signal = AbortSignal.timeout(10_000);
    try {
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const caps = await calibrationHttp.getCapabilities(
        selectedId,
        ctx.profile.baseUrl,
        signal,
      );
      // Snapshot the negotiation so diagnostics can report capability health
      // without a network call — which is exactly when it is needed.
      calibrationDiagnostics.recordCapabilities(caps);
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

      if (missingFlags.length > 0 || !firmwareOk || !slicerOk) {
        return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse(
          {
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
          },
        );
      }

      return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse({
        available: true,
        unavailableReason: null,
        unavailableDetail: null,
        negotiatedApiVersion: caps.apiVersion,
        negotiatedSchemaVersion: caps.schemaVersion,
        capabilityFlags: caps.flags,
        grantedScopes: caps.grantedScopes,
        offlineEditingEnabled: caps.flags.calibrationOfflineDraftEnabled,
      });
    } catch (error) {
      const reason =
        error instanceof CalibrationHttpError && error.code === 'notFound'
          ? 'serverVersionTooLow'
          : 'legacyServer';
      const detail =
        error instanceof Error
          ? error.message
          : 'Could not reach calibration capabilities endpoint.';
      return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse({
        available: false,
        unavailableReason: reason,
        unavailableDetail: detail,
        negotiatedApiVersion: null,
        negotiatedSchemaVersion: null,
        capabilityFlags: null,
        grantedScopes: null,
        offlineEditingEnabled: false,
      });
    }
  });

  // Calibration channels that require a valid server profile and IPC request.
  // Each validates its request schema before dispatching.

  ipcMain.handle(
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
        printers: printers.map((printer) => {
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
            eligibility,
          };
        }),
        fetchedAt: new Date().toISOString(),
      });
    },
  );

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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

  ipcMain.handle(
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
      if (!supportsConflictResolution(calibrationSidecarAdapter)) {
        throw Object.assign(
          new Error(
            'Conflict resolution is unavailable until the authoritative resolution RPC is present.',
          ),
          { code: 'CALIBRATION_CONFLICT_RESOLUTION_UNAVAILABLE' },
        );
      }
      return calibrationSidecarAdapter.resolveCalibrationConflict(request);
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationSyncNow,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
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
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse(result);
      } finally {
        activeSyncControllers.delete(syncKey);
      }
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationGetDiagnostics,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetDiagnostics].request.parse(
          rawRequest,
        );
      // Falls back to the selected profile rather than requiring one, so the
      // command still answers when no profile is selected — "no profile" is
      // itself a diagnosis.
      const profileList = await profiles.list();
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

  ipcMain.handle(
    IpcChannel.CalibrationStartGeneration,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStartGeneration].request.parse(
          rawRequest,
        );
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
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
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error ? error.message : 'Generation failed.',
                retryable: false,
                retryAfterSeconds: null,
              };
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'error',
            error: apiError,
          },
        );
      }
    },
  );

  ipcMain.handle(
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
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Orchestration status fetch failed.',
                retryable: false,
                retryAfterSeconds: null,
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

  ipcMain.handle(
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
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Queue job lookup failed.',
                retryable: false,
                retryAfterSeconds: null,
              };
        return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
          status: 'error',
          error: apiError,
        });
      }
    },
  );

  ipcMain.handle(
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
      const signal = AbortSignal.timeout(15_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const { correlationId, origin: correlationOrigin } =
        calibrationCorrelation.resolveOrBeginWithOrigin([
          ['job', request.jobId],
          ['operation', request.operationId],
        ]);
      const startedAt = Date.now();
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
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error ? error.message : 'Bed-clear failed.',
                retryable: false,
                retryAfterSeconds: null,
              };
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: apiError,
        });
      }
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationStartPrint,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStartPrint].request.parse(rawRequest);
      const selectedId = await requireSelectedCalibrationProfile(
        request.profileId,
      );
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
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Print start failed.',
                retryable: false,
                retryAfterSeconds: null,
              };
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'error',
          error: apiError,
        });
      }
    },
  );

  // --- Queue reconciliation (issue #54) ------------------------------------

  ipcMain.handle(
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
        // Detect gaps: if any event.sequence is not contiguous the caller must
        // refetch job state over REST.
        let gapDetected = false;
        const events = page.events;
        for (let i = 1; i < events.length; i++) {
          const cur = events[i];
          const prev = events[i - 1];
          if (
            cur !== undefined &&
            prev !== undefined &&
            cur.sequence !== prev.sequence + 1
          ) {
            gapDetected = true;
            break;
          }
        }
        // Also detect gap between cursor and first event
        const firstEvent = events[0];
        if (
          firstEvent !== undefined &&
          firstEvent.sequence !== page.afterSequence + 1
        ) {
          gapDetected = true;
        }
        return ipcSchemas[
          IpcChannel.CalibrationPollQueueChanges
        ].response.parse({
          status: 'ok',
          afterSequence: page.afterSequence,
          nextSequence: page.nextSequence,
          hasMore: page.hasMore,
          gapDetected,
          events: page.events,
        });
      } catch (error) {
        const apiError =
          error instanceof CalibrationHttpError
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Queue change feed poll failed.',
                retryable: false,
                retryAfterSeconds: null,
              };
        return ipcSchemas[
          IpcChannel.CalibrationPollQueueChanges
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  ipcMain.handle(
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
            ? error.toApiError()
            : {
                code: 'serverError' as const,
                message:
                  error instanceof Error
                    ? error.message
                    : 'Subscription resources fetch failed.',
                retryable: false,
                retryAfterSeconds: null,
              };
        return ipcSchemas[
          IpcChannel.CalibrationGetSubscriptionResources
        ].response.parse({ status: 'error', error: apiError });
      }
    },
  );

  // --- External calibration asset manifest (issue #54) ---------------------

  ipcMain.handle(IpcChannel.CalibrationGetAssetManifest, async () => {
    try {
      const manifest = await calibrationAssetManifest.load();
      return ipcSchemas[IpcChannel.CalibrationGetAssetManifest].response.parse(
        manifest,
      );
    } catch (error) {
      return ipcSchemas[IpcChannel.CalibrationGetAssetManifest].response.parse({
        status: 'error',
        message:
          error instanceof Error ? error.message : 'Manifest load failed.',
      });
    }
  });

  ipcMain.handle(
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

  ipcMain.handle(
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
  ipcMain.handle(
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

  ipcMain.handle(
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
      const candidates = await calibrationHttp.getPrinters(
        selectedId,
        profileContext.profile.baseUrl,
        signal,
      );
      const discovered = await Promise.all(
        candidates.map(async (candidate) => {
          if (
            !candidate.isOnline ||
            !isExplicitCalibrationEligibilityComplete(candidate)
          ) {
            return {
              pfEntries: [] as ReturnType<
                typeof projectPrintFarmerOrcaProfile
              >[],
              localEntries: [] as Awaited<
                ReturnType<typeof discoverLocalOrcaFilamentProfiles>
              >,
            };
          }
          try {
            const context = await calibrationHttp.getPrinterContext(
              selectedId,
              profileContext.profile.baseUrl,
              candidate.printerId,
              signal,
            );
            const pfEntry = projectPrintFarmerOrcaProfile(candidate, context);
            // Discover locally installed OrcaSlicer profiles compatible with
            // this printer context. These are real files on the user's machine
            // and allow the user to use the local install as a base for export.
            const localEntries = await discoverLocalOrcaFilamentProfiles(
              context,
            ).catch(() => []);
            return { pfEntries: pfEntry ? [pfEntry] : [], localEntries };
          } catch (error) {
            if (
              error instanceof CalibrationHttpError &&
              ['notFound', 'invalidResponse'].includes(error.code)
            ) {
              return { pfEntries: [], localEntries: [] };
            }
            throw error;
          }
        }),
      );
      const profilesByScope = new Map<
        string,
        NonNullable<(typeof discovered)[number]['pfEntries'][number]>
      >();
      for (const { pfEntries, localEntries } of discovered) {
        for (const profile of pfEntries) {
          if (profile === null) continue;
          const scope = [
            profile.orcaProfileId,
            profile.printerId,
            profile.configurationRevision,
            profile.snapshotId,
            profile.toolId,
            profile.toolheadId,
            profile.nozzleId,
          ].join('\u0000');
          profilesByScope.set(scope, profile);
        }
        // Include locally discovered profiles; deduplicate by scope key.
        // Local entries with upstreamVerified=true take precedence over
        // printFarmer entries for export eligibility.
        for (const profile of localEntries) {
          const scope =
            [
              profile.orcaProfileId,
              profile.printerId,
              profile.configurationRevision,
              profile.snapshotId,
              profile.toolId,
              profile.toolheadId,
              profile.nozzleId,
            ].join('\u0000') + '\u0000local';
          profilesByScope.set(scope, profile);
        }
      }
      return ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].response.parse({
        profiles: [...profilesByScope.values()],
      });
    },
  );

  ipcMain.handle(
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

  ipcMain.handle(
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
      const orcaProfileId = wsPayload.selectedBaseProfile.orcaProfileId;

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

      // Find the local base profile.
      const localProfile = await findLocalOrcaProfileRaw(orcaProfileId);
      if (!localProfile) {
        return ipcSchemas[
          IpcChannel.CalibrationGenerateOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'baseProfileMissing',
            message: `Local OrcaSlicer base profile "${orcaProfileId}" was not found. Ensure OrcaSlicer is installed and the profile exists.`,
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

  ipcMain.handle(
    IpcChannel.CalibrationInstallOrcaProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationInstallOrcaProfile].request.parse(
          rawRequest,
        );
      await requireSelectedCalibrationProfile(request.profileId);

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

  ipcMain.handle(
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

      const cached = getCachedProfile(request.operationId);
      if (!cached) {
        return ipcSchemas[
          IpcChannel.CalibrationRestoreOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'workspaceNotReady',
            message:
              'No install operation found for this operationId. Cannot locate backup.',
            retryable: false,
          },
        });
      }

      try {
        const { getWindowsOrcaInstallRoot, computeInstallPath } =
          await import('./orcaProfileInstall.js');
        const installRoot = getWindowsOrcaInstallRoot();
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        // Reconstruct the backup path. The caller provides the expected hash;
        // the handler verifies it before writing.
        // We scan for the backup file with matching hash in the install dir.
        const { readdir: readdirFs, readFile: readFileFs } =
          await import('node:fs/promises');
        const { createHash: createHashFs } = await import('node:crypto');
        let backupPath: string | null = null;
        try {
          const entries = await readdirFs(installRoot, { withFileTypes: true });
          for (const entry of entries) {
            if (
              entry.isFile() &&
              entry.name.includes('.bak-') &&
              entry.name.startsWith(cached.safeFilename)
            ) {
              const candidatePath = path.join(installRoot, entry.name);
              try {
                const bytes = await readFileFs(candidatePath);
                const hash = createHashFs('sha256').update(bytes).digest('hex');
                if (hash === request.backupHash) {
                  backupPath = candidatePath;
                  break;
                }
              } catch {
                // Skip unreadable files.
              }
            }
          }
        } catch {
          // Directory not accessible.
        }

        if (!backupPath) {
          return ipcSchemas[
            IpcChannel.CalibrationRestoreOrcaProfile
          ].response.parse({
            status: 'error',
            error: {
              code: 'pathRestricted',
              message:
                'Backup file with the specified hash not found in the OrcaSlicer user directory.',
              retryable: false,
            },
          });
        }

        const destPath = computeInstallPath(cached.safeFilename, installRoot);
        const restoreResult = await restoreOrcaProfileWindows(
          backupPath,
          request.backupHash,
          cached.safeFilename,
        );
        void destPath;
        void ts;
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
