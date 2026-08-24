import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import {
  SidecarClient,
  SIDECAR_RPC_PROTOCOL_VERSION,
  resolveSidecarPath,
  type SidecarChannel,
} from '../src/main/sidecar';
import { IPC_CONTRACT_VERSION } from '@shared/ipc';

/**
 * An in-memory fake sidecar channel. Tests supply a `respond` callback that
 * maps an incoming request line to zero or more response lines, letting us
 * exercise the client's framing and supervision without a real process.
 */
function makeFakeChannel(
  respond: (
    request: { id: number; method: string; params: unknown },
    emit: (line: string) => void,
    close: (code: number | null) => void,
  ) => void,
): {
  channel: SidecarChannel;
  sent: string[];
  closeFromSidecar: (code: number | null) => void;
} {
  let messageHandler: ((line: string) => void) | null = null;
  let closeHandler: ((info: { code: number | null }) => void) | null = null;
  const sent: string[] = [];

  const channel: SidecarChannel = {
    send(line: string): void {
      sent.push(line);
      const request = JSON.parse(line) as {
        id: number;
        method: string;
        params: unknown;
      };
      // Respond asynchronously, like a real process would.
      queueMicrotask(() => {
        respond(
          request,
          (responseLine) => messageHandler?.(responseLine),
          (code) => closeHandler?.({ code }),
        );
      });
    },
    onMessage(handler): void {
      messageHandler = handler;
    },
    onClose(handler): void {
      closeHandler = handler;
    },
    close(): void {
      closeHandler?.({ code: 0 });
    },
  };

  return {
    channel,
    sent,
    closeFromSidecar: (code) => closeHandler?.({ code }),
  };
}

describe('SidecarClient', () => {
  it('rejects a sidecar with an incompatible protocol version', async () => {
    const { channel } = makeFakeChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result: { protocolVersion: 2, sidecarVersion: 'stale' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);

    await expect(client.handshake()).rejects.toThrow(
      'sidecar protocol mismatch: expected 1, received 2',
    );
  });

  it('handshakes a newly spawned channel before other RPCs', async () => {
    const methods: string[] = [];
    const { channel } = makeFakeChannel((request, emit) => {
      methods.push(request.method);
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'handshake'
              ? { protocolVersion: 1, sidecarVersion: 'test' }
              : [],
        }),
      );
    });
    const client = new SidecarClient(() => channel, {
      requireProtocolHandshake: true,
    });

    await expect(client.listRetargetProfiles()).resolves.toEqual([]);
    await expect(client.listRetargetProfiles()).resolves.toEqual([]);
    expect(methods).toEqual([
      'handshake',
      'listRetargetProfiles',
      'listRetargetProfiles',
    ]);
  });

  it('binds a loaded scene to the recipe from the same sidecar channel', async () => {
    const methods: string[] = [];
    const { channel } = makeFakeChannel((request, emit) => {
      methods.push(request.method);
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'handshake'
              ? {
                  protocolVersion: 1,
                  sidecarVersion: 'test',
                  sceneCacheRecipe: 'scene/v2.2',
                }
              : { sceneVersion: 2 },
        }),
      );
    });
    const client = new SidecarClient(() => channel, {
      requireProtocolHandshake: true,
    });

    await expect(client.sceneCacheRecipe()).resolves.toBe('scene/v2.2');
    await expect(client.loadSceneWithRecipe('C:/part.stl')).resolves.toEqual({
      scene: { sceneVersion: 2 },
      cacheRecipe: 'scene/v2.2',
    });
    expect(methods).toEqual(['handshake', 'loadScene']);
  });

  it('uses the replacement channel recipe when the sidecar restarts before loading', async () => {
    const first = makeFakeChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result: {
            protocolVersion: 1,
            sidecarVersion: 'old',
            sceneCacheRecipe: 'scene/v2.1',
          },
        }),
      );
    });
    const second = makeFakeChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'handshake'
              ? {
                  protocolVersion: 1,
                  sidecarVersion: 'new',
                  sceneCacheRecipe: 'scene/v2.2',
                }
              : { sceneVersion: 2 },
        }),
      );
    });
    let starts = 0;
    const client = new SidecarClient(
      () => {
        starts += 1;
        return starts === 1 ? first.channel : second.channel;
      },
      { requireProtocolHandshake: true },
    );

    await expect(client.sceneCacheRecipe()).resolves.toBe('scene/v2.1');
    first.closeFromSidecar(0);
    await expect(client.loadSceneWithRecipe('C:/part.stl')).resolves.toEqual({
      scene: { sceneVersion: 2 },
      cacheRecipe: 'scene/v2.2',
    });
    expect(starts).toBe(2);
  });

  it('keeps a missing scene recipe as an explicit unversioned state', async () => {
    const { channel } = makeFakeChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result:
            request.method === 'handshake'
              ? { protocolVersion: 1, sidecarVersion: 'legacy' }
              : { sceneVersion: 2 },
        }),
      );
    });
    const client = new SidecarClient(() => channel, {
      requireProtocolHandshake: true,
    });

    await expect(client.sceneCacheRecipe()).resolves.toBeUndefined();
    await expect(client.loadSceneWithRecipe('C:/part.stl')).resolves.toEqual({
      scene: { sceneVersion: 2 },
    });
  });

  it('starts serialized request deadlines only when each request is dispatched', async () => {
    let releaseFirst: (() => void) | undefined;
    const { channel, sent } = makeFakeChannel((request, emit) => {
      const respond = () =>
        emit(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: { protocolVersion: 1, sidecarVersion: 'test' },
          }),
        );
      if (request.id === 1) releaseFirst = respond;
      else respond();
    });
    const client = new SidecarClient(() => channel, {
      serializeRequests: true,
    });

    const first = client.handshake();
    const second = client.handshake();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    releaseFirst?.();
    await first;
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    await second;
  });

  it('uses the amended six retarget RPC shapes and mutation timeout for builds', async () => {
    const { channel, sent } = makeFakeChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result: { status: 'ok', value: {} },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const target = {
      kind: 'imported' as const,
      path: 'C:\\private\\u1.3mf',
      expectedSha256: 'a'.repeat(64),
    };
    await client.listRetargetProfiles();
    await client.inspectRetargetProfile('bundle:profile');
    await client.inspectImportedRetargetProfile(target.path);
    await client.preflightRetarget('C:\\source.3mf', target, true);
    await client.buildRetarget(
      'C:\\source.3mf',
      'C:\\output.3mf',
      target,
      true,
    );
    await client.validateRetargetOutput(
      'C:\\source.3mf',
      'C:\\output.3mf',
      target,
      true,
    );
    const requests = sent.map(
      (line) =>
        JSON.parse(line) as { method: string; params: Record<string, unknown> },
    );
    expect(requests.map((request) => request.method)).toEqual([
      'listRetargetProfiles',
      'inspectRetargetProfile',
      'inspectImportedRetargetProfile',
      'preflightRetarget',
      'buildRetarget',
      'validateRetargetOutput',
    ]);
    expect(requests[3]?.params).toMatchObject({
      sourcePath: 'C:\\source.3mf',
      target,
      objectExclusion: true,
    });
    expect(requests[4]?.params).toMatchObject({
      outputPath: 'C:\\output.3mf',
      target,
    });
  });

  it('keeps Desktop IPC v4 independent from sidecar protocol v1', () => {
    expect(IPC_CONTRACT_VERSION).toBe(4);
    expect(SIDECAR_RPC_PROTOCOL_VERSION).toBe(1);
  });
  it('resolves a handshake response', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { protocolVersion: 1, sidecarVersion: '0.1.0' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await expect(client.handshake()).resolves.toEqual({
      protocolVersion: 1,
      sidecarVersion: '0.1.0',
    });
  });

  it('rejects a sidecar handshake protocol mismatch independently of Desktop IPC', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { protocolVersion: 2, sidecarVersion: 'future' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await expect(client.handshake()).rejects.toThrow(
      /sidecar protocol mismatch: expected 1, received 2/,
    );
  });

  it('sends a well-formed loadScene request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { positions: [0, 0, 0], indices: [], sourceFormat: 'stl' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.loadScene('C:/models/part.stl');
    expect(result).toMatchObject({ sourceFormat: 'stl' });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string };
    };
    expect(request.method).toBe('loadScene');
    expect(request.params.path).toBe('C:/models/part.stl');
  });

  it('sends server_binding in getRemoteModelLink requests and returns the response', async () => {
    const mockLink = {
      profileId: 'profile-a',
      localModelHash: 'hash-a',
      remoteModelId: 'remote-a',
      clientUploadId: 'upload-a',
      etag: 'etag-a',
      uploadStatus: 'uploaded' as const,
      createdAt: 1,
      updatedAt: 2,
      uploadedAt: 3,
    };
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: mockLink,
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.getRemoteModelLink(
      'profile-a',
      'binding-a',
      'hash-a',
    );
    expect(result).toEqual(mockLink);
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: {
        profileId: string;
        serverBinding: string;
        localModelHash: string;
      };
    };
    expect(request.method).toBe('getRemoteModelLink');
    expect(request.params).toEqual({
      profileId: 'profile-a',
      serverBinding: 'binding-a',
      localModelHash: 'hash-a',
    });
  });

  it('sends a well-formed extractVendorMetadata request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            slicer: 'bambuStudio',
            core: { title: 'Widget' },
            plates: [],
            thumbnails: ['Metadata/plate_1.png'],
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.extractVendorMetadata('C:/models/project.3mf');
    expect(result).toMatchObject({ slicer: 'bambuStudio' });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string };
    };
    expect(request.method).toBe('extractVendorMetadata');
    expect(request.params.path).toBe('C:/models/project.3mf');
  });

  it('sends a well-formed extractVendorPlateThumbnails request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            thumbnails: [
              {
                partName: 'Metadata/plate_1.png',
                plateIndex: 1,
                pngBase64: 'iVBORw0KGgo=',
              },
            ],
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.extractVendorPlateThumbnails(
      'C:/models/project.3mf',
    );
    expect(result).toMatchObject({
      thumbnails: [{ partName: 'Metadata/plate_1.png', plateIndex: 1 }],
    });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string };
    };
    expect(request.method).toBe('extractVendorPlateThumbnails');
    expect(request.params.path).toBe('C:/models/project.3mf');
  });

  it('sends a well-formed renderThumbnail request and resolves the result', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { width: 64, height: 64, pngBase64: 'iVBORw0KGgo=' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.renderThumbnail('C:/models/part.stl', 64);
    expect(result).toMatchObject({ width: 64, height: 64 });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string; size?: number };
    };
    expect(request.method).toBe('renderThumbnail');
    expect(request.params.path).toBe('C:/models/part.stl');
    expect(request.params.size).toBe(64);
  });

  it('omits the optional size when rendering a thumbnail without one', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: { width: 512, height: 512, pngBase64: 'iVBORw0KGgo=' },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await client.renderThumbnail('C:/models/part.stl');
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string; size?: number };
    };
    expect(request.params.size).toBeUndefined();
  });

  it('sends a well-formed scanRoot request and resolves the report', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            added: 2,
            changed: 0,
            unchanged: 1,
            missing: 0,
            hashErrors: 0,
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.scanRoot('root1', 'C:/models');
    expect(result).toMatchObject({ added: 2, unchanged: 1 });
    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { rootId: string; path: string };
    };
    expect(request.method).toBe('scanRoot');
    expect(request.params.rootId).toBe('root1');
    expect(request.params.path).toBe('C:/models');
  });

  it('previews a folder without importing it', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            modelCount: 2,
            totalBytes: 2048,
            skippedErrors: 0,
            complete: true,
            formats: { stl: 1, threeMf: 1, obj: 0 },
            folders: [],
            foldersTruncated: false,
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);

    await client.previewImport('C:/models');

    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { path: string };
    };
    expect(request.method).toBe('previewImport');
    expect(request.params).toEqual({ path: 'C:/models' });
  });

  it('sends confirmed organization rules with an import', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            report: {
              added: 2,
              changed: 0,
              unchanged: 0,
              missing: 0,
              hashErrors: 0,
            },
            modelsOrganized: 2,
            collectionsCreated: 1,
            collectionAssignments: 2,
            tagAssignments: 2,
            resolvedCollections: [],
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const rules = [
      {
        relativePath: 'Animals',
        kind: 'collection' as const,
        name: 'Animals',
        collectionId: 'collection-1',
      },
    ];

    await client.importRoot('root1', 'C:/models', rules, ['printable']);

    const request = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: unknown;
    };
    expect(request.method).toBe('importRoot');
    expect(request.params).toEqual({
      rootId: 'root1',
      path: 'C:/models',
      rules,
      commonTags: ['printable'],
    });
  });

  it('uses a longer mutation watchdog and terminates a stuck import', async () => {
    vi.useFakeTimers();
    try {
      const { channel } = makeFakeChannel(() => undefined);
      const close = vi.spyOn(channel, 'close');
      const client = new SidecarClient(() => channel, {
        requestTimeoutMs: 10,
        mutationTimeoutMs: 100,
      });
      let settled = false;
      const pending = client.importRoot('root1', 'C:/models', [], []);
      void pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      vi.runAllTicks();

      await vi.advanceTimersByTimeAsync(50);
      expect(settled).toBe(false);

      const rejection = expect(pending).rejects.toThrow(
        "sidecar request 'importRoot' timed out; the sidecar was terminated",
      );
      await vi.advanceTimersByTimeAsync(50);
      await rejection;
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses confirmed termination for stuck mutating sync RPCs', async () => {
    vi.useFakeTimers();
    try {
      const { channel } = makeFakeChannel(() => undefined);
      const close = vi.spyOn(channel, 'close');
      const client = new SidecarClient(() => channel, {
        requestTimeoutMs: 10,
        mutationTimeoutMs: 100,
      });
      const pending = client.bindSyncProfile('profile', 'binding', 1);
      const rejection = expect(pending).rejects.toThrow(
        "sidecar request 'bindSyncProfile' timed out; the sidecar was terminated",
      );

      await vi.advanceTimersByTimeAsync(100);
      await rejection;
      expect(close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('blocks replacement channels until timed-out sidecar shutdown is confirmed', async () => {
    vi.useFakeTimers();
    try {
      const first = makeFakeChannel(() => undefined);
      const close = vi
        .spyOn(first.channel, 'close')
        .mockImplementation(() => undefined);
      const second = makeFakeChannel((request, emit) => {
        emit(
          JSON.stringify({
            id: request.id,
            ok: true,
            result: [],
          }),
        );
      });
      let starts = 0;
      const client = new SidecarClient(
        () => {
          starts += 1;
          return starts === 1 ? first.channel : second.channel;
        },
        { mutationTimeoutMs: 100, terminationTimeoutMs: 1_000 },
      );
      let importSettled = false;
      const importRequest = client.importRoot('root1', 'C:/models', [], []);
      void importRequest.then(
        () => {
          importSettled = true;
        },
        () => {
          importSettled = true;
        },
      );
      const rejection = expect(importRequest).rejects.toThrow(
        'the sidecar was terminated',
      );
      vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(100);
      expect(importSettled).toBe(false);

      await expect(client.listModels()).rejects.toThrow(
        'sidecar termination is still in progress',
      );
      expect(starts).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);

      first.closeFromSidecar(null);
      await rejection;
      const catalog = client.listModels();
      vi.runAllTicks();
      await expect(catalog).resolves.toEqual([]);
      expect(starts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds the wait when sidecar shutdown cannot be confirmed', async () => {
    vi.useFakeTimers();
    try {
      const { channel } = makeFakeChannel(() => undefined);
      vi.spyOn(channel, 'close').mockImplementation(() => undefined);
      const client = new SidecarClient(() => channel, {
        mutationTimeoutMs: 100,
        terminationTimeoutMs: 50,
      });
      const importRequest = client.importRoot('root1', 'C:/models', [], []);
      const rejection = expect(importRequest).rejects.toThrow(
        'sidecar shutdown could not be confirmed',
      );
      vi.runAllTicks();

      await vi.advanceTimersByTimeAsync(150);
      await rejection;
      await expect(client.listModels()).rejects.toThrow(
        'sidecar termination is still in progress',
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('never restarts a disposed client while its process is exiting', async () => {
    const first = makeFakeChannel((request, emit) => {
      emit(
        JSON.stringify({
          id: request.id,
          ok: true,
          result: { protocolVersion: 1, sidecarVersion: '0.1.0' },
        }),
      );
    });
    vi.spyOn(first.channel, 'close').mockImplementation(() => undefined);
    let starts = 0;
    const client = new SidecarClient(() => {
      starts += 1;
      return first.channel;
    });
    await client.handshake();

    client.dispose();

    await expect(client.listModels()).rejects.toThrow(
      'sidecar client disposed',
    );
    expect(starts).toBe(1);
  });

  it('sends a listModels request and resolves the model array', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: [
            {
              hash: 'abc',
              format: 'stl',
              size: 1024,
              locations: [],
            },
          ],
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    const result = await client.listModels();
    expect(Array.isArray(result)).toBe(true);
    const request = JSON.parse(sent[0] ?? '{}') as { method: string };
    expect(request.method).toBe('listModels');
  });

  it('sends resetCatalog as a mutation and returns the removal summary', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: {
            reset: true,
            modelsRemoved: 12,
            sourceRootsRemoved: 2,
          },
        }),
      );
    });
    const client = new SidecarClient(() => channel);

    await expect(client.resetCatalog()).resolves.toEqual({
      reset: true,
      modelsRemoved: 12,
      sourceRootsRemoved: 2,
    });
    expect(JSON.parse(sent[0] ?? '{}')).toMatchObject({
      method: 'resetCatalog',
      params: {},
    });
  });

  it('sends favorite catalog requests and resolves the updated hashes', async () => {
    const { channel, sent } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: true,
          result: req.method === 'removeFavorite' ? [] : ['abc'],
        }),
      );
    });
    const client = new SidecarClient(() => channel);

    await expect(client.addFavorite('abc')).resolves.toEqual(['abc']);
    await expect(client.removeFavorite('abc')).resolves.toEqual([]);

    const addRequest = JSON.parse(sent[0] ?? '{}') as {
      method: string;
      params: { hash: string };
    };
    const removeRequest = JSON.parse(sent[1] ?? '{}') as {
      method: string;
      params: { hash: string };
    };
    expect(addRequest).toMatchObject({
      method: 'addFavorite',
      params: { hash: 'abc' },
    });
    expect(removeRequest).toMatchObject({
      method: 'removeFavorite',
      params: { hash: 'abc' },
    });
  });

  it('rejects when the sidecar returns an error envelope', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      emit(
        JSON.stringify({
          id: req.id,
          ok: false,
          error: 'failed to load scene',
        }),
      );
    });
    const client = new SidecarClient(() => channel);
    await expect(client.loadScene('missing.stl')).rejects.toThrow(
      /failed to load scene/,
    );
  });

  it('correlates concurrent requests by id', async () => {
    const { channel } = makeFakeChannel((req, emit) => {
      // Reply out of order to prove id-based correlation.
      const delay =
        req.params && (req.params as { path?: string }).path === 'a' ? 20 : 0;
      setTimeout(() => {
        emit(
          JSON.stringify({ id: req.id, ok: true, result: { echoed: req.id } }),
        );
      }, delay);
    });
    const client = new SidecarClient(() => channel);
    const [first, second] = await Promise.all([
      client.loadScene('a'),
      client.loadScene('b'),
    ]);
    expect(first).toEqual({ echoed: 1 });
    expect(second).toEqual({ echoed: 2 });
  });

  it('rejects in-flight requests when the sidecar exits', async () => {
    const { channel } = makeFakeChannel((_req, _emit, close) => {
      close(1);
    });
    const client = new SidecarClient(() => channel);
    await expect(client.loadScene('a')).rejects.toThrow(/sidecar exited/);
  });

  it('times out a request that never gets a response', async () => {
    vi.useFakeTimers();
    const { channel } = makeFakeChannel(() => {
      // Never respond.
    });
    const client = new SidecarClient(() => channel, { requestTimeoutMs: 100 });
    const promise = client.handshake();
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(150);
    await assertion;
    vi.useRealTimers();
  });

  it('restarts the channel after a crash on the next request', async () => {
    let starts = 0;
    const factory = (): SidecarChannel => {
      starts += 1;
      const startForThisChannel = starts;
      const { channel } = makeFakeChannel((req, emit, close) => {
        if (startForThisChannel === 1) {
          close(1);
        } else {
          emit(
            JSON.stringify({
              id: req.id,
              ok: true,
              result: { protocolVersion: 1, sidecarVersion: '0.1.0' },
            }),
          );
        }
      });
      return channel;
    };
    const client = new SidecarClient(factory);
    await expect(client.handshake()).rejects.toThrow();
    await expect(client.handshake()).resolves.toMatchObject({
      protocolVersion: 1,
    });
    expect(starts).toBe(2);
  });

  it('gives up after too many consecutive failures', async () => {
    const factory = (): SidecarChannel => {
      const { channel } = makeFakeChannel((_req, _emit, close) => close(1));
      return channel;
    };
    const client = new SidecarClient(factory, { maxConsecutiveFailures: 2 });
    await expect(client.handshake()).rejects.toThrow(/exited/);
    await expect(client.handshake()).rejects.toThrow(/exited/);
    await expect(client.handshake()).rejects.toThrow(/unavailable/);
  });
});

describe('resolveSidecarPath', () => {
  it('honors the PRINTFARMER_SIDECAR_PATH override', () => {
    const original = process.env.PRINTFARMER_SIDECAR_PATH;
    process.env.PRINTFARMER_SIDECAR_PATH = '/custom/model-core';
    try {
      expect(resolveSidecarPath()).toBe('/custom/model-core');
    } finally {
      if (original === undefined) {
        delete process.env.PRINTFARMER_SIDECAR_PATH;
      } else {
        process.env.PRINTFARMER_SIDECAR_PATH = original;
      }
    }
  });

  it('uses the staged repo sidecar during development', () => {
    const original = process.env.PRINTFARMER_SIDECAR_PATH;
    delete process.env.PRINTFARMER_SIDECAR_PATH;
    const proc = process as unknown as {
      defaultApp?: boolean;
      resourcesPath?: string;
    };
    const originalDefaultApp = proc.defaultApp;
    proc.defaultApp = true;
    try {
      const resolved = resolveSidecarPath();
      const expectedName =
        process.platform === 'win32' ? 'model-core.exe' : 'model-core';
      expect(resolved).toContain(
        path.join('resources', 'sidecar', expectedName),
      );
    } finally {
      if (originalDefaultApp === undefined) {
        delete proc.defaultApp;
      } else {
        proc.defaultApp = originalDefaultApp;
      }
      if (original !== undefined) {
        process.env.PRINTFARMER_SIDECAR_PATH = original;
      }
    }
  });

  it('uses the bundled resources path in a packaged build', () => {
    const original = process.env.PRINTFARMER_SIDECAR_PATH;
    delete process.env.PRINTFARMER_SIDECAR_PATH;
    const proc = process as unknown as {
      defaultApp?: boolean;
      resourcesPath?: string;
    };
    const originalDefaultApp = proc.defaultApp;
    const originalResources = proc.resourcesPath;
    delete proc.defaultApp;
    proc.resourcesPath = path.join('/opt', 'app', 'resources');
    try {
      const expectedName =
        process.platform === 'win32' ? 'model-core.exe' : 'model-core';
      expect(resolveSidecarPath()).toBe(
        path.join('/opt', 'app', 'resources', 'sidecar', expectedName),
      );
    } finally {
      if (originalDefaultApp !== undefined) {
        proc.defaultApp = originalDefaultApp;
      }
      if (originalResources === undefined) {
        delete proc.resourcesPath;
      } else {
        proc.resourcesPath = originalResources;
      }
      if (original !== undefined) {
        process.env.PRINTFARMER_SIDECAR_PATH = original;
      }
    }
  });
});
