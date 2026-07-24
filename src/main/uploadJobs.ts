import path from 'node:path';
import { promises as nodeFs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  ListModelsResponse,
  StartUploadJobRequest as StartUploadJobRequestSchema,
  UploadJob,
  type ListUploadJobsResponse,
  type LogicalModel,
  type RemoteUploadResult as RemoteUploadResultDto,
  type ServerProfile,
  type StartUploadJobRequest,
  type UploadError,
  type UploadJob as UploadJobDto,
  type UploadJobItem,
} from '@shared/ipc';
import {
  type AuthenticatedProfileContext,
  ServerProfileError,
  type ServerProfileService,
} from './serverProfiles.js';
import type { SidecarClient } from './sidecar.js';
import {
  RootApprovalError,
  type ApprovedFile,
  type RootApprovalStore,
} from './rootApprovals.js';
import {
  createNodeUploadTransport,
  makeUploadError,
  ModelUploadError,
  validateThumbnailPng,
  type UploadTransport,
} from './uploadTransport.js';
import {
  PrivateSnapshotManager,
  SnapshotError,
  type SnapshotManager,
  type UploadSnapshot,
} from './uploadSnapshot.js';

export const UPLOAD_JOB_STORE_VERSION = 2;
export const MAX_UPLOAD_JOBS = 100;
export const MAX_UPLOAD_STORE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPLOAD_CONCURRENCY = 2;
const PROGRESS_CHECKPOINT_BYTES = 1024 * 1024;

const UploadIdentity = z
  .object({
    profileId: z.string().uuid(),
    serverBinding: z.string().min(1).max(128).default('legacy-unbound'),
    hash: z.string().regex(/^[a-f0-9]{64}$/),
    clientUploadId: z.string().uuid(),
    remoteModelId: z.string().min(1).max(256).nullable(),
    etag: z.string().min(1).max(1024).nullable(),
    updatedAt: z.string().datetime(),
  })
  .strict();
type UploadIdentity = z.infer<typeof UploadIdentity>;

const UploadJobStoreFileV2 = z
  .object({
    version: z.literal(UPLOAD_JOB_STORE_VERSION),
    jobs: z.array(UploadJob).max(MAX_UPLOAD_JOBS),
    identities: z.array(UploadIdentity).max(50_000),
  })
  .strict();

const UploadJobStoreFileV1 = z
  .object({
    version: z.literal(1),
    jobs: z.array(UploadJob).max(MAX_UPLOAD_JOBS),
  })
  .strict();

export interface UploadJobStoreState {
  jobs: UploadJobDto[];
  identities: UploadIdentity[];
}

export interface UploadJobFileSystem {
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(filePath: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  mkdir(directory: string): Promise<void>;
  unlink(filePath: string): Promise<void>;
}

const nodeFileSystem: UploadJobFileSystem = {
  readFile: (filePath) => nodeFs.readFile(filePath),
  writeFile: (filePath, data) => nodeFs.writeFile(filePath, data, 'utf8'),
  rename: (from, to) => nodeFs.rename(from, to),
  mkdir: (directory) =>
    nodeFs.mkdir(directory, { recursive: true }).then(() => undefined),
  unlink: (filePath) => nodeFs.unlink(filePath),
};

export type UploadJobStoreErrorCode =
  'CORRUPT_STORE' | 'STORE_TOO_LARGE' | 'STORE_WRITE_FAILED';

export class UploadJobStoreError extends Error {
  constructor(
    readonly code: UploadJobStoreErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'UploadJobStoreError';
  }
}

export interface UploadJobStoreOptions {
  userDataPath: string;
  fileSystem?: UploadJobFileSystem;
  now?: () => number;
}

export class UploadJobStore {
  readonly storePath: string;
  private readonly legacyStorePath: string;
  private readonly fileSystem: UploadJobFileSystem;
  private readonly now: () => number;

  constructor(options: UploadJobStoreOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
    this.storePath = path.join(options.userDataPath, 'upload-jobs.v2.json');
    this.legacyStorePath = path.join(
      options.userDataPath,
      'upload-jobs.v1.json',
    );
  }

  async loadState(): Promise<UploadJobStoreState> {
    let bytes: Uint8Array;
    let loadedLegacyPath = false;
    try {
      bytes = await this.fileSystem.readFile(this.storePath);
    } catch (error) {
      if (isMissingFile(error)) {
        try {
          bytes = await this.fileSystem.readFile(this.legacyStorePath);
          loadedLegacyPath = true;
        } catch (legacyError) {
          if (isMissingFile(legacyError)) return { jobs: [], identities: [] };
          throw new UploadJobStoreError(
            'CORRUPT_STORE',
            'The legacy upload queue could not be read. Reset it explicitly to recover.',
          );
        }
      } else {
        throw new UploadJobStoreError(
          'CORRUPT_STORE',
          'The upload queue could not be read. Reset it explicitly to recover.',
        );
      }
    }
    if (bytes.byteLength > MAX_UPLOAD_STORE_BYTES) {
      throw new UploadJobStoreError(
        'STORE_TOO_LARGE',
        'The upload queue exceeds its safety limit. Reset it explicitly to recover.',
      );
    }
    const raw = parseJson(Buffer.from(bytes).toString('utf8'));
    const v2 = UploadJobStoreFileV2.safeParse(raw);
    let state: UploadJobStoreState;
    let migrated = loadedLegacyPath;
    if (v2.success) {
      state = structuredClone(v2.data);
    } else {
      const v1 = UploadJobStoreFileV1.safeParse(raw);
      if (!v1.success) {
        throw new UploadJobStoreError(
          'CORRUPT_STORE',
          'The upload queue is corrupt. Reset it explicitly to recover; the original file will be retained as a backup.',
        );
      }
      migrated = true;
      state = {
        jobs: structuredClone(v1.data.jobs),
        identities: identitiesFromJobs(v1.data.jobs),
      };
    }
    const timestamp = new Date(this.now()).toISOString();
    let recovered = false;
    for (const job of state.jobs) {
      for (const item of job.items) {
        if (
          job.serverBinding === 'legacy-unbound' &&
          item.state !== 'cancelled'
        ) {
          recovered = true;
          item.state = 'uncertain';
          item.updatedAt = timestamp;
          item.error = {
            code: 'UNBOUND_UPLOAD_IDENTITY',
            message:
              'This pre-migration upload identity is not bound to a verified server. Resolve the duplicate risk explicitly.',
            retryable: false,
            retryAfterSeconds: null,
            duplicateRisk: true,
          };
          continue;
        }
        if (item.state !== 'uploading') continue;
        recovered = true;
        item.state = 'uncertain';
        item.updatedAt = timestamp;
        item.error = {
          code: 'INTERRUPTED',
          message:
            job.mode === 'modern'
              ? 'The app closed during this upload. Retry safely with the retained upload identity.'
              : 'The app closed during this legacy upload. It may have completed; retrying can create a duplicate.',
          retryable: job.mode === 'modern',
          retryAfterSeconds: null,
          duplicateRisk: job.mode === 'legacyModelOnly',
        };
      }
      refreshDerived(job);
    }
    if (migrated || recovered) await this.saveState(state);
    return structuredClone(state);
  }

  async saveState(state: UploadJobStoreState): Promise<void> {
    const payload = JSON.stringify(
      UploadJobStoreFileV2.parse({
        version: UPLOAD_JOB_STORE_VERSION,
        ...state,
      }),
    );
    if (Buffer.byteLength(payload) > MAX_UPLOAD_STORE_BYTES) {
      throw new UploadJobStoreError(
        'STORE_TOO_LARGE',
        'The upload queue exceeds its safety limit.',
      );
    }
    const temporaryPath = `${this.storePath}.tmp`;
    try {
      await this.fileSystem.mkdir(path.dirname(this.storePath));
      await this.fileSystem.writeFile(temporaryPath, payload);
      await this.fileSystem.rename(temporaryPath, this.storePath);
    } catch (error) {
      try {
        await this.fileSystem.unlink(temporaryPath);
      } catch {
        // The previous queue file remains authoritative.
      }
      throw new UploadJobStoreError(
        'STORE_WRITE_FAILED',
        'The upload queue checkpoint could not be saved; no state transition was applied.',
        error,
      );
    }
  }

  async load(): Promise<UploadJobDto[]> {
    return (await this.loadState()).jobs;
  }

  async save(jobs: UploadJobDto[]): Promise<void> {
    const existing = await this.loadState();
    await this.saveState({ jobs, identities: existing.identities });
  }

  async reset(
    preservedIdentities: UploadIdentity[] = [],
  ): Promise<{ backupCreated: boolean }> {
    const backupPath = `${this.storePath}.backup-${this.now()}`;
    let backupCreated = false;
    try {
      await this.fileSystem.rename(this.storePath, backupPath);
      backupCreated = true;
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new UploadJobStoreError(
          'STORE_WRITE_FAILED',
          'The existing queue could not be retained as a recovery backup.',
        );
      }
    }
    await this.saveState({
      jobs: [],
      identities: structuredClone(preservedIdentities),
    });
    return { backupCreated };
  }
}

export interface RemoteModelLink {
  profileId: string;
  serverBinding: string;
  localModelHash: string;
  remoteModelId: string;
  clientUploadId: string;
  uploadStatus: 'pending' | 'uploading' | 'uploaded' | 'failed';
  etag?: string | null;
  uploadedAt?: number | null;
}

export interface UploadSidecar {
  listModels(): Promise<unknown>;
  renderThumbnail(filePath: string, size?: number): Promise<unknown>;
  getRemoteModelLink(
    profileId: string,
    serverBinding: string,
    hash: string,
  ): Promise<unknown>;
  removeRemoteModelLink(
    profileId: string,
    serverBinding: string,
    hash: string,
  ): Promise<unknown>;
  purgeRemoteModelLinks(
    profileId: string,
    serverBinding: string,
  ): Promise<unknown>;
  linkRemoteModel(link: {
    profileId: string;
    serverBinding: string;
    localModelHash: string;
    remoteModelId: string;
    clientUploadId: string;
    etag: string | null;
    uploadStatus: 'uploaded';
    createdAt: number;
    updatedAt: number;
    uploadedAt: number | null;
  }): Promise<unknown>;
}

export interface UploadProfileService {
  list(): Promise<{
    profiles: ServerProfile[];
    selectedProfileId: string | null;
  }>;
  getAuthenticatedContext(id: string): Promise<AuthenticatedProfileContext>;
  revalidateAuthenticatedContext(
    context: AuthenticatedProfileContext,
  ): Promise<void>;
  invalidateRejectedContext(
    context: AuthenticatedProfileContext,
  ): Promise<boolean>;
  onProfileBindingChanged?(
    listener: (
      profileId: string,
      previousBinding: string,
    ) => Promise<void> | void,
  ): () => void;
}

export interface UploadRootApprovals {
  openApprovedFile(filePath: string): Promise<ApprovedFile>;
}

export interface UploadJobServiceOptions {
  store: UploadJobStore;
  sidecar: UploadSidecar;
  profiles: UploadProfileService;
  approvals: UploadRootApprovals;
  snapshots: SnapshotManager;
  transport?: UploadTransport;
  concurrency?: number;
  now?: () => number;
  createId?: () => string;
  beforeClaim?: () => Promise<void>;
}

interface ActiveUpload {
  controller: AbortController;
  action: 'pause' | 'cancel' | null;
  generation: number;
  worker: Promise<void>;
}

class StaleQueueGenerationError extends Error {}
class SchedulerClaimLostError extends Error {}

export class UploadJobService {
  private state: UploadJobStoreState = { jobs: [], identities: [] };
  private readonly active = new Map<string, ActiveUpload>();
  private readonly transport: UploadTransport;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private queueError: Error | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private pumpPending = false;
  private pumping = false;
  private lastScheduledJobId: string | null = null;
  private queueGeneration = 0;
  private resetting = false;
  private readonly unsubscribeProfileChanges: (() => void) | null;
  private readonly changingProfileBindings = new Set<string>();

  constructor(private readonly options: UploadJobServiceOptions) {
    this.transport = options.transport ?? createNodeUploadTransport();
    this.concurrency = Math.max(
      1,
      Math.min(8, options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY),
    );
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
    this.unsubscribeProfileChanges =
      options.profiles.onProfileBindingChanged?.((profileId, binding) =>
        this.handleProfileBindingChanged(profileId, binding),
      ) ?? null;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializePromise) {
      const generation = this.queueGeneration;
      this.initializePromise = Promise.all([
        this.options.store.loadState(),
        this.options.snapshots.initialize?.() ?? Promise.resolve(),
      ])
        .then(([state]) => {
          if (generation !== this.queueGeneration || this.resetting) return;
          this.state = state;
          this.initialized = true;
          this.queueError = null;
          this.schedulePump();
        })
        .catch((error: unknown) => {
          if (generation !== this.queueGeneration || this.resetting) return;
          this.queueError = controlledQueueError(error);
          throw this.queueError;
        });
    }
    return this.initializePromise;
  }

  async list(): Promise<ListUploadJobsResponse> {
    await this.requireReady();
    return this.state.jobs.map((job) => UploadJob.parse(structuredClone(job)));
  }

  async reset(): Promise<{ reset: true; backupCreated: boolean }> {
    let generation = 0;
    const resetState: { initializer: Promise<void> | null } = {
      initializer: null,
    };
    await this.withMutationLock(() => {
      resetState.initializer = this.initializePromise;
      this.queueGeneration += 1;
      generation = this.queueGeneration;
      this.resetting = true;
      this.initialized = false;
      this.pumpPending = false;
      return Promise.resolve();
    });
    const workers = [...this.active.values()].map((active) => {
      active.controller.abort();
      return active.worker;
    });
    await Promise.allSettled(workers);
    if (resetState.initializer) {
      await Promise.allSettled([resetState.initializer]);
    }
    let backupCreated = false;
    await this.withMutationLock(async () => {
      if (generation !== this.queueGeneration) {
        throw new StaleQueueGenerationError();
      }
      const result = await this.options.store.reset(this.state.identities);
      backupCreated = result.backupCreated;
      this.state = {
        jobs: [],
        identities: structuredClone(this.state.identities),
      };
      this.active.clear();
      this.queueError = null;
      this.initialized = true;
      this.resetting = false;
      this.initializePromise = Promise.resolve();
    });
    return { reset: true, backupCreated };
  }

  async start(request: StartUploadJobRequest): Promise<UploadJobDto> {
    await this.requireReady();
    const startingGeneration = this.queueGeneration;
    const validatedRequest = StartUploadJobRequestSchema.parse(request);
    const [startingContext, rawModels] = await Promise.all([
      this.options.profiles.getAuthenticatedContext(validatedRequest.profileId),
      this.options.sidecar.listModels(),
    ]);
    if (
      startingGeneration !== this.queueGeneration ||
      this.resetting ||
      !this.initialized
    ) {
      throw new StaleQueueGenerationError();
    }
    if (this.changingProfileBindings.has(validatedRequest.profileId)) {
      throw new Error('The server profile binding is still being updated.');
    }
    const profile = startingContext.profile;
    const mode = modeForProfile(profile);
    const models = ListModelsResponse.parse(rawModels);
    const byHash = new Map(models.map((model) => [model.hash, model]));
    const timestamp = this.isoNow();
    const baseState = this.state;
    const draft = cloneState(baseState);
    if (draft.jobs.length >= MAX_UPLOAD_JOBS) {
      throw new Error('The upload queue is full. Remove completed jobs first.');
    }
    const items: UploadJobItem[] = [];
    for (const hash of validatedRequest.hashes) {
      const model = byHash.get(hash);
      if (!model) throw new Error('A selected catalog model was not found.');
      if (!availableLocation(model)) {
        throw new Error(
          `${displayName(model)} has no available catalog location.`,
        );
      }
      const duplicate = draft.jobs.some(
        (job) =>
          job.profileId === profile.id &&
          job.serverBinding === startingContext.serverBinding &&
          job.items.some(
            (item) =>
              item.hash === hash &&
              (item.state === 'queued' ||
                item.state === 'uploading' ||
                item.state === 'uncertain'),
          ),
      );
      if (duplicate) {
        throw new Error(
          `${displayName(model)} already has an active or recoverable upload for this profile.`,
        );
      }
      let remoteLink = parseRemoteLink(
        await this.options.sidecar.getRemoteModelLink(
          profile.id,
          startingContext.serverBinding,
          hash,
        ),
      );
      const unboundLink = remoteLink
        ? null
        : parseRemoteLink(
            await this.options.sidecar.getRemoteModelLink(
              profile.id,
              'legacy-unbound',
              hash,
            ),
          );
      let identity = draft.identities.find(
        (candidate) =>
          candidate.profileId === profile.id &&
          candidate.serverBinding === startingContext.serverBinding &&
          candidate.hash === hash,
      );
      const trustedRemoteLink =
        remoteLink?.uploadStatus === 'uploaded' &&
        remoteLink.serverBinding === startingContext.serverBinding
          ? remoteLink
          : null;
      const durableClientUploadId =
        trustedRemoteLink?.clientUploadId ??
        remoteLink?.clientUploadId ??
        unboundLink?.clientUploadId;
      if (remoteLink && !trustedRemoteLink) {
        await this.options.sidecar.removeRemoteModelLink(
          profile.id,
          startingContext.serverBinding,
          hash,
        );
        remoteLink = null;
      } else {
        remoteLink = trustedRemoteLink;
      }
      if (!identity) {
        identity = {
          profileId: profile.id,
          hash,
          clientUploadId: durableClientUploadId ?? this.createId(),
          serverBinding: startingContext.serverBinding,
          remoteModelId: remoteLink?.remoteModelId ?? null,
          etag: remoteLink?.etag ?? null,
          updatedAt: timestamp,
        };
        draft.identities.push(identity);
      } else if (durableClientUploadId) {
        identity.clientUploadId = durableClientUploadId;
        identity.updatedAt = timestamp;
      }
      if (remoteLink) {
        identity.remoteModelId = remoteLink.remoteModelId;
        identity.etag = remoteLink.etag ?? null;
      }
      items.push({
        id: this.createId(),
        hash,
        clientUploadId: identity.clientUploadId,
        displayName: displayName(model),
        size: model.size,
        state: remoteLink ? 'succeeded' : unboundLink ? 'uncertain' : 'queued',
        bytesSent: remoteLink ? model.size : 0,
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        remote: null,
        error: unboundLink
          ? {
              code: 'UNBOUND_REMOTE_LINK',
              message:
                'A pre-migration remote upload exists without a verified server binding. Resolve the duplicate risk explicitly.',
              retryable: false,
              retryAfterSeconds: null,
              duplicateRisk: true,
            }
          : null,
      });
    }
    const job: UploadJobDto = {
      id: this.createId(),
      profileId: profile.id,
      profileName: profile.displayName,
      profileRevision: startingContext.revision,
      serverBinding: startingContext.serverBinding,
      mode,
      state: 'running',
      paused: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      items,
      totalBytes: 0,
      bytesSent: 0,
      summary: emptySummary(),
    };
    refreshDerived(job);
    draft.jobs.push(job);
    await this.options.profiles.revalidateAuthenticatedContext(startingContext);
    await this.commitDraft(
      draft,
      baseState,
      startingGeneration,
      startingContext.serverBinding,
    );
    this.schedulePump();
    return UploadJob.parse(structuredClone(job));
  }

  async pause(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      job.paused = true;
    });
    this.abortJob(jobId, 'pause');
    return result;
  }

  async resume(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      job.paused = false;
    });
    this.schedulePump();
    return result;
  }

  async cancel(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      job.paused = false;
      for (const item of job.items) {
        if (item.state === 'queued') {
          setItemState(item, 'cancelled', this.isoNow(), {
            code: 'CANCELLED',
            message: 'Upload cancelled before it started.',
            retryable: true,
            retryAfterSeconds: null,
            duplicateRisk: false,
          });
        }
      }
    });
    this.abortJob(jobId, 'cancel');
    return result;
  }

  async retry(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      let changed = false;
      for (const item of job.items) {
        if (
          (item.state === 'failed' ||
            item.state === 'cancelled' ||
            item.state === 'uncertain') &&
          item.error?.retryable === true &&
          !item.error.duplicateRisk
        ) {
          item.state = 'queued';
          item.bytesSent = 0;
          item.error = null;
          item.updatedAt = this.isoNow();
          changed = true;
        }
      }
      if (!changed) throw new Error('This job has no safely retryable items.');
      job.paused = false;
    });
    this.schedulePump();
    return result;
  }

  async confirmLegacyRetry(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      let changed = false;
      for (const item of job.items) {
        if (item.state === 'uncertain' && item.error?.duplicateRisk === true) {
          item.state = 'queued';
          item.bytesSent = 0;
          item.error = null;
          item.updatedAt = this.isoNow();
          changed = true;
        }
      }
      if (!changed) {
        throw new Error(
          'This job has no legacy-risk retry awaiting confirmation.',
        );
      }
      job.paused = false;
    });
    this.schedulePump();
    return result;
  }

  async remove(jobId: string): Promise<{ removed: true }> {
    await this.requireReady();
    await this.durableMutate((draft) => {
      const index = draft.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) throw new Error('Upload job not found.');
      const job = draft.jobs[index]!;
      if (
        job.items.some(
          (item) =>
            item.state === 'queued' ||
            item.state === 'uploading' ||
            item.state === 'uncertain',
        )
      ) {
        throw new Error(
          'Active or uncertain uploads cannot be removed. Resolve or cancel them first.',
        );
      }
      draft.jobs.splice(index, 1);
    });
    return { removed: true };
  }

  dispose(): void {
    this.unsubscribeProfileChanges?.();
    for (const active of this.active.values()) active.controller.abort();
  }

  private async handleProfileBindingChanged(
    profileId: string,
    previousBinding: string,
  ): Promise<void> {
    this.changingProfileBindings.add(profileId);
    try {
      await this.requireReady();
    } catch {
      try {
        await this.options.sidecar.purgeRemoteModelLinks(
          profileId,
          previousBinding,
        );
      } finally {
        this.changingProfileBindings.delete(profileId);
      }
      return;
    }
    try {
      const workers: Promise<void>[] = [];
      for (const job of this.state.jobs) {
        if (
          job.profileId !== profileId ||
          job.serverBinding !== previousBinding
        )
          continue;
        for (const item of job.items) {
          const active = this.active.get(item.id);
          if (!active) continue;
          active.action = 'cancel';
          active.controller.abort();
          workers.push(active.worker);
        }
      }
      await Promise.allSettled(workers);
      await this.durableMutate((draft) => {
        for (const job of draft.jobs) {
          if (
            job.profileId !== profileId ||
            job.serverBinding !== previousBinding
          )
            continue;
          for (const item of job.items) {
            if (
              item.state === 'queued' ||
              item.state === 'uploading' ||
              item.state === 'uncertain'
            ) {
              setItemState(item, 'cancelled', this.isoNow(), {
                code: 'PROFILE_CHANGED',
                message:
                  'The server profile endpoint changed. Create a new upload job.',
                retryable: false,
                retryAfterSeconds: null,
                duplicateRisk: false,
              });
            }
          }
        }
        draft.identities = draft.identities.filter(
          (identity) =>
            identity.profileId !== profileId ||
            identity.serverBinding !== previousBinding,
        );
      });
      await this.options.sidecar.purgeRemoteModelLinks(
        profileId,
        previousBinding,
      );
    } finally {
      this.changingProfileBindings.delete(profileId);
    }
  }

  private async requireReady(): Promise<void> {
    if (this.resetting) {
      throw new Error('The upload queue reset is still in progress.');
    }
    if (this.queueError) throw this.queueError;
    await this.initialize();
    if (this.resetting) {
      throw new Error('The upload queue reset is still in progress.');
    }
    if (this.queueError !== null) {
      throw controlledQueueError(this.queueError);
    }
  }

  private async control(
    jobId: string,
    action: (job: UploadJobDto) => void,
  ): Promise<UploadJobDto> {
    await this.requireReady();
    let result: UploadJobDto | null = null;
    await this.durableMutate((draft) => {
      const job = requireJob(draft.jobs, jobId);
      action(job);
      refreshDerived(job);
      result = UploadJob.parse(structuredClone(job));
    });
    return result!;
  }

  private abortJob(jobId: string, action: 'pause' | 'cancel'): void {
    const job = this.state.jobs.find((candidate) => candidate.id === jobId);
    if (!job) return;
    for (const item of job.items) {
      const active = this.active.get(item.id);
      if (active) {
        active.action = action;
        active.controller.abort();
      }
    }
  }

  private schedulePump(): void {
    if (
      !this.initialized ||
      this.resetting ||
      this.pumpPending ||
      this.queueError
    )
      return;
    this.pumpPending = true;
    queueMicrotask(() => {
      this.pumpPending = false;
      void this.pump().catch((error: unknown) => {
        if (!(error instanceof StaleQueueGenerationError)) {
          this.queueError = controlledQueueError(error);
        }
      });
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.active.size < this.concurrency && !this.queueError) {
        const generation = this.queueGeneration;
        const candidate = this.nextQueuedItem();
        if (!candidate) break;
        const controller = new AbortController();
        await this.options.beforeClaim?.();
        try {
          await this.durableMutate((draft) => {
            const job = requireJob(draft.jobs, candidate.jobId);
            const item = job.items.find(
              (entry) => entry.id === candidate.itemId,
            );
            if (
              !item ||
              job.paused ||
              item.state !== 'queued' ||
              this.active.has(candidate.itemId)
            ) {
              throw new SchedulerClaimLostError();
            }
            setItemState(item, 'uploading', this.isoNow(), null);
            item.attempts += 1;
          }, generation);
        } catch (error) {
          if (error instanceof SchedulerClaimLostError) continue;
          throw error;
        }
        if (generation !== this.queueGeneration || this.resetting) continue;
        const active: ActiveUpload = {
          controller,
          action: null,
          generation,
          worker: Promise.resolve(),
        };
        this.active.set(candidate.itemId, active);
        const worker = this.runItem(
          candidate.jobId,
          candidate.itemId,
          controller.signal,
          generation,
        )
          .catch((error: unknown) => {
            if (!(error instanceof StaleQueueGenerationError)) {
              this.queueError = controlledQueueError(error);
            }
          })
          .finally(() => {
            if (this.active.get(candidate.itemId) === active) {
              this.active.delete(candidate.itemId);
            }
            if (generation === this.queueGeneration) this.schedulePump();
          });
        active.worker = worker;
      }
    } finally {
      this.pumping = false;
    }
  }

  private nextQueuedItem(): { jobId: string; itemId: string } | null {
    const jobs = this.state.jobs;
    if (jobs.length === 0) return null;
    const previousIndex = this.lastScheduledJobId
      ? jobs.findIndex((job) => job.id === this.lastScheduledJobId)
      : -1;
    const startIndex =
      previousIndex >= 0 ? (previousIndex + 1) % jobs.length : 0;
    for (let offset = 0; offset < jobs.length; offset += 1) {
      const index = (startIndex + offset) % jobs.length;
      const job = jobs[index]!;
      if (job.paused) continue;
      const item = job.items.find(
        (candidate) =>
          candidate.state === 'queued' && !this.active.has(candidate.id),
      );
      if (item) {
        this.lastScheduledJobId = job.id;
        return { jobId: job.id, itemId: item.id };
      }
    }
    return null;
  }

  private async runItem(
    jobId: string,
    itemId: string,
    signal: AbortSignal,
    generation: number,
  ): Promise<void> {
    let snapshot: UploadSnapshot | null = null;
    let cleanupError: Error | null = null;
    let legacyBytesCommitted = false;
    try {
      const current = this.currentItem(jobId, itemId);
      let context = await this.options.profiles.getAuthenticatedContext(
        current.job.profileId,
      );
      assertContextMatchesJob(context, current.job);
      const existingLink = parseRemoteLink(
        await this.options.sidecar.getRemoteModelLink(
          current.job.profileId,
          current.job.serverBinding,
          current.item.hash,
        ),
      );
      const currentIdentity = requireIdentity(
        this.state.identities,
        current.job.profileId,
        current.job.serverBinding,
        current.item.hash,
      );
      if (
        existingLink?.uploadStatus === 'uploaded' &&
        existingLink.serverBinding === current.job.serverBinding &&
        currentIdentity.serverBinding === current.job.serverBinding
      ) {
        await this.durableMutate((draft) => {
          const item = requireItem(draft.jobs, jobId, itemId);
          item.clientUploadId = existingLink.clientUploadId;
          item.bytesSent = item.size;
          setItemState(item, 'succeeded', this.isoNow(), null);
          const identity = requireIdentity(
            draft.identities,
            current.job.profileId,
            current.job.serverBinding,
            current.item.hash,
          );
          identity.clientUploadId = existingLink.clientUploadId;
          identity.remoteModelId = existingLink.remoteModelId;
          identity.etag = existingLink.etag ?? null;
          identity.updatedAt = this.isoNow();
        }, generation);
        return;
      } else if (existingLink) {
        await this.options.sidecar.removeRemoteModelLink(
          current.job.profileId,
          current.job.serverBinding,
          current.item.hash,
        );
      }
      const rawModels = await this.options.sidecar.listModels();
      const model = ListModelsResponse.parse(rawModels).find(
        (candidate) => candidate.hash === current.item.hash,
      );
      if (!model || !model.locations.some((location) => location.available)) {
        throw makeUploadError(
          'FILE_UNAVAILABLE',
          'The catalog file is no longer available.',
          false,
        );
      }
      snapshot = await this.createSnapshotFromAvailableLocations(
        model,
        current.item.hash,
        current.job.id,
        signal,
      );
      context = await this.options.profiles.getAuthenticatedContext(
        current.job.profileId,
      );
      assertContextMatchesJob(context, current.job);
      let thumbnail = await this.thumbnailFor(
        context,
        current.job.mode,
        snapshot.path,
      );
      await this.options.profiles.revalidateAuthenticatedContext(context);
      let remote: RemoteUploadResultDto;
      try {
        remote = await this.sendSnapshot(
          context,
          current.job,
          current.item,
          snapshot,
          thumbnail,
          signal,
          generation,
        );
        legacyBytesCommitted = current.job.mode === 'legacyModelOnly';
      } catch (error) {
        if (
          error instanceof ModelUploadError &&
          error.detail.code === 'UNAUTHENTICATED' &&
          current.job.mode === 'modern'
        ) {
          await this.options.profiles.invalidateRejectedContext(context);
          const refreshedContext =
            await this.options.profiles.getAuthenticatedContext(
              current.job.profileId,
            );
          if (
            refreshedContext.revision !== current.job.profileRevision ||
            refreshedContext.serverBinding !== current.job.serverBinding
          ) {
            throw profileChangedUploadError();
          }
          context = refreshedContext;
          assertContextMatchesJob(context, current.job);
          thumbnail = await this.thumbnailFor(
            context,
            current.job.mode,
            snapshot.path,
          );
          await this.options.profiles.revalidateAuthenticatedContext(context);
          remote = await this.sendSnapshot(
            context,
            current.job,
            current.item,
            snapshot,
            thumbnail,
            signal,
            generation,
          );
        } else {
          throw error;
        }
      }
      await this.linkRemote(
        current.job,
        current.item,
        remote,
        context,
        generation,
      );
      await snapshot.cleanup();
      snapshot = null;
      await this.durableMutate((draft) => {
        const item = requireItem(draft.jobs, jobId, itemId);
        item.remote = remote;
        item.bytesSent = item.size;
        setItemState(item, 'succeeded', this.isoNow(), null);
        const identity = requireIdentity(
          draft.identities,
          current.job.profileId,
          current.job.serverBinding,
          current.item.hash,
        );
        identity.remoteModelId = remote.id;
        identity.etag = remote.etag;
        identity.updatedAt = this.isoNow();
      }, generation);
    } catch (error) {
      if (snapshot) {
        try {
          await snapshot.cleanup();
        } catch (cleanupFailure) {
          cleanupError = controlledQueueError(cleanupFailure);
        }
      }
      await this.recordFailure(
        jobId,
        itemId,
        cleanupError ?? error,
        generation,
        legacyBytesCommitted ||
          (error instanceof ModelUploadError &&
            error.bytesMayHaveReachedServer &&
            isLegacyAmbiguousError(error)),
      );
      if (cleanupError) throw cleanupError;
    }
  }

  private async sendSnapshot(
    context: AuthenticatedProfileContext,
    job: UploadJobDto,
    item: UploadJobItem,
    snapshot: UploadSnapshot,
    thumbnail: Buffer | undefined,
    signal: AbortSignal,
    generation: number,
  ): Promise<RemoteUploadResultDto> {
    return this.transport({
      endpoint: context.endpoint('api/3d-models/upload').toString(),
      token: context.token,
      modelPath: snapshot.path,
      displayName: item.displayName,
      modelSize: snapshot.size,
      clientUploadId: item.clientUploadId,
      mode: job.mode,
      ...(thumbnail ? { thumbnail } : {}),
      signal,
      onProgress: async (bytesSent) => {
        if (generation !== this.queueGeneration || this.resetting) return;
        const live = this.currentItem(job.id, item.id).item;
        if (
          bytesSent - live.bytesSent < PROGRESS_CHECKPOINT_BYTES &&
          bytesSent !== snapshot.size
        ) {
          return;
        }

        await this.durableMutate((draft) => {
          const draftItem = requireItem(draft.jobs, job.id, item.id);
          draftItem.bytesSent = Math.min(snapshot.size, bytesSent);
          draftItem.updatedAt = this.isoNow();
        }, generation);
      },
    });
  }

  private async createSnapshotFromAvailableLocations(
    model: LogicalModel,
    expectedHash: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<UploadSnapshot> {
    let lastError: unknown = null;
    for (const location of model.locations) {
      if (!location.available) continue;
      try {
        const approved = await this.options.approvals.openApprovedFile(
          location.path,
        );
        return await this.options.snapshots.create(
          approved,
          expectedHash,
          jobId,
          signal,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        if (
          !(error instanceof RootApprovalError) &&
          !(error instanceof SnapshotError && error.code !== 'SNAPSHOT_FAILED')
        ) {
          throw error;
        }
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw makeUploadError(
      'FILE_UNAVAILABLE',
      'No approved catalog copy is available for this model.',
      false,
    );
  }

  private async thumbnailFor(
    context: AuthenticatedProfileContext,
    mode: UploadJobDto['mode'],
    snapshotPath: string,
  ): Promise<Buffer | undefined> {
    if (
      mode !== 'modern' ||
      !context.profile.capabilities?.modelFilesEnabled ||
      !context.profile.capabilities.clientThumbnailUploadEnabled
    ) {
      return undefined;
    }
    try {
      const raw = (await this.options.sidecar.renderThumbnail(
        snapshotPath,
        512,
      )) as { pngBase64?: unknown };
      if (typeof raw.pngBase64 !== 'string') return undefined;
      const thumbnail = Buffer.from(raw.pngBase64, 'base64');
      validateThumbnailPng(thumbnail);
      return thumbnail;
    } catch {
      return undefined;
    }
  }

  private async recordFailure(
    jobId: string,
    itemId: string,
    error: unknown,
    generation: number,
    legacyBytesCommitted: boolean,
  ): Promise<void> {
    await this.durableMutate((draft) => {
      const job = requireJob(draft.jobs, jobId);
      const item = requireItem(draft.jobs, jobId, itemId);
      const active = this.active.get(itemId);
      const detail = safeUploadError(error);
      if (isProfileChanged(error)) {
        setItemState(item, 'cancelled', this.isoNow(), detail);
      } else if (active?.action === 'pause' && job.mode === 'modern') {
        item.state = 'queued';
        item.bytesSent = 0;
        item.error = null;
        item.updatedAt = this.isoNow();
      } else if (active?.action === 'cancel' && job.mode === 'modern') {
        setItemState(item, 'cancelled', this.isoNow(), {
          ...detail,
          code: 'CANCELLED',
          message:
            'Upload cancelled. A safe retry retains the same upload identity.',
          retryable: true,
          duplicateRisk: false,
        });
      } else if (job.mode === 'legacyModelOnly' && legacyBytesCommitted) {
        setItemState(item, 'uncertain', this.isoNow(), {
          ...detail,
          code: 'LEGACY_UPLOAD_UNCERTAIN',
          message:
            'Legacy upload bytes may have reached the server. Confirm the duplicate risk explicitly before retrying.',
          retryable: false,
          duplicateRisk: true,
        });
      } else {
        setItemState(item, 'failed', this.isoNow(), detail);
      }
    }, generation);
  }

  private async linkRemote(
    job: UploadJobDto,
    item: UploadJobItem,
    remote: RemoteUploadResultDto,
    context: AuthenticatedProfileContext,
    generation: number,
  ): Promise<void> {
    await this.options.profiles.revalidateAuthenticatedContext(context);
    if (generation !== this.queueGeneration || this.resetting) {
      throw new StaleQueueGenerationError();
    }
    const live = this.currentItem(job.id, item.id);
    if (
      live.job.serverBinding !== context.serverBinding ||
      live.item.state !== 'uploading'
    ) {
      throw profileChangedUploadError();
    }
    const existing = parseRemoteLink(
      await this.options.sidecar.getRemoteModelLink(
        job.profileId,
        job.serverBinding,
        item.hash,
      ),
    );
    if (existing) {
      if (
        existing.uploadStatus !== 'uploaded' ||
        existing.serverBinding !== job.serverBinding
      ) {
        await this.options.sidecar.removeRemoteModelLink(
          job.profileId,
          job.serverBinding,
          item.hash,
        );
      } else {
        if (
          existing.remoteModelId !== remote.id ||
          existing.clientUploadId !== item.clientUploadId
        ) {
          throw new Error(
            'The catalog remote link conflicts with the completed upload.',
          );
        }
        return;
      }
    }
    const now = Math.floor(this.now() / 1000);
    const uploadedAt = Math.floor(Date.parse(remote.uploadedAt) / 1000);
    await this.options.sidecar.linkRemoteModel({
      profileId: job.profileId,
      serverBinding: job.serverBinding,
      localModelHash: item.hash,
      remoteModelId: remote.id,
      clientUploadId: item.clientUploadId,
      etag: remote.etag,
      uploadStatus: 'uploaded',
      createdAt: Math.min(now, uploadedAt),
      updatedAt: now,
      uploadedAt,
    });
  }

  private currentItem(
    jobId: string,
    itemId: string,
  ): { job: UploadJobDto; item: UploadJobItem } {
    const job = requireJob(this.state.jobs, jobId);
    const item = job.items.find((candidate) => candidate.id === itemId);
    if (!item) throw new Error('Upload item not found.');
    return { job, item };
  }

  private async durableMutate(
    operation: (draft: UploadJobStoreState) => void,
    expectedGeneration = this.queueGeneration,
  ): Promise<void> {
    await this.withMutationLock(async () => {
      if (expectedGeneration !== this.queueGeneration || this.resetting) {
        throw new StaleQueueGenerationError();
      }
      const draft = cloneState(this.state);
      operation(draft);
      for (const job of draft.jobs) refreshDerived(job);
      await this.options.store.saveState(draft);
      this.state = draft;
    });
  }

  private async commitDraft(
    draft: UploadJobStoreState,
    expectedState?: UploadJobStoreState,
    expectedGeneration = this.queueGeneration,
    expectedBinding?: string,
  ): Promise<void> {
    await this.withMutationLock(async () => {
      if (
        expectedGeneration !== this.queueGeneration ||
        this.resetting ||
        !this.initialized ||
        (expectedState && this.state !== expectedState)
      ) {
        throw new Error(
          'The upload queue changed concurrently. Retry creating the job.',
        );
      }
      if (
        expectedBinding &&
        draft.jobs.some(
          (job) =>
            job.serverBinding === expectedBinding &&
            this.changingProfileBindings.has(job.profileId),
        )
      ) {
        throw profileChangedUploadError();
      }
      for (const job of draft.jobs) refreshDerived(job);
      await this.options.store.saveState(draft);
      this.state = structuredClone(draft);
    });
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.mutationTail;
    let release: () => void = () => undefined;
    this.mutationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

export function createUploadJobService(
  userDataPath: string,
  sidecar: SidecarClient,
  profiles: ServerProfileService,
  approvals: RootApprovalStore,
): UploadJobService {
  return new UploadJobService({
    store: new UploadJobStore({ userDataPath }),
    sidecar,
    profiles,
    approvals,
    snapshots: new PrivateSnapshotManager(userDataPath),
  });
}

function assertContextMatchesJob(
  context: AuthenticatedProfileContext,
  job: UploadJobDto,
): void {
  const currentMode = modeForProfile(context.profile);
  if (
    currentMode !== job.mode ||
    context.revision !== job.profileRevision ||
    context.serverBinding !== job.serverBinding ||
    context.profile.id !== job.profileId
  ) {
    throw profileChangedUploadError();
  }
}

function modeForProfile(profile: ServerProfile): UploadJobDto['mode'] {
  const availability = profile.availability.modelUpload;
  if (
    !availability.available ||
    availability.mode === 'unavailable' ||
    profile.capabilities?.modelFilesEnabled === false
  ) {
    throw makeUploadError(
      'UPLOAD_UNAVAILABLE',
      availability.reason ?? 'Model upload is unavailable on this server.',
      false,
    );
  }
  return availability.mode === 'modern' &&
    profile.capabilities?.modelFilesEnabled === true &&
    profile.capabilities.idempotentModelUploadEnabled === true
    ? 'modern'
    : 'legacyModelOnly';
}

function profileChangedUploadError(): ModelUploadError {
  return makeUploadError(
    'PROFILE_CHANGED',
    'The server profile changed during upload preparation. Review it before retrying.',
    false,
  );
}

function isProfileChanged(error: unknown): boolean {
  return (
    (error instanceof ModelUploadError &&
      error.detail.code === 'PROFILE_CHANGED') ||
    (error instanceof ServerProfileError &&
      error.code === 'AUTHENTICATION_SUPERSEDED')
  );
}

function isLegacyAmbiguousError(error: ModelUploadError): boolean {
  return [
    'ABORTED',
    'UPLOAD_TIMEOUT',
    'RESPONSE_TIMEOUT',
    'TRANSPORT_ERROR',
    'INVALID_RESPONSE',
    'RESPONSE_TOO_LARGE',
    'SERVER_ERROR',
    'REQUEST_TIMEOUT',
    'TOO_EARLY',
  ].includes(error.detail.code);
}

function parseRemoteLink(raw: unknown): RemoteModelLink | null {
  if (raw === null || raw === undefined) return null;
  const parsed = z
    .object({
      profileId: z.string().uuid(),
      serverBinding: z.string().min(1).max(128),
      localModelHash: z.string().regex(/^[a-f0-9]{64}$/),
      remoteModelId: z.string().min(1).max(256),
      clientUploadId: z.string().uuid(),
      etag: z.string().min(1).max(1024).nullable().optional(),
      uploadedAt: z.number().int().nonnegative().nullable().optional(),
      uploadStatus: z.enum(['pending', 'uploading', 'uploaded', 'failed']),
    })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success)
    throw new Error('The catalog remote model link is invalid.');
  return {
    profileId: parsed.data.profileId,
    serverBinding: parsed.data.serverBinding,
    localModelHash: parsed.data.localModelHash,
    remoteModelId: parsed.data.remoteModelId,
    clientUploadId: parsed.data.clientUploadId,
    uploadStatus: parsed.data.uploadStatus,
    etag: parsed.data.etag ?? null,
    uploadedAt: parsed.data.uploadedAt ?? null,
  };
}

function safeUploadError(error: unknown): UploadError {
  if (error instanceof ModelUploadError) return error.detail;
  if (error instanceof SnapshotError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.code !== 'SOURCE_SYMLINK',
      retryAfterSeconds: null,
      duplicateRisk: false,
    };
  }
  if (error instanceof ServerProfileError) {
    return {
      code: error.code,
      message:
        error.code === 'AUTHENTICATION_SUPERSEDED'
          ? 'The server profile changed during upload preparation.'
          : 'The server profile could not authorize this upload.',
      retryable: error.code !== 'AUTHENTICATION_SUPERSEDED',
      retryAfterSeconds: error.retryAfterSeconds,
      duplicateRisk: false,
    };
  }
  return {
    code: 'UPLOAD_FAILED',
    message: 'The upload failed before a trusted result was available.',
    retryable: true,
    retryAfterSeconds: null,
    duplicateRisk: false,
  };
}

function controlledQueueError(error: unknown): Error {
  if (
    error instanceof UploadJobStoreError ||
    error instanceof SnapshotError ||
    error instanceof ModelUploadError
  ) {
    return error;
  }
  return new Error(
    'The upload queue encountered an internal error. No unsafe state transition was applied.',
  );
}

function availableLocation(
  model: LogicalModel,
): LogicalModel['locations'][number] | null {
  return model.locations.find((location) => location.available) ?? null;
}

function displayName(model: LogicalModel): string {
  const location = availableLocation(model) ?? model.locations[0];
  return location
    ? path.basename(location.path)
    : `${model.hash.slice(0, 12)}.${model.format === 'threeMf' ? '3mf' : model.format}`;
}

function cloneState(state: UploadJobStoreState): UploadJobStoreState {
  return structuredClone(state);
}

function requireJob(jobs: UploadJobDto[], jobId: string): UploadJobDto {
  const job = jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error('Upload job not found.');
  return job;
}

function requireItem(
  jobs: UploadJobDto[],
  jobId: string,
  itemId: string,
): UploadJobItem {
  const item = requireJob(jobs, jobId).items.find(
    (candidate) => candidate.id === itemId,
  );
  if (!item) throw new Error('Upload item not found.');
  return item;
}

function requireIdentity(
  identities: UploadIdentity[],
  profileId: string,
  serverBinding: string,
  hash: string,
): UploadIdentity {
  const identity = identities.find(
    (candidate) =>
      candidate.profileId === profileId &&
      candidate.serverBinding === serverBinding &&
      candidate.hash === hash,
  );
  if (!identity) throw new Error('Durable upload identity not found.');
  return identity;
}

function setItemState(
  item: UploadJobItem,
  state: UploadJobItem['state'],
  timestamp: string,
  error: UploadError | null,
): void {
  item.state = state;
  item.updatedAt = timestamp;
  item.error = error;
}

function emptySummary(): UploadJobDto['summary'] {
  return {
    queued: 0,
    uploading: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    uncertain: 0,
  };
}

function refreshDerived(job: UploadJobDto): void {
  const summary = emptySummary();
  let bytesSent = 0;
  let totalBytes = 0;
  for (const item of job.items) {
    summary[item.state] += 1;
    bytesSent += Math.min(item.bytesSent, item.size);
    totalBytes += item.size;
  }
  job.summary = summary;
  job.bytesSent = bytesSent;
  job.totalBytes = totalBytes;
  job.state = job.paused
    ? 'paused'
    : summary.queued > 0 || summary.uploading > 0
      ? 'running'
      : summary.uncertain > 0
        ? 'attention'
        : summary.succeeded === job.items.length
          ? 'completed'
          : summary.cancelled === job.items.length
            ? 'cancelled'
            : 'partialFailure';
  job.updatedAt = job.items.reduce(
    (latest, item) => (item.updatedAt > latest ? item.updatedAt : latest),
    job.updatedAt,
  );
}

function identitiesFromJobs(jobs: UploadJobDto[]): UploadIdentity[] {
  const identities = new Map<string, UploadIdentity>();
  for (const job of jobs) {
    for (const item of job.items) {
      const key = `${job.profileId}:${job.serverBinding}:${item.hash}`;
      const existing = identities.get(key);
      if (existing && existing.clientUploadId !== item.clientUploadId) {
        throw new UploadJobStoreError(
          'CORRUPT_STORE',
          'Legacy queue data contains conflicting durable upload identities.',
        );
      }
      identities.set(key, {
        profileId: job.profileId,
        hash: item.hash,
        clientUploadId: item.clientUploadId,
        serverBinding: job.serverBinding,
        remoteModelId: item.remote?.id ?? null,
        etag: item.remote?.etag ?? null,
        updatedAt: item.updatedAt,
      });
    }
  }
  return [...identities.values()];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
