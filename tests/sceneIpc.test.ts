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

describe('sidecar ping handler', () => {
  it('reports a healthy sidecar even when scene-cache adoption fails', async () => {
    // Two behaviours in one assertion, both unpinned before this test.
    //
    // 1. Adoption must not decide sidecar health. Running it inside the
    //    handshake `try` let a cache failure classify a live sidecar as down,
    //    which is the defect the #84 review recorded as N9.
    // 2. Adoption must not be able to fail the ping at all. Startup adoption
    //    has always been guarded (`ipc.ts` wraps `sceneCache.initialize()` in
    //    `.catch`); the ping-time call was not, so it silently depended on
    //    `adoptRecipe` never rejecting. Nothing stated that invariant and
    //    nothing enforced it, so any future throwing path inside adoption
    //    would have turned health reporting into a rejected IPC call.
    electronState.userDataPath = await mkdtemp(
      path.join(tmpdir(), 'printfarmer-scene-ping-'),
    );
    electronState.handlers.clear();
    const approvals = new RootApprovalStore({
      userDataPath: electronState.userDataPath,
    });
    const sceneCache = Object.create(
      SceneCacheService.prototype,
    ) as SceneCacheService;
    sceneCache.initialize = vi.fn(() => Promise.resolve());
    sceneCache.loadScene = vi.fn(() => Promise.resolve(scene()));
    const adoptRecipe = vi.fn(() =>
      Promise.reject(new Error('cache volume detached')),
    );
    sceneCache.adoptRecipe = adoptRecipe;
    const uploads = Object.create(
      UploadJobService.prototype,
    ) as UploadJobService;
    uploads.initialize = vi.fn(() => Promise.resolve());
    uploads.dispose = vi.fn();
    const sidecar = Object.create(SidecarClient.prototype) as SidecarClient;
    sidecar.handshake = vi.fn(() =>
      Promise.resolve({
        protocolVersion: 1,
        sidecarVersion: '9.9.9',
        sceneCacheRecipe: 'scene/v2.2',
      }),
    );
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
      const handler = electronState.handlers.get(IpcChannel.SidecarPing);
      expect(handler).toBeDefined();

      await expect(handler?.({}, { nonce: 'health-check' })).resolves.toEqual({
        ok: true,
        nonce: 'health-check',
        sidecarVersion: '9.9.9',
      });
      // The adoption really was attempted with the handshake's recipe, so this
      // is not green merely because the call was skipped.
      expect(adoptRecipe).toHaveBeenCalledWith('scene/v2.2');
    } finally {
      await dispose();
      await rm(electronState.userDataPath, { force: true, recursive: true });
    }
  });

  it('reports an unreachable sidecar as not ok', async () => {
    // The other side of the same boundary: the test above must not be able to
    // pass by reporting `ok: true` unconditionally.
    electronState.userDataPath = await mkdtemp(
      path.join(tmpdir(), 'printfarmer-scene-ping-'),
    );
    electronState.handlers.clear();
    const approvals = new RootApprovalStore({
      userDataPath: electronState.userDataPath,
    });
    const sceneCache = Object.create(
      SceneCacheService.prototype,
    ) as SceneCacheService;
    sceneCache.initialize = vi.fn(() => Promise.resolve());
    sceneCache.loadScene = vi.fn(() => Promise.resolve(scene()));
    const adoptRecipe = vi.fn(() => Promise.resolve());
    sceneCache.adoptRecipe = adoptRecipe;
    const uploads = Object.create(
      UploadJobService.prototype,
    ) as UploadJobService;
    uploads.initialize = vi.fn(() => Promise.resolve());
    uploads.dispose = vi.fn();
    const sidecar = Object.create(SidecarClient.prototype) as SidecarClient;
    sidecar.handshake = vi.fn(() =>
      Promise.reject(new Error('sidecar did not start')),
    );
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
      const handler = electronState.handlers.get(IpcChannel.SidecarPing);
      await expect(handler?.({}, { nonce: 'health-check' })).resolves.toEqual({
        ok: false,
        nonce: 'health-check',
        sidecarVersion: null,
      });
      // A dead sidecar advertises no recipe, so adoption must not run at all -
      // otherwise a failed handshake would evict the cache.
      expect(adoptRecipe).not.toHaveBeenCalled();
    } finally {
      await dispose();
      await rm(electronState.userDataPath, { force: true, recursive: true });
    }
  });
});
