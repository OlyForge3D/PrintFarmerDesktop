import path from 'node:path';
import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
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
import { createUploadJobService, type UploadJobService } from './uploadJobs.js';
import { RootApprovalStore } from './rootApprovals.js';

/**
 * Register all IPC handlers. Every incoming payload is validated against its
 * Zod request schema before the handler runs, and every result is validated
 * against the response schema before being returned to the renderer. Invalid
 * input from a compromised renderer is rejected rather than trusted.
 *
 * @param channelFactory - Optional sidecar transport override, primarily for
 *   tests. Defaults to spawning the real `model-core` process.
 */
export function registerIpcHandlers(
  channelFactory?: ChannelFactory,
  profileService?: ServerProfileService,
  uploadJobService?: UploadJobService,
  rootApprovalStore?: RootApprovalStore,
): void {
  const sidecar = new SidecarClient(channelFactory ?? spawnSidecarChannel);
  const profiles =
    profileService ??
    new ServerProfileService({
      userDataPath: app.getPath('userData'),
      secretStorage: safeStorage,
    });
  const approvals =
    rootApprovalStore ??
    new RootApprovalStore({ userDataPath: app.getPath('userData') });
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

  // Terminate the sidecar child process when the app exits. Windows does not
  // reap child processes on parent exit, so without this the `model-core`
  // process would linger as an orphan after every quit.
  app.on('will-quit', () => {
    sidecar.dispose();
    uploads.dispose();
    profiles.clearTokens();
  });

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
      try {
        const handshake = await sidecar.handshake();
        sidecarVersion = handshake.sidecarVersion;
        ok = true;
      } catch {
        ok = false;
      }
      const response: SidecarPingResponse = {
        ok,
        nonce: request.nonce,
        sidecarVersion,
      };
      return ipcSchemas[IpcChannel.SidecarPing].response.parse(response);
    },
  );

  ipcMain.handle(IpcChannel.LoadScene, async (_event, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.LoadScene].request.parse(rawRequest);
    const approvedPath = await authorizeRendererFile(request.path);
    const raw = await sidecar.loadScene(approvedPath);
    // Validate the sidecar's response against the contract before trusting it
    // in the renderer.
    return ipcSchemas[IpcChannel.LoadScene].response.parse(raw);
  });

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
      const raw = await sidecar.extractVendorPlateThumbnails(request.path);
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
      const raw = await sidecar.createCollection(request.name);
      return ipcSchemas[IpcChannel.CreateCollection].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.DeleteCollection,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.DeleteCollection].request.parse(rawRequest);
      const raw = await sidecar.deleteCollection(request.id);
      return ipcSchemas[IpcChannel.DeleteCollection].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.AddModelToCollection,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.AddModelToCollection].request.parse(rawRequest);
      const raw = await sidecar.addModelToCollection(
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
      const raw = await sidecar.removeModelFromCollection(
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
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
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
    return ipcSchemas[IpcChannel.ResetApprovedRoots].response.parse({
      reset: true,
    });
  });
}
