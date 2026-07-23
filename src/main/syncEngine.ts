import { createHash } from 'node:crypto';
import type { ServerProfile } from '@shared/ipc';
import type {
  SidecarApplyPullBatch,
  SidecarClaimedOutboundBatch,
  SidecarConflictInput,
  SidecarEntityRevision,
  SidecarOutboundOperation,
  SidecarSyncEntityType,
  SidecarSyncStatus,
} from './sidecar.js';
import { SyncHttpError, type ApplyResult } from './syncHttp.js';
import type {
  CollectionSnapshot,
  MembershipSnapshot,
  RemoteChange,
  TagSnapshot,
} from './syncWire.js';

const PULL_LIMIT = 500;
const OUTBOX_LEASE_SECONDS = 120;
const DEFAULT_INTERVAL_MS = 60_000;

export type SyncEngineErrorCode =
  'NOT_FOUND' | 'UNAVAILABLE' | 'LEGACY' | 'CANCELLED' | 'DISPOSED';

export class SyncEngineError extends Error {
  constructor(
    readonly code: SyncEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SyncEngineError';
  }
}

export interface SyncProfileService {
  list(): Promise<{
    profiles: ServerProfile[];
    selectedProfileId: string | null;
  }>;
}

export interface SyncSidecar {
  getSyncStatus(profileId: string): Promise<SidecarSyncStatus>;
  applySyncPullBatch(batch: SidecarApplyPullBatch): Promise<SidecarSyncStatus>;
  getSyncEntityRevision(
    profileId: string,
    entityType: SidecarSyncEntityType,
    remoteId: string,
  ): Promise<SidecarEntityRevision | null>;
  listSyncEntityRevisions(
    profileId: string,
    entityType?: SidecarSyncEntityType,
    limit?: number,
  ): Promise<SidecarEntityRevision[]>;
  listOutboundOperations(
    profileId: string,
    states: Array<'uncertain'>,
    limit?: number,
  ): Promise<SidecarOutboundOperation[]>;
  recoverOutboundOperations(
    profileId: string,
    now: number,
  ): Promise<{ markedUncertain: number }>;
  claimOutboundOperations(
    profileId: string,
    limit: number,
    now: number,
    leaseSeconds: number,
  ): Promise<SidecarClaimedOutboundBatch | null>;
  failOutboundBatch(input: {
    profileId: string;
    batchId: string;
    batchIncarnation: string;
    leaseToken: string;
    outcome: 'definiteTransient' | 'ambiguous';
    error: string;
    failedAt: number;
    retryAt: number | null;
  }): Promise<SidecarOutboundOperation[]>;
  settleOutboundBatch(input: {
    profileId: string;
    batchId: string;
    batchIncarnation: string;
    leaseToken: string;
    settledAt: number;
    serverRevision: number;
    applied: Array<{
      operationId: string;
      remoteId: string;
      revision: number;
      concurrencyToken: string | null;
    }>;
    conflicts: Array<{
      operationId: string;
      conflict: SidecarConflictInput;
    }>;
  }): Promise<unknown>;
  reconcileUncertainBatch(input: {
    profileId: string;
    batchId: string;
    batchIncarnation: string;
    expectedAttemptToken: string;
    resolution: 'acked' | 'requeue';
    reconciledAt: number;
    operations: Array<{
      operationId: string;
      baseRevision: number | null;
      concurrencyToken: string | null;
    }>;
  }): Promise<SidecarOutboundOperation[]>;
}

export interface SyncRemote {
  getChanges(
    profileId: string,
    baseUrl: string,
    cursor: string | null,
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    changes: RemoteChange[];
    nextCursor: string | null;
    hasMore: boolean;
    serverRevision: number;
  }>;
  getCollection(
    profileId: string,
    baseUrl: string,
    id: string,
    signal: AbortSignal,
  ): Promise<CollectionSnapshot | null>;
  getCollections(
    profileId: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<CollectionSnapshot[]>;
  getCollectionMembers(
    profileId: string,
    baseUrl: string,
    id: string,
    signal: AbortSignal,
  ): Promise<MembershipSnapshot[] | null>;
  getTag(
    profileId: string,
    baseUrl: string,
    id: string,
    signal: AbortSignal,
  ): Promise<TagSnapshot | null>;
  apply(
    profileId: string,
    baseUrl: string,
    body: {
      operations: Array<{
        operationId: string;
        entityType: SidecarSyncEntityType;
        operation: 'Create' | 'Update' | 'Delete';
        entityId: string;
        payload: unknown;
        baseRevision: number | null;
        concurrencyToken: string | null;
      }>;
    },
    signal: AbortSignal,
  ): Promise<ApplyResult>;
}

export type SyncPhase =
  | 'idle'
  | 'waiting'
  | 'recovering'
  | 'pulling'
  | 'pushing'
  | 'succeeded'
  | 'cancelled'
  | 'error'
  | 'unavailable';

export interface ProfileSyncStatus {
  profileId: string;
  phase: SyncPhase;
  running: boolean;
  pulledChanges: number;
  pushedOperations: number;
  cursor: string | null;
  serverRevision: number;
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
  nextRetryAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface PrintFarmerSyncEngineOptions {
  intervalMs?: number;
  maxConcurrentProfiles?: number;
  now?: () => number;
  setInterval?: typeof globalThis.setInterval;
  clearInterval?: typeof globalThis.clearInterval;
}

interface ActiveSync {
  generation: number;
  controller: AbortController;
  promise: Promise<ProfileSyncStatus>;
}

export class PrintFarmerSyncEngine {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private readonly permits: Semaphore;
  private readonly active = new Map<string, ActiveSync>();
  private readonly generations = new Map<string, number>();
  private readonly statuses = new Map<string, ProfileSyncStatus>();
  private readonly listeners = new Set<(status: ProfileSyncStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private schedulerTick: Promise<void> | null = null;

  constructor(
    private readonly profiles: SyncProfileService,
    private readonly sidecar: SyncSidecar,
    private readonly remote: SyncRemote,
    options: PrintFarmerSyncEngineOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.setIntervalImpl = options.setInterval ?? globalThis.setInterval;
    this.clearIntervalImpl = options.clearInterval ?? globalThis.clearInterval;
    this.permits = new Semaphore(options.maxConcurrentProfiles ?? 2);
  }

  snapshot(profileId?: string): ProfileSyncStatus[] {
    const values = profileId
      ? [this.statuses.get(profileId)].filter(
          (value): value is ProfileSyncStatus => value !== undefined,
        )
      : [...this.statuses.values()];
    return values
      .map((value) => ({ ...value }))
      .sort((left, right) => left.profileId.localeCompare(right.profileId));
  }

  subscribe(listener: (status: ProfileSyncStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.timer) return;
    await this.runSchedulerTick(true);
    if (this.disposed) return;
    this.timer = this.setIntervalImpl(() => {
      void this.runSchedulerTick(false);
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      this.clearIntervalImpl(this.timer);
      this.timer = null;
    }
  }

  syncNow(profileId: string): Promise<ProfileSyncStatus> {
    this.assertNotDisposed();
    const existing = this.active.get(profileId);
    if (existing) return existing.promise;

    const generation = this.currentGeneration(profileId);
    const controller = new AbortController();
    const promise = this.runProfile(profileId, generation, controller.signal)
      .catch((error: unknown) => {
        if (
          error instanceof SyncEngineError &&
          (error.code === 'UNAVAILABLE' ||
            error.code === 'LEGACY' ||
            error.code === 'NOT_FOUND')
        ) {
          throw error;
        }
        return this.finishWithError(profileId, error);
      })
      .finally(() => {
        if (this.active.get(profileId)?.generation === generation) {
          this.active.delete(profileId);
        }
      });
    this.active.set(profileId, { generation, controller, promise });
    return promise;
  }

  cancelProfile(profileId: string): void {
    this.generations.set(profileId, this.currentGeneration(profileId) + 1);
    this.active.get(profileId)?.controller.abort();
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const profileId of this.active.keys()) this.cancelProfile(profileId);
    await Promise.allSettled(
      [...this.active.values()].map(({ promise }) => promise),
    );
    if (this.schedulerTick) await this.schedulerTick;
    this.listeners.clear();
  }

  private async runSchedulerTick(recover: boolean): Promise<void> {
    if (this.schedulerTick || this.disposed)
      return this.schedulerTick ?? undefined;
    const tick = (async (): Promise<void> => {
      const store = await this.profiles.list();
      const eligible = store.profiles.filter(isSyncCapable);
      if (recover) {
        await Promise.all(
          eligible.map(async (profile) => {
            this.update(profile.id, { phase: 'recovering' });
            await this.sidecar.recoverOutboundOperations(
              profile.id,
              toUnixSeconds(this.now()),
            );
          }),
        );
      }
      await Promise.allSettled(
        eligible.map((profile) => this.syncNow(profile.id)),
      );
    })().finally(() => {
      if (this.schedulerTick === tick) this.schedulerTick = null;
    });
    this.schedulerTick = tick;
    return tick;
  }

  private async runProfile(
    profileId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<ProfileSyncStatus> {
    const release = await this.permits.acquire(signal);
    try {
      this.assertCurrent(profileId, generation, signal);
      const profile = await this.requireProfile(profileId);
      this.update(profileId, {
        phase: 'pulling',
        running: true,
        lastStartedAt: this.now(),
        lastCompletedAt: null,
        pulledChanges: 0,
        pushedOperations: 0,
        errorCode: null,
        errorMessage: null,
        nextRetryAt: null,
      });
      await this.pull(profile, generation, signal);
      await this.reconcileUncertain(profile.id, generation, signal);
      this.update(profileId, { phase: 'pushing' });
      await this.push(profile, generation, signal);
      const durable = await this.sidecar.getSyncStatus(profileId);
      this.assertCurrent(profileId, generation, signal);
      return this.update(profileId, {
        phase: 'succeeded',
        running: false,
        cursor: durable.cursor,
        serverRevision: durable.serverRevision,
        lastCompletedAt: this.now(),
      });
    } finally {
      release();
    }
  }

  private async pull(
    profile: ServerProfile,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    let checkpoint = await this.sidecar.getSyncStatus(profile.id);
    while (true) {
      this.assertCurrent(profile.id, generation, signal);
      const page = await this.remote.getChanges(
        profile.id,
        profile.baseUrl,
        checkpoint.cursor,
        PULL_LIMIT,
        signal,
      );
      this.assertCurrent(profile.id, generation, signal);
      if (page.hasMore && page.nextCursor === null) {
        throw new Error('The server returned hasMore without a next cursor.');
      }
      if (page.hasMore && page.nextCursor === checkpoint.cursor) {
        throw new Error('The server returned a non-advancing sync cursor.');
      }
      const entities = await this.materializeChanges(
        profile,
        collapseChanges(page.changes),
        generation,
        signal,
      );
      this.assertCurrent(profile.id, generation, signal);
      checkpoint = await this.sidecar.applySyncPullBatch({
        profileId: profile.id,
        expectedCheckpointGeneration: checkpoint.checkpointGeneration,
        expectedPreviousCursor: checkpoint.cursor,
        cursor: page.nextCursor,
        serverRevision: page.serverRevision,
        appliedAt: toUnixSeconds(this.now()),
        entities,
        conflicts: [],
      });
      this.update(profile.id, {
        cursor: checkpoint.cursor,
        serverRevision: checkpoint.serverRevision,
        pulledChanges:
          this.currentStatus(profile.id).pulledChanges + page.changes.length,
      });
      if (!page.hasMore) return;
    }
  }

  private async materializeChanges(
    profile: ServerProfile,
    changes: RemoteChange[],
    generation: number,
    signal: AbortSignal,
  ): Promise<SidecarApplyPullBatch['entities']> {
    const result: SidecarApplyPullBatch['entities'] = [];
    const membershipChanges = changes.filter(
      (change) => change.entityType === 'ModelCollectionMembership',
    );
    const memberships = membershipChanges.length
      ? await this.resolveMemberships(profile, membershipChanges, signal)
      : new Map<string, MembershipSnapshot>();
    this.assertCurrent(profile.id, generation, signal);

    for (const change of changes) {
      const existing = await this.sidecar.getSyncEntityRevision(
        profile.id,
        change.entityType,
        change.entityId,
      );
      this.assertCurrent(profile.id, generation, signal);
      if (change.operation === 'Delete') {
        result.push(tombstone(change, existing));
        continue;
      }
      if (change.entityType === 'ModelCollection') {
        const value = await this.remote.getCollection(
          profile.id,
          profile.baseUrl,
          change.entityId,
          signal,
        );
        this.assertCurrent(profile.id, generation, signal);
        if (!value) {
          result.push(tombstone(change, existing));
        } else {
          const timestamp = value.updatedAt ?? change.timestamp;
          result.push({
            entityType: change.entityType,
            localId:
              existing?.localId ??
              stableLocalId('collection', profile.id, value.id),
            remoteId: value.id,
            revision: value.revision,
            concurrencyToken: value.concurrencyToken,
            tombstone: false,
            visibility: change.visibility,
            snapshot: {
              ...value,
              createdAt: value.createdAt ?? timestamp,
              updatedAt: timestamp,
              memberCount: value.memberCount ?? value.modelIds.length,
            },
          });
        }
        continue;
      }
      if (change.entityType === 'Tag') {
        const value = await this.remote.getTag(
          profile.id,
          profile.baseUrl,
          change.entityId,
          signal,
        );
        this.assertCurrent(profile.id, generation, signal);
        result.push(
          value
            ? {
                entityType: change.entityType,
                localId:
                  existing?.localId ??
                  stableLocalId('tag', profile.id, value.id),
                remoteId: value.id,
                revision: value.revision,
                concurrencyToken: value.concurrencyToken,
                tombstone: false,
                visibility: change.visibility,
                snapshot: value,
              }
            : tombstone(change, existing),
        );
        continue;
      }
      const value = memberships.get(change.entityId);
      result.push(
        value
          ? {
              entityType: change.entityType,
              localId:
                existing?.localId ??
                stableLocalId('membership', profile.id, value.id),
              remoteId: value.id,
              revision: value.revision,
              concurrencyToken: null,
              tombstone: false,
              visibility: change.visibility,
              snapshot: value,
            }
          : tombstone(change, existing),
      );
    }
    return result;
  }

  private async resolveMemberships(
    profile: ServerProfile,
    changes: RemoteChange[],
    signal: AbortSignal,
  ): Promise<Map<string, MembershipSnapshot>> {
    const unresolved = new Set(changes.map((change) => change.entityId));
    const found = new Map<string, MembershipSnapshot>();
    let collections: CollectionSnapshot[];
    try {
      collections = await this.remote.getCollections(
        profile.id,
        profile.baseUrl,
        signal,
      );
    } catch (error) {
      if (
        error instanceof SyncHttpError &&
        (error.code === 'authorization' || error.code === 'notFound')
      ) {
        return found;
      }
      throw error;
    }
    for (const collection of collections) {
      if (unresolved.size === 0) break;
      const members = await this.remote.getCollectionMembers(
        profile.id,
        profile.baseUrl,
        collection.id,
        signal,
      );
      for (const member of members ?? []) {
        if (unresolved.delete(member.id)) found.set(member.id, member);
      }
    }
    return found;
  }

  private async reconcileUncertain(
    profileId: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const uncertain = await this.sidecar.listOutboundOperations(
      profileId,
      ['uncertain'],
      PULL_LIMIT,
    );
    const groups = groupBatches(uncertain);
    for (const operations of groups) {
      this.assertCurrent(profileId, generation, signal);
      const mappings = await this.sidecar.listSyncEntityRevisions(
        profileId,
        undefined,
        PULL_LIMIT,
      );
      const reflected = operations.map((operation) => ({
        operation,
        mapping: mappings.find(
          (mapping) =>
            mapping.entityType === operation.entityType &&
            mapping.localId === operation.entityId,
        ),
      }));
      const allApplied = reflected.every(({ operation, mapping }) =>
        operationReflected(operation, mapping),
      );
      const hasUnsafeCreate = operations.some(
        (operation) =>
          operation.entityType === 'ModelCollection' &&
          operation.operation === 'Create',
      );
      if (!allApplied && hasUnsafeCreate) continue;
      const first = operations[0]!;
      await this.sidecar.reconcileUncertainBatch({
        profileId,
        batchId: first.batchId,
        batchIncarnation: first.batchIncarnation,
        expectedAttemptToken: first.attemptToken!,
        resolution: allApplied ? 'acked' : 'requeue',
        reconciledAt: toUnixSeconds(this.now()),
        operations: reflected.map(({ operation, mapping }) => ({
          operationId: operation.operationId,
          baseRevision: mapping?.revision ?? operation.baseRevision,
          concurrencyToken:
            mapping?.concurrencyToken ?? operation.concurrencyToken,
        })),
      });
    }
  }

  private async push(
    profile: ServerProfile,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      this.assertCurrent(profile.id, generation, signal);
      const claimed = await this.sidecar.claimOutboundOperations(
        profile.id,
        PULL_LIMIT,
        toUnixSeconds(this.now()),
        OUTBOX_LEASE_SECONDS,
      );
      if (!claimed) return;
      let response: ApplyResult;
      try {
        response = await this.remote.apply(
          profile.id,
          profile.baseUrl,
          {
            operations: claimed.operations.map((operation) => ({
              operationId: operation.operationId,
              entityType: operation.entityType,
              operation: operation.operation,
              entityId: operation.entityId,
              payload: operation.payload,
              baseRevision: operation.baseRevision,
              concurrencyToken: operation.concurrencyToken,
            })),
          },
          signal,
        );
        this.assertCurrent(profile.id, generation, signal);
      } catch (error) {
        await this.handlePushFailure(claimed, error);
        if (error instanceof SyncHttpError && error.code === 'cancelled')
          throw error;
        return;
      }
      if (response.kind === 'success') {
        await this.sidecar.settleOutboundBatch({
          profileId: profile.id,
          batchId: claimed.batchId,
          batchIncarnation: claimed.batchIncarnation,
          leaseToken: claimed.leaseToken,
          settledAt: toUnixSeconds(this.now()),
          serverRevision: response.value.serverRevision,
          applied: response.value.applied.map((applied) => ({
            operationId: applied.operationId,
            remoteId: applied.remoteId,
            revision: applied.revision,
            concurrencyToken: applied.concurrencyToken ?? null,
          })),
          conflicts: [],
        });
        this.update(profile.id, {
          pushedOperations:
            this.currentStatus(profile.id).pushedOperations +
            claimed.operations.length,
        });
      } else {
        const byId = new Map(
          claimed.operations.map((operation) => [
            operation.operationId,
            operation,
          ]),
        );
        await this.sidecar.settleOutboundBatch({
          profileId: profile.id,
          batchId: claimed.batchId,
          batchIncarnation: claimed.batchIncarnation,
          leaseToken: claimed.leaseToken,
          settledAt: toUnixSeconds(this.now()),
          serverRevision: response.value.serverRevision,
          applied: [],
          conflicts: response.value.conflicts.map((conflict) => {
            const operation = byId.get(conflict.operationId);
            return {
              operationId: conflict.operationId,
              conflict: {
                conflictId:
                  conflict.conflictId ??
                  stableConflictId(
                    claimed.batchIncarnation,
                    conflict.operationId,
                  ),
                entityType: conflict.entityType,
                entityId: conflict.entityId,
                localPayload:
                  conflict.localPayload ?? operation?.payload ?? null,
                serverPayload: conflict.serverPayload ?? null,
                submittedPayload:
                  conflict.submittedPayload ?? operation?.payload ?? null,
                reason: conflict.reason,
                serverRevision: response.value.serverRevision,
                createdAt: toUnixSeconds(this.now()),
              },
            };
          }),
        });
        return;
      }
    }
  }

  private async handlePushFailure(
    claimed: SidecarClaimedOutboundBatch,
    error: unknown,
  ): Promise<void> {
    const mapped =
      error instanceof SyncHttpError
        ? error
        : new SyncHttpError(
            'transport',
            'The outbound synchronization attempt failed.',
            null,
            null,
            true,
          );
    const retryable =
      !mapped.ambiguous &&
      (mapped.code === 'rateLimited' ||
        mapped.code === 'authentication' ||
        mapped.code === 'authorization');
    const retryDelay = mapped.retryAfterMs ?? retryBackoff(claimed.operations);
    const failedAt = toUnixSeconds(this.now());
    await this.sidecar.failOutboundBatch({
      profileId: claimed.profileId,
      batchId: claimed.batchId,
      batchIncarnation: claimed.batchIncarnation,
      leaseToken: claimed.leaseToken,
      outcome: retryable ? 'definiteTransient' : 'ambiguous',
      error: mapped.message.slice(0, 4096),
      failedAt,
      retryAt: retryable ? failedAt + Math.ceil(retryDelay / 1000) : null,
    });
    this.update(claimed.profileId, {
      nextRetryAt: retryable ? this.now() + retryDelay : null,
    });
  }

  private async requireProfile(profileId: string): Promise<ServerProfile> {
    const store = await this.profiles.list();
    const profile = store.profiles.find(
      (candidate) => candidate.id === profileId,
    );
    if (!profile) {
      throw new SyncEngineError('NOT_FOUND', 'Server profile not found.');
    }
    if (profile.status === 'legacy') {
      this.update(profileId, { phase: 'unavailable', running: false });
      throw new SyncEngineError(
        'LEGACY',
        'Library synchronization is unavailable for legacy server profiles.',
      );
    }
    if (!isSyncCapable(profile)) {
      this.update(profileId, { phase: 'unavailable', running: false });
      throw new SyncEngineError(
        'UNAVAILABLE',
        profile.availability.librarySync.reason ??
          'Library synchronization is unavailable for this profile.',
      );
    }
    return profile;
  }

  private finishWithError(
    profileId: string,
    error: unknown,
  ): ProfileSyncStatus {
    const cancelled =
      error instanceof SyncEngineError
        ? error.code === 'CANCELLED'
        : error instanceof SyncHttpError && error.code === 'cancelled';
    return this.update(profileId, {
      phase: cancelled ? 'cancelled' : 'error',
      running: false,
      lastCompletedAt: this.now(),
      errorCode:
        error instanceof SyncHttpError || error instanceof SyncEngineError
          ? error.code
          : 'INTERNAL',
      errorMessage:
        error instanceof Error
          ? error.message.slice(0, 1024)
          : 'Library synchronization failed.',
    });
  }

  private assertCurrent(
    profileId: string,
    generation: number,
    signal: AbortSignal,
  ): void {
    if (
      this.disposed ||
      signal.aborted ||
      generation !== this.currentGeneration(profileId)
    ) {
      throw new SyncEngineError(
        'CANCELLED',
        'Library synchronization was cancelled.',
      );
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new SyncEngineError(
        'DISPOSED',
        'The synchronization engine is disposed.',
      );
    }
  }

  private currentGeneration(profileId: string): number {
    return this.generations.get(profileId) ?? 0;
  }

  private currentStatus(profileId: string): ProfileSyncStatus {
    return (
      this.statuses.get(profileId) ?? {
        profileId,
        phase: 'idle',
        running: false,
        pulledChanges: 0,
        pushedOperations: 0,
        cursor: null,
        serverRevision: 0,
        lastStartedAt: null,
        lastCompletedAt: null,
        nextRetryAt: null,
        errorCode: null,
        errorMessage: null,
      }
    );
  }

  private update(
    profileId: string,
    patch: Partial<Omit<ProfileSyncStatus, 'profileId'>>,
  ): ProfileSyncStatus {
    const value = { ...this.currentStatus(profileId), ...patch, profileId };
    this.statuses.set(profileId, value);
    for (const listener of this.listeners) listener({ ...value });
    return { ...value };
  }
}

function isSyncCapable(profile: ServerProfile): boolean {
  return (
    profile.status === 'connected' && profile.availability.librarySync.available
  );
}

function collapseChanges(changes: RemoteChange[]): RemoteChange[] {
  const latest = new Map<string, RemoteChange>();
  for (const change of changes) {
    const key = `${change.entityType}\0${change.entityId}`;
    const previous = latest.get(key);
    if (!previous || change.revision >= previous.revision)
      latest.set(key, change);
  }
  return [...latest.values()].sort(
    (left, right) => left.revision - right.revision,
  );
}

function tombstone(
  change: RemoteChange,
  existing: SidecarEntityRevision | null,
): SidecarApplyPullBatch['entities'][number] {
  return {
    entityType: change.entityType,
    localId: existing?.localId ?? null,
    remoteId: change.entityId,
    revision: change.revision,
    concurrencyToken: null,
    tombstone: true,
    visibility: change.visibility,
    snapshot: null,
  };
}

function stableLocalId(
  kind: 'collection' | 'membership' | 'tag',
  profileId: string,
  remoteId: string,
): string {
  const digest = createHash('sha256')
    .update(profileId)
    .update('\0')
    .update(remoteId)
    .digest('hex')
    .slice(0, 32);
  return `pf-sync-${kind}-${digest}`;
}

function stableConflictId(
  batchIncarnation: string,
  operationId: string,
): string {
  return `pf-conflict-${createHash('sha256')
    .update(batchIncarnation)
    .update('\0')
    .update(operationId)
    .digest('hex')
    .slice(0, 32)}`;
}

function groupBatches(
  operations: SidecarOutboundOperation[],
): SidecarOutboundOperation[][] {
  const groups = new Map<string, SidecarOutboundOperation[]>();
  for (const operation of operations) {
    const key = `${operation.batchId}\0${operation.batchIncarnation}`;
    const group = groups.get(key) ?? [];
    group.push(operation);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) =>
    group.sort((left, right) => left.batchOrdinal - right.batchOrdinal),
  );
}

function operationReflected(
  operation: SidecarOutboundOperation,
  mapping: SidecarEntityRevision | undefined,
): boolean {
  if (!mapping) return false;
  if (operation.operation === 'Delete') return mapping.tombstone;
  return !mapping.tombstone && mapping.revision > (operation.baseRevision ?? 0);
}

function retryBackoff(operations: SidecarOutboundOperation[]): number {
  const attempts = Math.max(
    ...operations.map((operation) => operation.attemptCount),
  );
  return Math.min(
    5 * 60_000,
    1000 * 2 ** Math.min(8, Math.max(0, attempts - 1)),
  );
}

function toUnixSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1000);
}

class Semaphore {
  private available: number;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (reason: Error) => void;
    signal: AbortSignal;
  }> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('maxConcurrentProfiles must be a positive integer');
    }
    this.available = capacity;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) {
      return Promise.reject(
        new SyncEngineError(
          'CANCELLED',
          'Library synchronization was cancelled.',
        ),
      );
    }
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(() => this.release());
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal };
      this.waiters.push(waiter);
      signal.addEventListener(
        'abort',
        () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(
            new SyncEngineError(
              'CANCELLED',
              'Library synchronization was cancelled.',
            ),
          );
        },
        { once: true },
      );
    });
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.resolve(() => this.release());
    } else {
      this.available += 1;
    }
  }
}
