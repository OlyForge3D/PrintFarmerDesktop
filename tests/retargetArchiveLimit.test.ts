import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_ARCHIVE_BYTES, IpcChannel } from '@shared/ipc';
import type { SidecarChannel } from '../src/main/sidecar';

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

import { registerIpcHandlers } from '../src/main/ipc';
import { RetargetArtifactService } from '../src/main/retargetArtifacts';
import { RootApprovalStore } from '../src/main/rootApprovals';
import { SceneCacheService } from '../src/main/sceneCache';
import { SidecarClient } from '../src/main/sidecar';
import { UploadJobService } from '../src/main/uploadJobs';

function recordingChannel(): {
  channel: SidecarChannel;
  requests: Array<{ method: string; params: unknown }>;
} {
  let messageHandler: ((line: string) => void) | undefined;
  let closeHandler:
    ((info: { code: number | null; error?: Error }) => void) | undefined;
  const requests: Array<{ method: string; params: unknown }> = [];
  return {
    requests,
    channel: {
      send(line) {
        const request = JSON.parse(line) as {
          id: number;
          method: string;
          params: unknown;
        };
        requests.push({ method: request.method, params: request.params });
        queueMicrotask(() =>
          messageHandler?.(
            JSON.stringify({ id: request.id, ok: true, result: {} }),
          ),
        );
      },
      onMessage(handler) {
        messageHandler = handler;
      },
      onClose(handler) {
        closeHandler = handler;
      },
      close() {
        closeHandler?.({ code: 0 });
      },
    },
  };
}

describe('retarget ZIP limit wiring', () => {
  it('uses the persisted setting on the distinct retarget sidecar and keeps strict validation', async () => {
    electronState.userDataPath = path.join(
      process.cwd(),
      `.test-retarget-archive-settings-${randomUUID()}`,
    );
    electronState.handlers.clear();
    const initializeArtifacts = vi
      .spyOn(RetargetArtifactService.prototype, 'initialize')
      .mockResolvedValue();
    const disposeArtifacts = vi
      .spyOn(RetargetArtifactService.prototype, 'disposeAll')
      .mockResolvedValue();
    const mainTransport = recordingChannel();
    const retargetTransport = recordingChannel();
    const mainSidecar = new SidecarClient(() => mainTransport.channel);
    const retargetSidecar = new SidecarClient(() => retargetTransport.channel);
    const uploads = Object.create(
      UploadJobService.prototype,
    ) as UploadJobService;
    uploads.initialize = vi.fn(() => Promise.resolve());
    const sceneCache = {
      initialize: vi.fn(() => Promise.resolve()),
    } as unknown as SceneCacheService;
    const approvals = Object.create(
      RootApprovalStore.prototype,
    ) as RootApprovalStore;
    const dispose = registerIpcHandlers(
      undefined,
      undefined,
      mainSidecar,
      retargetSidecar,
      uploads,
      approvals,
      sceneCache,
    );

    try {
      await expect(
        electronState.handlers.get(IpcChannel.GetArchiveSettings)?.(
          {},
          undefined,
        ),
      ).resolves.toEqual({ maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES });

      await retargetSidecar.loadRetargetScene('C:/part.3mf');
      await electronState.handlers.get(IpcChannel.SetArchiveSettings)?.(
        {},
        { maxArchiveBytes: 16 * 1024 * 1024 },
      );
      await retargetSidecar.loadRetargetScene('C:/part.3mf');
      await electronState.handlers.get(IpcChannel.SetArchiveSettings)?.(
        {},
        { maxArchiveBytes: 1024 * 1024 * 1024 },
      );
      await retargetSidecar.loadRetargetScene('C:/part.3mf');

      await expect(
        electronState.handlers.get(IpcChannel.SetArchiveSettings)?.(
          {},
          { maxArchiveBytes: 16 * 1024 * 1024 + 1 },
        ),
      ).rejects.toThrow();
      await expect(
        electronState.handlers.get(IpcChannel.SetArchiveSettings)?.(
          {},
          {
            maxArchiveBytes: 16 * 1024 * 1024,
            unexpected: true,
          },
        ),
      ).rejects.toThrow();
      await expect(
        electronState.handlers.get(IpcChannel.GetArchiveSettings)?.(
          {},
          undefined,
        ),
      ).resolves.toEqual({ maxArchiveBytes: 1024 * 1024 * 1024 });
      expect(
        retargetTransport.requests
          .filter((request) => request.method === 'loadScene')
          .map((request) => request.params),
      ).toEqual([
        {
          path: 'C:/part.3mf',
          maxArchiveBytes: DEFAULT_MAX_ARCHIVE_BYTES,
        },
        { path: 'C:/part.3mf', maxArchiveBytes: 16 * 1024 * 1024 },
        { path: 'C:/part.3mf', maxArchiveBytes: 1024 * 1024 * 1024 },
      ]);
      expect(
        mainTransport.requests.filter(
          (request) => request.method === 'loadScene',
        ),
      ).toEqual([]);
    } finally {
      await dispose();
      mainSidecar.dispose();
      retargetSidecar.dispose();
      initializeArtifacts.mockRestore();
      disposeArtifacts.mockRestore();
      electronState.handlers.clear();
      await rm(electronState.userDataPath, { force: true, recursive: true });
    }
  });
});
