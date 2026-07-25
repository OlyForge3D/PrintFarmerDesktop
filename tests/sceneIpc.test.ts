import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IpcChannel, type LoadSceneResponse } from '@shared/ipc';

type InvokeHandler = (event: unknown, request: unknown) => Promise<unknown>;

const electronState = vi.hoisted(() => ({
  handlers: new Map<string, InvokeHandler>(),
  userDataPath: '',
}));

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userDataPath,
    getVersion: () => '0.1.0',
    on: vi.fn(),
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    showOpenDialog: vi.fn(),
    showSaveDialog: vi.fn(),
  },
  ipcMain: {
    handle: (channel: string, handler: InvokeHandler) => {
      electronState.handlers.set(channel, handler);
    },
  },
  safeStorage: {
    decryptString: vi.fn(),
    encryptString: vi.fn(),
    isEncryptionAvailable: () => false,
  },
}));

import { createLoadSceneHandler, registerIpcHandlers } from '../src/main/ipc';
import { RootApprovalStore } from '../src/main/rootApprovals';
import { SceneCacheService } from '../src/main/sceneCache';
import { SidecarClient } from '../src/main/sidecar';
import { UploadJobService } from '../src/main/uploadJobs';

function scene(): LoadSceneResponse {
  return {
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    sourceFormat: 'stl',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [],
    rootObjectIds: [],
    plates: [],
  };
}

describe('load-scene IPC handler', () => {
  it('routes the approved model path through the scene cache', async () => {
    const authorizeFile = vi.fn(() =>
      Promise.resolve('C:\\approved\\part.stl'),
    );
    const loadScene = vi.fn(() => Promise.resolve(scene()));
    const handler = createLoadSceneHandler(authorizeFile, { loadScene });

    await expect(
      handler({}, { path: 'C:\\selected\\part.stl' }),
    ).resolves.toEqual(scene());

    expect(authorizeFile).toHaveBeenCalledWith('C:\\selected\\part.stl');
    expect(loadScene).toHaveBeenCalledWith('C:\\approved\\part.stl');
  });

  it('registers the product LoadScene channel with the cache-backed handler', async () => {
    electronState.userDataPath = await mkdtemp(
      path.join(tmpdir(), 'printfarmer-scene-ipc-'),
    );
    electronState.handlers.clear();
    const approvedPath = path.join(electronState.userDataPath, 'approved.stl');
    const approvals = new RootApprovalStore({
      userDataPath: electronState.userDataPath,
    });
    vi.spyOn(approvals, 'canonicalizePickerFile').mockResolvedValue(
      approvedPath,
    );
    vi.spyOn(approvals, 'authorizeFile').mockResolvedValue({
      sourcePath: approvedPath,
      canonicalPath: approvedPath,
    });
    const sceneCache = new SceneCacheService({
      userDataPath: electronState.userDataPath,
      sidecar: {
        sceneCacheRecipe: () => Promise.resolve(undefined),
        loadSceneWithRecipe: () => Promise.resolve({ scene: scene() }),
      },
    });
    vi.spyOn(sceneCache, 'initialize').mockResolvedValue();
    const loadScene = vi
      .spyOn(sceneCache, 'loadScene')
      .mockResolvedValue(scene());
    const uploads = Object.create(
      UploadJobService.prototype,
    ) as UploadJobService;
    uploads.initialize = vi.fn(() => Promise.resolve());
    uploads.dispose = vi.fn();
    const sidecar = Object.create(SidecarClient.prototype) as SidecarClient;
    sidecar.loadScene = vi.fn(() => Promise.resolve(scene()));
    const dispose = registerIpcHandlers(
      undefined,
      undefined,
      sidecar,
      undefined,
      uploads,
      approvals,
      sceneCache,
    );

    try {
      const handler = electronState.handlers.get(IpcChannel.LoadScene);
      expect(handler).toBeDefined();
      await expect(
        handler?.({}, { path: 'C:\\selected\\part.stl' }),
      ).resolves.toEqual(scene());

      expect(loadScene).toHaveBeenCalledWith(approvedPath);
    } finally {
      await dispose();
      await rm(electronState.userDataPath, { force: true, recursive: true });
    }
  });
});
