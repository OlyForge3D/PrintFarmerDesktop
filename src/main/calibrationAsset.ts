/**
 * Main-process calibration asset file inspection and validation (A-04).
 *
 * Only `inspectCalibrationModel` and `validateCalibrationModel` are exported.
 * Neither the renderer nor the preload ever see local file paths.
 */
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import type { CalibrationAssetValidationReasonCode } from '@shared/ipc.js';

export const MAX_CALIBRATION_MODEL_BYTES = 50 * 1024 * 1024; // 50 MiB
export const MIN_CALIBRATION_MODEL_BYTES = 512; // 512 B

const CALIBRATION_MODEL_APPROVAL_TTL_MS = 5 * 60 * 1_000;

interface ModelApproval {
  ownerId: number;
  filePath: string;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class CalibrationModelApprovalStore {
  readonly #approvals = new Map<string, ModelApproval>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? CALIBRATION_MODEL_APPROVAL_TTL_MS;
  }

  approve(filePath: string, ownerId: number): string {
    this.cleanupExpired();
    const approvalId = randomUUID();
    const expiresAt = this.#now() + this.#ttlMs;
    const timer = setTimeout(() => {
      const a = this.#approvals.get(approvalId);
      if (a && a.expiresAt <= this.#now()) this.#approvals.delete(approvalId);
    }, this.#ttlMs);
    timer.unref();
    this.#approvals.set(approvalId, { ownerId, filePath, expiresAt, timer });
    return approvalId;
  }

  consume(approvalId: string, ownerId: number): string {
    const a = this.#approvals.get(approvalId);
    if (!a || a.expiresAt <= this.#now()) {
      if (a) {
        clearTimeout(a.timer);
        this.#approvals.delete(approvalId);
      }
      throw Object.assign(
        new Error('The calibration model approval is missing or expired.'),
        { code: 'CALIBRATION_MODEL_NOT_APPROVED' },
      );
    }
    if (a.ownerId !== ownerId) {
      throw Object.assign(
        new Error('The calibration model approval belongs to another window.'),
        { code: 'CALIBRATION_MODEL_NOT_APPROVED' },
      );
    }
    clearTimeout(a.timer);
    this.#approvals.delete(approvalId);
    return a.filePath;
  }

  cleanupExpired(): void {
    const now = this.#now();
    for (const [id, a] of this.#approvals) {
      if (a.expiresAt <= now) {
        clearTimeout(a.timer);
        this.#approvals.delete(id);
      }
    }
  }
}

export type DetectedModelType = '3mf' | 'stl';

export type CalibrationModelInspectionResult =
  | {
      status: 'valid';
      sha256: string;
      byteSize: number;
      detectedType: DetectedModelType;
    }
  | {
      status: 'invalid';
      reason: CalibrationAssetValidationReasonCode;
      detail: string | null;
    };

function detectedExtension(filePath: string): '3mf' | 'stl' | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.3mf') return '3mf';
  if (ext === '.stl') return 'stl';
  return null;
}

function is3mfMagic(header: Buffer): boolean {
  return (
    header.length >= 4 &&
    header[0] === 0x50 &&
    header[1] === 0x4b &&
    header[2] === 0x03 &&
    header[3] === 0x04
  );
}

/**
 * Inspect a calibration model file.
 * Validates extension, magic bytes, file size, and basic structure.
 * Returns a typed result — never throws for validation failures.
 */
export async function inspectCalibrationModel(
  approvedPath: string,
  expectedSha256: string | null,
): Promise<CalibrationModelInspectionResult> {
  const extType = detectedExtension(approvedPath);
  if (extType === null) {
    return {
      status: 'invalid',
      reason: 'invalidExtension',
      detail: `Expected .3mf or .stl; got "${path.extname(approvedPath)}"`,
    };
  }

  let linkInfo: Awaited<ReturnType<typeof lstat>>;
  try {
    linkInfo = await lstat(approvedPath);
  } catch {
    return {
      status: 'invalid',
      reason: 'notARegularFile',
      detail: 'File could not be stat-ed.',
    };
  }
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    return {
      status: 'invalid',
      reason: 'notARegularFile',
      detail: 'The selected file is not a regular, non-symlink file.',
    };
  }
  const fileSize = linkInfo.size;
  if (fileSize > MAX_CALIBRATION_MODEL_BYTES) {
    return {
      status: 'invalid',
      reason: 'fileTooLarge',
      detail: `File is ${fileSize} bytes; maximum is ${MAX_CALIBRATION_MODEL_BYTES} bytes.`,
    };
  }
  if (fileSize < MIN_CALIBRATION_MODEL_BYTES) {
    return {
      status: 'invalid',
      reason: 'fileTooSmall',
      detail: `File is ${fileSize} bytes; minimum is ${MIN_CALIBRATION_MODEL_BYTES} bytes.`,
    };
  }

  const file = await open(
    approvedPath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let bytes: Buffer;
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.size <= 0 ||
      before.size > MAX_CALIBRATION_MODEL_BYTES
    ) {
      return { status: 'invalid', reason: 'fileTooLarge', detail: null };
    }
    bytes = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (before.ino !== 0 && after.ino !== before.ino)
    ) {
      return {
        status: 'invalid',
        reason: 'fileChangedDuringRead',
        detail: 'File changed while being read.',
      };
    }
  } finally {
    await file.close();
  }

  if (extType === '3mf') {
    const header = bytes.subarray(0, 4);
    if (!is3mfMagic(header)) {
      return {
        status: 'invalid',
        reason: 'invalidMagicBytes',
        detail: `Expected ZIP/3MF magic bytes (PK\\x03\\x04); got ${header.toString('hex')}`,
      };
    }
    const content = bytes.toString('latin1');
    if (
      !content.includes('3D/3dmodel.model') &&
      !content.includes('3d/3dmodel.model')
    ) {
      return {
        status: 'invalid',
        reason: 'geometryOutOfBounds',
        detail:
          'The .3mf file does not appear to contain a valid 3D model part (3D/3dmodel.model not found).',
      };
    }
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (expectedSha256 !== null && sha256 !== expectedSha256) {
    return {
      status: 'invalid',
      reason: 'checksumMismatch',
      detail: `Expected SHA-256 ${expectedSha256}; got ${sha256}`,
    };
  }

  return {
    status: 'valid',
    sha256,
    byteSize: bytes.length,
    detectedType: extType,
  };
}
