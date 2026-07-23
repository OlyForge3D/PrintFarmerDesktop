import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import {
  AppInfoResponse,
  IPC_CONTRACT_VERSION,
  IpcChannel,
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
  sharedSidecar?: SidecarClient,
): void {
  const sidecar =
    sharedSidecar ?? new SidecarClient(channelFactory ?? spawnSidecarChannel);
  const profiles =
    profileService ??
    new ServerProfileService({
      userDataPath: app.getPath('userData'),
      secretStorage: safeStorage,
    });

  // Terminate the sidecar child process when the app exits. Windows does not
  // reap child processes on parent exit, so without this the `model-core`
  // process would linger as an orphan after every quit.
  if (!sharedSidecar) {
    app.on('will-quit', () => {
      sidecar.dispose();
      profiles.clearTokens();
    });
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
    const raw = await sidecar.loadScene(request.path);
    // Validate the sidecar's response against the contract before trusting it
    // in the renderer.
    return ipcSchemas[IpcChannel.LoadScene].response.parse(raw);
  });

  ipcMain.handle(
    IpcChannel.ExtractVendorMetadata,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.ExtractVendorMetadata].request.parse(rawRequest);
      const raw = await sidecar.extractVendorMetadata(request.path);
      return ipcSchemas[IpcChannel.ExtractVendorMetadata].response.parse(raw);
    },
  );

  ipcMain.handle(
    IpcChannel.RenderThumbnail,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.RenderThumbnail].request.parse(rawRequest);
      const raw = await sidecar.renderThumbnail(request.path, request.size);
      return ipcSchemas[IpcChannel.RenderThumbnail].response.parse(raw);
    },
  );

  ipcMain.handle(IpcChannel.ScanRoot, async (_event, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.ScanRoot].request.parse(rawRequest);
    const raw = await sidecar.scanRoot(request.rootId, request.path);
    return ipcSchemas[IpcChannel.ScanRoot].response.parse(raw);
  });

  ipcMain.handle(
    IpcChannel.PreviewImport,
    async (_event, rawRequest: unknown) => {
      const request =
        ipcSchemas[IpcChannel.PreviewImport].request.parse(rawRequest);
      const raw = await sidecar.previewImport(request.path);
      return ipcSchemas[IpcChannel.PreviewImport].response.parse(raw);
    },
  );

  ipcMain.handle(IpcChannel.ImportRoot, async (_event, rawRequest: unknown) => {
    const request = ipcSchemas[IpcChannel.ImportRoot].request.parse(rawRequest);
    const raw = await sidecar.importRoot(
      request.rootId,
      request.path,
      request.rules,
      request.commonTags,
    );
    return ipcSchemas[IpcChannel.ImportRoot].response.parse(raw);
  });

  ipcMain.handle(IpcChannel.ListModels, async () => {
    const raw = await sidecar.listModels();
    return ipcSchemas[IpcChannel.ListModels].response.parse(raw);
  });

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
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);

    const selected =
      result.canceled || result.filePaths.length === 0
        ? null
        : { path: result.filePaths[0]! };
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

    const selected =
      result.canceled || result.filePaths.length === 0
        ? null
        : { path: result.filePaths[0]! };
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
}
