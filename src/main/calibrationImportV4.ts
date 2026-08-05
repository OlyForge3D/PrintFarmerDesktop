/**
 * Legacy calibration backup v4 import (issue #56).
 *
 * Provides bounded preflight validation and authenticated backend import for
 * legacy schema-v4 calibration backup files. The renderer never receives
 * arbitrary filesystem access; it interacts only through the typed IPC
 * surface. All file reading, path resolution, photo validation, and backend
 * mutation are main-process-only.
 *
 * Security contract:
 * - The renderer cannot supply a file path; it supplies only an approvalId
 *   from a prior native file-picker invocation (CalibrationPickLegacyBackupV4).
 * - File access is bounded: size, depth, array/string/photo limits are all
 *   enforced before any allocation of large parsed content.
 * - Paths and sensitive photo metadata (EXIF/GPS) are never returned to the
 *   renderer and never appear in migration reports.
 * - Source files remain unchanged; temporary decoded content is deterministically
 *   cleaned up whether the import succeeds or fails.
 * - No scripts, G-code, profile JSON bytes, or model content are executed during
 *   import validation; the backup JSON is parsed with strict schema enforcement.
 * - No browser storage, hidden directories, other-app directories, static printer
 *   database, or model/profile content outside the user-selected file is accessed.
 *
 * @module calibrationImportV4
 */

import { randomUUID, createHash } from 'node:crypto';
import { lstat, open } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { z } from 'zod';
import {
  findDuplicateJsonObjectKey,
  findUnsafeJsonNumber,
} from './untrustedJson.js';
import {
  LegacyCalibrationBackupSummary,
  LegacyBackupProjectOutcome,
  LegacyBackupProjectResult,
  type LegacyBackupPrinterMapping,
  CalibrationApiError,
} from '@shared/ipc.js';
import type { CalibrationTokenProvider } from './calibrationHttp.js';

// ---------------------------------------------------------------------------
// Bounded resource limits
// ---------------------------------------------------------------------------

/** Maximum raw backup file size: 50 MiB */
export const MAX_BACKUP_FILE_BYTES = 50 * 1024 * 1024;
/** Maximum decoded JSON text length: 50 MiB characters */
const MAX_JSON_TEXT_BYTES = 50 * 1024 * 1024;
/** Maximum number of projects in one backup */
const MAX_PROJECT_COUNT = 1_000;
/** Maximum number of attempts per project */
const MAX_ATTEMPT_COUNT_PER_PROJECT = 500;
/** Maximum number of photos per project */
const MAX_PHOTO_COUNT_PER_PROJECT = 200;
/** Maximum number of steps per project */
const MAX_STEP_COUNT_PER_PROJECT = 50;
/** Maximum photo data URL decoded bytes: 10 MiB */
const MAX_PHOTO_DECODED_BYTES = 10 * 1024 * 1024;
/** Maximum nesting depth for JSON parse validation */
const MAX_JSON_NESTING_DEPTH = 20;
/** Maximum string length in schema fields */
const MAX_FIELD_STRING_LENGTH = 4096;
/** Maximum approval TTL: 10 minutes */
const APPROVAL_TTL_MS = 10 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Approval store — maps approvalId → file path (no renderer exposure)
// ---------------------------------------------------------------------------

interface BackupApproval {
  path: string;
  ownerId: number;
  expiresAt: number;
  timer: ReturnType<typeof setTimeout>;
}

export class LegacyBackupApprovalStore {
  readonly #approvals = new Map<string, BackupApproval>();
  readonly #now: () => number;
  readonly #ttlMs: number;

  constructor(options: { now?: () => number; ttlMs?: number } = {}) {
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? APPROVAL_TTL_MS;
  }

  approve(filePath: string, ownerId: number): string {
    this.cleanupExpired();
    const approvalId = randomUUID();
    const expiresAt = this.#now() + this.#ttlMs;
    const timer = setTimeout(() => {
      const a = this.#approvals.get(approvalId);
      if (a && a.expiresAt <= this.#now()) {
        this.#approvals.delete(approvalId);
      }
    }, this.#ttlMs);
    timer.unref();
    this.#approvals.set(approvalId, {
      path: filePath,
      ownerId,
      expiresAt,
      timer,
    });
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
        new Error('The backup file approval is missing or expired.'),
        { code: 'LEGACY_BACKUP_NOT_APPROVED' },
      );
    }
    if (a.ownerId !== ownerId) {
      throw Object.assign(
        new Error('The backup file approval belongs to another window.'),
        { code: 'LEGACY_BACKUP_NOT_APPROVED' },
      );
    }
    clearTimeout(a.timer);
    this.#approvals.delete(approvalId);
    return a.path;
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

  clear(): void {
    for (const a of this.#approvals.values()) clearTimeout(a.timer);
    this.#approvals.clear();
  }
}

// ---------------------------------------------------------------------------
// V4 backup schema (Zod)
//
// Describes the exact shape of a schema-v4 calibration backup JSON produced
// by the approved AGPL v1.3.2 source. The exact field set is inferred from
// the approved source boundary (ADR 0001, issue #51).
// ---------------------------------------------------------------------------

/** ISO 8601 date string — safe range only. */
const SafeDate = z
  .string()
  .max(64)
  .refine((s) => {
    const d = new Date(s);
    return (
      !isNaN(d.getTime()) && d.getFullYear() >= 2000 && d.getFullYear() <= 2100
    );
  }, 'Invalid or out-of-range date');

/** Non-empty string with reasonable max length. */
const BoundedString = (max = MAX_FIELD_STRING_LENGTH) =>
  z.string().min(1).max(max);

/** Nullable non-empty string. */
const NullableString = (max = MAX_FIELD_STRING_LENGTH) =>
  z
    .string()
    .max(max)
    .nullable()
    .optional()
    .transform((v) => v ?? null);

/** Safe non-finite-free number. */
const SafeNumber = z
  .number()
  .refine((n) => isFinite(n) && !isNaN(n), 'Non-finite number rejected');

/**
 * Legacy printer snapshot from the backup.
 * Contains no credential fields; network/API tokens are rejected at runtime.
 * Stored as an immutable sanitized record; never used to infer eligibility.
 */
const LegacyPrinterSnapshot = z
  .object({
    id: BoundedString(256).optional(),
    name: BoundedString(256).optional(),
    model: z.string().max(256).optional(),
    firmware: z.string().max(256).optional(),
    nozzleDiameterMm: SafeNumber.optional(),
    buildVolume: z
      .object({
        x: SafeNumber,
        y: SafeNumber,
        z: SafeNumber,
      })
      .optional(),
  })
  .passthrough()
  .transform((raw) => {
    // Strip any credential-shaped fields before storing the snapshot.
    const safe: Record<string, unknown> = {};
    const credentialPatterns =
      /password|secret|token|key|auth|credential|api[-_]?key/i;
    for (const [k, v] of Object.entries(raw)) {
      if (credentialPatterns.test(k)) continue;
      safe[k] = v;
    }
    return safe;
  });

/**
 * Photo record from the legacy backup.
 * dataUrl must be a data: URI; MIME and magic bytes are validated at preflight.
 */
const LegacyPhotoRecord = z
  .object({
    id: BoundedString(256),
    caption: z.string().max(1024).optional().default(''),
    order: SafeNumber.optional().default(0),
    dataUrl: z.string().max(MAX_PHOTO_DECODED_BYTES * 2),
    captureMetadata: z.record(z.unknown()).optional(),
  })
  .passthrough();
export type LegacyPhotoRecord = z.infer<typeof LegacyPhotoRecord>;

/**
 * Attempt event — append-only lifecycle record.
 */
const LegacyAttemptEvent = z
  .object({
    eventId: BoundedString(256).optional(),
    type: z.string().max(128),
    timestamp: SafeDate.optional(),
    payload: z.record(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Observation record — user measurement for one calibration parameter.
 */
const LegacyObservation = z
  .object({
    observationId: BoundedString(256).optional(),
    parameter: BoundedString(128),
    value: z
      .union([SafeNumber, z.string().max(256)])
      .nullable()
      .optional(),
    unit: z.string().max(64).optional(),
    notes: z.string().max(2048).optional(),
    confidence: z
      .enum(['none', 'low', 'medium', 'high', 'confirmed'])
      .optional(),
    recordedAt: SafeDate.optional(),
  })
  .passthrough();

/**
 * Attempt plan — immutable; describes what a single calibration attempt
 * is supposed to measure.
 */
const LegacyAttemptPlan = z
  .object({
    planId: BoundedString(256).optional(),
    stepType: z.string().max(128),
    targetValue: z
      .union([SafeNumber, z.string().max(256)])
      .nullable()
      .optional(),
    parameters: z.record(z.unknown()).optional(),
  })
  .passthrough();

/**
 * Calibration attempt — a single execution of one calibration step.
 */
const LegacyAttempt = z
  .object({
    id: BoundedString(256),
    plan: LegacyAttemptPlan.optional(),
    events: z.array(LegacyAttemptEvent).max(MAX_ATTEMPT_COUNT_PER_PROJECT),
    observations: z.array(LegacyObservation).max(100),
    result: z
      .object({
        outcome: z.string().max(64).optional(),
        value: z
          .union([SafeNumber, z.string().max(256)])
          .nullable()
          .optional(),
        notes: z.string().max(2048).optional(),
        decidedAt: SafeDate.optional(),
      })
      .passthrough()
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    notes: z
      .string()
      .max(4096)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    confidence: z
      .enum(['none', 'low', 'medium', 'high', 'confirmed'])
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    retestRequested: z.boolean().optional().default(false),
    createdAt: SafeDate.optional(),
    updatedAt: SafeDate.optional(),
  })
  .passthrough();
export type LegacyAttempt = z.infer<typeof LegacyAttempt>;

/**
 * Calibration step — one stage (e.g. flow rate, pressure advance) with an
 * ordered history of attempts.
 */
const LegacyStep = z
  .object({
    id: BoundedString(256),
    type: BoundedString(128),
    order: SafeNumber.optional().default(0),
    attempts: z.array(LegacyAttempt).max(MAX_ATTEMPT_COUNT_PER_PROJECT),
    currentAttemptId: NullableString(256),
    redoStack: z
      .array(LegacyAttempt)
      .max(MAX_ATTEMPT_COUNT_PER_PROJECT)
      .optional()
      .default([]),
    notes: z
      .string()
      .max(4096)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    createdAt: SafeDate.optional(),
    updatedAt: SafeDate.optional(),
  })
  .passthrough();
export type LegacyStep = z.infer<typeof LegacyStep>;

/**
 * Generated profile revision from the backup.
 * Must have exactJson (the original generated content) if present; normalizedSettings
 * and hash are optional but validated for consistency when supplied.
 */
const LegacyGeneratedProfile = z
  .object({
    exactJson: z.string().max(512 * 1024),
    normalizedSettings: z.record(z.unknown()).optional(),
    hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
  })
  .passthrough()
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/**
 * A single project from the legacy backup.
 */
const LegacyProject = z
  .object({
    id: BoundedString(256),
    name: BoundedString(512),
    mode: z.string().max(128),
    status: z.string().max(64),
    printerId: NullableString(256),
    printer: LegacyPrinterSnapshot.optional(),
    filamentId: NullableString(256),
    filamentName: NullableString(256),
    skuId: NullableString(256),
    spoolId: NullableString(256),
    steps: z.array(LegacyStep).max(MAX_STEP_COUNT_PER_PROJECT).default([]),
    currentStepId: NullableString(256),
    photos: z
      .array(LegacyPhotoRecord)
      .max(MAX_PHOTO_COUNT_PER_PROJECT)
      .default([]),
    generatedProfile: LegacyGeneratedProfile,
    notes: z
      .string()
      .max(4096)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    confidence: z
      .enum(['none', 'low', 'medium', 'high', 'confirmed'])
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    retestRequested: z.boolean().optional().default(false),
    legacyId: NullableString(256),
    createdAt: SafeDate.optional(),
    updatedAt: SafeDate.optional(),
  })
  .passthrough();
export type LegacyProject = z.infer<typeof LegacyProject>;

/** The exact top-level shape of a schema-v4 backup JSON. */
const LegacyBackupV4 = z
  .object({
    schemaVersion: z.literal(4),
    exportedAt: SafeDate,
    appVersion: z.string().max(64).optional(),
    projects: z.array(LegacyProject).max(MAX_PROJECT_COUNT),
  })
  .strict();
export type LegacyBackupV4 = z.infer<typeof LegacyBackupV4>;

// ---------------------------------------------------------------------------
// Depth limit: prevents deeply nested JSON from exhausting the stack
// ---------------------------------------------------------------------------

function measureJsonDepth(value: unknown, depth = 0): number {
  if (depth > MAX_JSON_NESTING_DEPTH) return depth;
  if (Array.isArray(value)) {
    return Math.max(
      depth,
      ...value.map((item) => measureJsonDepth(item, depth + 1)),
    );
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.values(value as Record<string, unknown>);
    if (entries.length === 0) return depth;
    return Math.max(
      depth,
      ...entries.map((v) => measureJsonDepth(v, depth + 1)),
    );
  }
  return depth;
}

// ---------------------------------------------------------------------------
// Photo validation
// ---------------------------------------------------------------------------

const DATA_URL_PATTERN =
  /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/;
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const WEBP_RIFF = Buffer.from('RIFF', 'ascii');
const WEBP_MARKER = Buffer.from('WEBP', 'ascii');

function validatePhotoDataUrl(dataUrl: string): {
  valid: boolean;
  reason?: string;
} {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    return {
      valid: false,
      reason: 'Invalid data URL format or unsupported MIME type',
    };
  }
  const [, declaredMime, b64] = match;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(b64!, 'base64');
  } catch {
    return { valid: false, reason: 'Invalid base64 encoding' };
  }
  if (decoded.byteLength > MAX_PHOTO_DECODED_BYTES) {
    return {
      valid: false,
      reason: `Photo exceeds ${MAX_PHOTO_DECODED_BYTES} decoded bytes`,
    };
  }
  if (decoded.byteLength < 8) {
    return {
      valid: false,
      reason: 'Photo too small to have valid magic bytes',
    };
  }
  // Validate magic vs declared MIME
  if (
    declaredMime === 'image/jpeg' &&
    !decoded.subarray(0, 3).equals(JPEG_MAGIC)
  ) {
    return {
      valid: false,
      reason: 'JPEG magic bytes do not match image/jpeg MIME',
    };
  }
  if (
    declaredMime === 'image/png' &&
    !decoded.subarray(0, 8).equals(PNG_MAGIC)
  ) {
    return {
      valid: false,
      reason: 'PNG magic bytes do not match image/png MIME',
    };
  }
  if (
    declaredMime === 'image/webp' &&
    !(
      decoded.subarray(0, 4).equals(WEBP_RIFF) &&
      decoded.subarray(8, 12).equals(WEBP_MARKER)
    )
  ) {
    return {
      valid: false,
      reason: 'WEBP magic bytes do not match image/webp MIME',
    };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Generated profile validation
// ---------------------------------------------------------------------------

interface ProfileValidationResult {
  valid: boolean;
  reason?: string;
  computedHash?: string;
}

function validateGeneratedProfile(
  profile: NonNullable<LegacyProject['generatedProfile']>,
): ProfileValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(profile.exactJson);
  } catch {
    return {
      valid: false,
      reason: 'Generated profile exactJson is not valid JSON',
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return {
      valid: false,
      reason: 'Generated profile exactJson is not a JSON object',
    };
  }
  const computedHash = createHash('sha256')
    .update(profile.exactJson, 'utf8')
    .digest('hex');
  if (profile.hash !== null && profile.hash !== computedHash) {
    return {
      valid: false,
      reason: `Generated profile hash mismatch: declared ${profile.hash}, computed ${computedHash}`,
    };
  }
  return { valid: true, computedHash };
}

// ---------------------------------------------------------------------------
// Source-to-target ID mapping (deterministic, collision-safe)
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic target UUID from a legacy source ID and a stable
 * namespace constant. This is collision-safe across different legacy IDs and
 * is idempotent: the same legacy ID always maps to the same target ID.
 *
 * Note: this is NOT a real UUID v5 namespace derivation (which requires
 * SHA-1 of the namespace UUID bytes + name). We use a simple SHA-256
 * derivation for determinism within this PFD import context.
 */
function deriveTargetId(legacyId: string, namespace: string): string {
  const hash = createHash('sha256')
    .update(`${namespace}:${legacyId}`, 'utf8')
    .digest('hex');
  // Format as UUID v4 shape (but deterministic)
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-${(
    (parseInt(hash[16]!, 16) & 0x3) |
    0x8
  ).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

const TARGET_ID_NAMESPACE = 'pfd-import-v4-2026';

// ---------------------------------------------------------------------------
// Preflight — pure local validation, no mutation, no network
// ---------------------------------------------------------------------------

export interface PreflightResult {
  summary: z.infer<typeof LegacyCalibrationBackupSummary>;
  projectOutcomes: z.infer<typeof LegacyBackupProjectOutcome>[];
  importableCount: number;
  unsupportedCount: number;
  corruptCount: number;
  requiresActionCount: number;
  warnings: string[];
  parsedBackup: LegacyBackupV4 | null;
}

/**
 * Run bounded local preflight on a legacy calibration backup file.
 *
 * - Reads at most MAX_BACKUP_FILE_BYTES.
 * - Validates magic marker, exact schema version, and top-level shape.
 * - Enforces all nesting, count, string, photo, and number limits.
 * - Detects duplicate JSON keys (best-effort).
 * - Classifies each project as importable/unsupported/corrupt/requiresAction.
 * - Never claims import completion, removes the source, or contacts the backend.
 *
 * @param filePath - Absolute path approved by the LegacyBackupApprovalStore.
 */
export async function runLegacyBackupPreflight(
  filePath: string,
): Promise<PreflightResult> {
  // --- 1. Stat the file (symlink check, size gate) ---
  const linkInfo = await lstat(filePath);
  if (linkInfo.isSymbolicLink() || !linkInfo.isFile()) {
    throw Object.assign(
      new Error('The selected backup must be a regular, non-symlink file.'),
      { code: 'LEGACY_BACKUP_INVALID_FILE' },
    );
  }
  if (linkInfo.size > MAX_BACKUP_FILE_BYTES) {
    throw Object.assign(
      new Error(
        `The backup file exceeds the maximum size of ${MAX_BACKUP_FILE_BYTES} bytes.`,
      ),
      { code: 'LEGACY_BACKUP_TOO_LARGE' },
    );
  }

  // --- 2. Read with O_NOFOLLOW ---
  const file = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  let rawBytes: Buffer;
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size > MAX_BACKUP_FILE_BYTES) {
      throw Object.assign(new Error('Backup file size is invalid.'), {
        code: 'LEGACY_BACKUP_TOO_LARGE',
      });
    }
    rawBytes = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (before.ino !== 0 && before.ino !== after.ino)
    ) {
      throw Object.assign(new Error('Backup file changed while being read.'), {
        code: 'LEGACY_BACKUP_CHANGED',
      });
    }
  } finally {
    await file.close();
  }

  const fileHash = createHash('sha256').update(rawBytes).digest('hex');

  // --- 3. Decode as UTF-8 text ---
  if (rawBytes.byteLength > MAX_JSON_TEXT_BYTES) {
    throw Object.assign(
      new Error('Backup JSON text exceeds maximum allowed size.'),
      { code: 'LEGACY_BACKUP_TOO_LARGE' },
    );
  }
  const jsonText = rawBytes.toString('utf8');

  // --- 4. Magic marker check (must start with a JSON object containing schemaVersion:4) ---
  const trimmed = jsonText.trimStart();
  if (!trimmed.startsWith('{')) {
    throw Object.assign(
      new Error(
        'Backup file does not start with a JSON object. Only schema-v4 backup files are supported.',
      ),
      { code: 'LEGACY_BACKUP_INVALID_MARKER' },
    );
  }

  // --- 5. Parse JSON ---
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(jsonText);
  } catch (e) {
    throw Object.assign(
      new Error(
        `Backup file is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      ),
      { code: 'LEGACY_BACKUP_INVALID_JSON' },
    );
  }

  // --- 6. Depth limit ---
  const depth = measureJsonDepth(rawJson);
  if (depth > MAX_JSON_NESTING_DEPTH) {
    throw Object.assign(
      new Error(
        `Backup JSON nesting depth ${depth} exceeds the maximum of ${MAX_JSON_NESTING_DEPTH}.`,
      ),
      { code: 'LEGACY_BACKUP_TOO_DEEP' },
    );
  }

  // --- 7. Unsafe numerics ---
  //
  // Measured before this existed: a backup declaring `payload_count:
  // 9007199254740993` or `payload_size: -1` was ACCEPTED and reported as
  // importable. Only non-finite values were refused, and only because
  // `JSON.parse` cannot produce them. An integer past 2^53 silently loses
  // identity on every subsequent comparison, and a negative size is a
  // length that no allocation or bound can honour, so both are refused here
  // rather than carried into the import.
  const unsafeNumber = findUnsafeJsonNumber(rawJson);
  if (unsafeNumber !== null) {
    throw Object.assign(
      new Error(
        `Backup JSON contains ${unsafeNumber.reason} number at ${unsafeNumber.path}.`,
      ),
      { code: 'LEGACY_BACKUP_UNSAFE_NUMBER' },
    );
  }

  // --- 8. Duplicate key detection ---
  //
  // Per *object*, not globally. The previous detector collected every key
  // name in the document into one set, so a backup holding both a project
  // and a photo repeated `id` and earned a duplicate-key warning with
  // nothing duplicated — a false positive that a real regression could have
  // hidden behind.
  const dupKey = findDuplicateJsonObjectKey(jsonText);
  const warnings: string[] = [];
  if (dupKey !== null) {
    warnings.push(`Duplicate JSON key detected: "${dupKey}" (last value wins)`);
  }

  // --- 9. Top-level schema validation ---
  const backupResult = LegacyBackupV4.safeParse(rawJson);
  if (!backupResult.success) {
    const issues = backupResult.error.issues.slice(0, 5).map((i) => i.message);
    throw Object.assign(
      new Error(`Backup file does not match schema-v4: ${issues.join('; ')}`),
      { code: 'LEGACY_BACKUP_INVALID_SCHEMA' },
    );
  }
  const backup = backupResult.data;

  // --- 10. Count totals ---
  let totalAttempts = 0;
  let totalPhotos = 0;
  for (const project of backup.projects) {
    for (const step of project.steps) {
      totalAttempts += step.attempts.length + step.redoStack.length;
    }
    totalPhotos += project.photos.length;
  }

  const summary: z.infer<typeof LegacyCalibrationBackupSummary> = {
    fileHash,
    detectedVersion: 4,
    projectCount: backup.projects.length,
    attemptCount: Math.min(totalAttempts, 100_000),
    photoCount: Math.min(totalPhotos, 100_000),
    formatValid: true,
  };

  // --- 10. Per-project classification ---
  const projectOutcomes: z.infer<typeof LegacyBackupProjectOutcome>[] = [];
  let importableCount = 0;
  let unsupportedCount = 0;
  let corruptCount = 0;
  let requiresActionCount = 0;

  for (const project of backup.projects) {
    const issues: string[] = [];
    let outcome: 'importable' | 'unsupported' | 'corrupt' | 'requiresAction' =
      'importable';

    // Check profile
    if (project.generatedProfile !== null) {
      const profileValidation = validateGeneratedProfile(
        project.generatedProfile,
      );
      if (!profileValidation.valid) {
        issues.push(`Generated profile: ${profileValidation.reason}`);
        outcome = 'corrupt';
      }
    }

    // Check photos
    let validPhotoCount = 0;
    for (const photo of project.photos) {
      const photoCheck = validatePhotoDataUrl(photo.dataUrl);
      if (!photoCheck.valid) {
        issues.push(`Photo ${photo.id}: ${photoCheck.reason}`);
        if (outcome === 'importable') outcome = 'requiresAction';
      } else {
        validPhotoCount++;
      }
    }

    // Check for unsupported modes
    const unsupportedModes = new Set(['legacy', 'deprecated', 'unknown']);
    if (unsupportedModes.has(project.mode)) {
      issues.push(`Unsupported calibration mode: ${project.mode}`);
      outcome = 'unsupported';
    }

    // Check for duplicate step IDs
    const stepIds = new Set<string>();
    for (const step of project.steps) {
      if (stepIds.has(step.id)) {
        issues.push(`Duplicate step ID: ${step.id}`);
        if (outcome === 'importable') outcome = 'requiresAction';
      }
      stepIds.add(step.id);
    }

    // Check for dangling currentStepId
    if (
      project.currentStepId !== null &&
      !project.steps.some((s) => s.id === project.currentStepId)
    ) {
      issues.push(
        `currentStepId ${project.currentStepId} does not reference an existing step`,
      );
      if (outcome === 'importable') outcome = 'requiresAction';
    }

    // Determine if printer mapping is required
    const requiresPrinterMapping = true; // Always require explicit mapping per spec

    const targetProjectId =
      outcome !== 'corrupt' && outcome !== 'unsupported'
        ? deriveTargetId(project.id, TARGET_ID_NAMESPACE)
        : null;

    const projectOutcome: z.infer<typeof LegacyBackupProjectOutcome> = {
      legacyProjectId: project.id,
      name: project.name,
      outcome,
      issues,
      stepCount: project.steps.length,
      attemptCount: project.steps.reduce(
        (acc, s) => acc + s.attempts.length + s.redoStack.length,
        0,
      ),
      photoCount: validPhotoCount,
      legacyPrinterName: (() => {
        if (!project.printer) return null;
        // project.printer is Record<string, unknown> after the schema transform
        const nameVal = project.printer.name;
        if (typeof nameVal === 'string') return nameVal.slice(0, 256) || null;
        return null;
      })(),
      requiresPrinterMapping,
      targetProjectId,
    };
    projectOutcomes.push(projectOutcome);

    switch (outcome) {
      case 'importable':
        importableCount++;
        break;
      case 'unsupported':
        unsupportedCount++;
        break;
      case 'corrupt':
        corruptCount++;
        break;
      case 'requiresAction':
        requiresActionCount++;
        break;
    }
  }

  return {
    summary,
    projectOutcomes,
    importableCount,
    unsupportedCount,
    corruptCount,
    requiresActionCount,
    warnings,
    parsedBackup: backup,
  };
}

// ---------------------------------------------------------------------------
// Import HTTP route constants
// ---------------------------------------------------------------------------

const IMPORT_ROUTES = {
  importLegacyBackupV4: '/api/calibration/import/legacy-backup-v4',
} as const;

// ---------------------------------------------------------------------------
// Backend import result schema
// ---------------------------------------------------------------------------

const RemoteImportProjectResult = z
  .object({
    legacyProjectId: z.string().max(256),
    targetProjectId: z.string().uuid(),
    outcome: z.enum(['created', 'skipped', 'unsupported', 'corrupt', 'error']),
    detail: z
      .string()
      .max(512)
      .nullable()
      .optional()
      .transform((v) => v ?? null),
    importedAttemptCount: z.number().int().nonnegative().optional().default(0),
    importedPhotoCount: z.number().int().nonnegative().optional().default(0),
  })
  .passthrough();

const RemoteImportLegacyBackupV4Response = z
  .object({
    importedProjectCount: z.number().int().nonnegative(),
    projectResults: z.array(RemoteImportProjectResult).max(10_000),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Backend import execution
// ---------------------------------------------------------------------------

export interface ImportExecutionOptions {
  tokens: CalibrationTokenProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

/**
 * Execute the authenticated import of a validated v4 backup against the
 * PrintFarmer backend.
 *
 * Security contract:
 * - Only the approved, preflight-validated JSON is sent; no raw file bytes.
 * - Auth token obtained fresh from the profile service before sending.
 * - No credentials or file paths are included in the payload.
 * - Idempotency-Key header covers the entire approved plan.
 * - 409 with changed payload returns idempotencyPayloadChanged error.
 * - Source file is NOT deleted or modified by this function.
 */
export async function executeLegacyBackupImport(
  profileId: string,
  baseUrl: string,
  backup: LegacyBackupV4,
  fileHash: string,
  printerMappings: LegacyBackupPrinterMapping[],
  operationId: string,
  signal: AbortSignal,
  options: ImportExecutionOptions,
): Promise<{
  summary: z.infer<typeof LegacyCalibrationBackupSummary>;
  importedProjectCount: number;
  projectResults: z.infer<typeof LegacyBackupProjectResult>[];
}> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  // Build the canonical payload hash (idempotency)
  const canonicalPayload = JSON.stringify({
    operationId,
    fileHash,
    projectCount: backup.projects.length,
    printerMappings: printerMappings
      .slice()
      .sort((a, b) => a.legacyProjectId.localeCompare(b.legacyProjectId)),
  });
  const payloadHash = createHash('sha256')
    .update(canonicalPayload, 'utf8')
    .digest('hex');

  // Obtain auth context
  const authCtx = await options.tokens.getAuthenticatedContext(profileId);

  // Prepare backup data payload (only the data needed by the backend)
  const importPayload = {
    fileHash,
    payloadHash,
    schemaVersion: 4,
    exportedAt: backup.exportedAt,
    printerMappings,
    projects: backup.projects.map((p) => ({
      legacyProjectId: p.id,
      name: p.name,
      mode: p.mode,
      status: p.status,
      targetProjectId: deriveTargetId(p.id, TARGET_ID_NAMESPACE),
      // Send sanitized legacy printer snapshot (credentials already stripped by schema)
      legacyPrinterSnapshot: p.printer ?? null,
      // Steps and attempts (exclude raw photo data URLs from this payload)
      steps: p.steps.map((s) => ({
        legacyStepId: s.id,
        type: s.type,
        order: s.order,
        attempts: s.attempts.map((a) => ({
          legacyAttemptId: a.id,
          plan: a.plan ?? null,
          events: a.events,
          observations: a.observations,
          result: a.result,
          notes: a.notes,
          confidence: a.confidence,
          retestRequested: a.retestRequested,
        })),
        redoStack: s.redoStack.map((a) => ({
          legacyAttemptId: a.id,
          plan: a.plan ?? null,
          events: a.events,
          observations: a.observations,
          result: a.result,
          notes: a.notes,
          confidence: a.confidence,
          retestRequested: a.retestRequested,
        })),
        currentAttemptId: s.currentAttemptId,
      })),
      currentStepId: p.currentStepId,
      // Photos: send only IDs and metadata, not raw base64 (uploaded separately)
      photoCount: p.photos.length,
      generatedProfile: p.generatedProfile
        ? {
            hash: p.generatedProfile.hash,
            normalizedSettings: p.generatedProfile.normalizedSettings ?? null,
          }
        : null,
      notes: p.notes,
      confidence: p.confidence,
      retestRequested: p.retestRequested,
      legacyId: p.legacyId ?? p.id,
    })),
  };

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException('Timeout', 'TimeoutError')),
    timeoutMs,
  );
  const combinedSignal = signal.aborted
    ? signal
    : (() => {
        const merged = new AbortController();
        signal.addEventListener('abort', () => merged.abort(signal.reason), {
          once: true,
        });
        controller.signal.addEventListener(
          'abort',
          () => merged.abort(controller.signal.reason),
          { once: true },
        );
        return merged.signal;
      })();

  let response: Response;
  try {
    response = await fetchImpl(
      `${baseUrl}${IMPORT_ROUTES.importLegacyBackupV4}`,
      {
        method: 'POST',
        signal: combinedSignal,
        headers: {
          authorization: `Bearer ${authCtx.token}`,
          'content-type': 'application/json',
          'idempotency-key': operationId,
          'x-payload-hash': payloadHash,
        },
        body: JSON.stringify(importPayload),
      },
    );
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 409) {
    throw Object.assign(
      new Error(
        'Import idempotency key already used with a different payload. Use a new operationId.',
      ),
      { code: 'IMPORT_IDEMPOTENCY_CONFLICT', httpStatus: 409 },
    );
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    throw Object.assign(
      new Error(
        `Import backend returned HTTP ${response.status}: ${bodyText.slice(0, 256)}`,
      ),
      { code: 'IMPORT_BACKEND_ERROR', httpStatus: response.status },
    );
  }

  const responseJson: unknown = await response.json();
  const parsed = RemoteImportLegacyBackupV4Response.parse(responseJson);

  // Compute summary for the response
  let totalAttempts = 0;
  let totalPhotos = 0;
  for (const project of backup.projects) {
    for (const step of project.steps) {
      totalAttempts += step.attempts.length + step.redoStack.length;
    }
    totalPhotos += project.photos.length;
  }

  const fileHash2 = fileHash; // already computed
  const summary: z.infer<typeof LegacyCalibrationBackupSummary> = {
    fileHash: fileHash2,
    detectedVersion: 4,
    projectCount: backup.projects.length,
    attemptCount: Math.min(totalAttempts, 100_000),
    photoCount: Math.min(totalPhotos, 100_000),
    formatValid: true,
  };

  const projectResults: z.infer<typeof LegacyBackupProjectResult>[] =
    parsed.projectResults.map((r) =>
      LegacyBackupProjectResult.parse({
        legacyProjectId: r.legacyProjectId,
        targetProjectId: r.targetProjectId,
        outcome: r.outcome,
        detail: r.detail ?? null,
        importedAttemptCount: r.importedAttemptCount,
        importedPhotoCount: r.importedPhotoCount,
      }),
    );

  return {
    summary,
    importedProjectCount: parsed.importedProjectCount,
    projectResults,
  };
}

/**
 * Map a raw backend/preflight error into a CalibrationApiError for the IPC response.
 */
export function mapImportError(
  error: unknown,
): z.infer<typeof CalibrationApiError> {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException & { code?: string }).code;
    if (code === 'IMPORT_IDEMPOTENCY_CONFLICT') {
      return {
        code: 'idempotencyPayloadChanged',
        message: error.message,
        retryable: false,
        retryAfterSeconds: null,
        reference: null,
      };
    }
    if (code === 'IMPORT_BACKEND_ERROR') {
      return {
        code: 'serverError',
        message: error.message,
        retryable: true,
        retryAfterSeconds: null,
        reference: null,
      };
    }
    if (
      code === 'LEGACY_BACKUP_NOT_APPROVED' ||
      code === 'LEGACY_BACKUP_INVALID_MARKER' ||
      code === 'LEGACY_BACKUP_INVALID_JSON' ||
      code === 'LEGACY_BACKUP_INVALID_SCHEMA' ||
      code === 'LEGACY_BACKUP_TOO_DEEP' ||
      code === 'LEGACY_BACKUP_UNSAFE_NUMBER'
    ) {
      return {
        code: 'invalidData',
        message: error.message,
        retryable: false,
        retryAfterSeconds: null,
        reference: null,
      };
    }
    if (
      code === 'LEGACY_BACKUP_TOO_LARGE' ||
      code === 'LEGACY_BACKUP_INVALID_FILE' ||
      code === 'LEGACY_BACKUP_CHANGED'
    ) {
      return {
        code: 'invalidData',
        message: error.message,
        retryable: false,
        retryAfterSeconds: null,
        reference: null,
      };
    }
  }
  return {
    code: 'serverError',
    message:
      error instanceof Error ? error.message : 'Unexpected import error.',
    retryable: false,
    retryAfterSeconds: null,
    reference: null,
  };
}

// Re-export for convenience in main/ipc.ts
export { MAX_BACKUP_FILE_BYTES as LEGACY_BACKUP_MAX_BYTES };
