import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, promises as nodeFs } from 'node:fs';
import { z } from 'zod';
import {
  ListModelsResponse,
  UploadJob,
  type ListUploadJobsResponse,
  type LogicalModel,
  type RemoteUploadResult,
  type ServerProfile,
  type StartUploadJobRequest,
  type UploadError,
  type UploadJob as UploadJobDto,
  type UploadJobItem,
} from '@shared/ipc';
import type { ServerProfileService } from './serverProfiles.js';
import type { SidecarClient } from './sidecar.js';
import {
  createNodeUploadTransport,
  ModelUploadError,
  scrubSensitiveText,
  stableFileStat,
  validateThumbnailPng,
  type UploadTransport,
} from './uploadTransport.js';

export const UPLOAD_JOB_STORE_VERSION = 1;
export const MAX_UPLOAD_JOBS = 100;
export const MAX_UPLOAD_STORE_BYTES = 4 * 1024 * 1024;
export const DEFAULT_UPLOAD_CONCURRENCY = 2;

const UploadJobStoreFile = z
  .object({
    version: z.literal(UPLOAD_JOB_STORE_VERSION),
    jobs: z.array(UploadJob).max(MAX_UPLOAD_JOBS),
  })
  .strict();

type UploadJobStoreFile = z.infer<typeof UploadJobStoreFile>;

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
  private readonly fileSystem: UploadJobFileSystem;
  private readonly now: () => number;

  constructor(options: UploadJobStoreOptions) {
    this.fileSystem = options.fileSystem ?? nodeFileSystem;
    this.now = options.now ?? Date.now;
    this.storePath = path.join(options.userDataPath, 'upload-jobs.v1.json');
  }

  async load(): Promise<UploadJobDto[]> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fileSystem.readFile(this.storePath);
    } catch (error) {
      if (isMissingFile(error)) return [];
      throw new UploadJobStoreError(
        'CORRUPT_STORE',
        'The upload job store could not be read.',
        error,
      );
    }
    if (bytes.byteLength > MAX_UPLOAD_STORE_BYTES) {
      throw new UploadJobStoreError(
        'STORE_TOO_LARGE',
        'The upload job store exceeds its 4 MiB safety limit.',
      );
    }
    let parsed: UploadJobStoreFile;
    try {
      parsed = UploadJobStoreFile.parse(
        JSON.parse(Buffer.from(bytes).toString('utf8')),
      );
    } catch (error) {
      throw new UploadJobStoreError(
        'CORRUPT_STORE',
        'The upload job store is corrupt. Existing jobs were not discarded.',
        error,
      );
    }
    let recovered = false;
    const timestamp = new Date(this.now()).toISOString();
    for (const job of parsed.jobs) {
      for (const item of job.items) {
        if (item.state !== 'uploading') continue;
        recovered = true;
        item.state = 'uncertain';
        item.updatedAt = timestamp;
        item.error = {
          code: 'INTERRUPTED',
          message:
            job.mode === 'modern'
              ? 'PrintFarmer Desktop closed during this upload. Retry safely with the same upload ID.'
              : 'PrintFarmer Desktop closed during this legacy upload. The server may already contain a duplicate.',
          retryable: true,
          retryAfterSeconds: null,
          duplicateRisk: job.mode === 'legacyModelOnly',
        };
      }
      if (recovered) {
        job.updatedAt = timestamp;
        refreshDerived(job);
      }
    }
    if (recovered) await this.save(parsed.jobs);
    return structuredClone(parsed.jobs);
  }

  async save(jobs: UploadJobDto[]): Promise<void> {
    const payload = JSON.stringify(
      UploadJobStoreFile.parse({
        version: UPLOAD_JOB_STORE_VERSION,
        jobs,
      }),
    );
    if (Buffer.byteLength(payload) > MAX_UPLOAD_STORE_BYTES) {
      throw new UploadJobStoreError(
        'STORE_TOO_LARGE',
        'The upload job store exceeds its 4 MiB safety limit.',
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
        // Best-effort cleanup; the original atomic store remains untouched.
      }
      throw new UploadJobStoreError(
        'STORE_WRITE_FAILED',
        'Upload jobs could not be saved atomically.',
        error,
      );
    }
  }
}

export interface UploadSidecar {
  listModels(): Promise<unknown>;
  renderThumbnail(filePath: string, size?: number): Promise<unknown>;
  linkRemoteModel(link: {
    profileId: string;
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
  getToken(id: string): Promise<string>;
}

export interface UploadJobServiceOptions {
  store: UploadJobStore;
  sidecar: UploadSidecar;
  profiles: UploadProfileService;
  transport?: UploadTransport;
  concurrency?: number;
  now?: () => number;
  createId?: () => string;
}

interface ActiveUpload {
  controller: AbortController;
  action: 'pause' | 'cancel' | null;
}

export class UploadJobService {
  private jobs: UploadJobDto[] = [];
  private readonly active = new Map<string, ActiveUpload>();
  private readonly transport: UploadTransport;
  private readonly concurrency: number;
  private readonly now: () => number;
  private readonly createId: () => string;
  private initialized = false;
  private initializePromise: Promise<void> | null = null;
  private mutationTail: Promise<void> = Promise.resolve();
  private pumpPending = false;
  private progressSaveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: UploadJobServiceOptions) {
    this.transport = options.transport ?? createNodeUploadTransport();
    this.concurrency = Math.max(
      1,
      Math.min(8, options.concurrency ?? DEFAULT_UPLOAD_CONCURRENCY),
    );
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    if (!this.initializePromise) {
      this.initializePromise = this.options.store.load().then((jobs) => {
        this.jobs = jobs;
        this.initialized = true;
        this.schedulePump();
      });
    }
    return this.initializePromise;
  }

  async list(): Promise<ListUploadJobsResponse> {
    await this.initialize();
    return this.snapshotAll();
  }

  async start(request: StartUploadJobRequest): Promise<UploadJobDto> {
    await this.initialize();
    const [profileList, rawModels] = await Promise.all([
      this.options.profiles.list(),
      this.options.sidecar.listModels(),
    ]);
    const profile = profileList.profiles.find(
      (candidate) => candidate.id === request.profileId,
    );
    if (!profile)
      throw new Error('The selected server profile no longer exists.');
    const availability = profile.availability.modelUpload;
    if (!availability.available || availability.mode === 'unavailable') {
      throw new Error(
        availability.reason ?? 'Model upload is unavailable on this server.',
      );
    }
    const mode =
      availability.mode === 'modern' &&
      profile.capabilities?.modelFilesEnabled === true &&
      profile.capabilities.idempotentModelUploadEnabled === true
        ? 'modern'
        : 'legacyModelOnly';
    const models = ListModelsResponse.parse(rawModels);
    const byHash = new Map(models.map((model) => [model.hash, model]));
    const timestamp = this.isoNow();
    const items = request.hashes.map((hash): UploadJobItem => {
      const model = byHash.get(hash);
      if (!model)
        throw new Error(`Catalog model ${hash.slice(0, 12)} was not found.`);
      const location = availableLocation(model);
      if (!location) {
        throw new Error(
          `${displayName(model)} has no available catalog location.`,
        );
      }
      return {
        id: this.createId(),
        hash,
        clientUploadId: this.createId(),
        displayName: displayName(model),
        size: location.size,
        state: 'queued',
        bytesSent: 0,
        attempts: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
        remote: null,
        error: null,
      };
    });
    const job: UploadJobDto = {
      id: this.createId(),
      profileId: profile.id,
      profileName: profile.displayName,
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
    await this.mutate(async () => {
      if (this.jobs.length >= MAX_UPLOAD_JOBS) {
        throw new Error(
          `Upload queue is full (${MAX_UPLOAD_JOBS} jobs). Remove completed jobs first.`,
        );
      }
      this.jobs.push(job);
      await this.persist();
    });
    this.schedulePump();
    return this.snapshot(job);
  }

  async pause(jobId: string): Promise<UploadJobDto> {
    return this.control(jobId, (job) => {
      job.paused = true;
      for (const item of job.items) {
        const active = this.active.get(item.id);
        if (active) {
          active.action = 'pause';
          active.controller.abort();
        }
      }
    });
  }

  async resume(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      job.paused = false;
    });
    this.schedulePump();
    return result;
  }

  async cancel(jobId: string): Promise<UploadJobDto> {
    return this.control(jobId, (job) => {
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
        const active = this.active.get(item.id);
        if (active) {
          active.action = 'cancel';
          active.controller.abort();
        }
      }
    });
  }

  async retry(jobId: string): Promise<UploadJobDto> {
    const result = await this.control(jobId, (job) => {
      let changed = false;
      for (const item of job.items) {
        if (
          item.state === 'failed' ||
          item.state === 'cancelled' ||
          item.state === 'uncertain'
        ) {
          item.state = 'queued';
          item.bytesSent = 0;
          item.error = null;
          item.updatedAt = this.isoNow();
          changed = true;
        }
      }
      if (!changed) throw new Error('This job has no retryable items.');
      job.paused = false;
    });
    this.schedulePump();
    return result;
  }

  async remove(jobId: string): Promise<{ removed: true }> {
    await this.initialize();
    await this.mutate(async () => {
      const index = this.jobs.findIndex((job) => job.id === jobId);
      if (index < 0) throw new Error('Upload job not found.');
      const job = this.jobs[index]!;
      if (
        job.items.some(
          (item) => item.state === 'queued' || item.state === 'uploading',
        )
      ) {
        throw new Error(
          'Pause or cancel active uploads before removing this job.',
        );
      }
      this.jobs.splice(index, 1);
      await this.persist();
    });
    return { removed: true };
  }

  dispose(): void {
    if (this.progressSaveTimer) clearTimeout(this.progressSaveTimer);
    for (const active of this.active.values()) active.controller.abort();
    this.active.clear();
  }

  private async control(
    jobId: string,
    action: (job: UploadJobDto) => Promise<void> | void,
  ): Promise<UploadJobDto> {
    await this.initialize();
    let result: UploadJobDto | null = null;
    await this.mutate(async () => {
      const job = this.requireJob(jobId);
      await action(job);
      job.updatedAt = this.isoNow();
      refreshDerived(job);
      await this.persist();
      result = this.snapshot(job);
    });
    return result!;
  }

  private schedulePump(): void {
    if (!this.initialized || this.pumpPending) return;
    this.pumpPending = true;
    queueMicrotask(() => {
      this.pumpPending = false;
      this.pump();
    });
  }

  private pump(): void {
    while (this.active.size < this.concurrency) {
      const candidate = this.nextQueuedItem();
      if (!candidate) break;
      const { job, item } = candidate;
      const controller = new AbortController();
      this.active.set(item.id, { controller, action: null });
      setItemState(item, 'uploading', this.isoNow(), null);
      item.attempts += 1;
      refreshDerived(job);
      void this.persistProgress();
      void this.runItem(job, item, controller.signal);
    }
  }

  private nextQueuedItem(): { job: UploadJobDto; item: UploadJobItem } | null {
    for (const job of this.jobs) {
      if (job.paused) continue;
      const item = job.items.find((candidate) => candidate.state === 'queued');
      if (item) return { job, item };
    }
    return null;
  }

  private async runItem(
    job: UploadJobDto,
    item: UploadJobItem,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const [profileList, rawModels] = await Promise.all([
        this.options.profiles.list(),
        this.options.sidecar.listModels(),
      ]);
      const profile = profileList.profiles.find(
        (candidate) => candidate.id === job.profileId,
      );
      if (!profile) throw new Error('The upload server profile was removed.');
      if (!profile.availability.modelUpload.available) {
        throw new Error(
          profile.availability.modelUpload.reason ??
            'Model upload is no longer available.',
        );
      }
      const models = ListModelsResponse.parse(rawModels);
      const model = models.find((candidate) => candidate.hash === item.hash);
      const location = model ? availableLocation(model) : null;
      if (!model || !location) {
        throw new Error('The catalog file is no longer available.');
      }
      const before = await stableFileStat(location.path);
      if (before.size !== item.size || before.size !== location.size) {
        throw new Error(
          'The catalog file size changed after this job was created.',
        );
      }
      const hash = await hashFile(location.path, signal);
      if (hash !== item.hash) {
        throw new Error(
          'The catalog file content no longer matches its catalog hash.',
        );
      }
      const verified = await stableFileStat(location.path);
      if (
        verified.size !== before.size ||
        verified.mtimeMs !== before.mtimeMs
      ) {
        throw new Error(
          'The catalog file changed while it was being verified.',
        );
      }
      let thumbnail: Buffer | undefined;
      if (
        job.mode === 'modern' &&
        profile.capabilities?.clientThumbnailUploadEnabled
      ) {
        try {
          const raw = (await this.options.sidecar.renderThumbnail(
            location.path,
            512,
          )) as { pngBase64?: unknown };
          if (typeof raw.pngBase64 !== 'string') {
            throw new Error('Thumbnail renderer returned no PNG.');
          }
          thumbnail = Buffer.from(raw.pngBase64, 'base64');
          await validateThumbnailPng(thumbnail);
        } catch {
          thumbnail = undefined;
        }
      }
      const token = await this.options.profiles.getToken(job.profileId);
      const remote = await this.transport({
        baseUrl: profile.baseUrl,
        token,
        modelPath: location.path,
        displayName: item.displayName,
        modelSize: item.size,
        clientUploadId: item.clientUploadId,
        mode: job.mode,
        ...(thumbnail ? { thumbnail } : {}),
        signal,
        onProgress: (bytesSent) => {
          item.bytesSent = Math.min(item.size, bytesSent);
          item.updatedAt = this.isoNow();
          refreshDerived(job);
          this.scheduleProgressSave();
        },
      });
      item.remote = remote;
      const after = await stableFileStat(location.path);
      if (after.size !== verified.size || after.mtimeMs !== verified.mtimeMs) {
        throw new ModelUploadError({
          code: 'FILE_CHANGED_DURING_UPLOAD',
          message:
            'The local file changed during upload. The server result is uncertain.',
          retryable: job.mode === 'modern',
          retryAfterSeconds: null,
          duplicateRisk: job.mode === 'legacyModelOnly',
        });
      }
      await this.linkRemote(job, item, remote);
      await this.mutate(async () => {
        item.remote = remote;
        item.bytesSent = item.size;
        setItemState(item, 'succeeded', this.isoNow(), null);
        refreshDerived(job);
        await this.persist();
      });
    } catch (error) {
      await this.mutate(async () => {
        const active = this.active.get(item.id);
        const action = active?.action ?? null;
        const detail = scrubUploadError(error, job.mode === 'legacyModelOnly');
        if (action === 'pause' && job.mode === 'modern') {
          item.state = 'queued';
          item.bytesSent = 0;
          item.error = null;
          item.updatedAt = this.isoNow();
        } else if (action === 'cancel' && job.mode === 'modern') {
          setItemState(item, 'cancelled', this.isoNow(), {
            ...detail,
            code: 'CANCELLED',
            message:
              'Upload cancelled. Retry uses the same upload ID to recover a possible server commit.',
            retryable: true,
            duplicateRisk: false,
          });
        } else if (
          (action === 'pause' || action === 'cancel') &&
          job.mode === 'legacyModelOnly'
        ) {
          setItemState(item, 'uncertain', this.isoNow(), {
            ...detail,
            code: 'LEGACY_UPLOAD_UNCERTAIN',
            message:
              'The legacy upload was interrupted after it started. It may have completed; retrying can create a duplicate.',
            retryable: true,
            duplicateRisk: true,
          });
        } else {
          const committedLegacyUpload =
            job.mode === 'legacyModelOnly' && item.remote !== null;
          setItemState(
            item,
            committedLegacyUpload ||
              detail.code === 'FILE_CHANGED_DURING_UPLOAD'
              ? 'uncertain'
              : 'failed',
            this.isoNow(),
            {
              ...detail,
              ...(committedLegacyUpload
                ? {
                    code: 'LEGACY_UPLOAD_UNCERTAIN',
                    message:
                      'The legacy server accepted the model, but its local link could not be finalized. Retrying can create a duplicate.',
                    duplicateRisk: true,
                  }
                : {}),
            },
          );
        }
        refreshDerived(job);
        await this.persist();
      });
    } finally {
      this.active.delete(item.id);
      this.schedulePump();
    }
  }

  private async linkRemote(
    job: UploadJobDto,
    item: UploadJobItem,
    remote: RemoteUploadResult,
  ): Promise<void> {
    const now = Math.floor(this.now() / 1000);
    const uploadedAt = Math.floor(Date.parse(remote.uploadedAt) / 1000);
    const createdAt = Math.min(now, uploadedAt);
    await this.options.sidecar.linkRemoteModel({
      profileId: job.profileId,
      localModelHash: item.hash,
      remoteModelId: remote.id,
      clientUploadId: item.clientUploadId,
      etag: remote.etag,
      uploadStatus: 'uploaded',
      createdAt,
      updatedAt: now,
      uploadedAt,
    });
  }

  private scheduleProgressSave(): void {
    if (this.progressSaveTimer) return;
    this.progressSaveTimer = setTimeout(() => {
      this.progressSaveTimer = null;
      void this.persistProgress();
    }, 200);
  }

  private async persistProgress(): Promise<void> {
    try {
      await this.mutate(async () => this.persist());
    } catch {
      // The terminal transition retries persistence and surfaces a failure.
    }
  }

  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
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

  private persist(): Promise<void> {
    for (const job of this.jobs) refreshDerived(job);
    return this.options.store.save(this.jobs);
  }

  private requireJob(jobId: string): UploadJobDto {
    const job = this.jobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new Error('Upload job not found.');
    return job;
  }

  private snapshot(job: UploadJobDto): UploadJobDto {
    return UploadJob.parse(structuredClone(job));
  }

  private snapshotAll(): ListUploadJobsResponse {
    return this.jobs.map((job) => this.snapshot(job));
  }

  private isoNow(): string {
    return new Date(this.now()).toISOString();
  }
}

export function createUploadJobService(
  userDataPath: string,
  sidecar: SidecarClient,
  profiles: ServerProfileService,
): UploadJobService {
  return new UploadJobService({
    store: new UploadJobStore({ userDataPath }),
    sidecar,
    profiles,
  });
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

async function hashFile(
  filePath: string,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  const abort = (): void => {
    stream.destroy(new Error('aborted'));
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      hash.update(chunk);
    }
  } finally {
    signal.removeEventListener('abort', abort);
  }
  return hash.digest('hex');
}

function scrubUploadError(error: unknown, legacy: boolean): UploadError {
  if (error instanceof ModelUploadError) {
    return {
      ...error.detail,
      message: scrubSensitiveText(error.detail.message),
      duplicateRisk: error.detail.duplicateRisk || legacy,
    };
  }
  return {
    code: 'UPLOAD_FAILED',
    message: scrubSensitiveText(
      error instanceof Error ? error.message : 'The upload failed.',
    ).slice(0, 1024),
    retryable: true,
    retryAfterSeconds: null,
    duplicateRisk: legacy,
  };
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

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
