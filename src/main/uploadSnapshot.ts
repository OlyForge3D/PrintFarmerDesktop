import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { MAX_UPLOAD_REQUEST_BYTES } from './uploadTransport.js';
import type { ApprovedFile } from './rootApprovals.js';

const COPY_CHUNK_BYTES = 64 * 1024;

export interface UploadSnapshot {
  path: string;
  size: number;
  cleanup(): Promise<void>;
}

export interface SnapshotManager {
  initialize?(): Promise<void>;
  create(
    source: ApprovedFile,
    expectedHash: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<UploadSnapshot>;
}

export class SnapshotError extends Error {
  constructor(
    readonly code:
      | 'SOURCE_CHANGED'
      | 'SOURCE_SYMLINK'
      | 'SOURCE_TOO_LARGE'
      | 'SOURCE_UNAVAILABLE'
      | 'SNAPSHOT_FAILED',
    message: string,
  ) {
    super(message);
    this.name = 'SnapshotError';
  }
}

export class PrivateSnapshotManager implements SnapshotManager {
  private readonly root: string;

  constructor(
    userDataPath: string,
    private readonly createId: () => string = randomUUID,
    private readonly hooks: {
      afterChunk?: (bytesCopied: number) => Promise<void>;
      beforeCleanup?: () => Promise<void>;
    } = {},
  ) {
    this.root = path.join(userDataPath, 'upload-snapshots');
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    await fs.chmod(this.root, 0o700);
    const entries = await fs.readdir(this.root, { withFileTypes: true });
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          entry.name,
        )
      ) {
        continue;
      }
      const directory = path.join(this.root, entry.name);
      const directoryStat = await fs.lstat(directory);
      if (directoryStat.isSymbolicLink()) continue;
      const children = await fs.readdir(directory, { withFileTypes: true });
      if (
        children.some(
          (child) =>
            !child.isFile() ||
            child.isSymbolicLink() ||
            !/^[0-9a-f-]{36}\.model$/i.test(child.name),
        )
      ) {
        continue;
      }
      for (const child of children) {
        await fs.unlink(path.join(directory, child.name));
      }
      await fs.rmdir(directory);
    }
  }

  async create(
    approved: ApprovedFile,
    expectedHash: string,
    jobId: string,
    signal: AbortSignal,
  ): Promise<UploadSnapshot> {
    const directory = path.join(this.root, jobId);
    const snapshotPath = path.join(directory, `${this.createId()}.model`);
    let source: FileHandle | null = approved.handle;
    let destination: FileHandle | null = null;
    try {
      const opened = await source.stat();
      if (!opened.isFile()) {
        throw new SnapshotError(
          'SOURCE_UNAVAILABLE',
          'The catalog source is not a regular file.',
        );
      }
      if (
        opened.size !== approved.size ||
        opened.size > MAX_UPLOAD_REQUEST_BYTES
      ) {
        throw new SnapshotError(
          'SOURCE_TOO_LARGE',
          'The model exceeds the server upload limit.',
        );
      }
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      destination = await fs.open(
        snapshotPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL,
        0o600,
      );
      await destination.chmod(0o600);
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(COPY_CHUNK_BYTES);
      let total = 0;
      while (true) {
        if (signal.aborted) throw abortError();
        const { bytesRead } = await source.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        total += bytesRead;
        if (total > MAX_UPLOAD_REQUEST_BYTES) {
          throw new SnapshotError(
            'SOURCE_TOO_LARGE',
            'The model grew beyond the server upload limit while being copied.',
          );
        }
        await this.hooks.afterChunk?.(total);
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        let written = 0;
        while (written < bytesRead) {
          const result = await destination.write(
            chunk,
            written,
            bytesRead - written,
            null,
          );
          if (result.bytesWritten === 0) {
            throw new SnapshotError(
              'SNAPSHOT_FAILED',
              'The private upload snapshot could not be completed.',
            );
          }
          written += result.bytesWritten;
        }
      }
      if (total !== opened.size || hash.digest('hex') !== expectedHash) {
        throw new SnapshotError(
          'SOURCE_CHANGED',
          'The catalog source bytes no longer match its catalog identity.',
        );
      }
      await destination.sync();
      await destination.close();
      destination = null;
      await source.close();
      source = null;
      const finalStat = await fs.stat(snapshotPath);
      if (!finalStat.isFile() || finalStat.size !== total) {
        throw new SnapshotError(
          'SNAPSHOT_FAILED',
          'The private upload snapshot failed final verification.',
        );
      }
      let cleaned = false;
      return {
        path: snapshotPath,
        size: finalStat.size,
        cleanup: async () => {
          if (cleaned) return;
          await this.hooks.beforeCleanup?.();
          await removeSnapshot(snapshotPath, directory);
          cleaned = true;
        },
      };
    } catch (error) {
      await Promise.allSettled([source?.close(), destination?.close()]);
      await removeSnapshot(snapshotPath, directory);
      if (error instanceof SnapshotError || isAbortError(error)) throw error;
      throw new SnapshotError(
        'SOURCE_UNAVAILABLE',
        'The catalog source could not be snapshotted for upload.',
      );
    }
  }
}

async function removeSnapshot(
  snapshotPath: string,
  directory: string,
): Promise<void> {
  try {
    await fs.unlink(snapshotPath);
  } catch (error) {
    if (!isMissing(error)) {
      throw new SnapshotError(
        'SNAPSHOT_FAILED',
        'The private upload snapshot could not be removed.',
      );
    }
  }
  try {
    await fs.rmdir(directory);
  } catch (error) {
    if (!isMissing(error) && !isNotEmpty(error)) {
      throw new SnapshotError(
        'SNAPSHOT_FAILED',
        'The private snapshot directory could not be removed.',
      );
    }
  }
}

function abortError(): Error {
  const error = new Error('Snapshot creation was aborted.');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error
    ? (error as { code?: unknown }).code
    : null;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === 'ENOENT';
}

function isNotEmpty(error: unknown): boolean {
  return errorCode(error) === 'ENOTEMPTY';
}
