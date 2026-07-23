/* eslint-disable @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument */
import { describe, expect, it, vi } from 'vitest';
import type { ServerProfile } from '@shared/ipc';
import {
  PrintFarmerSyncEngine,
  SyncEngineError,
  type SyncRemote,
  type SyncSidecar,
} from '../src/main/syncEngine.js';
import { SyncHttpError } from '../src/main/syncHttp.js';
import type {
  SidecarApplyPullBatch,
  SidecarClaimedOutboundBatch,
  SidecarEntityRevision,
  SidecarOutboundOperation,
  SidecarSyncStatus,
} from '../src/main/sidecar.js';

const NOW = Date.parse('2026-07-23T12:00:00.000Z');
const PROFILE_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_PROFILE_ID = '22222222-2222-4222-8222-222222222222';
const REMOTE_COLLECTION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE_MEMBERSHIP_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOTE_MODEL_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('PrintFarmerSyncEngine pull', () => {
  it('commits multipage opaque cursors with materialized membership snapshots', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    remote.getChanges
      .mockResolvedValueOnce(
        page(
          [
            change(1, 'ModelCollection', 'remote-collection'),
            change(2, 'ModelCollectionMembership', 'remote-membership'),
          ],
          'opaque+cursor=1',
          true,
          2,
        ),
      )
      .mockResolvedValueOnce(
        page([change(3, 'Tag', 'remote-tag')], null, false, 3),
      );
    remote.getCollection.mockResolvedValue(collection('remote-collection', 1));
    remote.getCollections.mockResolvedValue([
      collection('remote-collection', 1),
    ]);
    remote.getCollectionMembers.mockResolvedValue([
      membership('remote-membership', 'remote-collection', 'remote-model', 2),
    ]);
    remote.getTag.mockResolvedValue(tag('remote-tag', 3));

    const engine = createEngine(sidecar.api, remote.api);
    const status = await engine.syncNow(PROFILE_ID);

    expect(status).toMatchObject({
      phase: 'succeeded',
      pulledChanges: 3,
      cursor: 'cursor-3',
      serverRevision: 3,
    });
    expect(sidecar.pullBatches).toHaveLength(2);
    expect(sidecar.pullBatches[0]).toMatchObject({
      profileId: PROFILE_ID,
      expectedPreviousCursor: null,
      cursor: 'opaque+cursor=1',
      expectedCheckpointGeneration: 0,
    });
    expect(sidecar.pullBatches[1]).toMatchObject({
      expectedPreviousCursor: 'opaque+cursor=1',
      expectedCheckpointGeneration: 1,
      cursor: 'cursor-3',
    });
    expect(
      sidecar.pullBatches[0]!.entities.find(
        (entity) => entity.entityType === 'ModelCollectionMembership',
      ),
    ).toMatchObject({
      remoteId: 'remote-membership',
      tombstone: false,
      snapshot: {
        collectionId: 'remote-collection',
        modelId: 'remote-model',
      },
    });
  });

  it('turns permission loss into a mapped tombstone without rebinding names', async () => {
    const existing: SidecarEntityRevision = {
      profileId: PROFILE_ID,
      entityType: 'ModelCollection',
      localId: 'stable-local-id',
      remoteId: 'remote-collection',
      revision: 1,
      concurrencyToken: 'old-token',
      tombstone: false,
      visibility: 'Shared',
      snapshot: collection('remote-collection', 1),
      updatedAt: 1,
    };
    const sidecar = fakeSidecar([existing]);
    const remote = fakeRemote();
    remote.getChanges.mockResolvedValue(
      page(
        [
          {
            ...change(2, 'ModelCollection', 'remote-collection'),
            operation: 'Delete',
            visibility: 'Private',
          },
        ],
        null,
        false,
        2,
      ),
    );
    remote.getCollection.mockResolvedValue(null);

    await createEngine(sidecar.api, remote.api).syncNow(PROFILE_ID);

    expect(sidecar.pullBatches[0]!.entities[0]).toEqual({
      entityType: 'ModelCollection',
      localId: 'stable-local-id',
      remoteId: 'remote-collection',
      revision: 1,
      journalRevision: 2,
      concurrencyToken: null,
      tombstone: true,
      visibility: 'Private',
      snapshot: null,
    });
  });

  it('does not advance a cursor when the sidecar transaction fails', async () => {
    const sidecar = fakeSidecar();
    sidecar.api.applySyncPullBatch = vi.fn(() =>
      Promise.reject(new Error('atomic apply failed')),
    );
    const remote = fakeRemote();
    remote.getChanges.mockResolvedValue(
      page([change(1, 'Tag', 'tag-1')], 'next', true, 1),
    );
    remote.getTag.mockResolvedValue(tag('tag-1', 1));

    const status = await createEngine(sidecar.api, remote.api).syncNow(
      PROFILE_ID,
    );

    expect(status.phase).toBe('error');
    expect(remote.getChanges).toHaveBeenCalledOnce();
    expect((await sidecar.api.getSyncStatus(PROFILE_ID)).cursor).toBeNull();
  });

  it('retains an established cursor across a later empty poll', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    remote.getChanges
      .mockResolvedValueOnce(
        page([change(1, 'Tag', 'remote-tag')], 'cursor-1', false, 1),
      )
      .mockResolvedValueOnce(page([], null, false, 1));
    remote.getTag.mockResolvedValue(tag('remote-tag', 1));
    const engine = createEngine(sidecar.api, remote.api);

    await engine.syncNow(PROFILE_ID);
    await engine.syncNow(PROFILE_ID);

    expect(remote.getChanges.mock.calls[1]![2]).toBe('cursor-1');
    expect(sidecar.pullBatches[1]).toMatchObject({
      expectedPreviousCursor: 'cursor-1',
      cursor: 'cursor-1',
    });
  });

  it('leaves an unresolved update uncheckpointed for retry', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    remote.getChanges.mockResolvedValue(
      page(
        [change(2, 'ModelCollection', 'eventually-consistent')],
        'cursor-2',
        false,
        2,
      ),
    );
    remote.getCollection.mockResolvedValue(null);

    const status = await createEngine(sidecar.api, remote.api).syncNow(
      PROFILE_ID,
    );

    expect(status.phase).toBe('error');
    expect(sidecar.pullBatches).toHaveLength(0);
  });

  it('isolates checkpoints for concurrent profiles', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    remote.getChanges.mockImplementation((profileId: string) =>
      Promise.resolve(
        page([change(1, 'Tag', `tag-${profileId}`)], null, false, 1),
      ),
    );
    remote.getTag.mockImplementation(
      (_profileId: string, _baseUrl: string, id: string) =>
        Promise.resolve(tag(id, 1)),
    );
    const engine = createEngine(
      sidecar.api,
      remote.api,
      [profile(), profile(OTHER_PROFILE_ID)],
      2,
    );

    await Promise.all([
      engine.syncNow(PROFILE_ID),
      engine.syncNow(OTHER_PROFILE_ID),
    ]);

    expect(
      new Set(sidecar.pullBatches.map((batch) => batch.profileId)),
    ).toEqual(new Set([PROFILE_ID, OTHER_PROFILE_ID]));
    expect(sidecar.statuses.get(PROFILE_ID)?.checkpointGeneration).toBe(1);
    expect(sidecar.statuses.get(OTHER_PROFILE_ID)?.checkpointGeneration).toBe(
      1,
    );
  });

  it('ignores a cancelled stale network result', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    const gate = deferred<ReturnType<typeof page>>();
    remote.getChanges.mockReturnValue(gate.promise);
    const engine = createEngine(sidecar.api, remote.api);
    const running = engine.syncNow(PROFILE_ID);

    await vi.waitFor(() => expect(remote.getChanges).toHaveBeenCalledOnce());
    engine.cancelProfile(PROFILE_ID);
    gate.resolve(page([], null, false, 0));

    await expect(running).resolves.toMatchObject({ phase: 'cancelled' });
    expect(sidecar.api.applySyncPullBatch).not.toHaveBeenCalled();
  });

  it('rejects an old-server result after the profile binding changes', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    const gate = deferred<ReturnType<typeof page>>();
    remote.getChanges.mockReturnValue(gate.promise);
    let binding = 'binding-a';
    const profiles = {
      list: () =>
        Promise.resolve({
          profiles: [profile()],
          selectedProfileId: PROFILE_ID,
        }),
      getAuthenticatedContext: () =>
        Promise.resolve({
          baseUrl: profile().baseUrl,
          binding,
        }),
    };
    const engine = new PrintFarmerSyncEngine(
      profiles,
      sidecar.api,
      remote.api,
      {
        now: () => NOW,
      },
    );
    const running = engine.syncNow(PROFILE_ID);
    await vi.waitFor(() => expect(remote.getChanges).toHaveBeenCalledOnce());

    binding = 'binding-b';
    gate.resolve(page([], null, false, 0));
    const status = await running;

    expect(status.phase).toBe('cancelled');
    expect(sidecar.api.applySyncPullBatch).not.toHaveBeenCalled();
  });
});

describe('PrintFarmerSyncEngine push and recovery', () => {
  it('translates references to creates in the same flat server batch', async () => {
    const collectionCreate = {
      ...operation('create-collection', 0),
      operation: 'Create' as const,
      entityId: 'local-new',
      baseRevision: null,
      concurrencyToken: null,
      payload: {
        remoteId: REMOTE_COLLECTION_ID,
        name: 'New',
        description: null,
        isShared: false,
      },
    };
    const membershipCreate = {
      ...operation('create-member', 1),
      entityType: 'ModelCollectionMembership' as const,
      operation: 'Create' as const,
      entityId: 'local-membership',
      baseRevision: null,
      concurrencyToken: null,
      payload: {
        remoteId: REMOTE_MEMBERSHIP_ID,
        collectionId: 'local-new',
        modelHash: 'a'.repeat(64),
      },
    };
    const sidecar = fakeSidecar(
      [],
      batch([collectionCreate, membershipCreate]),
    );
    vi.mocked(sidecar.api.getRemoteModelLink).mockResolvedValue({
      profileId: PROFILE_ID,
      localModelHash: 'a'.repeat(64),
      remoteModelId: REMOTE_MODEL_ID,
      clientUploadId: 'upload',
      etag: null,
      uploadStatus: 'uploaded',
      createdAt: 1,
      updatedAt: 1,
      uploadedAt: 1,
    });
    const remote = fakeRemote();
    remote.apply.mockResolvedValue({
      kind: 'success',
      value: {
        serverRevision: 2,
        applied: [
          {
            entityType: 'ModelCollection',
            operation: 'Create',
            entityId: REMOTE_COLLECTION_ID,
            revision: 1,
            merged: false,
          },
          {
            entityType: 'ModelCollectionMembership',
            operation: 'Create',
            entityId: REMOTE_MEMBERSHIP_ID,
            revision: 2,
            merged: false,
          },
        ],
      },
    });

    await createEngine(sidecar.api, remote.api).syncNow(PROFILE_ID);

    expect(remote.apply.mock.calls[0]![2].operations[1]).toMatchObject({
      entityId: REMOTE_MEMBERSHIP_ID,
      collectionId: REMOTE_COLLECTION_ID,
      modelId: REMOTE_MODEL_ID,
    });
  });

  it('claims and settles one ordered logical batch exactly once', async () => {
    const claimed = batch([operation('op-1', 0), operation('op-2', 1)]);
    const sidecar = fakeSidecar([], claimed);
    const remote = fakeRemote();
    remote.apply.mockResolvedValue({
      kind: 'success',
      value: {
        serverRevision: 10,
        applied: [
          {
            entityType: 'ModelCollection',
            operation: 'Update',
            entityId: REMOTE_COLLECTION_ID,
            revision: 9,
            merged: false,
          },
          {
            entityType: 'ModelCollection',
            operation: 'Update',
            entityId: REMOTE_COLLECTION_ID,
            revision: 10,
            merged: false,
          },
        ],
      },
    });

    const status = await createEngine(sidecar.api, remote.api).syncNow(
      PROFILE_ID,
    );

    expect(status.pushedOperations).toBe(2);
    expect(remote.apply).toHaveBeenCalledOnce();
    expect(remote.apply.mock.calls[0]![2].operations[0]).toEqual({
      entityType: 'ModelCollection',
      operation: 'Update',
      entityId: REMOTE_COLLECTION_ID,
      baseRevision: 1,
      concurrencyToken: 'old-token',
      collectionId: null,
      modelId: null,
      name: 'Collection',
      description: null,
      isShared: false,
    });
    expect(remote.apply.mock.calls[0]![2].operations[0]).not.toHaveProperty(
      'operationId',
    );
    expect(remote.apply.mock.calls[0]![2].operations[0]).not.toHaveProperty(
      'payload',
    );
    expect(sidecar.api.settleOutboundBatch).toHaveBeenCalledWith(
      expect.objectContaining({ batchId: 'batch-1', serverRevision: 10 }),
    );
  });

  it('persists 409 conflict payloads and terminal settlement', async () => {
    const sidecar = fakeSidecar([], batch([operation('op-1', 0)]));
    const remote = fakeRemote();
    remote.apply.mockResolvedValue({
      kind: 'conflict',
      value: {
        error: 'conflict',
        serverRevision: 11,
        conflicts: [
          {
            entityType: 'ModelCollection',
            entityId: REMOTE_COLLECTION_ID,
            reason: 'revision mismatch',
            server: { name: 'server' },
            submitted: { name: 'Collection' },
          },
        ],
      },
    });

    await createEngine(sidecar.api, remote.api).syncNow(PROFILE_ID);

    expect(sidecar.api.settleOutboundBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        applied: [],
        conflicts: [
          expect.objectContaining({
            operationId: 'op-1',
            conflict: expect.objectContaining({
              serverPayload: { name: 'server' },
              submittedPayload: { name: 'Collection' },
            }),
          }),
        ],
      }),
    );
  });

  it('quarantines an ambiguous after-send failure without replay', async () => {
    const sidecar = fakeSidecar([], batch([operation('op-1', 0)]));
    const remote = fakeRemote();
    remote.apply.mockRejectedValue(
      new SyncHttpError('timeout', 'Apply timed out.', null, null, true),
    );

    await createEngine(sidecar.api, remote.api).syncNow(PROFILE_ID);

    expect(sidecar.api.failOutboundBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        outcome: 'ambiguous',
        retryAt: null,
      }),
    );
    expect(remote.apply).toHaveBeenCalledOnce();
  });

  it('acks uncertain work only after pull proves the remote revision', async () => {
    const uncertain = {
      ...operation('op-1', 0),
      state: 'uncertain' as const,
      attemptToken: 'attempt-1',
      baseRevision: 2,
    };
    const mapping: SidecarEntityRevision = {
      profileId: PROFILE_ID,
      entityType: 'ModelCollection',
      localId: 'local-1',
      remoteId: REMOTE_COLLECTION_ID,
      revision: 3,
      concurrencyToken: 'new-token',
      tombstone: false,
      visibility: 'Private',
      snapshot: collection(REMOTE_COLLECTION_ID, 3),
      updatedAt: 3,
    };
    const sidecar = fakeSidecar([mapping], null, [uncertain]);
    const remote = fakeRemote();
    remote.getCollection.mockResolvedValue({
      ...collection(REMOTE_COLLECTION_ID, 3),
      name: 'Collection',
      description: null,
      isShared: false,
    });

    await createEngine(sidecar.api, remote.api).syncNow(PROFILE_ID);

    expect(sidecar.api.reconcileUncertainBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        batchId: 'batch-1',
        resolution: 'acked',
        operations: [
          expect.objectContaining({
            operationId: 'op-1',
            baseRevision: 2,
            concurrencyToken: 'old-token',
          }),
        ],
      }),
    );
  });
});

describe('PrintFarmerSyncEngine scheduling', () => {
  it('returns explicit legacy/unavailable errors', async () => {
    const remote = fakeRemote();
    const legacy = profile(PROFILE_ID, 'legacy', false);
    const engine = createEngine(fakeSidecar().api, remote.api, [legacy]);

    await expect(engine.syncNow(PROFILE_ID)).rejects.toEqual(
      expect.objectContaining<Partial<SyncEngineError>>({ code: 'LEGACY' }),
    );
    expect(remote.getChanges).not.toHaveBeenCalled();
  });

  it('is single-flight per profile and disposes an active scheduler cleanly', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    const gate = deferred<ReturnType<typeof page>>();
    remote.getChanges.mockReturnValue(gate.promise);
    const engine = createEngine(sidecar.api, remote.api);

    const first = engine.syncNow(PROFILE_ID);
    const second = engine.syncNow(PROFILE_ID);
    expect(second).toBe(first);
    await vi.waitFor(() => expect(remote.getChanges).toHaveBeenCalledOnce());
    const disposing = engine.dispose();
    gate.resolve(page([], null, false, 0));
    await disposing;

    expect((await first).phase).toBe('cancelled');
    expect(() => engine.syncNow(PROFILE_ID)).toThrow(
      expect.objectContaining({ code: 'DISPOSED' }),
    );
  });

  it('recovers expired leases before the first scheduled pull', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    const engine = createEngine(sidecar.api, remote.api);

    await engine.start();
    engine.stop();

    expect(
      vi.mocked(sidecar.api.recoverOutboundOperations).mock
        .invocationCallOrder[0],
    ).toBeLessThan(remote.getChanges.mock.invocationCallOrder[0]!);
  });

  it('coalesces concurrent scheduler starts into one retained timer', async () => {
    const sidecar = fakeSidecar();
    const remote = fakeRemote();
    const setInterval = vi.fn(
      () => 17 as unknown as ReturnType<typeof globalThis.setInterval>,
    );
    const engine = new PrintFarmerSyncEngine(
      {
        list: () =>
          Promise.resolve({
            profiles: [profile()],
            selectedProfileId: PROFILE_ID,
          }),
      },
      sidecar.api,
      remote.api,
      {
        now: () => NOW,
        setInterval: setInterval as unknown as typeof globalThis.setInterval,
        clearInterval: vi.fn(),
      },
    );

    await Promise.all([engine.start(), engine.start()]);

    expect(setInterval).toHaveBeenCalledOnce();
    await engine.dispose();
  });
});

function createEngine(
  sidecar: SyncSidecar,
  remote: SyncRemote,
  profiles = [profile()],
  maxConcurrentProfiles = 1,
): PrintFarmerSyncEngine {
  return new PrintFarmerSyncEngine(
    { list: () => Promise.resolve({ profiles, selectedProfileId: null }) },
    sidecar,
    remote,
    {
      now: () => NOW,
      maxConcurrentProfiles,
      intervalMs: 60_000,
    },
  );
}

function profile(
  id = PROFILE_ID,
  status: 'connected' | 'legacy' | 'error' = 'connected',
  available = true,
): ServerProfile {
  return {
    id,
    displayName: `Farm ${id}`,
    baseUrl: `https://${id}.example`,
    authMode: 'apiKey',
    version: null,
    capabilities: null,
    availability: {
      modelUpload: { available: true, reason: null, mode: 'modern' },
      librarySync: { available, reason: available ? null : 'Disabled' },
      clientThumbnailUpload: { available: false, reason: null },
      serverThumbnailFallback: { available: true, reason: null },
    },
    status,
    lastCheckedAt: new Date(NOW).toISOString(),
    warnings: status === 'legacy' ? ['legacy'] : [],
  };
}

function fakeSidecar(
  initialRevisions: SidecarEntityRevision[] = [],
  initialClaim: SidecarClaimedOutboundBatch | null = null,
  uncertain: SidecarOutboundOperation[] = [],
): {
  api: SyncSidecar;
  pullBatches: SidecarApplyPullBatch[];
  statuses: Map<string, SidecarSyncStatus>;
} {
  const statuses = new Map<string, SidecarSyncStatus>();
  const revisions = [...initialRevisions];
  const pullBatches: SidecarApplyPullBatch[] = [];
  let claim = initialClaim;
  const status = (profileId: string): SidecarSyncStatus =>
    statuses.get(profileId) ?? {
      profileId,
      cursor: null,
      serverRevision: 0,
      checkpointGeneration: 0,
      lastPulledAt: null,
      lastPushedAt: null,
      updatedAt: 0,
    };
  const api = {
    bindSyncProfile: vi.fn((profileId: string) =>
      Promise.resolve(status(profileId)),
    ),
    getSyncStatus: vi.fn((profileId: string) =>
      Promise.resolve(status(profileId)),
    ),
    applySyncPullBatch: vi.fn((input: SidecarApplyPullBatch) => {
      pullBatches.push(input);
      for (const entity of input.entities) {
        const index = revisions.findIndex(
          (item) =>
            item.profileId === input.profileId &&
            item.entityType === entity.entityType &&
            item.remoteId === entity.remoteId,
        );
        const next = {
          ...entity,
          profileId: input.profileId,
          updatedAt: input.appliedAt,
        };
        if (index >= 0) revisions[index] = next;
        else revisions.push(next);
      }
      const next = {
        ...status(input.profileId),
        cursor: input.cursor,
        serverRevision: input.serverRevision,
        checkpointGeneration: status(input.profileId).checkpointGeneration + 1,
        lastPulledAt: input.appliedAt,
        updatedAt: input.appliedAt,
      };
      statuses.set(input.profileId, next);
      return Promise.resolve(next);
    }),
    getSyncEntityRevision: vi.fn(
      (profileId: string, entityType: string, remoteId: string) =>
        Promise.resolve(
          revisions.find(
            (item) =>
              item.profileId === profileId &&
              item.entityType === entityType &&
              item.remoteId === remoteId,
          ) ?? null,
        ),
    ),
    getSyncEntityRevisionByLocal: vi.fn(
      (profileId: string, entityType: string, localId: string) =>
        Promise.resolve(
          revisions.find(
            (item) =>
              item.profileId === profileId &&
              item.entityType === entityType &&
              item.localId === localId,
          ) ?? {
            profileId,
            entityType,
            localId,
            remoteId: REMOTE_COLLECTION_ID,
            revision: 1,
            journalRevision: 1,
            concurrencyToken: 'old-token',
            tombstone: false,
            visibility: 'Private',
            snapshot: null,
            updatedAt: 1,
          },
        ),
    ),
    getRemoteModelLink: vi.fn(() => Promise.resolve(null)),
    listSyncEntityRevisions: vi.fn((profileId: string) =>
      Promise.resolve(revisions.filter((item) => item.profileId === profileId)),
    ),
    listOutboundOperations: vi.fn(() => Promise.resolve(uncertain)),
    recoverOutboundOperations: vi.fn(() =>
      Promise.resolve({ markedUncertain: 0 }),
    ),
    claimOutboundOperations: vi.fn(() => {
      const value = claim;
      claim = null;
      return Promise.resolve(value);
    }),
    failOutboundBatch: vi.fn(() => Promise.resolve([])),
    settleOutboundBatch: vi.fn(() => Promise.resolve({})),
    reconcileUncertainBatch: vi.fn(() => Promise.resolve([])),
  } as unknown as SyncSidecar;
  return { api, pullBatches, statuses };
}

function fakeRemote(): {
  api: SyncRemote;
  getChanges: ReturnType<typeof vi.fn>;
  getCollection: ReturnType<typeof vi.fn>;
  getCollections: ReturnType<typeof vi.fn>;
  getCollectionMembers: ReturnType<typeof vi.fn>;
  getTag: ReturnType<typeof vi.fn>;
  apply: ReturnType<typeof vi.fn>;
} {
  const getChanges = vi.fn(() => Promise.resolve(page([], null, false, 0)));
  const getCollection = vi.fn();
  const getCollections = vi.fn(() => Promise.resolve([]));
  const getCollectionMembers = vi.fn(() => Promise.resolve([]));
  const getTag = vi.fn();
  const apply = vi.fn();
  return {
    api: {
      getChanges,
      getCollection,
      getCollections,
      getCollectionMembers,
      getTag,
      apply,
    },
    getChanges,
    getCollection,
    getCollections,
    getCollectionMembers,
    getTag,
    apply,
  };
}

function page(
  changes: ReturnType<typeof change>[],
  nextCursor: string | null,
  hasMore: boolean,
  serverRevision: number,
) {
  return {
    changes,
    nextCursor:
      nextCursor ?? (changes.length > 0 ? `cursor-${serverRevision}` : null),
    hasMore,
    serverRevision,
  };
}

function change(
  revision: number,
  entityType: 'ModelCollection' | 'ModelCollectionMembership' | 'Tag',
  entityId: string,
) {
  return {
    revision,
    entityType,
    entityId,
    operation: 'Update' as 'Create' | 'Update' | 'Delete',
    ownerUserId: 'owner',
    visibility: 'Shared' as 'Shared' | 'Private',
    actorUserId: 'actor',
    timestamp: new Date(NOW).toISOString(),
  };
}

function collection(id: string, revision: number) {
  return {
    id,
    name: 'Collection',
    description: null,
    ownerUserId: 'owner',
    isShared: true,
    modelIds: ['remote-model'],
    revision,
    concurrencyToken: `collection-token-${revision}`,
  };
}

function membership(
  id: string,
  collectionId: string,
  modelId: string,
  revision: number,
) {
  return {
    id,
    collectionId,
    modelId,
    revision,
    createdAt: new Date(NOW - 1000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  };
}

function tag(id: string, revision: number) {
  return {
    id,
    name: 'Tag',
    category: null,
    revision,
    concurrencyToken: `tag-token-${revision}`,
    isAutoGenerated: false,
    color: null,
    description: null,
  };
}

function operation(
  operationId: string,
  ordinal: number,
): SidecarOutboundOperation {
  return {
    profileId: PROFILE_ID,
    operationId,
    sequence: ordinal + 1,
    batchId: 'batch-1',
    batchIncarnation: 'incarnation-1',
    batchOrdinal: ordinal,
    entityType: 'ModelCollection',
    operation: 'Update',
    entityId: 'local-1',
    payload: {
      remoteId: REMOTE_COLLECTION_ID,
      name: 'Collection',
      description: null,
      isShared: false,
    },
    baseRevision: 1,
    concurrencyToken: 'old-token',
    state: 'inFlight',
    attemptCount: 1,
    retryEligible: true,
    retryAt: null,
    leaseUntil: Math.floor(NOW / 1000) + 120,
    leaseToken: 'lease-1',
    attemptToken: 'attempt-1',
    lastError: null,
    createdAt: Math.floor(NOW / 1000) - 10,
    updatedAt: Math.floor(NOW / 1000),
    ackedAt: null,
  };
}

function batch(
  operations: SidecarOutboundOperation[],
): SidecarClaimedOutboundBatch {
  return {
    profileId: PROFILE_ID,
    batchId: 'batch-1',
    batchIncarnation: 'incarnation-1',
    leaseToken: 'lease-1',
    attemptToken: 'attempt-1',
    leaseUntil: Math.floor(NOW / 1000) + 120,
    operations,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
