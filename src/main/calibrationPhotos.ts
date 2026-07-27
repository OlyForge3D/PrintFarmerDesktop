import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  inspectCalibrationPhoto,
  MAX_CALIBRATION_PHOTO_BYTES,
} from './calibrationWire.js';

export const CALIBRATION_PHOTO_APPROVAL_TTL_MS = 5 * 60 * 1_000;
const CALIBRATION_PHOTO_TEMP_MAX_AGE_MS = 5 * 60 * 1_000;

interface Approval {
  ownerId: number;
  path: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class CalibrationPhotoApprovalStore {
  readonly #approvals = new Map<string, Approval>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CALIBRATION_PHOTO_APPROVAL_TTL_MS;
  }

  approve(photoPath: string, ownerId: number): string {
    this.cleanupExpired();
    const approvalId = randomUUID();
    const expiresAt = this.#now() + this.#ttlMs;
    const timer = setTimeout(() => {
      const approval = this.#approvals.get(approvalId);
      if (approval && approval.expiresAt <= this.#now()) {
        this.#approvals.delete(approvalId);
      }
    }, this.#ttlMs);
    timer.unref();
    this.#approvals.set(approvalId, {
      ownerId,
      path: photoPath,
      expiresAt,
      timer,
    });
    return approvalId;
  }

  consume(approvalId: string, ownerId: number): string {
    const approval = this.#approvals.get(approvalId);
    if (!approval || approval.expiresAt <= this.#now()) {
      if (approval) {
        clearTimeout(approval.timer);
        this.#approvals.delete(approvalId);
      }
      throw Object.assign(
        new Error('The calibration photo approval is missing or expired.'),
        { code: 'CALIBRATION_FILE_NOT_APPROVED' },
      );
    }
    if (approval.ownerId !== ownerId) {
      throw Object.assign(
        new Error('The calibration photo approval belongs to another window.'),
        { code: 'CALIBRATION_FILE_NOT_APPROVED' },
      );
    }

    clearTimeout(approval.timer);
    this.#approvals.delete(approvalId);
    return approval.path;
  }

  cleanupExpired(): void {
    const now = this.#now();
    for (const [approvalId, approval] of this.#approvals) {
      if (approval.expiresAt <= now) {
        clearTimeout(approval.timer);
        this.#approvals.delete(approvalId);
      }
    }
  }

  clear(): void {
    for (const approval of this.#approvals.values()) {
      clearTimeout(approval.timer);
    }
    this.#approvals.clear();
  }
}

async function assertNoLinkedPathSegments(filePath: string): Promise<void> {
  const absolutePath = path.resolve(filePath);
  const parsed = path.parse(absolutePath);
  let current = parsed.root;
  for (const segment of absolutePath
    .slice(parsed.root.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      throw new Error(
        'The approved photo path must not contain a symlink or reparse point.',
      );
    }
  }
}

export interface PrivateCalibrationPhoto {
  bytes: Buffer;
  contentHash: string;
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp';
  localPath: string;
  created: boolean;
}

export async function stagePrivateCalibrationPhoto(
  sourcePath: string,
  photoRoot: string,
  profileId: string,
  photoId: string,
): Promise<PrivateCalibrationPhoto> {
  await assertNoLinkedPathSegments(sourcePath);
  const { bytes, contentHash, mimeType, extension } =
    await inspectCalibrationPhoto(sourcePath);
  const photoDirectory = path.join(photoRoot, 'v1', profileId);
  await mkdir(photoDirectory, { recursive: true, mode: 0o700 });
  await assertNoLinkedPathSegments(photoDirectory);
  await chmod(photoDirectory, 0o700).catch(() => undefined);
  const finalPath = path.join(photoDirectory, `${photoId}.${extension}`);

  try {
    const existing = await lstat(finalPath);
    if (
      !existing.isFile() ||
      existing.isSymbolicLink() ||
      existing.size <= 0 ||
      existing.size > MAX_CALIBRATION_PHOTO_BYTES
    ) {
      throw new Error('The staged photo destination is not a valid file.');
    }
    const existingHash = createHash('sha256')
      .update(await readFile(finalPath))
      .digest('hex');
    if (existingHash !== contentHash) {
      throw new Error('photoId was already staged with different content.');
    }
    return {
      bytes,
      contentHash,
      mimeType,
      localPath: finalPath,
      created: false,
    };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : null;
    if (code !== 'ENOENT') throw error;

    const temporaryPath = path.join(
      photoDirectory,
      `.${photoId}.${randomUUID()}.tmp`,
    );
    try {
      await writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(temporaryPath, 0o600).catch(() => undefined);
      await link(temporaryPath, finalPath);
      return {
        bytes,
        contentHash,
        mimeType,
        localPath: finalPath,
        created: true,
      };
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function cleanupStaleCalibrationPhotoTemps(
  photoRoot: string,
  now = Date.now(),
): Promise<void> {
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 3) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        String(error.code) === 'ENOENT'
      ) {
        return;
      }
      throw error;
    }
    await Promise.all(
      entries.map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(entryPath, depth + 1);
          return;
        }
        if (!entry.isFile() || !/^\..+\.tmp$/.test(entry.name)) return;
        const info = await lstat(entryPath);
        if (now - info.mtimeMs >= CALIBRATION_PHOTO_TEMP_MAX_AGE_MS) {
          await rm(entryPath, { force: true });
        }
      }),
    );
  };
  await visit(photoRoot, 0);
}
