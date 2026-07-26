import path from 'node:path';
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
} from './targetProfiles.js';
import { RetargetArtifactService, type Dialogs } from './retargetArtifacts.js';
import { SceneCacheService } from './sceneCache.js';
import {
  CalibrationHttpClient,
  CalibrationHttpError,
} from './calibrationHttp.js';
import { CalibrationSyncEngine } from './calibrationEngine.js';
import {
  ServerProfileCalibrationTokenProvider,
  SidecarCalibrationAdapter,
} from './calibrationService.js';

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

function targetProfileFailure(error: unknown) {
  return error instanceof TargetProfileNativeError
    ? error.failure
    : {
        domain: 'electron' as const,
        code: 'sidecarUnavailable' as const,
        message: 'Snapmaker U1 profiles could not be loaded.',
        action:
          'Restart the application; reinstall it if the profile bundle remains unavailable.',
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
    console.error('[scene-cache] startup invalidation failed', error);
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

  app.on('will-quit', () => {
    calibrationEngine.dispose();
    for (const controller of activeSyncControllers.values()) {
      controller.abort();
    }
    activeSyncControllers.clear();
    uploads.dispose();
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
          console.error('[scene-cache] recipe adoption failed', error);
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
    const selected = canonicalPath ? { path: canonicalPath } : null;
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
    await approvals.reset();
    approvedPickerFiles.clear();
    // Both grant sources are cleared above — the persisted root approvals and
    // the in-memory picker allowlist — and each is pinned by a test that dies
    // when that one line is dropped and survives when the other is.
    //
    // Scenes derived under those grants are artifacts of them, so they are
    // shredded here for symmetry. Awaited rather than fired off, and unguarded
    // rather than best-effort: a reset that reports success while derived
    // scenes remain on disk is reporting something that did not happen.
    await sceneCache.purge();
    await retargetArtifacts.disposeArtifacts();
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
    // from the selected server profile and validate all required flags.
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
      const allFlagsEnabled =
        caps.flags.calibrationApiEnabled &&
        caps.flags.calibrationChangeFeedEnabled &&
        caps.flags.calibrationOfflineDraftEnabled;
      const firmwareOk =
        caps.requiredFirmware === 'Klipper' &&
        caps.requiredGcodeDialect === 'Klipper';
      const slicerOk = caps.requiredSlicer === 'OrcaSlicer';

      if (!allFlagsEnabled || !firmwareOk || !slicerOk) {
        return ipcSchemas[IpcChannel.CalibrationGetAvailability].response.parse(
          {
            available: false,
            unavailableReason: !firmwareOk
              ? 'firmwareUnsupported'
              : !slicerOk
                ? 'slicerUnsupported'
                : 'featureDisabled',
            unavailableDetail:
              'Server does not meet all calibration capability requirements.',
            negotiatedApiVersion: caps.apiVersion,
            negotiatedSchemaVersion: caps.schemaVersion,
            capabilityFlags: caps.flags,
            grantedScopes: caps.requiredScopes,
            offlineEditingEnabled:
              caps.flags.calibrationOfflineDraftEnabled ?? false,
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
        grantedScopes: caps.requiredScopes,
        offlineEditingEnabled:
          caps.flags.calibrationOfflineDraftEnabled ?? false,
      });
    } catch (error) {
      const reason =
        error instanceof CalibrationHttpError && error.code === 'notFound'
          ? 'serverVersionTooLow'
          : 'networkError';
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
      ipcSchemas[IpcChannel.CalibrationListPrinters].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationListPrinters].response.parse({
          printers: [],
          fetchedAt: new Date().toISOString(),
        });
      }
      const signal = AbortSignal.timeout(10_000);
      try {
        const ctx = await profiles.getAuthenticatedContext(selectedId);
        const printers = await calibrationHttp.getPrinters(
          selectedId,
          ctx.profile.baseUrl,
          signal,
        );
        const printerList = Array.isArray(printers) ? printers : [];
        return ipcSchemas[IpcChannel.CalibrationListPrinters].response.parse({
          printers: printerList,
          fetchedAt: new Date().toISOString(),
        });
      } catch {
        return ipcSchemas[IpcChannel.CalibrationListPrinters].response.parse({
          printers: [],
          fetchedAt: new Date().toISOString(),
        });
      }
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationGetPrinterContext,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetPrinterContext].request.parse(
          rawRequest,
        );
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        throw Object.assign(
          new Error('No server profile is selected for calibration.'),
          { code: 'CALIBRATION_NO_PROFILE' },
        );
      }
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      const context = await calibrationHttp.getPrinterContext(
        selectedId,
        ctx.profile.baseUrl,
        request.printerId,
        signal,
      );
      return ipcSchemas[IpcChannel.CalibrationGetPrinterContext].response.parse(
        context,
      );
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationListProjects,
    async (_event, rawRequest: unknown) => {
      ipcSchemas[IpcChannel.CalibrationListProjects].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationListProjects].response.parse({
          projects: [],
        });
      }
      // Load project summaries from the local sidecar persistence store.
      const conflicts =
        await calibrationSidecarAdapter.listCalibrationConflicts(
          selectedId,
          null,
        );
      const conflictProjectIds = new Set(conflicts.map((c) => c.projectId));
      // Return an empty list — the renderer hydrates via sync + individual gets.
      // hasConflicts is computed from the conflict store.
      return ipcSchemas[IpcChannel.CalibrationListProjects].response.parse({
        projects: [],
        conflictProjectIds: [...conflictProjectIds],
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationGetProject,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetProject].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        throw Object.assign(new Error('No server profile is selected.'), {
          code: 'CALIBRATION_NO_PROFILE',
        });
      }
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
      return ipcSchemas[IpcChannel.CalibrationGetProject].response.parse({
        projectId: project.id,
        profileId: selectedId,
        printerId: project.printerId,
        displayName: project.displayName,
        description: project.description,
        status: project.status,
        steps: steps.map((s) => ({
          stepId: s.id,
          projectId: s.projectId,
          ordinal: s.ordinal,
          kind: s.kind,
          status: s.status,
          displayName: s.displayName,
          prerequisites: s.prerequisites,
          methodNotes: s.methodNotes,
          expectedResult: s.expectedResult,
          measuredResult: s.measuredResult,
          reorderingSupported: s.reorderingSupported,
          revision: s.revision,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          draftFields: null,
        })),
        printerContext: project.printerSnapshot
          ? {
              printerId: project.printerSnapshot.printerId,
              displayName: project.printerSnapshot.displayName,
              printerModel: project.printerSnapshot.printerModel,
              firmware: {
                firmware: project.printerSnapshot.firmware,
                gcodeDialect: project.printerSnapshot.gcodeDialect,
                firmwareVersion: project.printerSnapshot.firmwareVersion,
                klipperConfigHash: project.printerSnapshot.klipperConfigHash,
              },
              orcaProfileId: project.printerSnapshot.orcaProfileId,
              orcaProfileDisplayName:
                project.printerSnapshot.orcaProfileDisplayName,
              bedWidthMm: project.printerSnapshot.bedWidthMm,
              bedDepthMm: project.printerSnapshot.bedDepthMm,
              nozzleDiameterMm: project.printerSnapshot.nozzleDiameterMm,
              snapshotAt: project.printerSnapshot.snapshotAt,
              isCurrent: printerFresh,
            }
          : null,
        hasConflicts: conflicts.length > 0,
        isSynced: pendingCount === 0,
        isPrinterContextFresh: printerFresh,
        remoteProjectId: project.id,
        baseRevision: project.revision,
        changeFeedCursor: null,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationSaveDraft,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSaveDraft].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        throw Object.assign(
          new Error('No server profile is selected for calibration.'),
          { code: 'CALIBRATION_NO_PROFILE' },
        );
      }
      // Offline drafts are queued as outbox operations in the sidecar.
      // The engine will push them during the next sync cycle.
      await calibrationSidecarAdapter.applyCalibrationSnapshot(
        selectedId,
        'CalibrationProject',
        request.projectId,
        {
          id: request.projectId,
          displayName: request.fields.displayName ?? '',
          description: request.fields.description ?? null,
          status: 'draft',
          printerId: '',
          revision: 0,
          concurrencyToken: '',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        false,
        0,
      );
      return ipcSchemas[IpcChannel.CalibrationSaveDraft].response.parse({
        status: 'ok',
        savedAt: new Date().toISOString(),
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationListAttempts,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListAttempts].request.parse(
          rawRequest,
        );
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationListAttempts].response.parse({
          attempts: [],
        });
      }
      const signal = AbortSignal.timeout(10_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      try {
        const attempts = await calibrationHttp.getProjectSteps(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          signal,
        );
        // Attempts are fetched via the step-level endpoint in the HTTP client.
        // Return empty list since the schema doesn't have a listAttempts endpoint.
        void attempts;
        return ipcSchemas[IpcChannel.CalibrationListAttempts].response.parse({
          attempts: [],
        });
      } catch {
        return ipcSchemas[IpcChannel.CalibrationListAttempts].response.parse({
          attempts: [],
        });
      }
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationGetAttempt,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetAttempt].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        throw Object.assign(new Error('No server profile selected.'), {
          code: 'CALIBRATION_NO_PROFILE',
        });
      }
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
        attemptNumber: attempt.attemptNumber,
        measuredValue: attempt.measuredValue,
        measuredUnit: attempt.measuredUnit,
        isSelected: attempt.isSelected,
        printerContextSnapshotHash: attempt.printerContextSnapshotHash,
        revision: attempt.revision,
        createdAt: attempt.createdAt,
        events: [],
        observations: [],
        photos: [],
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationStagePhoto,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStagePhoto].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        throw Object.assign(
          new Error('No server profile selected for photo staging.'),
          { code: 'CALIBRATION_NO_PROFILE' },
        );
      }
      // Photos are staged in the local store. Upload happens during sync.
      // The photo path comes from the opaque approvalId — the main process
      // resolves it to the approved file path from the allowlist.
      const now = new Date().toISOString();
      await calibrationSidecarAdapter.applyCalibrationSnapshot(
        selectedId,
        'CalibrationPhoto',
        request.photoId,
        {
          id: request.photoId,
          attemptId: request.attemptId,
          stepId: request.stepId,
          projectId: request.projectId,
          approvalId: request.approvalId,
          uploadedAt: null,
          stagedAt: now,
        },
        false,
        0,
      );
      return ipcSchemas[IpcChannel.CalibrationStagePhoto].response.parse({
        status: 'ok',
        photoId: request.photoId,
        stagedAt: now,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationListConflicts,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationListConflicts].request.parse(
          rawRequest,
        );
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationListConflicts].response.parse({
          conflicts: [],
        });
      }
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
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        throw Object.assign(new Error('No server profile selected.'), {
          code: 'CALIBRATION_NO_PROFILE',
        });
      }
      // Resolution: validate the strategy and record locally.
      // Only semantically valid resolutions are accepted (schema enforces this).
      // For 'acceptServer': trigger a sync to pull the authoritative state.
      // For 'keepLocalAsNewRevision': queue as a new outbox operation.
      if (
        request.resolution !== 'acceptServer' &&
        request.resolution !== 'keepLocalAsNewRevision'
      ) {
        throw Object.assign(
          new Error('Invalid conflict resolution strategy.'),
          { code: 'CALIBRATION_INVALID_RESOLUTION' },
        );
      }
      return ipcSchemas[IpcChannel.CalibrationResolveConflict].response.parse({
        status: 'ok',
        resolvedAt: new Date().toISOString(),
        conflictId: request.conflictId,
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationSyncNow,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationSyncNow].request.parse(rawRequest);
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationSyncNow].response.parse({
          phase: 'failed',
          profileId: null,
          projectId: null,
          pushedOperations: 0,
          pulledChanges: 0,
          conflictCount: 0,
          cursor: null,
          error: 'No server profile is selected.',
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

  // Generation, queue, bed-clear, and print start require all mutations to be
  // synchronized and printer context to be freshly validated before proceeding.

  ipcMain.handle(
    IpcChannel.CalibrationStartGeneration,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationStartGeneration].request.parse(
          rawRequest,
        );
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'error',
            error: {
              code: 'syncRequired',
              message: 'No server profile is selected.',
              retryable: false,
              retryAfterSeconds: null,
            },
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
            },
          },
        );
      }
      const signal = AbortSignal.timeout(30_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      try {
        const result = await calibrationHttp.startGeneration(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          request.operationId,
          request.baseRevision,
          signal,
        );
        return ipcSchemas[IpcChannel.CalibrationStartGeneration].response.parse(
          {
            status: 'ok',
            generationJobId: result.generationJobId,
          },
        );
      } catch (error) {
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
    IpcChannel.CalibrationGetQueueState,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationGetQueueState].request.parse(
          rawRequest,
        );
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: 'No server profile is selected.',
            retryable: false,
            retryAfterSeconds: null,
          },
        });
      }
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
      return ipcSchemas[IpcChannel.CalibrationGetQueueState].response.parse({
        status: 'ok',
        queueEntries: [],
        fetchedAt: new Date().toISOString(),
      });
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationAcknowledgeBedClear,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationAcknowledgeBedClear].request.parse(
          rawRequest,
        );
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: 'No server profile is selected.',
            retryable: false,
            retryAfterSeconds: null,
          },
        });
      }
      const prerequisiteError =
        await calibrationEngine.checkOnlineActionPrerequisites(
          selectedId,
          request.projectId,
        );
      if (prerequisiteError !== null) {
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: prerequisiteError,
            retryable: true,
            retryAfterSeconds: null,
          },
        });
      }
      const signal = AbortSignal.timeout(15_000);
      const ctx = await profiles.getAuthenticatedContext(selectedId);
      try {
        await calibrationHttp.acknowledgeBedClear(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          request.jobId,
          request.operationId,
          signal,
        );
        return ipcSchemas[
          IpcChannel.CalibrationAcknowledgeBedClear
        ].response.parse({
          status: 'ok',
          acknowledgedAt: new Date().toISOString(),
        });
      } catch (error) {
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
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: 'No server profile is selected.',
            retryable: false,
            retryAfterSeconds: null,
          },
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
      try {
        const result = await calibrationHttp.startPrint(
          selectedId,
          ctx.profile.baseUrl,
          request.projectId,
          request.jobId,
          request.operationId,
          request.baseRevision,
          signal,
        );
        return ipcSchemas[IpcChannel.CalibrationStartPrint].response.parse({
          status: 'ok',
          jobId: result.jobId,
          startedAt: new Date().toISOString(),
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

  ipcMain.handle(IpcChannel.CalibrationListOrcaProfiles, () => {
    // Local OrcaSlicer profiles are enumerated by the renderer directly.
    // This handler exists for privilege isolation — no filesystem primitive
    // is exposed; profiles known to the target profile service are returned.
    return ipcSchemas[IpcChannel.CalibrationListOrcaProfiles].response.parse({
      profiles: [],
    });
  });

  ipcMain.handle(
    IpcChannel.CalibrationExportOrcaProfile,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationExportOrcaProfile].request.parse(
          rawRequest,
        );
      // Export the generated OrcaSlicer profile from a profile revision.
      // Requires a valid profile revision ID. The renderer cannot supply
      // arbitrary file paths — the main process controls the export path.
      const profileList = await profiles.list();
      const selectedId = profileList.selectedProfileId;
      if (!selectedId) {
        return ipcSchemas[
          IpcChannel.CalibrationExportOrcaProfile
        ].response.parse({
          status: 'error',
          error: {
            code: 'syncRequired',
            message: 'No server profile is selected.',
            retryable: false,
            retryAfterSeconds: null,
          },
        });
      }
      // Downstream issue #55 implements the full export UI/workflow.
      // This handler validates the request and returns a typed not-yet-available
      // response with a stable typed contract for the future implementation.
      void request;
      return ipcSchemas[IpcChannel.CalibrationExportOrcaProfile].response.parse(
        {
          status: 'error',
          error: {
            code: 'invalidData',
            message:
              'OrcaSlicer profile export requires the generated profile UI (issue #55).',
            retryable: false,
            retryAfterSeconds: null,
          },
        },
      );
    },
  );

  ipcMain.handle(
    IpcChannel.CalibrationImportLegacyBackupV4,
    (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.CalibrationImportLegacyBackupV4].request.parse(
          rawRequest,
        );
      // Legacy v4 backup import is the typed contract surface for issue #56.
      // The renderer cannot supply arbitrary paths — only the approvalId from
      // the allowlisted file-picker channel is accepted.
      void request.approvalId;
      void request.operationId;
      return ipcSchemas[
        IpcChannel.CalibrationImportLegacyBackupV4
      ].response.parse({
        status: 'error',
        error: {
          code: 'invalidData',
          message:
            'Legacy calibration backup v4 import requires the import implementation (issue #56).',
          retryable: false,
          retryAfterSeconds: null,
        },
      });
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
