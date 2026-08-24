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
  type UploadRootApprovals,
  type UploadSidecar,
} from '../src/main/uploadJobs.js';
import {
  ModelUploadError,
  scrubSensitiveText,
  type UploadTransport,
} from '../src/main/uploadTransport.js';
import { ServerProfileError } from '../src/main/serverProfiles.js';
import { RootApprovalError } from '../src/main/rootApprovals.js';
import {
  SnapshotError,
  type SnapshotManager,
} from '../src/main/uploadSnapshot.js';

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
      error: { retryable: false, duplicateRisk: true },
    });
  });

  it('does not reflag an already-succeeded legacy-unbound upload as duplicate risk on restart', async () => {
    const now = Date.parse('2026-07-23T20:00:00.000Z');
    const legacyJob = {
      id: '00000000-0000-4000-8000-000000000010',
      profileId: '00000000-0000-4000-8000-000000000011',
      profileName: 'Farm',
      // No profileRevision/serverBinding: pre-migration data defaults both
      // to the 'legacy-unbound' placeholder.
      mode: 'legacyModelOnly',
      state: 'partialFailure',
      paused: false,
      createdAt: '2026-07-23T18:00:00.000Z',
      updatedAt: '2026-07-23T18:00:00.000Z',
      items: [
        {
          id: '00000000-0000-4000-8000-000000000012',
          hash: 'a'.repeat(64),
          clientUploadId: '00000000-0000-4000-8000-000000000013',
          displayName: 'succeeded.stl',
          size: 4,
          state: 'succeeded',
          bytesSent: 4,
          attempts: 1,
          createdAt: '2026-07-23T18:00:00.000Z',
          updatedAt: '2026-07-23T18:00:00.000Z',
          remote: {
            id: 'remote-1',
            name: 'succeeded.stl',
            fileName: 'succeeded.stl',
            fileSize: 4,
            fileType: 'stl',
            uploadedAt: '2026-07-23T18:00:00.000Z',
            url: '/models/1',
            thumbnailUrl: null,
            wasExisting: false,
            clientUploadId: '00000000-0000-4000-8000-000000000013',
            etag: '"etag"',
          },
          error: null,
        },
        {
          id: '00000000-0000-4000-8000-000000000014',
          hash: 'b'.repeat(64),
          clientUploadId: '00000000-0000-4000-8000-000000000015',
          displayName: 'pending.stl',
          size: 4,
          state: 'queued',
          bytesSent: 0,
          attempts: 0,
          createdAt: '2026-07-23T18:00:00.000Z',
          updatedAt: '2026-07-23T18:00:00.000Z',
          remote: null,
          error: null,
        },
      ],
      totalBytes: 8,
      bytesSent: 4,
      summary: {
        queued: 1,
        uploading: 0,
        succeeded: 1,
        failed: 0,
        cancelled: 0,
        uncertain: 0,
      },
    };
    const fileSystem = memoryFileSystem(
      JSON.stringify({ version: 1, jobs: [legacyJob] }),
    );
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem,
      now: () => now,
    });
    const jobs = await store.load();
    expect(jobs[0]?.items[0]).toMatchObject({
      state: 'succeeded',
      error: null,
    });
    expect(jobs[0]?.items[1]).toMatchObject({
      state: 'uncertain',
      error: { code: 'UNBOUND_UPLOAD_IDENTITY', duplicateRisk: true },
    });

    // A second restart must not disturb the already-succeeded item either.
    const jobsAgain = await store.load();
    expect(jobsAgain[0]?.items[0]).toMatchObject({
      state: 'succeeded',
      error: null,
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

  it('confirming a legacy-unbound retry adopts the current server binding instead of self-cancelling', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const jobId = '00000000-0000-4000-8000-000000000020';
    const itemId = '00000000-0000-4000-8000-000000000021';
    const clientUploadId = '00000000-0000-4000-8000-000000000022';
    const fileSystem = memoryFileSystem(
      JSON.stringify({
        version: 2,
        jobs: [
          {
            id: jobId,
            profileId: PROFILE.id,
            profileName: PROFILE.displayName,
            profileRevision: 'legacy-unbound',
            serverBinding: 'legacy-unbound',
            mode: 'legacyModelOnly',
            state: 'attention',
            paused: false,
            createdAt: '2026-07-23T18:00:00.000Z',
            updatedAt: '2026-07-23T18:00:00.000Z',
            items: [
              {
                id: itemId,
                hash,
                clientUploadId,
                displayName: 'part.stl',
                size: bytes.length,
                state: 'uncertain',
                bytesSent: 0,
                attempts: 1,
                createdAt: '2026-07-23T18:00:00.000Z',
                updatedAt: '2026-07-23T18:00:00.000Z',
                remote: null,
                error: {
                  code: 'UNBOUND_UPLOAD_IDENTITY',
                  message:
                    'This pre-migration upload identity is not bound to a verified server. Resolve the duplicate risk explicitly.',
                  retryable: false,
                  retryAfterSeconds: null,
                  duplicateRisk: true,
                },
              },
            ],
            totalBytes: bytes.length,
            bytesSent: 0,
            summary: {
              queued: 0,
              uploading: 0,
              succeeded: 0,
              failed: 0,
              cancelled: 0,
              uncertain: 1,
            },
          },
        ],
        identities: [
          {
            profileId: PROFILE.id,
            serverBinding: 'legacy-unbound',
            hash,
            clientUploadId,
            remoteModelId: null,
            etag: null,
            updatedAt: '2026-07-23T18:00:00.000Z',
          },
        ],
      }),
    );
    const store = new UploadJobStore({ userDataPath: 'data', fileSystem });
    const service = await serviceFixture({
      hashes: [hash],
      profile: profile('legacyModelOnly'),
      transport: (request) =>
        Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        ),
      store,
    });

    const confirmed = await service.confirmLegacyRetry(jobId);
    expect(confirmed.serverBinding).toBe('binding-1');
    expect(confirmed.items[0]?.state).toBe('queued');

    const jobs = await waitFor(
      () => service.list(),
      (value) => value[0]?.items[0]?.state === 'succeeded',
    );
    expect(jobs[0]?.serverBinding).toBe('binding-1');
    expect(jobs[0]?.items[0]?.error).toBeNull();
    expect(jobs[0]?.items[0]?.clientUploadId).toBe(clientUploadId);
  });

  it('confirming a recovered mixed legacy-unbound job rebinds succeeded identities without reflagging them', async () => {
    const now = Date.parse('2026-07-23T20:00:00.000Z');
    const succeededHash = 'a'.repeat(64);
    const retryHash = 'b'.repeat(64);
    const jobId = '00000000-0000-4000-8000-000000000030';
    const succeededClientUploadId = '00000000-0000-4000-8000-000000000031';
    const retryClientUploadId = '00000000-0000-4000-8000-000000000032';
    const fileSystem = memoryFileSystem(
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: jobId,
            profileId: PROFILE.id,
            profileName: PROFILE.displayName,
            mode: 'legacyModelOnly',
            state: 'partialFailure',
            paused: false,
            createdAt: '2026-07-23T18:00:00.000Z',
            updatedAt: '2026-07-23T18:00:00.000Z',
            items: [
              {
                id: '00000000-0000-4000-8000-000000000033',
                hash: succeededHash,
                clientUploadId: succeededClientUploadId,
                displayName: 'succeeded.stl',
                size: 4,
                state: 'succeeded',
                bytesSent: 4,
                attempts: 1,
                createdAt: '2026-07-23T18:00:00.000Z',
                updatedAt: '2026-07-23T18:00:00.000Z',
                remote: {
                  id: 'remote-succeeded',
                  name: 'succeeded.stl',
                  fileName: 'succeeded.stl',
                  fileSize: 4,
                  fileType: 'stl',
                  uploadedAt: '2026-07-23T18:00:00.000Z',
                  url: '/models/1',
                  thumbnailUrl: null,
                  wasExisting: false,
                  clientUploadId: succeededClientUploadId,
                  etag: '"etag-succeeded"',
                },
                error: null,
              },
              {
                id: '00000000-0000-4000-8000-000000000034',
                hash: retryHash,
                clientUploadId: retryClientUploadId,
                displayName: 'retry.stl',
                size: 4,
                state: 'queued',
                bytesSent: 0,
                attempts: 0,
                createdAt: '2026-07-23T18:00:00.000Z',
                updatedAt: '2026-07-23T18:00:00.000Z',
                remote: null,
                error: null,
              },
            ],
            totalBytes: 8,
            bytesSent: 4,
            summary: {
              queued: 1,
              uploading: 0,
              succeeded: 1,
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
    const service = await serviceFixture({
      hashes: [succeededHash, retryHash],
      profile: profile('legacyModelOnly'),
      transport: (request) =>
        Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        ),
      store,
    });

    const recovered = (await service.list())[0]!;
    expect(recovered.items[0]).toMatchObject({
      state: 'succeeded',
      clientUploadId: succeededClientUploadId,
      error: null,
    });
    expect(recovered.items[1]).toMatchObject({
      state: 'uncertain',
      error: { code: 'UNBOUND_UPLOAD_IDENTITY', duplicateRisk: true },
    });

    const confirmed = await service.confirmLegacyRetry(jobId);
    expect(confirmed.serverBinding).toBe('binding-1');
    expect(confirmed.items[0]).toMatchObject({
      state: 'succeeded',
      clientUploadId: succeededClientUploadId,
      error: null,
    });
    expect(confirmed.items[1]).toMatchObject({
      state: 'queued',
      clientUploadId: retryClientUploadId,
      error: null,
    });

    const persisted = await store.loadState();
    expect(
      persisted.identities.filter(
        (identity) =>
          identity.profileId === PROFILE.id &&
          identity.serverBinding === 'binding-1',
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          hash: succeededHash,
          clientUploadId: succeededClientUploadId,
          remoteModelId: 'remote-succeeded',
          etag: '"etag-succeeded"',
        }),
        expect.objectContaining({
          hash: retryHash,
          clientUploadId: retryClientUploadId,
        }),
      ]),
    );

    const jobs = await waitFor(
      () => service.list(),
      (value) => value[0]?.summary.succeeded === 2,
    );
    expect(jobs[0]?.items[0]).toMatchObject({
      state: 'succeeded',
      clientUploadId: succeededClientUploadId,
      error: null,
    });
    expect(jobs[0]?.items[1]).toMatchObject({
      state: 'succeeded',
      error: null,
    });
  });

  it('confirming a legacy-unbound retry adopts the current profile mode before rerunning', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const jobId = '00000000-0000-4000-8000-000000000040';
    const clientUploadId = '00000000-0000-4000-8000-000000000041';
    const modernProfile = profile('modern');
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem: memoryFileSystem(
        JSON.stringify({
          version: 2,
          jobs: [
            {
              id: jobId,
              profileId: PROFILE.id,
              profileName: PROFILE.displayName,
              profileRevision: 'legacy-unbound',
              serverBinding: 'legacy-unbound',
              mode: 'legacyModelOnly',
              state: 'attention',
              paused: false,
              createdAt: '2026-07-23T18:00:00.000Z',
              updatedAt: '2026-07-23T18:00:00.000Z',
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000042',
                  hash,
                  clientUploadId,
                  displayName: 'part.stl',
                  size: bytes.length,
                  state: 'uncertain',
                  bytesSent: 0,
                  attempts: 1,
                  createdAt: '2026-07-23T18:00:00.000Z',
                  updatedAt: '2026-07-23T18:00:00.000Z',
                  remote: null,
                  error: {
                    code: 'UNBOUND_UPLOAD_IDENTITY',
                    message:
                      'This pre-migration upload identity is not bound to a verified server. Resolve the duplicate risk explicitly.',
                    retryable: false,
                    retryAfterSeconds: null,
                    duplicateRisk: true,
                  },
                },
              ],
              totalBytes: bytes.length,
              bytesSent: 0,
              summary: {
                queued: 0,
                uploading: 0,
                succeeded: 0,
                failed: 0,
                cancelled: 0,
                uncertain: 1,
              },
            },
          ],
          identities: [
            {
              profileId: PROFILE.id,
              serverBinding: 'legacy-unbound',
              hash,
              clientUploadId,
              remoteModelId: null,
              etag: null,
              updatedAt: '2026-07-23T18:00:00.000Z',
            },
          ],
        }),
      ),
    });
    const transportModes: string[] = [];
    const profiles: UploadProfileService = {
      list: () =>
        Promise.resolve({
          profiles: [modernProfile],
          selectedProfileId: PROFILE.id,
        }),
      getAuthenticatedContext: () =>
        Promise.resolve({
          ...authContext('jwt-modern'),
          profile: modernProfile,
          revision: 'revision-2',
          serverBinding: 'binding-1',
        }),
      revalidateAuthenticatedContext: () => Promise.resolve(),
      invalidateRejectedContext: () => Promise.resolve(true),
    };
    const service = await serviceFixture({
      hashes: [hash],
      profiles,
      transport: (request) => {
        transportModes.push(request.mode);
        return Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        );
      },
      store,
    });

    const confirmed = await service.confirmLegacyRetry(jobId);
    expect(confirmed.mode).toBe('modern');
    expect(confirmed.profileRevision).toBe('revision-2');
    expect(confirmed.serverBinding).toBe('binding-1');

    const jobs = await waitFor(
      () => service.list(),
      (value) => value[0]?.items[0]?.state === 'succeeded',
    );
    expect(transportModes).toEqual(['modern']);
    expect(jobs[0]).toMatchObject({
      mode: 'modern',
      profileRevision: 'revision-2',
      serverBinding: 'binding-1',
      state: 'completed',
    });
    expect(jobs[0]?.items[0]).toMatchObject({
      state: 'succeeded',
      error: null,
    });
  });

  it('rejects a second concurrent legacy retry confirmation without corrupting the job', async () => {
    const bytes = await fs.readFile(MODEL_PATH);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const jobId = '00000000-0000-4000-8000-000000000050';
    const clientUploadId = '00000000-0000-4000-8000-000000000051';
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem: memoryFileSystem(
        JSON.stringify({
          version: 2,
          jobs: [
            {
              id: jobId,
              profileId: PROFILE.id,
              profileName: PROFILE.displayName,
              profileRevision: 'legacy-unbound',
              serverBinding: 'legacy-unbound',
              mode: 'legacyModelOnly',
              state: 'attention',
              paused: false,
              createdAt: '2026-07-23T18:00:00.000Z',
              updatedAt: '2026-07-23T18:00:00.000Z',
              items: [
                {
                  id: '00000000-0000-4000-8000-000000000052',
                  hash,
                  clientUploadId,
                  displayName: 'part.stl',
                  size: bytes.length,
                  state: 'uncertain',
                  bytesSent: 0,
                  attempts: 1,
                  createdAt: '2026-07-23T18:00:00.000Z',
                  updatedAt: '2026-07-23T18:00:00.000Z',
                  remote: null,
                  error: {
                    code: 'UNBOUND_UPLOAD_IDENTITY',
                    message:
                      'This pre-migration upload identity is not bound to a verified server. Resolve the duplicate risk explicitly.',
                    retryable: false,
                    retryAfterSeconds: null,
                    duplicateRisk: true,
                  },
                },
              ],
              totalBytes: bytes.length,
              bytesSent: 0,
              summary: {
                queued: 0,
                uploading: 0,
                succeeded: 0,
                failed: 0,
                cancelled: 0,
                uncertain: 1,
              },
            },
          ],
          identities: [
            {
              profileId: PROFILE.id,
              serverBinding: 'legacy-unbound',
              hash,
              clientUploadId,
              remoteModelId: null,
              etag: null,
              updatedAt: '2026-07-23T18:00:00.000Z',
            },
          ],
        }),
      ),
    });
    const service = await serviceFixture({
      hashes: [hash],
      profile: profile('legacyModelOnly'),
      transport: (request) =>
        Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        ),
      store,
    });

    const results = await Promise.allSettled([
      service.confirmLegacyRetry(jobId),
      service.confirmLegacyRetry(jobId),
    ]);
    const fulfilled = results.filter((result) => result.status === 'fulfilled');
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toBeDefined();
    expect(rejected?.reason).toBeInstanceOf(Error);
    expect(String(rejected?.reason)).toMatch(/no legacy-risk retry/i);

    const jobs = await waitFor(
      () => service.list(),
      (value) => value[0]?.items[0]?.state === 'succeeded',
    );
    expect(jobs[0]).toMatchObject({
      serverBinding: 'binding-1',
      state: 'completed',
    });
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

  it('preserves modern ambiguous identity across deliberate queue reset', async () => {
    const hash = 'c'.repeat(64);
    const ids: string[] = [];
    let first = true;
    const service = await serviceFixture({
      hashes: [hash],
      transport: (request) => {
        ids.push(request.clientUploadId);
        if (first) {
          first = false;
          return Promise.reject(
            new ModelUploadError(
              {
                code: 'TRANSPORT_ERROR',
                message: 'connection lost',
                retryable: true,
                retryAfterSeconds: null,
                duplicateRisk: false,
              },
              'modelStreaming',
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
      (jobs) => jobs[0]?.items[0]?.state === 'failed',
    );
    await service.reset();
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.state === 'completed',
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

  it('keeps legacy duplicate risk when remote-link persistence fails after upload', async () => {
    const hash = '5'.repeat(64);
    const service = await serviceFixture({
      hashes: [hash],
      profile: profile('legacyModelOnly'),
      sidecarFactory: (models) => ({
        listModels: () => Promise.resolve(models),
        renderThumbnail: () => Promise.resolve(null),
        getRemoteModelLink: () => Promise.resolve(null),
        removeRemoteModelLink: () => Promise.resolve(false),
        purgeRemoteModelLinks: () => Promise.resolve(0),
        linkRemoteModel: () => Promise.reject(new Error('disk unavailable')),
      }),
      transport: (request) =>
        Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        ),
    });
    const job = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    const jobs = await waitFor(
      () => service.list(),
      (value) => value[0]?.items[0]?.state === 'uncertain',
    );
    expect(jobs[0]?.items[0]?.error).toMatchObject({
      retryable: false,
      duplicateRisk: true,
    });
    await expect(service.retry(job.id)).rejects.toThrow(/no safely retryable/i);
  });

  it.each([
    {
      code: 'PAYLOAD_TOO_LARGE',
      retryable: false,
      expectedState: 'failed',
      duplicateRisk: false,
    },
    {
      code: 'SERVER_ERROR',
      retryable: true,
      expectedState: 'uncertain',
      duplicateRisk: true,
    },
  ] as const)(
    'classifies legacy $code without treating every response as ambiguous',
    async ({ code, retryable, expectedState, duplicateRisk }) => {
      const hash = code === 'SERVER_ERROR' ? '1'.repeat(64) : '0'.repeat(64);
      const service = await serviceFixture({
        hashes: [hash],
        profile: profile('legacyModelOnly'),
        transport: () =>
          Promise.reject(
            new ModelUploadError(
              {
                code,
                message: 'fixed response message',
                retryable,
                retryAfterSeconds: null,
                duplicateRisk: false,
              },
              'responseReceived',
            ),
          ),
      });
      await service.start({ profileId: PROFILE.id, hashes: [hash] });
      const jobs = await waitFor(
        () => service.list(),
        (value) => value[0]?.items[0]?.state === expectedState,
      );
      expect(jobs[0]?.items[0]?.error?.duplicateRisk).toBe(duplicateRisk);
    },
  );

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
    expect(tokens).toEqual(['token-3', 'token-4']);
    expect(new Set(uploadIds).size).toBe(1);
    expect(invalidations).toBe(1);
  });

  it('lets parallel stale-token uploads share one conditional refresh', async () => {
    const hashes = ['6'.repeat(64), '7'.repeat(64)];
    const bothStale = deferred<void>();
    let staleAttempts = 0;
    let invalidations = 0;
    let fresh = false;
    const profiles: UploadProfileService = {
      list: () =>
        Promise.resolve({ profiles: [PROFILE], selectedProfileId: PROFILE.id }),
      getAuthenticatedContext: () =>
        Promise.resolve(authContext(fresh ? 'fresh-token' : 'stale-token')),
      revalidateAuthenticatedContext: () => Promise.resolve(),
      invalidateRejectedContext: () => {
        if (fresh) return Promise.resolve(false);
        fresh = true;
        invalidations += 1;
        return Promise.resolve(true);
      },
    };
    const service = await serviceFixture({
      hashes,
      profiles,
      concurrency: 2,
      transport: async (request) => {
        if (request.token === 'stale-token') {
          staleAttempts += 1;
          if (staleAttempts === 2) bothStale.resolve(undefined);
          await bothStale.promise;
          throw new ModelUploadError(
            {
              code: 'UNAUTHENTICATED',
              message: 'rejected',
              retryable: true,
              retryAfterSeconds: null,
              duplicateRisk: false,
            },
            'responseReceived',
          );
        }
        return remote(
          request.clientUploadId,
          request.displayName,
          request.modelSize,
        );
      },
    });
    await service.start({ profileId: PROFILE.id, hashes });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.summary.succeeded === 2,
    );
    expect(staleAttempts).toBe(2);
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
    await expect(
      service.start({ profileId: PROFILE.id, hashes: [hash] }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_SUPERSEDED' });
    expect(sends).toBe(0);
    expect(await service.list()).toEqual([]);
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
        removeRemoteModelLink: () => Promise.resolve(false),
        purgeRemoteModelLinks: () => Promise.resolve(0),
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

  it('does not let a pending remote link suppress an upload', async () => {
    const hash = '9'.repeat(64);
    let removed = 0;
    let sends = 0;
    const service = await serviceFixture({
      hashes: [hash],
      sidecarFactory: (models) => ({
        listModels: () => Promise.resolve(models),
        renderThumbnail: () => Promise.resolve(null),
        getRemoteModelLink: () =>
          Promise.resolve({
            profileId: PROFILE.id,
            serverBinding: 'binding-1',
            localModelHash: hash,
            remoteModelId: 'pending-remote',
            clientUploadId: '99999999-9999-4999-8999-999999999999',
            uploadStatus: 'pending',
            etag: null,
            uploadedAt: null,
          }),
        removeRemoteModelLink: () => {
          removed += 1;
          return Promise.resolve(true);
        },
        purgeRemoteModelLinks: () => Promise.resolve(0),
        linkRemoteModel: (link) => Promise.resolve(link),
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
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.state === 'completed',
    );
    expect(removed).toBeGreaterThan(0);
    expect(sends).toBe(1);
  });

  it('aborts old-binding jobs and purges links when the profile endpoint changes', async () => {
    const hash = '8'.repeat(64);
    const listeners: {
      binding?: (
        profileId: string,
        previousBinding: string,
      ) => Promise<void> | void;
    } = {};
    let purges = 0;
    let entered = false;
    const profiles: UploadProfileService = {
      list: () =>
        Promise.resolve({ profiles: [PROFILE], selectedProfileId: PROFILE.id }),
      getAuthenticatedContext: () => Promise.resolve(authContext('token')),
      revalidateAuthenticatedContext: () => Promise.resolve(),
      invalidateRejectedContext: () => Promise.resolve(true),
      onProfileBindingChanged: (callback) => {
        listeners.binding = callback;
        return () => {
          delete listeners.binding;
        };
      },
    };
    const service = await serviceFixture({
      hashes: [hash],
      profiles,
      sidecarFactory: (models) => ({
        listModels: () => Promise.resolve(models),
        renderThumbnail: () => Promise.resolve(null),
        getRemoteModelLink: () => Promise.resolve(null),
        removeRemoteModelLink: () => Promise.resolve(false),
        purgeRemoteModelLinks: () => {
          purges += 1;
          return Promise.resolve(0);
        },
        linkRemoteModel: (link) => Promise.resolve(link),
      }),
      transport: (request) =>
        new Promise((_resolve, reject) => {
          entered = true;
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
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      () => entered,
    );
    const bindingListener = listeners.binding;
    if (!bindingListener)
      throw new Error('profile listener was not registered');
    await bindingListener(PROFILE.id, 'binding-1');
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.items[0]?.state === 'cancelled',
    );
    expect(purges).toBe(1);
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

  it('lets a concurrent pause win before the atomic scheduler claim', async () => {
    const hash = 'd'.repeat(64);
    const claim = deferred<void>();
    let claimEntered = false;
    let sends = 0;
    const service = await serviceFixture({
      hashes: [hash],
      beforeClaim: () => {
        claimEntered = true;
        return claim.promise;
      },
      transport: () => {
        sends += 1;
        return Promise.reject(new Error('must not send'));
      },
    });
    const job = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    await waitFor(
      () => service.list(),
      () => claimEntered,
    );
    await service.pause(job.id);
    claim.resolve(undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(0);
    expect((await service.list())[0]).toMatchObject({
      paused: true,
      items: [{ state: 'queued' }],
    });
  });

  it('generation-fences reset from late progress and completion callbacks', async () => {
    const hash = 'e'.repeat(64);
    const callbacks: {
      progress?: (bytesSent: number) => void | Promise<void>;
    } = {};
    let entered = false;
    const service = await serviceFixture({
      hashes: [hash],
      transport: (request) =>
        new Promise((_resolve, reject) => {
          entered = true;
          callbacks.progress = (bytesSent) => request.onProgress(bytesSent);
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
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      () => entered,
    );
    await service.reset();
    await callbacks.progress?.(50);
    expect(await service.list()).toEqual([]);
  });

  it('generation-fences reset against a late initialization failure', async () => {
    const hash = '4'.repeat(64);
    const store = new UploadJobStore({
      userDataPath: 'data',
      fileSystem: memoryFileSystem(),
    });
    const loading = deferred<{
      jobs: [];
      identities: [];
    }>();
    vi.spyOn(store, 'loadState').mockReturnValueOnce(loading.promise);
    const service = await serviceFixture({
      hashes: [hash],
      store,
      initialize: false,
      transport: () => Promise.reject(new Error('must not send')),
    });
    const initialization = service.initialize();
    const reset = service.reset();
    await new Promise((resolve) => setImmediate(resolve));
    loading.reject(new Error('late corrupt store'));
    await expect(initialization).resolves.toBeUndefined();
    await expect(reset).resolves.toMatchObject({ reset: true });
    expect(await service.list()).toEqual([]);
  });

  it('prevents pre-reset start preparation from committing after reset', async () => {
    const hash = 'b'.repeat(64);
    const authentication = deferred<ReturnType<typeof authContext>>();
    let authRequested = false;
    const profiles: UploadProfileService = {
      list: () =>
        Promise.resolve({ profiles: [PROFILE], selectedProfileId: PROFILE.id }),
      getAuthenticatedContext: () => {
        authRequested = true;
        return authentication.promise;
      },
      revalidateAuthenticatedContext: () => Promise.resolve(),
      invalidateRejectedContext: () => Promise.resolve(true),
    };
    const service = await serviceFixture({
      hashes: [hash],
      profiles,
      transport: () => Promise.reject(new Error('must not send')),
    });
    const start = service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      () => authRequested,
    );
    await service.reset();
    authentication.resolve(authContext('token'));
    await expect(start).rejects.toBeInstanceOf(Error);
    expect(await service.list()).toEqual([]);
  });

  it('does not let a late progress callback resurrect a removed job', async () => {
    const hash = '3'.repeat(64);
    const callbacks: {
      progress?: (bytesSent: number) => void | Promise<void>;
    } = {};
    const service = await serviceFixture({
      hashes: [hash],
      transport: (request) => {
        callbacks.progress = (bytesSent) => request.onProgress(bytesSent);
        return Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        );
      },
    });
    const job = await service.start({
      profileId: PROFILE.id,
      hashes: [hash],
    });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.state === 'completed',
    );
    await service.remove(job.id);
    const lateProgress = callbacks.progress;
    if (!lateProgress) throw new Error('progress callback not captured');
    await expect(Promise.resolve(lateProgress(10))).rejects.toThrow(
      /upload job not found/i,
    );
    expect(await service.list()).toEqual([]);
  });

  it('skips an unapproved duplicate and opens the next approved location', async () => {
    const hash = 'f'.repeat(64);
    const stat = await fs.stat(MODEL_PATH);
    const attempted: string[] = [];
    const service = await serviceFixture({
      hashes: [hash],
      locations: [
        {
          rootId: 'unapproved',
          path: path.resolve('unapproved-copy.stl'),
          rootRelative: 'copy.stl',
          size: stat.size,
          available: true,
        },
        {
          rootId: 'approved',
          path: MODEL_PATH,
          rootRelative: 'package.json',
          size: stat.size,
          available: true,
        },
      ],
      approvals: {
        openApprovedFile: async (sourcePath) => {
          attempted.push(sourcePath);
          if (sourcePath !== MODEL_PATH) {
            throw new RootApprovalError('APPROVAL_REQUIRED', 'not approved');
          }
          const handle = await fs.open(sourcePath, 'r');
          const opened = await handle.stat();
          return {
            handle,
            canonicalPath: sourcePath,
            size: opened.size,
          };
        },
      },
      transport: (request) =>
        Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        ),
    });
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.state === 'completed',
    );
    expect(attempted).toEqual([
      path.resolve('unapproved-copy.stl'),
      MODEL_PATH,
    ]);
  });

  it('falls back after a stale approved copy fails snapshot hashing', async () => {
    const hash = '2'.repeat(64);
    const stat = await fs.stat(MODEL_PATH);
    let snapshotAttempts = 0;
    const service = await serviceFixture({
      hashes: [hash],
      locations: [
        {
          rootId: 'stale',
          path: 'stale-copy',
          rootRelative: 'stale.stl',
          size: stat.size,
          available: true,
        },
        {
          rootId: 'valid',
          path: 'valid-copy',
          rootRelative: 'valid.stl',
          size: stat.size,
          available: true,
        },
      ],
      approvals: {
        openApprovedFile: async (sourcePath) => {
          const handle = await fs.open(MODEL_PATH, 'r');
          return { handle, canonicalPath: sourcePath, size: stat.size };
        },
      },
      snapshots: {
        create: async (approved) => {
          snapshotAttempts += 1;
          await approved.handle.close();
          if (approved.canonicalPath === 'stale-copy') {
            throw new SnapshotError('SOURCE_CHANGED', 'stale catalog copy');
          }
          return {
            path: MODEL_PATH,
            size: stat.size,
            cleanup: () => Promise.resolve(),
          };
        },
      },
      transport: (request) =>
        Promise.resolve(
          remote(
            request.clientUploadId,
            request.displayName,
            request.modelSize,
          ),
        ),
    });
    await service.start({ profileId: PROFILE.id, hashes: [hash] });
    await waitFor(
      () => service.list(),
      (jobs) => jobs[0]?.state === 'completed',
    );
    expect(snapshotAttempts).toBe(2);
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
  beforeClaim?: () => Promise<void>;
  initialize?: boolean;
  approvals?: UploadRootApprovals;
  snapshots?: SnapshotManager;
  locations?: Array<{
    rootId: string;
    path: string;
    rootRelative: string;
    size: number;
    available: boolean;
  }>;
  links?: unknown[];
}): Promise<UploadJobService> {
  const stat = await fs.stat(MODEL_PATH);
  const models = options.hashes.map((hash) => ({
    hash,
    format: 'stl' as const,
    size: stat.size,
    locations: options.locations ?? [
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
    removeRemoteModelLink: vi.fn().mockResolvedValue(false),
    purgeRemoteModelLinks: vi.fn().mockResolvedValue(0),
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
          serverBinding: 'binding-1',
          principalId: '00000000-0000-4000-8000-0000000000aa',
          endpoint: (relativePath: string) =>
            new URL(relativePath, 'https://farm.example/'),
        }),
      ),
      revalidateAuthenticatedContext: vi.fn().mockResolvedValue(undefined),
      invalidateRejectedContext: vi.fn().mockResolvedValue(true),
    },
    approvals: options.approvals ?? {
      openApprovedFile: vi
        .fn()
        .mockImplementation(async (sourcePath: string) => {
          const handle = await fs.open(sourcePath, 'r');
          const opened = await handle.stat();
          return {
            handle,
            canonicalPath: sourcePath,
            size: opened.size,
          };
        }),
    },
    snapshots: options.snapshots ?? {
      create: vi
        .fn()
        .mockImplementation(
          async (approved: { handle: { close(): Promise<void> } }) => {
            await approved.handle.close();
            return {
              path: MODEL_PATH,
              size: stat.size,
              cleanup: () => Promise.resolve(),
            };
          },
        ),
    },
    transport: options.transport,
    ...(options.concurrency !== undefined
      ? { concurrency: options.concurrency }
      : {}),
    ...(options.beforeClaim ? { beforeClaim: options.beforeClaim } : {}),
    createId: uuidFactory(),
    now: () => Date.parse('2026-07-23T20:00:00.000Z'),
  });
  if (options.initialize !== false) await service.initialize();
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
    serverBinding: 'binding-1',
    principalId: '00000000-0000-4000-8000-0000000000aa',
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: Error) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: Error) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
}
