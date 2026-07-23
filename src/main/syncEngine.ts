import { createHash } from 'node:crypto';
import type { ServerProfile } from '@shared/ipc';
import type {
  SidecarApplyPullBatch,
  SidecarClaimedOutboundBatch,
  SidecarConflictInput,
  SidecarEntityRevision,
  SidecarOutboundOperation,
  SidecarRemoteModelLink,
  SidecarSyncEntityType,
  SidecarSyncStatus,
} from './sidecar.js';
import { SyncHttpError, type ApplyResult } from './syncHttp.js';
import type {
  CollectionSnapshot,
  MembershipSnapshot,
  RemoteChange,
  TagSnapshot,
  ApplyOperationRequest,
  AppliedOperation,
  ApplyConflict,
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
  getAuthenticatedContext?(
    profileId: string,
    expectedBaseUrl?: string,
  ): Promise<{ baseUrl: string; binding: string }>;
  subscribeInvalidation?(
    listener: (profileId: string) => Promise<void> | void,
  ): () => void;
}

export interface SyncSidecar {
  getSyncStatus(profileId: string): Promise<SidecarSyncStatus>;
  bindSyncProfile(
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<SidecarSyncStatus>;
  replaceSyncProfileBinding(
    profileId: string,
    expectedBinding: string,
    newBinding: string,
    now: number,
  ): Promise<SidecarSyncStatus>;
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
  getSyncEntityRevisionByLocal(
    profileId: string,
    entityType: SidecarSyncEntityType,
    localId: string,
  ): Promise<SidecarEntityRevision | null>;
  getRemoteModelLink(
    profileId: string,
    localModelHash: string,
  ): Promise<SidecarRemoteModelLink | null>;
  listOutboundOperations(
    profileId: string,
    states: Array<'uncertain'>,
    limit?: number,
  ): Promise<SidecarOutboundOperation[]>;
  getOutboundBatch(
    profileId: string,
    batchId: string,
  ): Promise<SidecarOutboundOperation[]>;
  recoverOutboundOperations(
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<{ markedUncertain: number }>;
  claimOutboundOperations(
    profileId: string,
    profileBinding: string,
    limit: number,
    now: number,
    leaseSeconds: number,
  ): Promise<SidecarClaimedOutboundBatch | null>;
  failOutboundBatch(input: {
    profileId: string;
    profileBinding: string;
    batchId: string;
    batchIncarnation: string;
    leaseToken: string;
    outcome: 'definiteTransient' | 'definitePermanent' | 'ambiguous';
    error: string;
    failedAt: number;
    retryAt: number | null;
  }): Promise<SidecarOutboundOperation[]>;
  settleOutboundBatch(input: {
    profileId: string;
    profileBinding: string;
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
    profileBinding: string;
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
    body: { operations: ApplyOperationRequest[] },
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

interface TranslatedOperation {
  operation: SidecarOutboundOperation;
  wire: ApplyOperationRequest;
}

export class PrintFarmerSyncEngine {
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly setIntervalImpl: typeof globalThis.setInterval;
  private readonly clearIntervalImpl: typeof globalThis.clearInterval;
  private readonly permits: Semaphore;
  private readonly active = new Map<string, ActiveSync>();
  private readonly generations = new Map<string, number>();
  private readonly boundBindings = new Map<string, string>();
  private readonly statuses = new Map<string, ProfileSyncStatus>();
  private readonly listeners = new Set<(status: ProfileSyncStatus) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private startPromise: Promise<void> | null = null;
  private disposed = false;
  private schedulerTick: Promise<void> | null = null;
  private readonly unsubscribeInvalidation: (() => void) | null;

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
    this.unsubscribeInvalidation =
      this.profiles.subscribeInvalidation?.(async (profileId) => {
        this.cancelProfile(profileId);
        const expected = this.boundBindings.get(profileId);
        if (!expected) return;
        let replacement: string;
        try {
          replacement =
            (await this.profiles.getAuthenticatedContext?.(profileId))
              ?.binding ??
            `${createHash('sha256').update(profileId).digest('hex')}:1`;
        } catch {
          replacement = `${createHash('sha256')
            .update('removed')
            .update(profileId)
            .digest('hex')}:1`;
        }
        await this.sidecar.replaceSyncProfileBinding(
          profileId,
          expected,
          replacement,
          toUnixSeconds(this.now()),
        );
        this.boundBindings.set(profileId, replacement);
      }) ?? null;
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
    if (this.startPromise) return this.startPromise;
    const starting = (async (): Promise<void> => {
      await this.runSchedulerTick(true);
      if (this.disposed || this.timer) return;
      this.timer = this.setIntervalImpl(() => {
        void this.runSchedulerTick(false).catch(() => {
          console.error('[sync] scheduled synchronization failed');
        });
      }, this.intervalMs);
    })().finally(() => {
      if (this.startPromise === starting) this.startPromise = null;
    });
    this.startPromise = starting;
    return starting;
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

  async resolveUncertainAsApplied(
    profileId: string,
    batchId: string,
  ): Promise<void> {
    this.assertNotDisposed();
    const profile = await this.requireProfile(profileId);
    const context = await this.authenticatedContext(profile);
    await this.sidecar.bindSyncProfile(
      profileId,
      context.binding,
      toUnixSeconds(this.now()),
    );
    this.boundBindings.set(profile.id, context.binding);
    const operations = await this.sidecar.getOutboundBatch(profileId, batchId);
    if (
      operations.length === 0 ||
      operations.some(
        (operation) =>
          operation.state !== 'uncertain' || !operation.attemptToken,
      )
    ) {
      throw new Error('The requested batch is not wholly uncertain.');
    }
    const first = operations[0]!;
    await this.sidecar.reconcileUncertainBatch({
      profileId,
      profileBinding: context.binding,
      batchId,
      batchIncarnation: first.batchIncarnation,
      expectedAttemptToken: first.attemptToken!,
      resolution: 'acked',
      reconciledAt: toUnixSeconds(this.now()),
      operations: operations.map((operation) => ({
        operationId: operation.operationId,
        baseRevision: operation.baseRevision,
        concurrencyToken: operation.concurrencyToken,
      })),
    });
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
    this.unsubscribeInvalidation?.();
    this.listeners.clear();
  }

  private async runSchedulerTick(recover: boolean): Promise<void> {
    if (this.schedulerTick || this.disposed)
      return this.schedulerTick ?? undefined;
    const tick = (async (): Promise<void> => {
      const store = await this.profiles.list();
      const eligible = store.profiles.filter(isSyncCapable);
      if (recover) {
        const recovery = await Promise.allSettled(
          eligible.map(async (profile) => {
            this.update(profile.id, { phase: 'recovering' });
            const context = await this.authenticatedContext(profile);
            await this.sidecar.bindSyncProfile(
              profile.id,
              context.binding,
              toUnixSeconds(this.now()),
            );
            this.boundBindings.set(profile.id, context.binding);
            await this.sidecar.recoverOutboundOperations(
              profile.id,
              context.binding,
              toUnixSeconds(this.now()),
            );
          }),
        );
        if (recovery.some((result) => result.status === 'rejected')) {
          console.error('[sync] one or more profile recoveries failed');
        }
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
      const context = await this.authenticatedContext(profile);
      await this.sidecar.bindSyncProfile(
        profile.id,
        context.binding,
        toUnixSeconds(this.now()),
      );
      this.boundBindings.set(profile.id, context.binding);
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
      await this.pull(profile, context.binding, generation, signal);
      await this.reconcileUncertain(
        profile,
        context.binding,
        generation,
        signal,
      );
      this.update(profileId, { phase: 'pushing' });
      await this.push(profile, context.binding, generation, signal);
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
    profileBinding: string,
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
      if (page.nextCursor === null && page.changes.length > 0) {
        throw new Error(
          'The server omitted a terminal cursor for a non-empty journal page.',
        );
      }
      const committedCursor = page.nextCursor ?? checkpoint.cursor;
      this.assertCurrent(profile.id, generation, signal);
      await this.assertProfileBinding(profile, profileBinding);
      checkpoint = await this.sidecar.applySyncPullBatch({
        profileId: profile.id,
        profileBinding,
        expectedCheckpointGeneration: checkpoint.checkpointGeneration,
        expectedPreviousCursor: checkpoint.cursor,
        cursor: committedCursor,
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
      (change) =>
        change.entityType === 'ModelCollectionMembership' &&
        change.operation !== 'Delete',
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
          continue;
        } else {
          const timestamp = value.updatedAt ?? change.timestamp;
          result.push({
            entityType: change.entityType,
            localId:
              existing?.localId ??
              stableLocalId('collection', profile.id, value.id),
            remoteId: value.id,
            revision: value.revision,
            journalRevision: change.revision,
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
        if (!value) {
          continue;
        }
        result.push({
          entityType: change.entityType,
          localId:
            existing?.localId ?? stableLocalId('tag', profile.id, value.id),
          remoteId: value.id,
          revision: value.revision,
          journalRevision: change.revision,
          concurrencyToken: value.concurrencyToken,
          tombstone: false,
          visibility: change.visibility,
          snapshot: value,
        });
        continue;
      }
      const value = memberships.get(change.entityId);
      if (!value) {
        continue;
      }
      result.push({
        entityType: change.entityType,
        localId:
          existing?.localId ??
          stableLocalId('membership', profile.id, value.id),
        remoteId: value.id,
        revision: value.revision,
        journalRevision: change.revision,
        concurrencyToken: null,
        tombstone: false,
        visibility: change.visibility,
        snapshot: value,
      });
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
    const collections = await this.remote.getCollections(
      profile.id,
      profile.baseUrl,
      signal,
    );
    for (let offset = 0; offset < collections.length; offset += 6) {
      if (unresolved.size === 0) break;
      const page = collections.slice(offset, offset + 6);
      const memberPages = await Promise.all(
        page.map((collection) =>
          this.remote.getCollectionMembers(
            profile.id,
            profile.baseUrl,
            collection.id,
            signal,
          ),
        ),
      );
      for (const members of memberPages) {
        for (const member of members ?? []) {
          if (unresolved.delete(member.id)) found.set(member.id, member);
        }
      }
    }
    return found;
  }

  private async reconcileUncertain(
    profile: ServerProfile,
    profileBinding: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    const uncertain = await this.sidecar.listOutboundOperations(
      profile.id,
      ['uncertain'],
      PULL_LIMIT,
    );
    const groups = groupBatches(uncertain);
    for (const operations of groups) {
      this.assertCurrent(profile.id, generation, signal);
      const translated = await this.translateOperations(profile.id, operations);
      const effects = await Promise.all(
        translated.map(({ wire }) =>
          this.remoteEffectMatches(profile, wire, signal),
        ),
      );
      if (!effects.every(Boolean)) continue;
      const first = operations[0]!;
      await this.sidecar.reconcileUncertainBatch({
        profileId: profile.id,
        profileBinding,
        batchId: first.batchId,
        batchIncarnation: first.batchIncarnation,
        expectedAttemptToken: first.attemptToken!,
        resolution: 'acked',
        reconciledAt: toUnixSeconds(this.now()),
        operations: translated.map(({ operation }) => ({
          operationId: operation.operationId,
          baseRevision: operation.baseRevision,
          concurrencyToken: operation.concurrencyToken,
        })),
      });
    }
  }

  private async push(
    profile: ServerProfile,
    profileBinding: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    while (true) {
      this.assertCurrent(profile.id, generation, signal);
      await this.assertProfileBinding(profile, profileBinding);
      const claimed = await this.sidecar.claimOutboundOperations(
        profile.id,
        profileBinding,
        PULL_LIMIT,
        toUnixSeconds(this.now()),
        OUTBOX_LEASE_SECONDS,
      );
      if (!claimed) return;
      let translated: TranslatedOperation[];
      try {
        translated = await this.translateOperations(
          profile.id,
          claimed.operations,
        );
      } catch {
        const failedAt = toUnixSeconds(this.now());
        await this.sidecar.failOutboundBatch({
          profileId: profile.id,
          profileBinding,
          batchId: claimed.batchId,
          batchIncarnation: claimed.batchIncarnation,
          leaseToken: claimed.leaseToken,
          outcome: 'definiteTransient',
          error: 'Outbound prerequisites are not available.',
          failedAt,
          retryAt: failedAt + 30,
        });
        this.update(profile.id, { nextRetryAt: this.now() + 30_000 });
        return;
      }
      let response: ApplyResult;
      try {
        response = await this.remote.apply(
          profile.id,
          profile.baseUrl,
          {
            operations: translated.map(({ wire }) => wire),
          },
          signal,
        );
        this.assertCurrent(profile.id, generation, signal);
        await this.assertProfileBinding(profile, profileBinding);
      } catch (error) {
        await this.handlePushFailure(claimed, profileBinding, error);
        if (error instanceof SyncHttpError && error.code === 'cancelled')
          throw error;
        return;
      }
      if (response.kind === 'success') {
        const associated = associateApplied(translated, response.value.applied);
        const authoritative = new Map<string, CollectionSnapshot>();
        for (const { operation, applied } of associated) {
          if (
            applied.entityType === 'ModelCollection' &&
            applied.operation !== 'Delete'
          ) {
            const current = await this.remote.getCollection(
              profile.id,
              profile.baseUrl,
              applied.entityId,
              signal,
            );
            if (!current) {
              throw new SyncHttpError(
                'transport',
                'Applied collection could not be authoritatively refreshed.',
                null,
                null,
                true,
              );
            }
            authoritative.set(operation.operationId, current);
          }
        }
        await this.sidecar.settleOutboundBatch({
          profileId: profile.id,
          profileBinding,
          batchId: claimed.batchId,
          batchIncarnation: claimed.batchIncarnation,
          leaseToken: claimed.leaseToken,
          settledAt: toUnixSeconds(this.now()),
          serverRevision: response.value.serverRevision,
          applied: associated.map(({ operation, applied, submitted }) => ({
            operationId: operation.operationId,
            remoteId:
              applied.entityId === '00000000-0000-0000-0000-000000000000'
                ? submitted.entityId
                : applied.entityId,
            revision:
              authoritative.get(operation.operationId)?.revision ??
              applied.revision,
            concurrencyToken:
              authoritative.get(operation.operationId)?.concurrencyToken ??
              operation.concurrencyToken,
          })),
          conflicts: [],
        });
        this.update(profile.id, {
          pushedOperations:
            this.currentStatus(profile.id).pushedOperations +
            claimed.operations.length,
        });
      } else {
        const associated = associateConflicts(
          translated,
          response.value.conflicts,
        );
        await this.sidecar.settleOutboundBatch({
          profileId: profile.id,
          profileBinding,
          batchId: claimed.batchId,
          batchIncarnation: claimed.batchIncarnation,
          leaseToken: claimed.leaseToken,
          settledAt: toUnixSeconds(this.now()),
          serverRevision: response.value.serverRevision,
          applied: [],
          conflicts: associated.map(({ conflict, operation }) => {
            return {
              operationId: operation.operationId,
              conflict: {
                conflictId: stableConflictId(
                  claimed.batchIncarnation,
                  operation.operationId,
                ),
                entityType: conflict.entityType,
                entityId: conflict.entityId,
                localPayload: operation.payload,
                serverPayload: conflict.server,
                submittedPayload: conflict.submitted,
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

  private async translateOperations(
    profileId: string,
    operations: SidecarOutboundOperation[],
  ): Promise<TranslatedOperation[]> {
    const createdCollections = new Map<string, string>();
    for (const operation of operations) {
      if (
        operation.entityType === 'ModelCollection' &&
        operation.operation === 'Create'
      ) {
        createdCollections.set(
          operation.entityId,
          requireGuid(readString(operation.payload, 'remoteId'), 'remoteId'),
        );
      }
    }
    const translated: TranslatedOperation[] = [];
    for (const operation of operations) {
      if (operation.entityType === 'Tag') {
        throw new Error('Tags are pull-only and cannot be pushed.');
      }
      const payload = asRecord(operation.payload);
      let entityId: string;
      let resolvedMapping: SidecarEntityRevision | null = null;
      if (operation.operation === 'Create') {
        entityId = requireGuid(readString(payload, 'remoteId'), 'remoteId');
      } else {
        resolvedMapping = await this.sidecar.getSyncEntityRevisionByLocal(
          profileId,
          operation.entityType,
          operation.entityId,
        );
        entityId = requireGuid(resolvedMapping?.remoteId ?? '', 'entityId');
      }
      let collectionId: string | null = null;
      let modelId: string | null = null;
      if (operation.entityType === 'ModelCollectionMembership') {
        const localCollectionId = readString(payload, 'collectionId');
        collectionId =
          createdCollections.get(localCollectionId) ??
          requireGuid(
            (
              await this.sidecar.getSyncEntityRevisionByLocal(
                profileId,
                'ModelCollection',
                localCollectionId,
              )
            )?.remoteId ?? '',
            'collectionId',
          );
        const modelHash = readString(payload, 'modelHash');
        const link = await this.sidecar.getRemoteModelLink(
          profileId,
          modelHash,
        );
        if (link?.uploadStatus !== 'uploaded') {
          throw new Error('Membership model upload is not complete.');
        }
        modelId = requireGuid(link.remoteModelId, 'modelId');
      }
      translated.push({
        operation,
        wire: {
          entityType: operation.entityType,
          operation: operation.operation,
          entityId,
          baseRevision:
            operation.baseRevision ?? resolvedMapping?.revision ?? null,
          concurrencyToken:
            operation.concurrencyToken ??
            resolvedMapping?.concurrencyToken ??
            null,
          collectionId,
          modelId,
          name:
            operation.entityType === 'ModelCollection' &&
            operation.operation !== 'Delete'
              ? readString(payload, 'name')
              : null,
          description: readNullableString(payload, 'description'),
          isShared: readNullableBoolean(payload, 'isShared'),
        },
      });
    }
    return translated;
  }

  private async remoteEffectMatches(
    profile: ServerProfile,
    wire: ApplyOperationRequest,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (wire.entityType === 'ModelCollection') {
      const current = await this.remote.getCollection(
        profile.id,
        profile.baseUrl,
        wire.entityId,
        signal,
      );
      if (wire.operation === 'Delete') return current === null;
      return (
        current !== null &&
        current.name === wire.name &&
        current.description === wire.description &&
        current.isShared === wire.isShared
      );
    }
    if (wire.entityType === 'ModelCollectionMembership') {
      if (!wire.collectionId || !wire.modelId) return false;
      const members = await this.remote.getCollectionMembers(
        profile.id,
        profile.baseUrl,
        wire.collectionId,
        signal,
      );
      if (members === null) return false;
      const exists = members.some(
        (member) =>
          member.id === wire.entityId &&
          member.collectionId === wire.collectionId &&
          member.modelId === wire.modelId,
      );
      return wire.operation === 'Delete' ? !exists : exists;
    }
    return false;
  }

  private async handlePushFailure(
    claimed: SidecarClaimedOutboundBatch,
    profileBinding: string,
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
        mapped.code === 'server');
    const retryDelay = mapped.retryAfterMs ?? retryBackoff(claimed.operations);
    const failedAt = toUnixSeconds(this.now());
    await this.sidecar.failOutboundBatch({
      profileId: claimed.profileId,
      profileBinding,
      batchId: claimed.batchId,
      batchIncarnation: claimed.batchIncarnation,
      leaseToken: claimed.leaseToken,
      outcome: mapped.ambiguous
        ? 'ambiguous'
        : retryable
          ? 'definiteTransient'
          : 'definitePermanent',
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

  private async authenticatedContext(
    profile: ServerProfile,
  ): Promise<{ binding: string }> {
    if (this.profiles.getAuthenticatedContext) {
      return this.profiles.getAuthenticatedContext(profile.id, profile.baseUrl);
    }
    return {
      binding: createHash('sha256')
        .update(profile.id)
        .update('\0')
        .update(profile.baseUrl)
        .digest('hex'),
    };
  }

  private async assertProfileBinding(
    profile: ServerProfile,
    expectedBinding: string,
  ): Promise<void> {
    const current = await this.authenticatedContext(profile);
    if (current.binding !== expectedBinding) {
      throw new SyncEngineError(
        'CANCELLED',
        'The server profile changed during synchronization.',
      );
    }
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
    revision: existing?.revision ?? 0,
    journalRevision: change.revision,
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

function retryBackoff(operations: SidecarOutboundOperation[]): number {
  const attempts = Math.max(
    ...operations.map((operation) => operation.attemptCount),
  );
  return Math.min(
    5 * 60_000,
    1000 * 2 ** Math.min(8, Math.max(0, attempts - 1)),
  );
}

function associateApplied(
  translated: TranslatedOperation[],
  applied: AppliedOperation[],
): Array<{
  operation: SidecarOutboundOperation;
  applied: AppliedOperation;
  submitted: ApplyOperationRequest;
}> {
  if (translated.length !== applied.length) {
    throw new Error('Apply success did not cover the complete logical batch.');
  }
  return applied.map((result, index) => {
    const entry = translated[index]!;
    if (
      entry.wire.entityType !== result.entityType ||
      entry.wire.operation !== result.operation ||
      (result.entityType !== 'ModelCollectionMembership' &&
        entry.wire.entityId !== result.entityId)
    ) {
      throw new Error(
        'Apply success order/type did not match the submitted batch.',
      );
    }
    return {
      operation: entry.operation,
      applied: result,
      submitted: entry.wire,
    };
  });
}

function associateConflicts(
  translated: TranslatedOperation[],
  conflicts: ApplyConflict[],
): Array<{ operation: SidecarOutboundOperation; conflict: ApplyConflict }> {
  const remaining = [...translated];
  return conflicts.map((conflict) => {
    const index = remaining.findIndex(
      ({ wire }) =>
        wire.entityType === conflict.entityType &&
        wire.entityId === conflict.entityId,
    );
    if (index < 0) {
      throw new Error(
        'Apply conflict referenced an operation outside the batch.',
      );
    }
    const [entry] = remaining.splice(index, 1);
    return { operation: entry!.operation, conflict };
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Outbound operation payload must be an object.');
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown, key: string): string {
  const field = asRecord(value)[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new Error(`Outbound operation requires ${key}.`);
  }
  return field;
}

function readNullableString(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const field = value[key];
  if (field === undefined || field === null) return null;
  if (typeof field !== 'string') {
    throw new Error(`Outbound operation ${key} must be a string or null.`);
  }
  return field;
}

function readNullableBoolean(
  value: Record<string, unknown>,
  key: string,
): boolean | null {
  const field = value[key];
  if (field === undefined || field === null) return null;
  if (typeof field !== 'boolean') {
    throw new Error(`Outbound operation ${key} must be a boolean or null.`);
  }
  return field;
}

function requireGuid(value: string, name: string): string {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new Error(`Outbound ${name} must be a server GUID.`);
  }
  return value;
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
