import { spawn } from 'node:child_process';
import path from 'node:path';
import type { CalibrationWorkspaceStageId } from '@shared/ipc';
import { emitCalibrationLog } from './calibrationLog.js';

/**
 * Supervised client for the Rust `model-core` sidecar.
 *
 * The sidecar is a separate process that speaks newline-delimited JSON-RPC over
 * stdio (see `native/model-core/src/serve.rs`). This client owns its lifecycle:
 * it lazily starts the process, correlates responses to requests by id, times
 * out stuck calls, and transparently restarts a crashed sidecar on the next
 * request (up to a bounded number of consecutive failures).
 *
 * The transport is injected as a {@link ChannelFactory} so the framing and
 * supervision logic can be unit-tested without spawning a real process.
 */

/** A duplex, line-oriented channel to one running sidecar process. */
export interface SidecarChannel {
  /** Send a single request line (no trailing newline required). */
  send(line: string): void;
  /** Register the handler invoked once per received response line. */
  onMessage(handler: (line: string) => void): void;
  /** Register the handler invoked when the process/channel closes. */
  onClose(handler: (info: { code: number | null }) => void): void;
  /** Terminate the channel and its process. */
  close(): void;
}

/** Creates a fresh channel bound to a newly spawned sidecar process. */
export type ChannelFactory = () => SidecarChannel;

interface ResponseEnvelope {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** Default per-request timeout. Parsing a very large model can be slow. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
export const SIDECAR_RPC_PROTOCOL_VERSION = 1 as const;
/** Imports get a longer watchdog; expiry terminates the mutating sidecar. */
export const DEFAULT_MUTATION_TIMEOUT_MS = 15 * 60_000;
/** Maximum wait for a killed sidecar to confirm process closure. */
export const DEFAULT_TERMINATION_TIMEOUT_MS = 10_000;

/** How many times the sidecar may fail to produce a response before we give up. */
export const MAX_CONSECUTIVE_FAILURES = 5;

export interface SidecarClientOptions {
  requestTimeoutMs?: number;
  mutationTimeoutMs?: number;
  terminationTimeoutMs?: number;
  maxConsecutiveFailures?: number;
  serializeRequests?: boolean;
  requireProtocolHandshake?: boolean;
}

export interface SidecarHandshake {
  protocolVersion: number;
  sidecarVersion: string;
  sceneDtoVersion?: number;
  parserSemanticsVersion?: number;
  sceneCacheRecipe?: string;
}

export interface RecipeBoundScene {
  scene: unknown;
  cacheRecipe?: string;
}

/** Private main-process-only native target reference. Never expose this to IPC. */
export type RetargetTargetReference =
  | { kind: 'bundled'; targetProfileId: string }
  | { kind: 'imported'; path: string; expectedSha256: string };

export type SidecarSyncEntityType =
  'ModelCollection' | 'ModelCollectionMembership' | 'Tag';
export type SidecarSyncOperation = 'Create' | 'Update' | 'Delete';
export type SidecarSyncVisibility = 'Private' | 'Shared';
export type SidecarOutboundState =
  'pending' | 'inFlight' | 'uncertain' | 'failed' | 'acked';

export interface SidecarSyncStatus {
  profileId: string;
  cursor: string | null;
  serverRevision: number;
  checkpointGeneration: number;
  lastPulledAt: number | null;
  lastPushedAt: number | null;
  updatedAt: number;
}

export interface SidecarPullEntity {
  entityType: SidecarSyncEntityType;
  localId: string | null;
  remoteId: string;
  revision: number;
  journalRevision?: number;
  concurrencyToken: string | null;
  tombstone: boolean;
  visibility: SidecarSyncVisibility;
  snapshot: unknown;
}

export interface SidecarApplyPullBatch {
  profileId: string;
  profileBinding: string;
  expectedCheckpointGeneration: number;
  expectedPreviousCursor: string | null;
  cursor: string | null;
  serverRevision: number;
  appliedAt: number;
  entities: SidecarPullEntity[];
  conflicts: SidecarConflictInput[];
}

export interface SidecarEntityRevision extends SidecarPullEntity {
  profileId: string;
  updatedAt: number;
}

export interface SidecarRemoteModelLink {
  profileId: string;
  localModelHash: string;
  remoteModelId: string;
  clientUploadId: string;
  etag: string | null;
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  createdAt: number;
  updatedAt: number;
  uploadedAt: number | null;
}

export interface SidecarConflictInput {
  conflictId: string;
  entityType: SidecarSyncEntityType;
  entityId: string;
  localPayload: unknown;
  serverPayload: unknown;
  submittedPayload: unknown;
  reason: string;
  serverRevision: number;
  createdAt: number;
}

export interface SidecarOutboundOperation {
  profileId: string;
  operationId: string;
  sequence: number;
  batchId: string;
  batchIncarnation: string;
  batchOrdinal: number;
  entityType: SidecarSyncEntityType;
  operation: SidecarSyncOperation;
  entityId: string;
  payload: unknown;
  baseRevision: number | null;
  concurrencyToken: string | null;
  state: SidecarOutboundState;
  attemptCount: number;
  retryEligible: boolean;
  retryAt: number | null;
  leaseUntil: number | null;
  leaseToken: string | null;
  attemptToken: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  ackedAt: number | null;
}

export interface SidecarClaimedOutboundBatch {
  profileId: string;
  batchId: string;
  batchIncarnation: string;
  leaseToken: string;
  attemptToken: string;
  leaseUntil: number;
  operations: SidecarOutboundOperation[];
}

export type SidecarCalibrationProjectStatus =
  | 'draft'
  | 'inProgress'
  | 'awaitingGeneration'
  | 'generated'
  | 'complete'
  | 'archived';

export interface SaveCalibrationWorkspaceStateInput {
  profileId: string;
  projectId: string;
  displayName: string;
  description?: string | null;
  printerId: string;
  status: SidecarCalibrationProjectStatus;
  completedStepCount: number;
  totalStepCount: number;
  printerContextFresh: boolean;
  baseRevision?: number | null;
  operationId: string;
  idempotencyKey: string;
  workspaceState: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface SidecarCalibrationWorkspaceState {
  profileId: string;
  projectId: string;
  displayName: string;
  description: string | null;
  printerId: string;
  status: SidecarCalibrationProjectStatus;
  completedStepCount: number;
  totalStepCount: number;
  isSynced: boolean;
  isPrinterContextFresh: boolean;
  hasConflicts: boolean;
  remoteProjectId: string | null;
  baseRevision: number | null;
  createdAt: string;
  updatedAt: string;
  workspaceState: unknown;
}

export interface StageCalibrationPhotoInput {
  photoId: string;
  attemptId: string;
  stageId: CalibrationWorkspaceStageId;
  projectId: string;
  profileId: string;
  contentHash: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  byteSize: number;
  localPath: string;
  stagedAt: string;
  caption: string;
  order: number;
}

export interface SidecarStagedCalibrationPhoto {
  photoId: string;
  attemptId: string;
  stageId: CalibrationWorkspaceStageId;
  projectId: string;
  profileId: string;
  contentHash: string;
  mimeType: string;
  byteSize: number;
  status: string;
  uploadAttempts: number;
  remotePhotoId: string | null;
  remoteUrl: string | null;
  stagedAt: string;
  uploadedAt: string | null;
  caption: string;
  order: number;
}

interface RequestPolicy {
  timeoutMs: number;
  terminateOnTimeout: boolean;
}

export class SidecarClient {
  private disposed = false;
  private channel: SidecarChannel | null = null;
  private terminatingChannel: SidecarChannel | null = null;
  private terminationError: Error | null = null;
  private terminationTimer: ReturnType<typeof setTimeout> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private consecutiveFailures = 0;
  private readonly requestTimeoutMs: number;
  private readonly mutationTimeoutMs: number;
  private readonly terminationTimeoutMs: number;
  private readonly maxConsecutiveFailures: number;
  private readonly serializeRequests: boolean;
  private readonly requireProtocolHandshake: boolean;
  private serializedQueue: Promise<void> = Promise.resolve();
  private protocolChannel: SidecarChannel | null = null;
  private protocolReady: Promise<SidecarHandshake> | null = null;

  constructor(
    private readonly createChannel: ChannelFactory,
    options: SidecarClientOptions = {},
  ) {
    this.requestTimeoutMs =
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.mutationTimeoutMs =
      options.mutationTimeoutMs ?? DEFAULT_MUTATION_TIMEOUT_MS;
    this.terminationTimeoutMs =
      options.terminationTimeoutMs ?? DEFAULT_TERMINATION_TIMEOUT_MS;
    this.maxConsecutiveFailures =
      options.maxConsecutiveFailures ?? MAX_CONSECUTIVE_FAILURES;
    this.serializeRequests = options.serializeRequests ?? false;
    this.requireProtocolHandshake = options.requireProtocolHandshake ?? false;
  }

  /** Confirm the sidecar is alive and report its protocol/version. */
  async handshake(): Promise<SidecarHandshake> {
    const result = await this.request('handshake', {});
    validateHandshake(result);
    return result;
  }

  async sceneCacheRecipe(): Promise<string | undefined> {
    return this.enqueue(
      async () => (await this.ensureProtocol()).sceneCacheRecipe,
    );
  }

  /** Parse a model file into a normalized scene mesh (raw wire object). */
  async loadScene(filePath: string): Promise<unknown> {
    return this.request('loadScene', { path: filePath });
  }

  async loadSceneWithRecipe(filePath: string): Promise<RecipeBoundScene> {
    return this.enqueue(async () => {
      const handshake = await this.ensureProtocol();
      const channel = this.protocolChannel;
      if (!channel || channel !== this.channel) {
        throw new Error('sidecar restarted before the scene request');
      }
      const scene = await this.dispatchRequest(
        'loadScene',
        { path: filePath },
        {
          timeoutMs: this.requestTimeoutMs,
          terminateOnTimeout: false,
        },
        channel,
      );
      return handshake.sceneCacheRecipe
        ? { scene, cacheRecipe: handshake.sceneCacheRecipe }
        : { scene };
    });
  }

  async loadRetargetScene(filePath: string): Promise<unknown> {
    return this.retargetRequest('loadScene', { path: filePath });
  }

  async listRetargetProfiles(): Promise<unknown> {
    return this.request('listRetargetProfiles', {});
  }

  async inspectRetargetProfile(profileId: string): Promise<unknown> {
    return this.request('inspectRetargetProfile', { profileId });
  }

  async inspectImportedRetargetProfile(path: string): Promise<unknown> {
    return this.retargetRequest('inspectImportedRetargetProfile', { path });
  }

  async preflightRetarget(
    sourcePath: string,
    target: RetargetTargetReference,
    objectExclusion: boolean,
  ): Promise<unknown> {
    return this.retargetRequest('preflightRetarget', {
      sourcePath,
      target,
      objectExclusion,
    });
  }

  async buildRetarget(
    sourcePath: string,
    outputPath: string,
    target: RetargetTargetReference,
    objectExclusion: boolean,
  ): Promise<unknown> {
    return this.request(
      'buildRetarget',
      { sourcePath, outputPath, target, objectExclusion },
      { timeoutMs: this.mutationTimeoutMs, terminateOnTimeout: true },
    );
  }

  async validateRetargetOutput(
    sourcePath: string,
    outputPath: string,
    target: RetargetTargetReference,
    objectExclusion: boolean,
  ): Promise<unknown> {
    return this.retargetRequest('validateRetargetOutput', {
      sourcePath,
      outputPath,
      target,
      objectExclusion,
    });
  }

  /** Extract slicer-project (vendor) metadata from a 3MF file (raw wire object). */
  async extractVendorMetadata(filePath: string): Promise<unknown> {
    return this.request('extractVendorMetadata', { path: filePath });
  }

  /** Extract embedded vendor plate thumbnails (part names + base64 PNGs). */
  async extractVendorPlateThumbnails(filePath: string): Promise<unknown> {
    return this.request('extractVendorPlateThumbnails', { path: filePath });
  }

  /** Render a deterministic PNG thumbnail for a model (raw wire object). */
  async renderThumbnail(filePath: string, size?: number): Promise<unknown> {
    const params: { path: string; size?: number } = { path: filePath };
    if (size !== undefined) {
      params.size = size;
    }
    return this.request('renderThumbnail', params);
  }

  /** Scan a folder and reconcile it into the catalog (raw wire object). */
  async scanRoot(rootId: string, path: string): Promise<unknown> {
    return this.request('scanRoot', { rootId, path });
  }

  /** Inspect a folder's model hierarchy without mutating the catalog. */
  async previewImport(path: string): Promise<unknown> {
    return this.request('previewImport', { path });
  }

  /** Reconcile a folder and apply its confirmed organization rules. */
  async importRoot(
    rootId: string,
    path: string,
    rules: Array<{
      relativePath: string;
      kind: 'collection' | 'tag';
      name: string;
      collectionId?: string | undefined;
    }>,
    commonTags: string[],
  ): Promise<unknown> {
    return this.request(
      'importRoot',
      {
        rootId,
        path,
        rules,
        commonTags,
      },
      {
        timeoutMs: this.mutationTimeoutMs,
        terminateOnTimeout: true,
      },
    );
  }

  /** List every logical model known to the catalog (raw wire array). */
  async listModels(): Promise<unknown> {
    return this.request('listModels', {});
  }

  /** Clear indexed models and source roots while preserving source files. */
  async resetCatalog(): Promise<unknown> {
    return this.request(
      'resetCatalog',
      {},
      {
        timeoutMs: this.mutationTimeoutMs,
        terminateOnTimeout: true,
      },
    );
  }

  /** Persist a successful local-to-remote model upload mapping. */
  async linkRemoteModel(link: {
    profileId: string;
    localModelHash: string;
    remoteModelId: string;
    clientUploadId: string;
    etag: string | null;
    uploadStatus: 'uploaded';
    createdAt: number;
    updatedAt: number;
    uploadedAt: number | null;
  }): Promise<unknown> {
    return this.request('linkRemoteModel', link);
  }

  /** Return the durable profile/hash upload mapping, when one exists. */
  async getRemoteModelLink(
    profileId: string,
    serverBinding: string,
    hash: string,
  ): Promise<SidecarRemoteModelLink | null> {
    return (await this.request('getRemoteModelLink', {
      profileId,
      serverBinding,
      localModelHash: hash,
    })) as SidecarRemoteModelLink | null;
  }

  async removeRemoteModelLink(
    profileId: string,
    serverBinding: string,
    hash: string,
  ): Promise<unknown> {
    return this.request('removeRemoteModelLink', {
      profileId,
      serverBinding,
      localModelHash: hash,
    });
  }

  async purgeRemoteModelLinks(
    profileId: string,
    serverBinding: string,
  ): Promise<unknown> {
    return this.request('purgeRemoteModelLinks', {
      profileId,
      serverBinding,
    });
  }

  /** List every model hash marked as a local favorite. */
  async listFavorites(): Promise<unknown> {
    return this.request('listFavorites', {});
  }

  /** Favorite a model by content hash; returns all favorite hashes. */
  async addFavorite(hash: string): Promise<unknown> {
    return this.request('addFavorite', { hash });
  }

  /** Remove a model from favorites; returns all favorite hashes. */
  async removeFavorite(hash: string): Promise<unknown> {
    return this.request('removeFavorite', { hash });
  }

  /** List every tag known to the catalog (raw wire array). */
  async listTags(): Promise<unknown> {
    return this.request('listTags', {});
  }

  /** List the tags assigned to one model (raw wire array). */
  async tagsForModel(hash: string): Promise<unknown> {
    return this.request('tagsForModel', { hash });
  }

  /** Assign a tag to a model; returns the model's tags (raw wire array). */
  async addModelTag(hash: string, name: string): Promise<unknown> {
    return this.request('addModelTag', { hash, name });
  }

  /** Remove a tag from a model; returns the model's tags (raw wire array). */
  async removeModelTag(hash: string, tagId: string): Promise<unknown> {
    return this.request('removeModelTag', { hash, tagId });
  }

  /** List every collection known to the catalog (raw wire array). */
  async listCollections(): Promise<unknown> {
    return this.request('listCollections', {});
  }

  /** List the collections a model belongs to (raw wire array). */
  async collectionsForModel(hash: string): Promise<unknown> {
    return this.request('collectionsForModel', { hash });
  }

  /** Create a collection; returns the created collection (raw wire object). */
  async createCollection(name: string): Promise<unknown> {
    return this.mutationRequest('createCollection', { name });
  }

  async createCollectionWithSync(
    name: string,
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<unknown> {
    return this.mutationRequest('createCollectionWithSync', {
      name,
      profileId,
      profileBinding,
      now,
    });
  }

  /** Delete a collection; returns all collections (raw wire array). */
  async deleteCollection(id: string): Promise<unknown> {
    return this.mutationRequest('deleteCollection', { id });
  }

  async deleteCollectionWithSync(
    id: string,
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<unknown> {
    return this.mutationRequest('deleteCollectionWithSync', {
      id,
      profileId,
      profileBinding,
      now,
    });
  }

  async updateCollectionWithSync(
    id: string,
    name: string,
    isShared: boolean,
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<unknown> {
    return this.mutationRequest('updateCollectionWithSync', {
      id,
      name,
      isShared,
      profileId,
      profileBinding,
      now,
    });
  }

  /** Add a model to a collection; returns the model's collections. */
  async addModelToCollection(
    collectionId: string,
    hash: string,
  ): Promise<unknown> {
    return this.mutationRequest('addModelToCollection', { collectionId, hash });
  }

  async addModelToCollectionWithSync(
    collectionId: string,
    hash: string,
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<unknown> {
    return this.mutationRequest('addModelToCollectionWithSync', {
      id: collectionId,
      hash,
      profileId,
      profileBinding,
      now,
    });
  }

  /** Remove a model from a collection; returns the model's collections. */
  async removeModelFromCollection(
    collectionId: string,
    hash: string,
  ): Promise<unknown> {
    return this.mutationRequest('removeModelFromCollection', {
      collectionId,
      hash,
    });
  }

  async removeModelFromCollectionWithSync(
    collectionId: string,
    hash: string,
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<unknown> {
    return this.mutationRequest('removeModelFromCollectionWithSync', {
      id: collectionId,
      hash,
      profileId,
      profileBinding,
      now,
    });
  }

  async getSyncStatus(profileId: string): Promise<SidecarSyncStatus> {
    return (await this.request('getSyncStatus', {
      profileId,
    })) as SidecarSyncStatus;
  }

  async bindSyncProfile(
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<SidecarSyncStatus> {
    return (await this.mutationRequest('bindSyncProfile', {
      profileId,
      profileBinding,
      now,
    })) as SidecarSyncStatus;
  }

  async replaceSyncProfileBinding(
    profileId: string,
    expectedBinding: string,
    newBinding: string,
    now: number,
  ): Promise<SidecarSyncStatus> {
    return (await this.mutationRequest('replaceSyncProfileBinding', {
      profileId,
      expectedBinding,
      newBinding,
      now,
    })) as SidecarSyncStatus;
  }

  async applySyncPullBatch(
    batch: SidecarApplyPullBatch,
  ): Promise<SidecarSyncStatus> {
    return (await this.mutationRequest(
      'applySyncPullBatch',
      batch,
    )) as SidecarSyncStatus;
  }

  async getSyncEntityRevision(
    profileId: string,
    entityType: SidecarSyncEntityType,
    remoteId: string,
  ): Promise<SidecarEntityRevision | null> {
    return (await this.request('getEntityRevision', {
      profileId,
      entityType,
      remoteId,
    })) as SidecarEntityRevision | null;
  }

  async getSyncEntityRevisionByLocal(
    profileId: string,
    entityType: SidecarSyncEntityType,
    localId: string,
  ): Promise<SidecarEntityRevision | null> {
    return (await this.request('getEntityRevision', {
      profileId,
      entityType,
      localId,
    })) as SidecarEntityRevision | null;
  }

  async listSyncEntityRevisions(
    profileId: string,
    entityType?: SidecarSyncEntityType,
    limit = 500,
  ): Promise<SidecarEntityRevision[]> {
    return (await this.request('listEntityRevisions', {
      profileId,
      ...(entityType ? { entityType } : {}),
      limit,
    })) as SidecarEntityRevision[];
  }

  async listOutboundOperations(
    profileId: string,
    states: SidecarOutboundState[],
    limit = 500,
  ): Promise<SidecarOutboundOperation[]> {
    return (await this.request('listOutboundOperations', {
      profileId,
      states,
      limit,
    })) as SidecarOutboundOperation[];
  }

  async getOutboundBatch(
    profileId: string,
    batchId: string,
  ): Promise<SidecarOutboundOperation[]> {
    return (await this.request('getOutboundBatch', {
      profileId,
      batchId,
    })) as SidecarOutboundOperation[];
  }

  async recoverOutboundOperations(
    profileId: string,
    profileBinding: string,
    now: number,
  ): Promise<{ markedUncertain: number }> {
    return (await this.mutationRequest('recoverOutboundOperations', {
      profileId,
      profileBinding,
      now,
    })) as { markedUncertain: number };
  }

  async claimOutboundOperations(
    profileId: string,
    profileBinding: string,
    limit: number,
    now: number,
    leaseSeconds: number,
  ): Promise<SidecarClaimedOutboundBatch | null> {
    return (await this.mutationRequest('claimOutboundOperations', {
      profileId,
      profileBinding,
      limit,
      now,
      leaseSeconds,
    })) as SidecarClaimedOutboundBatch | null;
  }

  async failOutboundBatch(input: {
    profileId: string;
    profileBinding: string;
    batchId: string;
    batchIncarnation: string;
    leaseToken: string;
    outcome: 'definiteTransient' | 'definitePermanent' | 'ambiguous';
    error: string;
    failedAt: number;
    retryAt: number | null;
  }): Promise<SidecarOutboundOperation[]> {
    return (await this.mutationRequest(
      'failOutboundBatch',
      input,
    )) as SidecarOutboundOperation[];
  }

  async settleOutboundBatch(input: {
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
  }): Promise<unknown> {
    return this.mutationRequest('settleOutboundBatch', input);
  }

  async reconcileUncertainBatch(input: {
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
  }): Promise<SidecarOutboundOperation[]> {
    return (await this.mutationRequest(
      'reconcileUncertainBatch',
      input,
    )) as SidecarOutboundOperation[];
  }

  /** Stop the sidecar and reject any in-flight requests. */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const channel = this.channel;
    this.channel = null;
    this.terminatingChannel = null;
    this.terminationError = null;
    if (this.terminationTimer) {
      clearTimeout(this.terminationTimer);
      this.terminationTimer = null;
    }
    this.rejectAllPending(new Error('sidecar client disposed'));
    channel?.close();
  }

  // --- Calibration persistence RPC (issue #52) ------------------------------
  // These delegate to the sidecar's calibration_outbox and calibration_*
  // tables added in schema v12/v13. No server URLs or credentials are involved.

  async saveCalibrationWorkspaceState(
    input: SaveCalibrationWorkspaceStateInput,
  ): Promise<SidecarCalibrationWorkspaceState> {
    return (await this.mutationRequest(
      'saveCalibrationWorkspaceState',
      input,
    )) as SidecarCalibrationWorkspaceState;
  }

  async listCalibrationWorkspaceStates(
    profileId: string,
  ): Promise<SidecarCalibrationWorkspaceState[]> {
    return (await this.request('listCalibrationWorkspaceStates', {
      profileId,
    })) as SidecarCalibrationWorkspaceState[];
  }

  async listCalibrationUnhydratedProjects(
    profileId: string,
  ): Promise<import('@shared/ipc').CalibrationUnhydratedProject[]> {
    return (await this.request('listCalibrationUnhydratedProjects', {
      profileId,
    })) as import('@shared/ipc').CalibrationUnhydratedProject[];
  }

  async getCalibrationWorkspaceState(
    profileId: string,
    projectId: string,
  ): Promise<SidecarCalibrationWorkspaceState | null> {
    return (await this.request('getCalibrationWorkspaceState', {
      profileId,
      projectId,
    })) as SidecarCalibrationWorkspaceState | null;
  }

  async stageCalibrationPhoto(
    input: StageCalibrationPhotoInput,
  ): Promise<SidecarStagedCalibrationPhoto> {
    return (await this.mutationRequest(
      'stageCalibrationPhoto',
      input,
    )) as SidecarStagedCalibrationPhoto;
  }

  async listCalibrationPendingOps(
    profileId: string,
    projectId: string | null,
    limit: number,
  ): Promise<unknown[]> {
    return (await this.request('listCalibrationPendingOps', {
      profileId,
      projectId,
      limit,
    })) as unknown[];
  }

  async settleCalibrationOp(
    profileId: string,
    operationId: string,
    serverRevision: number,
  ): Promise<void> {
    await this.mutationRequest('settleCalibrationOp', {
      profileId,
      operationId,
      serverRevision,
    });
  }

  async replayCalibrationOp(
    profileId: string,
    operationId: string,
  ): Promise<void> {
    await this.mutationRequest('replayCalibrationOp', {
      profileId,
      operationId,
    });
  }

  async recordCalibrationConflict(
    profileId: string,
    operationId: string,
    entityType: string,
    entityId: string,
    reason: string,
    serverRevision: number,
    conflictKind?: string,
  ): Promise<void> {
    await this.mutationRequest('recordCalibrationConflict', {
      profileId,
      operationId,
      entityType,
      entityId,
      reason,
      serverRevision,
      conflictKind: conflictKind ?? null,
    });
  }

  /**
   * Resolve a calibration conflict under the ratified policy (issue #216).
   *
   * A mutation, not a read: it writes `resolved_at`, and for
   * `keepLocalAsNewRevision` it mints a revision. Routed through
   * `mutationRequest` so it inherits the same retry/settlement treatment as
   * every other calibration write.
   */
  async resolveCalibrationConflict(request: {
    profileId: string;
    conflictId: string;
    resolution: string;
    mergedFields?: Record<string, string> | undefined;
  }): Promise<unknown> {
    return await this.mutationRequest('resolveCalibrationConflict', {
      profileId: request.profileId,
      conflictId: request.conflictId,
      resolution: request.resolution,
      mergedFields: request.mergedFields ?? null,
    });
  }

  async getCalibrationCursorState(
    profileId: string,
    projectId: string | null,
  ): Promise<{
    cursor: string | null;
    serverRevision: number;
    checkpointGeneration: number;
  }> {
    return (await this.request('getCalibrationCursorState', {
      profileId,
      projectId,
    })) as {
      cursor: string | null;
      serverRevision: number;
      checkpointGeneration: number;
    };
  }

  async commitCalibrationCursor(
    profileId: string,
    projectId: string | null,
    cursor: string | null,
    serverRevision: number,
    checkpointGeneration: number,
  ): Promise<void> {
    await this.mutationRequest('commitCalibrationCursor', {
      profileId,
      projectId,
      cursor,
      serverRevision,
      checkpointGeneration,
    });
  }

  async applyCalibrationSnapshot(
    profileId: string,
    entityType: string,
    entityId: string,
    snapshot: unknown,
    tombstone: boolean,
    serverRevision: number,
  ): Promise<void> {
    await this.mutationRequest('applyCalibrationSnapshot', {
      profileId,
      entityType,
      entityId,
      snapshot,
      tombstone,
      serverRevision,
    });
  }

  async listCalibrationConflicts(
    profileId: string,
    projectId: string | null,
  ): Promise<unknown[]> {
    return (await this.request('listCalibrationConflicts', {
      profileId,
      projectId,
    })) as unknown[];
  }

  async countCalibrationPendingOps(
    profileId: string,
    projectId: string | null,
  ): Promise<number> {
    const result = (await this.request('countCalibrationPendingOps', {
      profileId,
      projectId,
    })) as { count: number };
    return result.count;
  }

  async isCalibrationPrinterContextFresh(
    profileId: string,
    projectId: string,
  ): Promise<boolean> {
    const result = (await this.request('isPrinterContextFresh', {
      profileId,
      projectId,
    })) as { fresh: boolean };
    return result.fresh;
  }

  private mutationRequest(method: string, params: unknown): Promise<unknown> {
    return this.request(method, params, {
      timeoutMs: this.mutationTimeoutMs,
      terminateOnTimeout: true,
    });
  }

  private retargetRequest(method: string, params: unknown): Promise<unknown> {
    return this.request(method, params, {
      timeoutMs: this.mutationTimeoutMs,
      terminateOnTimeout: true,
    });
  }

  private request(
    method: string,
    params: unknown,
    policy: RequestPolicy = {
      timeoutMs: this.requestTimeoutMs,
      terminateOnTimeout: false,
    },
  ): Promise<unknown> {
    return this.enqueue(async (): Promise<unknown> => {
      if (this.requireProtocolHandshake && method !== 'handshake') {
        await this.ensureProtocol();
      }
      return this.dispatchRequest(method, params, policy);
    });
  }

  private enqueue<T>(dispatch: () => Promise<T>): Promise<T> {
    if (!this.serializeRequests) {
      return dispatch();
    }
    const result = this.serializedQueue.then(dispatch);
    this.serializedQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async ensureProtocol(): Promise<SidecarHandshake> {
    const channel = this.ensureChannel();
    if (this.protocolChannel !== channel || !this.protocolReady) {
      this.protocolChannel = channel;
      this.protocolReady = this.dispatchRequest(
        'handshake',
        {},
        {
          timeoutMs: this.requestTimeoutMs,
          terminateOnTimeout: false,
        },
        channel,
      ).then((result): SidecarHandshake => {
        validateHandshake(result);
        return result;
      });
    }
    let handshake: SidecarHandshake;
    try {
      handshake = await this.protocolReady;
    } catch (error) {
      if (this.protocolChannel === channel) {
        this.protocolChannel = null;
        this.protocolReady = null;
      }
      throw error;
    }
    if (this.channel !== channel) {
      return this.ensureProtocol();
    }
    return handshake;
  }

  private dispatchRequest(
    method: string,
    params: unknown,
    policy: RequestPolicy,
    expectedChannel?: SidecarChannel,
  ): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error('sidecar client disposed'));
    }
    if (this.terminatingChannel) {
      return Promise.reject(
        new Error(
          'sidecar termination is still in progress; the catalog is temporarily unavailable',
        ),
      );
    }
    let channel: SidecarChannel;
    try {
      channel = expectedChannel ?? this.ensureChannel();
      if (expectedChannel && this.channel !== expectedChannel) {
        return Promise.reject(
          new Error('sidecar restarted before the request could be sent'),
        );
      }
    } catch (error) {
      return Promise.reject(
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    const id = this.nextId++;
    const line = JSON.stringify({ id, method, params });

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (policy.terminateOnTimeout) {
          const error = new Error(
            `sidecar request '${method}' timed out; the sidecar was terminated, so refresh the catalog before retrying`,
          );
          const isActiveChannel = this.channel === channel;
          if (isActiveChannel) {
            this.terminatingChannel = channel;
            this.terminationError = error;
            for (const pending of this.pending.values()) {
              clearTimeout(pending.timer);
            }
            this.terminationTimer = setTimeout(() => {
              this.terminationTimer = null;
              this.rejectAllPending(
                new Error(
                  `${error.message}; sidecar shutdown could not be confirmed`,
                ),
              );
            }, this.terminationTimeoutMs);
          }
          this.recordFailure();
          if (isActiveChannel) {
            channel.close();
          } else {
            this.rejectAllPending(error);
          }
        } else {
          this.pending.delete(id);
          this.recordFailure();
          reject(new Error(`sidecar request '${method}' timed out`));
        }
      }, policy.timeoutMs);

      this.pending.set(id, {
        resolve,
        reject,
        timer,
      });

      try {
        channel.send(line);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        this.recordFailure();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private ensureChannel(): SidecarChannel {
    if (this.channel) {
      return this.channel;
    }
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      throw new Error(
        `sidecar unavailable after ${this.consecutiveFailures} consecutive failures`,
      );
    }

    const channel = this.createChannel();
    channel.onMessage((rawLine) => this.handleMessage(channel, rawLine));
    channel.onClose((info) => this.handleClose(channel, info));
    this.channel = channel;
    return channel;
  }

  private handleMessage(sourceChannel: SidecarChannel, rawLine: string): void {
    if (
      sourceChannel !== this.channel ||
      sourceChannel === this.terminatingChannel
    ) {
      return;
    }
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) {
      return;
    }

    let envelope: ResponseEnvelope;
    try {
      envelope = JSON.parse(trimmed) as ResponseEnvelope;
    } catch {
      // A corrupt line is a protocol fault; ignore it rather than crashing.
      return;
    }

    const pending = this.pending.get(envelope.id);
    if (!pending) {
      return;
    }
    this.pending.delete(envelope.id);
    clearTimeout(pending.timer);

    if (envelope.ok) {
      this.consecutiveFailures = 0;
      pending.resolve(envelope.result);
    } else {
      this.recordFailure();
      pending.reject(new Error(envelope.error ?? 'sidecar returned an error'));
    }
  }

  private handleClose(
    closedChannel: SidecarChannel,
    info: { code: number | null },
  ): void {
    if (this.terminatingChannel === closedChannel) {
      const terminationError =
        this.terminationError ??
        new Error('sidecar was terminated before the request completed');
      this.terminatingChannel = null;
      this.terminationError = null;
      if (this.terminationTimer) {
        clearTimeout(this.terminationTimer);
        this.terminationTimer = null;
      }
      if (this.channel === closedChannel) {
        this.channel = null;
      }
      this.clearProtocol(closedChannel);
      this.rejectAllPending(terminationError);
      return;
    }
    // Ignore closes from a channel we already replaced.
    if (this.channel !== closedChannel) {
      return;
    }
    this.channel = null;
    this.clearProtocol(closedChannel);
    if (this.pending.size > 0) {
      this.recordFailure();
      this.rejectAllPending(
        new Error(
          `sidecar exited (code ${info.code ?? 'unknown'}) with requests in flight`,
        ),
      );
    }
  }

  private recordFailure(): void {
    this.consecutiveFailures += 1;
  }

  private clearProtocol(channel: SidecarChannel): void {
    if (this.protocolChannel !== channel) return;
    this.protocolChannel = null;
    this.protocolReady = null;
  }

  private rejectAllPending(reason: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }
}

function validateHandshake(value: unknown): asserts value is {
  protocolVersion: number;
  sidecarVersion: string;
  sceneDtoVersion?: number;
  parserSemanticsVersion?: number;
  sceneCacheRecipe?: string;
} {
  const result = value as {
    protocolVersion?: unknown;
    sidecarVersion?: unknown;
    sceneDtoVersion?: unknown;
    parserSemanticsVersion?: unknown;
    sceneCacheRecipe?: unknown;
  } | null;
  if (
    result?.protocolVersion !== SIDECAR_RPC_PROTOCOL_VERSION ||
    typeof result.sidecarVersion !== 'string' ||
    result.sidecarVersion.length === 0 ||
    (result.sceneDtoVersion !== undefined &&
      (!Number.isInteger(result.sceneDtoVersion) ||
        (result.sceneDtoVersion as number) < 1)) ||
    (result.parserSemanticsVersion !== undefined &&
      (!Number.isInteger(result.parserSemanticsVersion) ||
        (result.parserSemanticsVersion as number) < 1)) ||
    (result.sceneCacheRecipe !== undefined &&
      (typeof result.sceneCacheRecipe !== 'string' ||
        result.sceneCacheRecipe.length === 0))
  ) {
    throw new Error(
      `sidecar protocol mismatch: expected ${SIDECAR_RPC_PROTOCOL_VERSION}, received ${String(result?.protocolVersion)}`,
    );
  }
}

/**
 * Resolve the path to the compiled sidecar binary.
 *
 * Priority:
 *  1. an explicit `PRINTFARMER_SIDECAR_PATH` override;
 *  2. in a packaged build, the bundled location under Electron's
 *     `resourcesPath` (`<resources>/sidecar/<binary>`);
 *  3. in development (`electron-forge start`), the sidecar staged into the repo
 *     by `npm run stage:sidecar` at `<cwd>/resources/sidecar/<binary>`.
 *
 * Packaging is detected via `process.defaultApp`, which Electron sets only when
 * running an unpackaged app; a packaged build leaves it undefined. This matters
 * because `process.resourcesPath` is populated in *both* modes (pointing at
 * Electron's own resources during `start`), so it cannot be used on its own to
 * tell dev from packaged.
 */
export function resolveSidecarPath(): string {
  const override = process.env.PRINTFARMER_SIDECAR_PATH;
  if (override && override.length > 0) {
    return override;
  }

  const binaryName =
    process.platform === 'win32' ? 'model-core.exe' : 'model-core';

  const isUnpackaged = Boolean(
    (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp,
  );
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (!isUnpackaged && resourcesPath) {
    return path.join(resourcesPath, 'sidecar', binaryName);
  }

  return path.resolve(process.cwd(), 'resources', 'sidecar', binaryName);
}

/**
 * Resolve the on-disk catalog database path, or `undefined` for an ephemeral
 * in-memory catalog. Sourced from `PRINTFARMER_CATALOG_DB`, which the main
 * process sets to a file under Electron's `userData` directory. When unset
 * (e.g. in tests or a bare dev run) the sidecar keeps the catalog in memory.
 */
export function resolveCatalogDbPath(): string | undefined {
  const dbPath = process.env.PRINTFARMER_CATALOG_DB;
  return dbPath && dbPath.length > 0 ? dbPath : undefined;
}

export function resolveTargetProfilesPath(): string {
  const isUnpackaged = Boolean(
    (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp,
  );
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  if (!isUnpackaged && resourcesPath) {
    return path.join(resourcesPath, 'target-profiles', 'snapmaker-u1');
  }
  return path.resolve(
    process.cwd(),
    'resources',
    'target-profiles',
    'snapmaker-u1',
  );
}

/**
 * Spawn the real sidecar process and adapt its stdio into a
 * {@link SidecarChannel}. stdout is decoded as UTF-8 and split on newlines;
 * stderr is forwarded to the main-process console for diagnostics.
 */
export function spawnSidecarChannel(binaryPath?: string): SidecarChannel {
  const executable = binaryPath ?? resolveSidecarPath();
  const dbPath = resolveCatalogDbPath();
  const args = [
    ...(dbPath ? ['--catalog-db', dbPath] : []),
    '--target-profiles-dir',
    resolveTargetProfilesPath(),
  ];
  const child = spawn(executable, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let buffer = '';
  let messageHandler: ((line: string) => void) | null = null;
  let closeHandler: ((info: { code: number | null }) => void) | null = null;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newlineIndex = buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (messageHandler) {
        messageHandler(line);
      }
      newlineIndex = buffer.indexOf('\n');
    }
  });

  child.stderr.setEncoding('utf8');
  // Forwarded verbatim to the parent's stderr rather than turned into a
  // structured record. This is the Rust crate's own log stream, not a
  // calibration record: it carries no correlation, operation or dispatch ID to
  // put in one, and its text is arbitrary, so it cannot pass the structural
  // allowlist in `calibrationLog`. Piping it preserves sidecar debuggability
  // without pretending it is a redacted record. The policy test in
  // `tests/calibrationLogPolicy.test.ts` pins this as one of exactly two
  // permitted direct stream writes, so it cannot become a general escape hatch.
  child.stderr.on('data', (chunk: string) => {
    process.stderr.write(`${chunk.trimEnd()}\n`);
  });

  const emitClose = (code: number | null): void => {
    if (closeHandler) {
      closeHandler({ code });
    }
  };
  child.on('close', (code) => emitClose(code));
  child.on('error', () => {
    emitCalibrationLog({
      level: 'error',
      component: 'calibration.sidecar',
      event: 'sidecar.processFailed',
      outcome: 'failed',
      errorCode: 'unexpected',
    });
  });

  return {
    send(line: string): void {
      child.stdin.write(`${line}\n`);
    },
    onMessage(handler: (line: string) => void): void {
      messageHandler = handler;
    },
    onClose(handler: (info: { code: number | null }) => void): void {
      closeHandler = handler;
    },
    close(): void {
      child.kill();
    },
  };
}
