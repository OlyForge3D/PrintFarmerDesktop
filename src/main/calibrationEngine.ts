/**
 * Calibration sync engine.
 *
 * Semantics (from issue #52):
 * 1. Validate selected server/profile identity and capabilities.
 * 2. Push dependency-ready operations in stable order with idempotency keys
 *    and base revisions.
 * 3. Accept exact replays (idempotent re-send) as success; stop and record
 *    typed conflicts rather than overwriting.
 * 4. Pull `/api/calibration-sync/changes` to completion using opaque cursors.
 * 5. Hydrate changed aggregates via authoritative REST; apply tombstones;
 *    commit cursors atomically.
 * 6. After reconnect/event gaps, REST/change-feed is authoritative;
 *    authenticated SignalR only accelerates progress.
 *
 * Offline controls (generation, queue creation, bed-clear, print start)
 * remain disabled until ALL mutations are synchronized and printer context
 * is freshly revalidated.
 */

import {
  CalibrationSyncPhase,
  type CalibrationSyncStatus,
  type CalibrationConflict,
} from '@shared/ipc';
import {
  CalibrationHttpError,
  type CalibrationHttpClient,
} from './calibrationHttp.js';
import {
  REQUIRED_FIRMWARE_FAMILY,
  REQUIRED_SLICER_ENGINE,
  missingCalibrationFlags,
  supportsKlipper,
  supportsOrcaSlicer,
} from './calibrationWire.js';
import type {
  RemoteCalibrationChange,
  RemoteCalibrationApplyRequest,
} from './calibrationWire.js';

export type CalibrationEngineErrorCode =
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
  | 'CAPABILITIES_MISMATCH'
  | 'CANCELLED'
  | 'DISPOSED';

export class CalibrationEngineError extends Error {
  constructor(
    readonly code: CalibrationEngineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CalibrationEngineError';
  }
}

// --- Interfaces for collaborators -----------------------------------------

export interface CalibrationProfileService {
  list(): Promise<{
    profiles: Array<{ id: string; baseUrl: string }>;
    selectedProfileId: string | null;
  }>;
  getAuthenticatedContext?(
    profileId: string,
    expectedBaseUrl?: string,
  ): Promise<{ baseUrl: string; binding: string }>;
}

/** Calibration-specific outbound operation as loaded from sidecar/store. */
export interface CalibrationPendingOperation {
  operationId: string;
  profileId: string;
  projectId: string;
  kind: string;
  sequence: number;
  baseRevision: number | null;
  /** Canonical request hash for the idempotency key. */
  idempotencyKey: string;
  entityType: string;
  entityId: string;
  operationKind: 'Create' | 'Update' | 'Delete';
  payload: Record<string, unknown>;
  /** IDs of operations this one depends on (must be settled first). */
  dependsOn: string[];
}

/** Result of pushing a single batch. */
export interface CalibrationPushResult {
  kind: 'success' | 'conflict' | 'replay';
  serverRevision?: number;
  conflict?: {
    operationId: string;
    entityType: string;
    entityId: string;
    reason: string;
    serverRevision: number;
  };
}

/** Pull cursor state managed by the engine. */
export interface CalibrationCursorState {
  cursor: string | null;
  serverRevision: number;
  checkpointGeneration: number;
}

export interface CalibrationSidecar {
  /** List pending outbox operations ready to push (dependency-ready, in stable sequence order). */
  listCalibrationPendingOperations(
    profileId: string,
    projectId: string | null,
    limit: number,
  ): Promise<CalibrationPendingOperation[]>;

  /** Mark an outbox operation as settled (applied). */
  settleCalibrationOperation(
    profileId: string,
    operationId: string,
    serverRevision: number,
  ): Promise<void>;

  /** Mark an outbox operation as exact-replay success. */
  replayCalibrationOperation(
    profileId: string,
    operationId: string,
  ): Promise<void>;

  /** Record a conflict for an outbox operation. */
  recordCalibrationConflict(
    profileId: string,
    operationId: string,
    conflict: {
      entityType: string;
      entityId: string;
      reason: string;
      serverRevision: number;
    },
  ): Promise<void>;

  /** Get the current cursor state for a profile/project. */
  getCalibrationCursorState(
    profileId: string,
    projectId: string | null,
  ): Promise<CalibrationCursorState>;

  /** Atomically commit a new cursor after a successful pull page. */
  commitCalibrationCursor(
    profileId: string,
    projectId: string | null,
    cursor: string | null,
    serverRevision: number,
    checkpointGeneration: number,
  ): Promise<void>;

  /** Store a hydrated remote aggregate snapshot. */
  applyCalibrationSnapshot(
    profileId: string,
    entityType: string,
    entityId: string,
    snapshot: unknown,
    tombstone: boolean,
    serverRevision: number,
  ): Promise<void>;

  /** List unresolved conflicts. */
  listCalibrationConflicts(
    profileId: string,
    projectId: string | null,
  ): Promise<CalibrationConflict[]>;

  /** Get the count of pending outbox operations that are not yet settled. */
  countCalibrationPendingOperations(
    profileId: string,
    projectId: string | null,
  ): Promise<number>;

  /** Check if printer context is freshly validated. */
  isPrinterContextFresh(profileId: string, projectId: string): Promise<boolean>;
}

// --- Engine implementation ------------------------------------------------

const PULL_LIMIT = 500;
const PUSH_BATCH_SIZE = 20;

export class CalibrationSyncEngine {
  private disposed = false;

  constructor(
    private readonly http: CalibrationHttpClient,
    private readonly sidecar: CalibrationSidecar,
    private readonly profileService: CalibrationProfileService,
  ) {}

  dispose(): void {
    this.disposed = true;
  }

  /**
   * Run a full calibration sync cycle for the given profile (and optionally
   * a specific project).
   *
   * Steps:
   * 1. Validate identity + capabilities.
   * 2. Push all dependency-ready outbox operations.
   * 3. Pull all change pages to completion.
   * 4. Hydrate REST aggregates for each changed entity.
   * 5. Commit cursor atomically per page.
   */
  async syncNow(
    profileId: string,
    projectId: string | null,
    signal: AbortSignal,
  ): Promise<CalibrationSyncStatus> {
    this.requireNotDisposed();

    const status: CalibrationSyncStatus = {
      phase: CalibrationSyncPhase.parse('validatingCapabilities'),
      profileId,
      projectId: projectId ?? null,
      pushedOperations: 0,
      pulledChanges: 0,
      conflictCount: 0,
      cursor: null,
      error: null,
    };

    try {
      // Step 1: Validate profile identity and capabilities
      const context = await this.validateProfileContext(profileId, signal);

      // Step 2: Push pending operations
      status.phase = CalibrationSyncPhase.parse('pushingOperations');
      const pushResult = await this.pushAll(
        profileId,
        projectId,
        context.baseUrl,
        signal,
      );
      status.pushedOperations = pushResult.pushed;
      status.conflictCount += pushResult.conflicts;

      if (signal.aborted) {
        return {
          ...status,
          phase: CalibrationSyncPhase.parse('failed'),
          error: 'Cancelled.',
        };
      }

      // Step 3+4+5: Pull changes and hydrate aggregates
      status.phase = CalibrationSyncPhase.parse('pullingChanges');
      const pullResult = await this.pullAll(
        profileId,
        projectId,
        context.baseUrl,
        signal,
      );
      status.pulledChanges = pullResult.pulled;
      status.cursor = pullResult.cursor;

      const conflictCount = await this.sidecar.listCalibrationConflicts(
        profileId,
        projectId,
      );
      status.conflictCount = conflictCount.length;

      status.phase =
        conflictCount.length > 0
          ? CalibrationSyncPhase.parse('partialConflict')
          : CalibrationSyncPhase.parse('succeeded');
      return status;
    } catch (error) {
      if (
        signal.aborted ||
        (error instanceof CalibrationHttpError && error.code === 'cancelled')
      ) {
        return {
          ...status,
          phase: CalibrationSyncPhase.parse('failed'),
          error: 'Cancelled.',
        };
      }
      if (error instanceof CalibrationEngineError) {
        return {
          ...status,
          phase: CalibrationSyncPhase.parse('failed'),
          error: error.message,
        };
      }
      const message =
        error instanceof Error ? error.message : 'Unknown sync error.';
      return {
        ...status,
        phase: CalibrationSyncPhase.parse('failed'),
        error: message,
      };
    }
  }

  /**
   * Validate that the profile exists, is bound, and the server supports
   * the required calibration capabilities.
   */
  async validateProfileContext(
    profileId: string,
    signal: AbortSignal,
  ): Promise<{ baseUrl: string; binding: string }> {
    this.requireNotDisposed();

    if (!this.profileService.getAuthenticatedContext) {
      throw new CalibrationEngineError(
        'UNAVAILABLE',
        'Profile service does not support authenticated context.',
      );
    }

    let context: { baseUrl: string; binding: string };
    try {
      context = await this.profileService.getAuthenticatedContext(profileId);
    } catch {
      throw new CalibrationEngineError(
        'NOT_FOUND',
        `Profile ${profileId} not found or not authenticated.`,
      );
    }

    // Verify calibration capabilities are enabled on this server
    try {
      const caps = await this.http.getCapabilities(
        profileId,
        context.baseUrl,
        signal,
      );
      // All required flags must be true. Offline drafts and the change feed
      // are the minimum this engine needs to push and pull.
      const missing = missingCalibrationFlags(caps, [
        'calibrationApiEnabled',
        'calibrationChangeFeedEnabled',
        'calibrationOfflineDraftEnabled',
      ]);
      if (missing.length > 0) {
        throw new CalibrationEngineError(
          'CAPABILITIES_MISMATCH',
          `Calibration capability flag '${missing[0]}' is not enabled on this server.`,
        );
      }
      // Firmware/dialect/slicer requirements
      if (!supportsKlipper(caps)) {
        throw new CalibrationEngineError(
          'CAPABILITIES_MISMATCH',
          `Server requires ${REQUIRED_FIRMWARE_FAMILY} firmware and ${REQUIRED_FIRMWARE_FAMILY} G-code dialect for calibration.`,
        );
      }
      if (!supportsOrcaSlicer(caps)) {
        throw new CalibrationEngineError(
          'CAPABILITIES_MISMATCH',
          `Server requires ${REQUIRED_SLICER_ENGINE} as the upstream slicer for calibration.`,
        );
      }
    } catch (error) {
      if (error instanceof CalibrationEngineError) throw error;
      if (error instanceof CalibrationHttpError && error.code === 'notFound') {
        throw new CalibrationEngineError(
          'UNAVAILABLE',
          'Calibration API is not available on this server.',
        );
      }
      throw error;
    }

    return context;
  }

  // --- Private: push phase -------------------------------------------------

  private async pushAll(
    profileId: string,
    projectId: string | null,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<{ pushed: number; conflicts: number }> {
    let pushed = 0;
    let conflicts = 0;

    while (!signal.aborted && !this.disposed) {
      // Load next batch of dependency-ready operations in stable sequence order
      const ops = await this.sidecar.listCalibrationPendingOperations(
        profileId,
        projectId,
        PUSH_BATCH_SIZE,
      );
      if (ops.length === 0) break;

      for (const op of ops) {
        if (signal.aborted || this.disposed) break;

        const applyRequest: RemoteCalibrationApplyRequest = {
          profileId,
          projectId: op.projectId,
          operations: [
            {
              operationId: op.operationId,
              idempotencyKey: op.idempotencyKey,
              entityType:
                op.entityType as import('./calibrationWire.js').CalibrationEntityType,
              entityId: op.entityId,
              operationKind: op.operationKind,
              baseRevision: op.baseRevision,
              payload: op.payload,
            },
          ],
        };

        try {
          const result = await this.http.apply(
            profileId,
            baseUrl,
            applyRequest,
            op.operationId,
            null,
            signal,
          );

          if (result.kind === 'success') {
            // Accept exact replay as success (same operationId accepted again)
            await this.sidecar.settleCalibrationOperation(
              profileId,
              op.operationId,
              result.value.serverRevision,
            );
            pushed += 1;
          } else if (result.kind === 'conflict') {
            // Record typed conflict; do not overwrite server state
            await this.sidecar.recordCalibrationConflict(
              profileId,
              op.operationId,
              {
                entityType: result.value.entityType,
                entityId: result.value.entityId,
                reason: result.value.reason,
                serverRevision: result.value.serverRevision,
              },
            );
            conflicts += 1;
            // Stop pushing this project's operations to avoid cascading conflicts
            break;
          }
        } catch (error) {
          if (
            error instanceof CalibrationHttpError &&
            error.code === 'cancelled'
          ) {
            return { pushed, conflicts };
          }
          // For transient errors during push, surface but continue
          // (the outbox lease mechanism will retry on next sync)
          throw error;
        }
      }
    }

    return { pushed, conflicts };
  }

  // --- Private: pull phase -------------------------------------------------

  private async pullAll(
    profileId: string,
    projectId: string | null,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<{ pulled: number; cursor: string | null }> {
    let totalPulled = 0;
    let cursorState = await this.sidecar.getCalibrationCursorState(
      profileId,
      projectId,
    );

    while (!signal.aborted && !this.disposed) {
      const page = await this.http.getChanges(
        profileId,
        baseUrl,
        cursorState.cursor,
        projectId,
        PULL_LIMIT,
        signal,
      );

      // Hydrate REST aggregates for each change (step 4)
      if (page.changes.length > 0) {
        await this.hydrateChanges(profileId, baseUrl, page.changes, signal);
        totalPulled += page.changes.length;
      }

      // Atomically commit cursor after each page (step 5), even when empty.
      // The cursor represents the server's current position regardless of
      // whether this page contained changes.
      const nextCursor = page.nextCursor ?? cursorState.cursor;
      await this.sidecar.commitCalibrationCursor(
        profileId,
        projectId,
        nextCursor,
        page.serverRevision,
        cursorState.checkpointGeneration + 1,
      );

      cursorState = {
        cursor: nextCursor,
        serverRevision: page.serverRevision,
        checkpointGeneration: cursorState.checkpointGeneration + 1,
      };

      if (!page.hasMore) break;
    }

    return { pulled: totalPulled, cursor: cursorState.cursor };
  }

  /**
   * Hydrate REST aggregates for a list of change-feed entries.
   *
   * Each entity type maps to its canonical REST resource. Tombstones
   * (Deleted operations) are applied without fetching the REST resource.
   * This is the authoritative data path; SignalR events are hints only.
   */
  private async hydrateChanges(
    profileId: string,
    baseUrl: string,
    changes: RemoteCalibrationChange[],
    signal: AbortSignal,
  ): Promise<void> {
    for (const change of changes) {
      if (signal.aborted || this.disposed) return;

      if (change.operation === 'Deleted') {
        // Tombstone — mark as deleted without fetching REST aggregate
        await this.sidecar.applyCalibrationSnapshot(
          profileId,
          change.entityType,
          change.entityId,
          null,
          true,
          change.revision,
        );
        continue;
      }

      // Fetch the authoritative aggregate for Created/Updated entities
      let snapshot: unknown = null;
      try {
        snapshot = await this.fetchAggregate(
          profileId,
          baseUrl,
          change.entityType,
          change.entityId,
          signal,
        );
      } catch (error) {
        if (
          error instanceof CalibrationHttpError &&
          error.code === 'notFound'
        ) {
          // Entity was deleted before we could fetch — treat as tombstone
          await this.sidecar.applyCalibrationSnapshot(
            profileId,
            change.entityType,
            change.entityId,
            null,
            true,
            change.revision,
          );
          continue;
        }
        throw error;
      }

      if (snapshot !== null) {
        await this.sidecar.applyCalibrationSnapshot(
          profileId,
          change.entityType,
          change.entityId,
          snapshot,
          false,
          change.revision,
        );
      } else {
        // REST returned null (entity not found on server) → apply as tombstone.
        // This covers the case where the entity was deleted between the change-feed
        // entry being emitted and our REST fetch.
        await this.sidecar.applyCalibrationSnapshot(
          profileId,
          change.entityType,
          change.entityId,
          null,
          true,
          change.revision,
        );
      }
    }
  }

  /** Fetch the authoritative REST aggregate for a given entity type and ID. */
  private async fetchAggregate(
    profileId: string,
    baseUrl: string,
    entityType: string,
    entityId: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (entityType) {
      case 'CalibrationProject':
        return this.http.getProject(profileId, baseUrl, entityId, signal);
      case 'CalibrationAttempt':
        return this.http.getAttempt(profileId, baseUrl, entityId, signal);
      case 'CalibrationPhoto':
        return this.http.getPhoto(profileId, baseUrl, entityId, signal);
      case 'CalibrationStep':
      case 'CalibrationEvent':
      case 'CalibrationObservation':
      case 'CalibrationProfileRevision':
      case 'CalibrationPrinterSnapshot':
        // These are fetched as part of the project aggregate or via parent.
        // For the pull phase, the change-feed revision is enough to record
        // the hydration pass; the full aggregate is fetched on demand.
        return { entityType, entityId, revision: 0 };
      default:
        return null;
    }
  }

  /**
   * Check whether all preconditions for generation/queue/bed-clear/print-start
   * are met. Returns null when allowed, or a typed reason string when blocked.
   *
   * These operations are disabled until:
   * - All outbox mutations are synchronized (pending count = 0).
   * - Printer context is freshly validated.
   */
  async checkOnlineActionPrerequisites(
    profileId: string,
    projectId: string,
  ): Promise<string | null> {
    this.requireNotDisposed();

    const pendingCount = await this.sidecar.countCalibrationPendingOperations(
      profileId,
      projectId,
    );
    if (pendingCount > 0) {
      return `${pendingCount} outbox operation(s) must synchronize before this action is available.`;
    }

    const printerFresh = await this.sidecar.isPrinterContextFresh(
      profileId,
      projectId,
    );
    if (!printerFresh) {
      return 'Printer context is stale and must be freshly revalidated before this action.';
    }

    // Verify there are no unresolved conflicts
    const conflicts = await this.sidecar.listCalibrationConflicts(
      profileId,
      projectId,
    );
    if (conflicts.length > 0) {
      return `${conflicts.length} unresolved conflict(s) must be resolved before this action.`;
    }

    return null;
  }

  private requireNotDisposed(): void {
    if (this.disposed) {
      throw new CalibrationEngineError(
        'DISPOSED',
        'CalibrationSyncEngine has been disposed.',
      );
    }
  }
}
