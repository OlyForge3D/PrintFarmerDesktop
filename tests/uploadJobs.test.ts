import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '@shared/ipc';
import {
  UploadJobService,
  UploadJobStore,
  type UploadJobFileSystem,
  type UploadProfileService,
  type UploadSidecar,
} from '../src/main/uploadJobs.js';
import {
  ModelUploadError,
  scrubSensitiveText,
  type UploadTransport,
} from '../src/main/uploadTransport.js';
import { ServerProfileError } from '../src/main/serverProfiles.js';

const MODEL_PATH = path.resolve('package.json');
const STORE_PATH = path.join('data', 'upload-jobs.v2.json');

function uuidFactory(): () => string {
  let value = 1;
  return () => `00000000-0000-4000-8000-${String(value++).padStart(12, '0')}`;
}

function memoryFileSystem(initial?: string): UploadJobFileSystem & {
  files: Map<string, Uint8Array>;
  operations: string[];
} {
  const files = new Map<string, Uint8Array>();
  const operations: string[] = [];
  if (initial !== undefined) files.set(STORE_PATH, Buffer.from(initial));
  return {
    files,
    operations,
    readFile(filePath) {
      const value = files.get(filePath);
      if (!value) {
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(value);
    },
    writeFile(filePath, data) {
      operations.push(`write:${filePath}`);
      files.set(filePath, Buffer.from(data));
      return Promise.resolve();
    },
    rename(from, to) {
      operations.push(`rename:${from}->${to}`);
      files.set(to, files.get(from)!);
      files.delete(from);
      return Promise.resolve();
    },
    mkdir(directory) {
      operations.push(`mkdir:${directory}`);
      return Promise.resolve();
    },
    unlink(filePath) {
      files.delete(filePath);
      return Promise.resolve();
    },
  };
}

describe('UploadJobStore', () => {
  it('writes through a temporary file before atomic rename', async () => {
    const fileSystem = memoryFileSystem();
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem,
    });
    await store.save([]);
    expect(fileSystem.operations).toEqual([
      'mkdir:data',
      `write:${STORE_PATH}.tmp`,
      `rename:${STORE_PATH}.tmp->${STORE_PATH}`,
    ]);
  });

  it('reports corruption without silently replacing the store', async () => {
    const fileSystem = memoryFileSystem('{not json');
    const store = new UploadJobStore({ userDataPath: 'data', fileSystem });
    await expect(store.load()).rejects.toMatchObject({
      code: 'CORRUPT_STORE',
    });
    expect(fileSystem.operations).toEqual([]);
  });

  it('resets corruption only explicitly and retains a recovery backup', async () => {
    const fileSystem = memoryFileSystem('{not json');
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem,
      now: () => 123,
    });
    await expect(store.load()).rejects.toMatchObject({ code: 'CORRUPT_STORE' });
    const reset = await store.reset();
    expect(reset.backupCreated).toBe(true);
    expect(fileSystem.files.has(`${STORE_PATH}.backup-123`)).toBe(true);
    expect(await store.load()).toEqual([]);
  });

  it('recovers crash-left modern uploads as retryable uncertainty', async () => {
    const now = Date.parse('2026-07-23T20:00:00.000Z');
    const fileSystem = memoryFileSystem(
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: '00000000-0000-4000-8000-000000000001',
            profileId: '00000000-0000-4000-8000-000000000002',
            profileName: 'Farm',
            mode: 'modern',
            state: 'running',
            paused: false,
            createdAt: '2026-07-23T19:00:00.000Z',
            updatedAt: '2026-07-23T19:00:00.000Z',
            items: [
              {
                id: '00000000-0000-4000-8000-000000000003',
                hash: 'a'.repeat(64),
                clientUploadId: '00000000-0000-4000-8000-000000000004',
                displayName: 'part.stl',
                size: 4,
                state: 'uploading',
                bytesSent: 2,
                attempts: 1,
                createdAt: '2026-07-23T19:00:00.000Z',
                updatedAt: '2026-07-23T19:00:00.000Z',
                remote: null,
                error: null,
              },
            ],
            totalBytes: 4,
            bytesSent: 2,
            summary: {
              queued: 0,
              uploading: 1,
              succeeded: 0,
              failed: 0,
              cancelled: 0,
              uncertain: 0,
            },
          },
        ],
      }),
    );
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem,
      now: () => now,
    });
    const jobs = await store.load();
    expect(jobs[0]?.items[0]).toMatchObject({
      state: 'uncertain',
      clientUploadId: '00000000-0000-4000-8000-000000000004',
      error: { retryable: true, duplicateRisk: false },
    });
  });
});

describe('UploadJobService', () => {
  it('bounds parallel uploads, records progress, and links every success', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const hashes = [hash, 'b'.repeat(64), 'c'.repeat(64)];
    let active = 0;
    let peak = 0;
    const transport: UploadTransport = async (request) => {
      active += 1;
      peak = Math.max(peak, active);
      await request.onProgress(request.modelSize);
      await new Promise((resolve) => setTimeout(resolve, 25));
      active -= 1;
      return remote(
        request.clientUploadId,
        request.displayName,
        request.modelSize,
      );
    };
    const links: unknown[] = [];
    const service = await serviceFixture({
      hashes,
      transport,
      concurrency: 2,
      links,
    });
    const job = await service.start({
      profileId: PROFILE.id,
      hashes,
    });
    await waitFor(
      () => service.list(),
      () => peak === 2,
    );
    expect(peak).toBe(2);
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.summary.succeeded === hashes.length,
    );
    const completed = (await service.list())[0]!;
    expect(completed.bytesSent).toBe(completed.totalBytes);
    expect(completed.items.every((item) => item.clientUploadId)).toBe(true);
    expect(links).toHaveLength(3);
    expect(job.items[0]).not.toHaveProperty('path');
  });

  it('cancels modern work safely but marks interrupted legacy work uncertain', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    let transportEntered = false;
    const transport: UploadTransport = async (request) =>
      new Promise((_resolve, reject) => {
        transportEntered = true;
        request.signal.addEventListener('abort', () =>
          reject(
            new ModelUploadError(
              {
                code: 'ABORTED',
                message: 'stopped',
                retryable: true,
                retryAfterSeconds: null,
                duplicateRisk: request.mode === 'legacyModelOnly',
              },
              'modelStreaming',
            ),
          ),
        );
      });
    for (const mode of ['modern', 'legacyModelOnly'] as const) {
      const service = await serviceFixture({
        hashes: [hash],
        transport,
        profile: profile(mode),
      });
      const job = await service.start({
        profileId: PROFILE.id,
        hashes: [hash],
      });
      await waitFor(
        () => service.list(),
        () => transportEntered,
      );
      await service.cancel(job.id);
      const expected = mode === 'modern' ? 'cancelled' : 'uncertain';
      const jobs = await waitFor(
        () => service.list(),
        (value) => value[0]?.items[0]?.state === expected,
      );
      expect(jobs[0]?.items[0]?.error?.duplicateRisk).toBe(
        mode === 'legacyModelOnly',
      );
      if (mode === 'legacyModelOnly') {
        await expect(service.retry(job.id)).rejects.toThrow(
          /no safely retryable/i,
        );
        transportEntered = false;
        await service.confirmLegacyRetry(job.id);
        await waitFor(
          () => service.list(),
          () => transportEntered,
        );
        await service.cancel(job.id);
        await waitFor(
          () => service.list(),
          (value) => value[0]?.items[0]?.state === 'uncertain',
        );
      }
      transportEntered = false;
    }
  });

  it('retains the modern client upload ID across retry', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const ids: string[] = [];
    let attempts = 0;
    const service = await serviceFixture({
      hashes: [hash],
      transport: (request) => {
        ids.push(request.clientUploadId);
        attempts += 1;
        if (attempts === 1) {
          throw new ModelUploadError({
            code: 'SERVER_ERROR',
            message: 'retry',
            retryable: true,
            retryAfterSeconds: null,
            duplicateRisk: false,
          });
        }
        return Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        );
      },
    });
    const job = await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.items[0]?.state === 'failed',
    );
    await service.retry(job.id);
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.items[0]?.state === 'succeeded',
    );
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it('does not requeue permanent upload failures', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const service = await serviceFixture({
      hashes: [hash],
      transport: () =>
        Promise.reject(
          new ModelUploadError(
            {
              code: 'BAD_REQUEST',
              message: 'The server rejected the request.',
              retryable: false,
              retryAfterSeconds: null,
              duplicateRisk: false,
            },
            'responseReceived',
          ),
        ),
    });
    const job = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.items[0]?.state === 'failed',
    );
    await expect(service.retry(job.id)).rejects.toThrow(/no safely retryable/i);
  });

  it('invalidates exactly one rejected auth context and retries with the same identity', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    let contextNumber = 0;
    let invalidations = 0;
    const tokens: string[] = [];
    const uploadIds: string[] = [];
    const profiles: UploadProfileService = {
      list: () =>
        Promise.resolve({ profiles: [PROFILE], selectedProfileId: PROFILE.id }),
      getAuthenticatedContext: () => {
        contextNumber += 1;
        return Promise.resolve(authContext(`token-${contextNumber}`));
      },
      revalidateAuthenticatedContext: () => Promise.resolve(),
      invalidateRejectedContext: () => {
        invalidations += 1;
        return Promise.resolve(true);
      },
    };
    const service = await serviceFixture({
      hashes: [hash],
      profiles,
      transport: (request) => {
        tokens.push(request.token);
        uploadIds.push(request.clientUploadId);
        if (tokens.length === 1) {
          return Promise.reject(
            new ModelUploadError(
              {
                code: 'UNAUTHENTICATED',
                message: 'rejected',
                retryable: true,
                retryAfterSeconds: null,
                duplicateRisk: false,
              },
              'responseReceived',
            ),
          );
        }
        return Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        );
      },
    });
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.items[0]?.state === 'succeeded',
    );
    expect(tokens).toEqual(['token-2', 'token-3']);
    expect(new Set(uploadIds).size).toBe(1);
    expect(invalidations).toBe(1);
  });

  it('cancels without transport when the profile changes before send', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    let sends = 0;
    const service = await serviceFixture({
      hashes: [hash],
      profiles: {
        list: () =>
          Promise.resolve({
            profiles: [PROFILE],
            selectedProfileId: PROFILE.id,
          }),
        getAuthenticatedContext: () => Promise.resolve(authContext('token-a')),
        revalidateAuthenticatedContext: () =>
          Promise.reject(
            new ServerProfileError(
              'AUTHENTICATION_SUPERSEDED',
              'profile changed',
            ),
          ),
        invalidateRejectedContext: () => Promise.resolve(false),
      },
      transport: () => {
        sends += 1;
        return Promise.reject(new Error('must not send'));
      },
    });
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    const jobs = await waitFor(
      () => service.list(),
      (value) => value[0]?.items[0]?.state === 'cancelled',
    );
    expect(sends).toBe(0);
    expect(jobs[0]?.items[0]?.error).toMatchObject({
      code: 'AUTHENTICATION_SUPERSEDED',
      duplicateRisk: false,
    });
  });

  it('reuses an immutable sidecar link after the UI job is removed', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    let savedLink: Parameters<UploadSidecar['linkRemoteModel']>[0] | null =
      null;
    let sends = 0;
    const service = await serviceFixture({
      hashes: [hash],
      sidecarFactory: (models) => ({
        listModels: () => Promise.resolve(models),
        renderThumbnail: () => Promise.resolve(null),
        getRemoteModelLink: () => Promise.resolve(savedLink),
        linkRemoteModel: (link) => {
          if (
            savedLink &&
            (savedLink.remoteModelId !== link.remoteModelId ||
              savedLink.clientUploadId !== link.clientUploadId)
          ) {
            return Promise.reject(new Error('immutable link mismatch'));
          }
          savedLink = link;
          return Promise.resolve(link);
        },
      }),
      transport: (request) => {
        sends += 1;
        return Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        );
      },
    });
    const first = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    const completed = await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.state === 'completed',
    );
    const durableId = completed[0]!.items[0]!.clientUploadId;
    await service.remove(first.id);
    const second = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    expect(second.items[0]).toMatchObject({
      state: 'succeeded',
      clientUploadId: durableId,
    });
    expect(sends).toBe(1);
  });

  it('rejects a duplicate active profile/hash upload', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const service = await serviceFixture({
      hashes: [hash],
      transport: (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener('abort', () =>
            reject(
              new ModelUploadError(
                {
                  code: 'ABORTED',
                  message: 'stopped',
                  retryable: true,
                  retryAfterSeconds: null,
                  duplicateRisk: false,
                },
                'modelStreaming',
              ),
            ),
          );
        }),
    });
    const first = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    await expect(
      service.start({ profileId: PROFILE.id, hashes: [hash] }),
    ).rejects.toThrow(/active or recoverable upload/i);
    await service.cancel(first.id);
  });

  it('rolls back a job creation when its atomic checkpoint fails', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem: memoryFileSystem(),
    });
    vi.spyOn(store, 'saveState').mockRejectedValueOnce(
      new Error('simulated disk failure'),
    );
    const service = await serviceFixture({
      hashes: [hash],
      store,
      transport: () => Promise.reject(new Error('must not send')),
    });
    await expect(
      service.start({ profileId: PROFILE.id, hashes: [hash] }),
    ).rejects.toThrow();
    expect(await service.list()).toEqual([]);
  });

  it('never sends when the durable uploading checkpoint fails', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem: memoryFileSystem(),
    });
    const realSave = store.saveState.bind(store);
    let saves = 0;
    vi.spyOn(store, 'saveState').mockImplementation((state) => {
      saves += 1;
      return saves === 2
        ? Promise.reject(new Error('checkpoint unavailable'))
        : realSave(state);
    });
    let sends = 0;
    const service = await serviceFixture({
      hashes: [hash],
      store,
      transport: () => {
        sends += 1;
        return Promise.reject(new Error('must not send'));
      },
    });
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await expectEventuallyRejected(() => service.list());
    expect(sends).toBe(0);
  });

  it('schedules jobs round-robin while preserving each job item order', async () => {
    const hashes = ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64)];
    const started: string[] = [];
    const releases: Array<() => void> = [];
    const service = await serviceFixture({
      hashes,
      concurrency: 1,
      transport: (request) =>
        new Promise((resolve) => {
          started.push(request.clientUploadId);
          releases.push(() =>
            resolve(
              remote(
                request.clientUploadId,
                request.displayName,
                request.modelSize,
              ),
            ),
          );
        }),
    });
    const first = await service.start({
      profileId: PROFILE.id,
      hashes: hashes.slice(0, 2),
    });
    await waitFor(
      () => service.list(),
      () => started.length === 1,
    );
    const second = await service.start({
      profileId: PROFILE.id,
      hashes: [hashes[2]!],
    });
    const firstIds = first.items.map((item) => item.clientUploadId);
    const secondId = second.items[0]!.clientUploadId;
    releases.shift()?.();
    await waitFor(
      () => service.list(),
      () => started.length === 2,
    );
    expect(started).toEqual([firstIds[0], secondId]);
    releases.shift()?.();
    await waitFor(
      () => service.list(),
      () => started.length === 3,
    );
    expect(started[2]).toBe(firstIds[1]);
    releases.shift()?.();
    await waitFor(
      () => service.list(),
      (jobs) => jobs.every((job) => job.state === 'completed'),
    );
  });
});

it('redacts bearer tokens, credentials, and local paths from errors', () => {
  const scrubbed = scrubSensitiveText(
    'Bearer abc.def token=secret C:\\Users\\name\\private\\part.stl',
  );
  expect(scrubbed).not.toContain('abc.def');
  expect(scrubbed).not.toContain('secret');
  expect(scrubbed).not.toContain('name');
});

const PROFILE = profile('modern');

function profile(mode: 'modern' | 'legacyModelOnly'): ServerProfile {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    displayName: 'Farm',
    baseUrl: 'https://farm.example',
    authMode: 'apiKey',
    version: null,
    capabilities: {
      architecture: 'x64',
      slicingEnabled: true,
      modelFilesEnabled: true,
      thumbnailGenerationEnabled: true,
      gcodeUploadEnabled: true,
      clientThumbnailUploadEnabled: false,
      idempotentModelUploadEnabled: mode === 'modern',
      modelThumbnailReplacementEnabled: false,
      platformNote: null,
    },
    availability: {
      modelUpload: { available: true, mode, reason: null },
      librarySync: { available: true, reason: null },
      clientThumbnailUpload: { available: false, reason: null },
      serverThumbnailFallback: { available: mode !== 'modern', reason: null },
    },
    status: mode === 'modern' ? 'connected' : 'legacy',
    lastCheckedAt: '2026-07-23T19:00:00.000Z',
    warnings: mode === 'modern' ? [] : ['legacy'],
  };
}

async function serviceFixture(options: {
  hashes: string[];
  transport: UploadTransport;
  concurrency?: number;
  profile?: ServerProfile;
  profiles?: UploadProfileService;
  sidecarFactory?: (
    models: Array<{
      hash: string;
      format: 'stl';
      size: number;
      locations: Array<{
        rootId: string;
        path: string;
        rootRelative: string;
        size: number;
        available: boolean;
      }>;
    }>,
  ) => UploadSidecar;
  store?: UploadJobStore;
  links?: unknown[];
}): Promise<UploadJobService> {
  const stat = await fs.stat(MODEL_PATH);
  const models = options.hashes.map((hash) => ({
    hash,
    format: 'stl' as const,
    size: stat.size,
    locations: [
      {
        rootId: 'root',
        path: MODEL_PATH,
        rootRelative: 'package.json',
        size: stat.size,
        available: true,
      },
    ],
  }));
  const sidecar: UploadSidecar = options.sidecarFactory?.(models) ?? {
    listModels: vi.fn().mockResolvedValue(models),
    renderThumbnail: vi.fn(),
    getRemoteModelLink: vi.fn().mockResolvedValue(null),
    linkRemoteModel: (link) => {
      options.links?.push(link);
      return Promise.resolve(link);
    },
  };
  const fileSystem = memoryFileSystem();
  const service = new UploadJobService({
    store:
      options.store ?? new UploadJobStore({ userDataPath: 'data', fileSystem }),
    sidecar,
    profiles: options.profiles ?? {
      list: vi.fn().mockResolvedValue({
        profiles: [options.profile ?? PROFILE],
        selectedProfileId: PROFILE.id,
      }),
      getAuthenticatedContext: vi.fn().mockImplementation(() =>
        Promise.resolve({
          profile: options.profile ?? PROFILE,
          token: 'jwt-test-value',
          revision: 'revision-1',
          generation: 1,
          endpoint: (relativePath: string) =>
            new URL(relativePath, 'https://farm.example/'),
        }),
      ),
      revalidateAuthenticatedContext: vi.fn().mockResolvedValue(undefined),
      invalidateRejectedContext: vi.fn().mockResolvedValue(true),
    },
    approvals: {
      authorizeFile: vi
        .fn()
        .mockImplementation((sourcePath: string) =>
          Promise.resolve({ sourcePath, canonicalPath: sourcePath }),
        ),
    },
    snapshots: {
      create: vi.fn().mockImplementation((sourcePath: string) =>
        Promise.resolve({
          path: sourcePath,
          size: stat.size,
          cleanup: () => Promise.resolve(),
        }),
      ),
    },
    transport: options.transport,
    ...(options.concurrency !== undefined
      ? { concurrency: options.concurrency }
      : {}),
    createId: uuidFactory(),
    now: () => Date.parse('2026-07-23T20:00:00.000Z'),
  });
  await service.initialize();
  return service;
}

function remote(clientUploadId: string, name: string, size: number) {
  return {
    id: `remote-${clientUploadId}`,
    name,
    fileName: name,
    fileSize: size,
    fileType: 'stl',
    uploadedAt: '2026-07-23T20:00:00.000Z',
    url: '/models/1',
    thumbnailUrl: null,
    wasExisting: false,
    clientUploadId,
    etag: '"etag"',
  };
}

function authContext(token: string) {
  return {
    profile: PROFILE,
    token,
    revision: 'revision-1',
    generation: 1,
    endpoint: (relativePath: string) =>
      new URL(relativePath, 'https://farm.example/prefix/'),
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  condition: (value: T) => boolean,
): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (condition(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error('condition not reached');
}

async function expectEventuallyRejected(
  read: () => Promise<unknown>,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await read();
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expected operation to reject');
}
