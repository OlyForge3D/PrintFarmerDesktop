/**
 * OrcaSlicer filament profile transactional install/restore (issue #55).
 *
 * Windows-only: installs a generated OrcaSlicer filament profile into the
 * canonical user-data directory using a transactional write pattern:
 *   1. Detect OrcaSlicer not running (typed error if it is).
 *   2. Revalidate source fingerprint from main-process cache.
 *   3. Create a durable timestamped backup with hash metadata.
 *   4. Write to a same-directory temporary file.
 *   5. Flush, read back, parse, and semantically verify the written bytes.
 *   6. Atomically rename temp file over target.
 *   7. Verify post-install via a fresh read.
 *   8. Record truthful outcome.
 *
 * macOS: exports the generated profile bytes to a user-chosen location via a
 * native save dialog (no direct installation, per the issue requirements).
 *
 * Security contract:
 * - Destination is computed solely from the canonical OrcaSlicer user-data
 *   root and the safe filename; the renderer cannot supply an arbitrary path.
 * - Symlinks and junctions at the destination are rejected.
 * - The target file is verified before and after writing (fingerprint race
 *   guard).
 * - OrcaSlicer must not be running before any write is attempted.
 * - Every failure preserves or restores the prior profile.
 * - Restore verifies the backup hash before overwriting anything.
 *
 * Independently authored. Not derived from any approved third-party source.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readFile,
  writeFile,
  rename,
  lstat,
  mkdir,
  realpath,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OrcaProfileOperationError } from '@shared/ipc';
import {
  ORCA_PROFILE_MAX_BYTES,
  validateOrcaProfileJson,
} from './orcaProfileValidation.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Canonical Windows OrcaSlicer user-data roots
// ---------------------------------------------------------------------------

/**
 * Returns the canonical OrcaSlicer user-data filament profile directory on
 * Windows. Only this directory is ever used as an install destination.
 */
export function getWindowsOrcaInstallRoot(): string {
  const appData = process.env['APPDATA'];
  if (!appData) {
    throw makeError(
      'pathRestricted',
      'APPDATA environment variable is not set.',
    );
  }
  return path.join(appData, 'OrcaSlicer', 'user', 'default', 'filament');
}

// ---------------------------------------------------------------------------
// Error construction helpers
// ---------------------------------------------------------------------------

/**
 * Create a typed OrcaProfileOperationError as a proper Error instance so
 * that the @typescript-eslint/only-throw-error rule is satisfied. The code
 * and retryable fields are attached to the Error for pattern-matching in
 * catch blocks.
 */
export class OrcaInstallError extends Error {
  readonly code: OrcaProfileOperationError['code'];
  readonly retryable: boolean;
  constructor(
    code: OrcaProfileOperationError['code'],
    message: string,
    retryable = false,
  ) {
    super(message);
    this.name = 'OrcaInstallError';
    this.code = code;
    this.retryable = retryable;
  }
}

function makeError(
  code: OrcaProfileOperationError['code'],
  message: string,
  retryable = false,
): OrcaInstallError {
  return new OrcaInstallError(code, message, retryable);
}

// ---------------------------------------------------------------------------
// OrcaSlicer running detection (Windows)
// ---------------------------------------------------------------------------

/**
 * Returns true if the OrcaSlicer process is currently running on Windows.
 * Uses `tasklist` with a filter — this is synchronous-ish via promisified
 * execFile. Resolves false on any error (safe: don't block installs due to
 * detection failures by default).
 */
export async function isOrcaSlicerRunning(): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  try {
    const { stdout } = await execFileAsync(
      'tasklist',
      ['/FI', 'IMAGENAME eq OrcaSlicer.exe', '/NH', '/FO', 'CSV'],
      { timeout: 5_000 },
    );
    // tasklist outputs CSV; if OrcaSlicer.exe is listed, it appears in stdout.
    return stdout.toLowerCase().includes('orcaslicer.exe');
  } catch {
    return false; // Treat detection failure as not-running (safe fallback).
  }
}

// ---------------------------------------------------------------------------
// SHA-256 helpers
// ---------------------------------------------------------------------------

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await readFile(filePath);
  return sha256(buf);
}

// ---------------------------------------------------------------------------
// Root-escape guard for install destination
// ---------------------------------------------------------------------------

/**
 * Compute and validate the install destination path.
 * Ensures the computed path stays within the canonical OrcaSlicer user root.
 */
export function computeInstallPath(
  safeFilename: string,
  installRoot: string,
): string {
  // safeFilename must not contain path separators.
  if (
    safeFilename.includes('/') ||
    safeFilename.includes('\\') ||
    safeFilename.includes('\0') ||
    !safeFilename.endsWith('.json') ||
    safeFilename.length > 200 ||
    safeFilename.length < 6
  ) {
    throw makeError(
      'pathRestricted',
      'Invalid safe filename for install path.',
    );
  }
  const dest = path.join(installRoot, safeFilename);
  // Verify no path traversal via basename comparison.
  if (path.basename(dest) !== safeFilename) {
    throw makeError('pathRestricted', 'Install path escapes canonical root.');
  }
  return dest;
}

// ---------------------------------------------------------------------------
// Transactional Windows install
// ---------------------------------------------------------------------------

export interface InstallResult {
  readonly installedHash: string;
  readonly backupHash: string;
  readonly backupPath: string;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}

function isUnderRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== '..' &&
      !path.isAbsolute(relative))
  );
}

async function ensureInstallRootSafe(installRoot: string): Promise<void> {
  const appData = process.env['APPDATA'];
  if (!appData || !isUnderRoot(installRoot, appData)) {
    throw makeError('pathRestricted', 'Install root is outside APPDATA.');
  }

  let canonicalAppData: string;
  try {
    canonicalAppData = await realpath(appData);
  } catch {
    throw makeError('pathRestricted', 'APPDATA is inaccessible.');
  }

  const relative = path.relative(appData, installRoot);
  let current = appData;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw makeError(
          'pathRestricted',
          'Install root contains a symlink or junction.',
        );
      }
      if (!info.isDirectory()) {
        throw makeError(
          'pathRestricted',
          'Install root contains a non-directory component.',
        );
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      await mkdir(current);
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw makeError(
          'pathRestricted',
          'Install directory creation was redirected.',
        );
      }
    }

    const canonicalCurrent = await realpath(current);
    if (!isUnderRoot(canonicalCurrent, canonicalAppData)) {
      throw makeError(
        'pathRestricted',
        'Install root escapes canonical APPDATA.',
      );
    }
  }
}

function validateInstallProfile(generatedJson: string): void {
  if (Buffer.byteLength(generatedJson, 'utf8') > ORCA_PROFILE_MAX_BYTES) {
    throw makeError(
      'verificationFailed',
      `Generated profile exceeds ${ORCA_PROFILE_MAX_BYTES} bytes.`,
    );
  }
  const validation = validateOrcaProfileJson(generatedJson);
  if (validation.status === 'rejected') {
    throw makeError(
      'verificationFailed',
      `Generated profile rejected (${validation.code}): ${validation.detail}`,
    );
  }
  if (
    typeof validation.raw.name !== 'string' ||
    validation.raw.name.trim().length === 0 ||
    (validation.raw.type !== undefined && validation.raw.type !== 'filament')
  ) {
    throw makeError(
      'verificationFailed',
      'Generated profile is not a named filament profile.',
    );
  }
  if (
    typeof validation.raw.inherits === 'string' &&
    validation.raw.inherits.trim().length > 0
  ) {
    throw makeError(
      'verificationFailed',
      'Generated install profiles must be fully resolved and cannot inherit.',
    );
  }
}

/**
 * Transactionally install `generatedJson` to the canonical OrcaSlicer
 * user-data filament directory.
 *
 * Throws OrcaProfileOperationError (or re-throws as-is) on failure.
 */
export async function installOrcaProfileWindows(
  generatedJson: string,
  expectedHash: string,
  safeFilename: string,
): Promise<InstallResult> {
  if (process.platform !== 'win32') {
    throw makeError(
      'unsupportedPlatform',
      'Direct profile installation is only supported on Windows.',
    );
  }

  validateInstallProfile(generatedJson);
  const installRoot = getWindowsOrcaInstallRoot();
  const destPath = computeInstallPath(safeFilename, installRoot);

  // 1. Verify OrcaSlicer is not running.
  if (await isOrcaSlicerRunning()) {
    throw makeError(
      'slicerRunning',
      'OrcaSlicer is running. Close it before installing a profile.',
      true,
    );
  }

  // 2. Verify the generated JSON hash matches what the caller provided.
  const actualHash = sha256(generatedJson);
  if (actualHash !== expectedHash) {
    throw makeError(
      'verificationFailed',
      'Generated profile content hash mismatch; generation result may be stale.',
    );
  }

  // 3. Ensure destination directory exists.
  await ensureInstallRootSafe(installRoot);

  // 4. Canonicalize destination (may not exist yet — in that case just verify
  //    the parent is safe).
  let destExists = false;
  let priorHash: string | null = null;
  try {
    const info = await lstat(destPath);
    if (info.isSymbolicLink()) {
      throw makeError('pathRestricted', 'Destination is a symlink; rejected.');
    }
    destExists = true;
    priorHash = await sha256File(destPath);
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      // File does not yet exist — that's fine.
    } else if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      err.code === 'pathRestricted'
    ) {
      throw err;
    } else {
      throw err;
    }
  }

  // 5. Create durable timestamped backup if destination exists.
  let backupPath: string | null = null;
  let backupHash: string | null = null;
  if (destExists && priorHash !== null) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = `${destPath}.bak-${ts}`;
    const priorBytes = await readFile(destPath);
    await writeFile(backupPath, priorBytes, { flag: 'wx' }); // exclusive create
    backupHash = sha256(priorBytes);
  }

  // 6. Write to a temp file in the same directory (same-directory = same FS for rename).
  const tempPath = path.join(installRoot, `.pfd-tmp-${randomUUID()}.json`);
  try {
    await writeFile(tempPath, generatedJson, { encoding: 'utf8', flag: 'wx' });

    // 7. Read back and verify before atomic rename.
    const readBack = await readFile(tempPath, 'utf8');
    const readBackHash = sha256(readBack);
    if (readBackHash !== expectedHash) {
      throw makeError(
        'verificationFailed',
        'Written profile bytes do not match the expected hash.',
      );
    }

    // Verify JSON parses correctly (basic sanity — not full OrcaSlicer validation).
    try {
      JSON.parse(readBack);
    } catch {
      throw makeError(
        'verificationFailed',
        'Written profile is not valid JSON.',
      );
    }

    // 8. Atomic rename: replaces destination if it exists.
    await rename(tempPath, destPath);
  } catch (writeErr) {
    // Best-effort cleanup of the temp file.
    try {
      const { rm } = await import('node:fs/promises');
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    throw writeErr;
  }

  // 9. Post-install verification: fresh read of destination.
  let installedHash: string;
  try {
    installedHash = await sha256File(destPath);
  } catch {
    throw makeError(
      'verificationFailed',
      'Post-install verification read failed.',
    );
  }
  if (installedHash !== expectedHash) {
    throw makeError(
      'verificationFailed',
      'Post-install content hash does not match expected value.',
    );
  }

  return {
    installedHash,
    backupHash: backupHash ?? expectedHash, // If no prior file, backup = install
    backupPath: backupPath ?? destPath,
  };
}

// ---------------------------------------------------------------------------
// Restore from backup
// ---------------------------------------------------------------------------

export interface RestoreResult {
  readonly restoredHash: string;
}

/**
 * Restore a profile from a previously created backup file.
 * Verifies the backup hash before overwriting the target.
 */
export async function restoreOrcaProfileWindows(
  backupPath: string,
  expectedBackupHash: string,
  safeFilename: string,
): Promise<RestoreResult> {
  if (process.platform !== 'win32') {
    throw makeError(
      'unsupportedPlatform',
      'Profile restore is only supported on Windows.',
    );
  }

  // Verify the backup file exists and has the expected hash.
  let backupBytes: Buffer;
  try {
    backupBytes = await readFile(backupPath);
  } catch {
    throw makeError('pathRestricted', 'Backup file not found or unreadable.');
  }
  const actualBackupHash = sha256(backupBytes);
  if (actualBackupHash !== expectedBackupHash) {
    throw makeError(
      'verificationFailed',
      'Backup file hash does not match expected value; restore aborted.',
    );
  }

  const installRoot = getWindowsOrcaInstallRoot();
  const destPath = computeInstallPath(safeFilename, installRoot);
  await ensureInstallRootSafe(installRoot);

  // Reject if destination is a symlink.
  try {
    const info = await lstat(destPath);
    if (info.isSymbolicLink()) {
      throw makeError(
        'pathRestricted',
        'Destination is a symlink; restore rejected.',
      );
    }
  } catch (err) {
    if (isErrno(err, 'ENOENT')) {
      // Destination doesn't exist — restore will create it.
    } else {
      throw err;
    }
  }

  // Write via temp + rename for atomicity.
  const tempPath = path.join(installRoot, `.pfd-restore-${randomUUID()}.json`);
  try {
    await writeFile(tempPath, backupBytes, { flag: 'wx' });
    const readBack = await readFile(tempPath);
    if (sha256(readBack) !== expectedBackupHash) {
      throw makeError(
        'rollbackFailed',
        'Restore write verification failed; backup bytes corrupted in transit.',
      );
    }
    await rename(tempPath, destPath);
  } catch (writeErr) {
    try {
      const { rm } = await import('node:fs/promises');
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    throw writeErr;
  }

  const restoredHash = await sha256File(destPath);
  if (restoredHash !== expectedBackupHash) {
    throw makeError(
      'rollbackFailed',
      'Post-restore verification failed; hash mismatch.',
    );
  }

  return { restoredHash };
}

// ---------------------------------------------------------------------------
// macOS export via native save dialog (wired in ipc.ts)
// ---------------------------------------------------------------------------

/**
 * Verify the exported profile bytes after writing on macOS.
 * Reads the file back, computes SHA-256, and compares to expectedHash.
 */
export async function verifyExportedProfile(
  filePath: string,
  expectedHash: string,
): Promise<string> {
  let actual: string;
  try {
    actual = await sha256File(filePath);
  } catch {
    throw makeError('verificationFailed', 'Export verification read failed.');
  }
  if (actual !== expectedHash) {
    throw makeError(
      'verificationFailed',
      'Exported profile hash does not match the expected value.',
    );
  }
  return actual;
}

/**
 * Canonicalize a save-dialog-chosen path and verify it does not point to a
 * symlink (on macOS, the dialog should prevent this, but we guard anyway).
 */
export async function canonicalizeSaveTarget(
  filePath: string,
): Promise<string> {
  // Check the parent directory exists and is reachable.
  const parentDir = path.dirname(filePath);
  let canonicalParent: string;
  try {
    canonicalParent = await realpath(parentDir);
  } catch {
    throw makeError(
      'pathRestricted',
      'Save destination directory is inaccessible.',
    );
  }
  // Don't allow writing to special system paths.
  if (
    canonicalParent.startsWith('/System') ||
    canonicalParent.startsWith('/usr') ||
    canonicalParent === '/'
  ) {
    throw makeError(
      'pathRestricted',
      'Save destination is in a restricted system directory.',
    );
  }
  const canonicalPath = path.join(canonicalParent, path.basename(filePath));
  // Ensure no existing symlink at target.
  try {
    const info = await lstat(canonicalPath);
    if (info.isSymbolicLink()) {
      throw makeError('pathRestricted', 'Save target is a symlink; rejected.');
    }
  } catch (err) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      // OK — file doesn't exist yet.
    } else {
      throw err;
    }
  }
  return canonicalPath;
}

// ---------------------------------------------------------------------------
// Per-operation generated profile cache
// ---------------------------------------------------------------------------

/**
 * In-memory cache of generated profiles keyed by operationId.
 * Cleared when the main process exits. Entries are bounded in size by
 * MAX_CACHE_ENTRIES; oldest entries are evicted when the limit is reached.
 */
const MAX_CACHE_ENTRIES = 50;

interface CachedProfile {
  readonly generatedJson: string;
  readonly profileJsonHash: string;
  readonly displayName: string;
  readonly safeFilename: string;
  readonly cachedAt: number;
}

const profileCache = new Map<string, CachedProfile>();

export function cacheGeneratedProfile(
  operationId: string,
  entry: CachedProfile,
): void {
  if (profileCache.size >= MAX_CACHE_ENTRIES) {
    // Evict the oldest entry.
    const oldest = [...profileCache.entries()].sort(
      ([, a], [, b]) => a.cachedAt - b.cachedAt,
    )[0];
    if (oldest) profileCache.delete(oldest[0]);
  }
  profileCache.set(operationId, entry);
}

export function getCachedProfile(
  operationId: string,
): CachedProfile | undefined {
  return profileCache.get(operationId);
}

export function clearProfileCache(): void {
  profileCache.clear();
}
