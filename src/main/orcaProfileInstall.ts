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
  rm,
  lstat,
  mkdir,
  realpath,
  open,
} from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { OrcaProfileOperationError } from '@shared/ipc';

const execFileAsync = promisify(execFile);

/**
 * Hard cap on the bytes install will write.
 *
 * Measured before this was added: `installOrcaProfileWindows` accepted and
 * wrote a 2 MB profile as long as the caller supplied the matching hash. The
 * content-hash gate pins *which* bytes are written but says nothing about how
 * many, so it is not a size bound. #158 requires bounded allocation on every
 * untrusted path, and a generator defect or a compromised caller reaches this
 * one, so the bound is stated here rather than assumed upstream.
 */
export const ORCA_INSTALL_MAX_BYTES = 1_048_576;

/**
 * Filename prefix reserved for this module's own bookkeeping files that live
 * directly alongside real profiles in the install root (temp files during
 * atomic writes, and the durable per-operation backup-metadata record — see
 * `BACKUP_META_FILE_PREFIX` below). No real profile's `safeFilename` may
 * begin with this prefix, so a bookkeeping file can never collide with, or
 * be mistaken for, an installed profile.
 *
 * `generateProfileIdentity` (orcaProfileGenerator.ts) always appends a
 * `_[PFD-<8-hex-chars>].json` suffix, which this prefix does not resemble,
 * so no legitimately generated name can equal `RESERVED_FILE_PREFIX + ...`.
 * This is enforced by a test (`orcaProfileGenerator` name derivation never
 * starts with this prefix) rather than left as an assumption, matching this
 * file's existing convention for the reachability argument below.
 */
export const RESERVED_FILE_PREFIX = '.pfd-';

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

/**
 * Create the install root one segment at a time, refusing any component that
 * is a reparse point or that canonicalizes outside APPDATA.
 *
 * This replaces `mkdir(installRoot, { recursive: true })`, which follows an
 * existing junction silently. Measured against the pre-fix code: with
 * `%APPDATA%\OrcaSlicer\user\default\filament` made a junction to an unrelated
 * directory, install reported success and the profile landed in that
 * directory — a write outside the install root, which is exactly the escape
 * #158 asks about and which the destination-file symlink check does not cover,
 * because the destination file itself was never a link.
 */
/**
 * Walk from `baseRoot` down through each path segment of `relativeSubdir`,
 * refusing any segment that is a symlink/junction, refusing any segment
 * that is not a directory, and refusing any segment whose canonical
 * (symlink-resolved) path escapes `canonicalBaseRoot`. Creates directories
 * that do not yet exist (never through a symlink). Returns the canonical
 * path of the final directory.
 *
 * Shared by `ensureInstallRootSafe` (APPDATA -> installRoot). The durable
 * backup-metadata record (#208) lives as a plain leaf file directly inside
 * the install root (see `BACKUP_META_FILE_PREFIX`), not a separate
 * subdirectory, so it is validated by this exact same walk rather than a
 * dedicated one.
 */
async function walkDirSafe(
  baseRoot: string,
  canonicalBaseRoot: string,
  relativeSubdir: string,
): Promise<string> {
  let current = baseRoot;
  for (const segment of relativeSubdir.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw makeError(
          'pathRestricted',
          'Path contains a symlink or junction.',
        );
      }
      if (!info.isDirectory()) {
        throw makeError(
          'pathRestricted',
          'Path contains a non-directory component.',
        );
      }
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
      await mkdir(current);
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw makeError('pathRestricted', 'Directory creation was redirected.');
      }
    }

    if (!isUnderRoot(await realpath(current), canonicalBaseRoot)) {
      throw makeError('pathRestricted', 'Path escapes canonical root.');
    }
  }
  return realpath(current);
}

/**
 * Create the install root one segment at a time, refusing any component that
 * is a reparse point or that canonicalizes outside APPDATA.
 *
 * This replaces `mkdir(installRoot, { recursive: true })`, which follows an
 * existing junction silently. Measured against the pre-fix code: with
 * `%APPDATA%\OrcaSlicer\user\default\filament` made a junction to an unrelated
 * directory, install reported success and the profile landed in that
 * directory — a write outside the install root, which is exactly the escape
 * #158 asks about and which the destination-file symlink check does not cover,
 * because the destination file itself was never a link.
 */
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

  await walkDirSafe(
    appData,
    canonicalAppData,
    path.relative(appData, installRoot),
  );
}

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
  // Windows path syntax that a `.json` suffix does not neutralise.
  //
  // `x:evil.json` names an alternate data stream on `x` — content that a
  // directory listing does not show and that the backup/restore bookkeeping
  // would then be wrong about. `CON.json` and `COM1.json` still resolve to
  // devices, extension notwithstanding, so a write goes somewhere that is not
  // a file. A trailing space or dot is silently trimmed by the filesystem, so
  // the name written is not the name checked.
  //
  // Reachability, stated honestly: no untrusted input reaches here today.
  // `deriveProfileNames` is the only producer, and it strips `:` along with
  // the other reserved characters and always appends `_[PFD-<hash>].json`,
  // which cannot be a device name. That argument is enforced by a test rather
  // than left as a comment, because it is the argument that makes this guard
  // defence in depth rather than a live fix.
  if (
    safeFilename.includes(':') ||
    // eslint-disable-next-line no-control-regex -- matching control characters is the point: they are legal in a JS string, illegal in an NTFS name, and a profile name carrying one must not reach a path.
    /[\u0000-\u001f]/.test(safeFilename) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(safeFilename) ||
    /[ .]$/.test(safeFilename.slice(0, -'.json'.length))
  ) {
    throw makeError(
      'pathRestricted',
      'Install filename uses reserved Windows path syntax.',
    );
  }
  // This module writes its own bookkeeping files (atomic-write temp files,
  // the durable per-operation backup-metadata record) directly alongside
  // real profiles in the install root, all under `RESERVED_FILE_PREFIX`. A
  // real profile filename must never be able to collide with one of those
  // — see `RESERVED_FILE_PREFIX`'s doc comment for why no legitimately
  // generated name can reach this in practice; this rejects it outright
  // regardless. Compared case-insensitively: NTFS (the only filesystem this
  // path ever targets) is case-insensitive-but-preserving, so `.PFD-op-...`
  // and `.pfd-op-...` name the same file on disk even though they differ as
  // strings — a case-sensitive comparison here would let a profile named
  // `.PFD-op-<uuid>.json` collide with real bookkeeping despite passing this
  // check.
  if (
    safeFilename.toLowerCase().startsWith(RESERVED_FILE_PREFIX.toLowerCase())
  ) {
    throw makeError(
      'pathRestricted',
      'Install filename collides with a reserved internal prefix.',
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

/**
 * Transactionally install `generatedJson` to the canonical OrcaSlicer
 * user-data filament directory.
 *
 * `operationId` identifies the install operation durably: if a backup is
 * created, a metadata record keyed by `operationId` is written alongside it
 * (see `writeBackupMeta`) so a later restore can recover exactly which
 * backup this operation produced, without depending on `profileCache` or on
 * reverse-parsing the backup's own filename (#208).
 *
 * Throws OrcaProfileOperationError (or re-throws as-is) on failure.
 */
export async function installOrcaProfileWindows(
  generatedJson: string,
  expectedHash: string,
  safeFilename: string,
  operationId: string,
): Promise<InstallResult> {
  if (process.platform !== 'win32') {
    throw makeError(
      'unsupportedPlatform',
      'Direct profile installation is only supported on Windows.',
    );
  }

  // 1. Verify OrcaSlicer is not running.
  if (await isOrcaSlicerRunning()) {
    throw makeError(
      'slicerRunning',
      'OrcaSlicer is running. Close it before installing a profile.',
      true,
    );
  }

  // 2. Verify the generated JSON hash matches what the caller provided, and
  //    that there are not more bytes than install will ever write.
  if (Buffer.byteLength(generatedJson, 'utf8') > ORCA_INSTALL_MAX_BYTES) {
    throw makeError(
      'verificationFailed',
      `Generated profile exceeds ${ORCA_INSTALL_MAX_BYTES} bytes.`,
    );
  }
  const actualHash = sha256(generatedJson);
  if (actualHash !== expectedHash) {
    throw makeError(
      'verificationFailed',
      'Generated profile content hash mismatch; generation result may be stale.',
    );
  }

  const installRoot = getWindowsOrcaInstallRoot();
  const destPath = computeInstallPath(safeFilename, installRoot);

  // 3. Ensure destination directory exists, without following a reparse point.
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
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
      // File does not yet exist — that's fine.
    } else if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'pathRestricted'
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
    // Durably record which operation produced this backup and what its
    // original safeFilename was, so restore can find it later without
    // depending on profileCache or on parsing the backup's own filename.
    await writeBackupMeta(installRoot, operationId, {
      safeFilename,
      backupFileName: path.basename(backupPath),
      backupHash,
      createdAt: Date.now(),
    });
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

export interface LocatedBackup {
  readonly backupPath: string;
  readonly safeFilename: string;
}

/**
 * Durable per-operation backup-identity record, keyed by `operationId`, so
 * restore can recover which backup a given install operation produced.
 *
 * Restore used to be gated on `profileCache` (`getCachedProfile`), an
 * in-memory, process-lifetime, `MAX_CACHE_ENTRIES`-bounded LRU map, so it
 * failed after a restart or after enough later installs evicted the
 * original entry — even though the backup file on disk was untouched
 * (#208). Scanning the install directory for *any* backup whose content
 * hash matched the caller-supplied hash was tried and rejected: two
 * different profiles can have byte-identical prior content (and therefore
 * the same SHA-256 `backupHash`), which would let restore silently pick the
 * wrong profile's backup. Reverse-parsing `safeFilename` back out of the
 * backup's own filename was also rejected: a generated profile's filename
 * can legitimately contain the literal substring `.bak-` (see
 * `generateProfileIdentity` in orcaProfileGenerator.ts, which only strips
 * path-reserved characters), which corrupts that parse.
 *
 * Instead, each backup gets its own durable metadata record on disk, keyed
 * by the `operationId` that created it. This is written once, at backup
 * creation time, and read back at restore time — no in-memory state and no
 * content- or filename-based inference is involved in resolving identity.
 * The backup's content hash is still verified independently before any
 * write happens (see `restoreOrcaProfileWindows`); metadata never bypasses
 * that check, it only recovers *which* file to check.
 *
 * Design history (rounds 1-4): the record was originally stored in a
 * dedicated `.pfd-backup-meta` subdirectory of the install root, with its
 * own directory-level TOCTOU guard layered on top of the leaf-file guard.
 * Across four review rounds, that directory-level guard was narrowed
 * (lstat bracket -> fd-pinned before-check -> fd-pinned before-and-after
 * checks) but never fully closed, because Node has no directory-handle-
 * relative open (`openat`) on any platform: the leaf file's own path
 * necessarily re-resolves through the directory as a fresh string, so any
 * finite number of directory rechecks around it still leaves a
 * single-syscall window between the last recheck and the leaf operation.
 *
 * That entire class of finding is a self-inflicted problem: the real
 * backup file this record describes is written directly into `installRoot`
 * (see `installOrcaProfileWindows`, step 5) with only `ensureInstallRootSafe`
 * validated once up front and no per-write directory recheck at all — and
 * that level of protection has already been accepted through review. There
 * is no principled reason to hold the *record describing* a backup to a
 * stricter standard than the backup's own bytes. So the record is now
 * stored the same way the backup itself is: as a leaf file directly in
 * `installRoot`, named `${RESERVED_FILE_PREFIX}op-${operationId}.json`,
 * validated via the exact same `ensureInstallRootSafe` call every real
 * profile write and restore already goes through — no separate
 * subdirectory, and therefore no separate directory-level TOCTOU surface
 * to keep re-discovering narrower instances of.
 */
const BACKUP_META_FILE_PREFIX = `${RESERVED_FILE_PREFIX}op-`;

const OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface BackupMetaRecord {
  readonly safeFilename: string;
  readonly backupFileName: string;
  readonly backupHash: string;
  readonly createdAt: number;
}

function validateOperationId(operationId: string): void {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    throw makeError('pathRestricted', 'Invalid operationId; expected a UUID.');
  }
}

/**
 * Validate `installRoot` (via `ensureInstallRootSafe`) and return its
 * canonical, realpath'd form.
 *
 * Round-5 reviewer finding (Vasquez): a single validate-then-reuse-the-path
 * pattern is only as tight as the gap between the validation and the last
 * use of its result. `installOrcaProfileWindows` and
 * `restoreOrcaProfileWindows` each validate once and use the result
 * immediately (no further `await`s in between) — but `findBackupByOperationId`
 * used to validate once via `resolveBackupMetaPath` and then reuse that same
 * `canonicalInstallRoot` string *after* several further `await`s (reading and
 * parsing the metadata file), which is a materially wider window for
 * `installRoot` to be swapped in. Every caller of this function now
 * re-validates immediately before its own last use of the canonical root,
 * rather than trusting a validation an arbitrary number of `await`s earlier.
 */
async function ensureInstallRootSafeCanonical(
  installRoot: string,
): Promise<string> {
  await ensureInstallRootSafe(installRoot);
  try {
    return await realpath(installRoot);
  } catch {
    throw makeError('pathRestricted', 'Install root is inaccessible.');
  }
}

/**
 * Validate `installRoot` (via `ensureInstallRootSafe`, the same check every
 * real profile write and restore already goes through) and return its
 * canonical path plus the path the metadata record for `operationId` lives
 * at within it.
 */
async function resolveBackupMetaPath(
  installRoot: string,
  operationId: string,
): Promise<{ canonicalInstallRoot: string; metaPath: string }> {
  const canonicalInstallRoot =
    await ensureInstallRootSafeCanonical(installRoot);
  return {
    canonicalInstallRoot,
    metaPath: path.join(
      canonicalInstallRoot,
      `${BACKUP_META_FILE_PREFIX}${operationId}.json`,
    ),
  };
}

/**
 * Test-only hook invoked immediately before the atomic `rename()` in
 * `writeBackupMeta`, i.e. exactly inside the write-side race window a
 * reviewer flagged (between validating the temp file and replacing
 * `metaPath` with it). Lets a regression test deterministically plant a
 * symlink at `metaPath` at the precise moment the race would occur,
 * proving `rename()` replaces it rather than writing through it. No-op in
 * production; never set outside tests.
 */
let backupMetaWriteRaceHookForTests:
  ((metaPath: string) => Promise<void> | void) | null = null;

export function __setBackupMetaWriteRaceHookForTests(
  hook: ((metaPath: string) => Promise<void> | void) | null,
): void {
  backupMetaWriteRaceHookForTests = hook;
}

/**
 * Durably record which backup file a given install operation produced.
 * Overwrites any prior record for the same `operationId`: if an operation
 * is retried and produces a newer backup, that newer backup is the one
 * restore should recover.
 *
 * The record is a leaf file directly in the (once, freshly re-validated)
 * install root, written via the exact same pattern already used for real
 * profile installs/restores: an unpredictably-named, exclusively-created
 * (`wx`) temp file, verified not to be a symlink, then an atomic `rename()`
 * onto the final path. `wx` on an unguessable temp name cannot be
 * pre-empted, and `rename()` replaces whatever is at the destination path
 * (including a symlink placed there in the interim) rather than following
 * it — so there is no window in which a symlink at `metaPath` causes data
 * to be written through it. There is no separate metadata subdirectory (see
 * `BACKUP_META_FILE_PREFIX`'s doc comment), so there is no directory-level
 * TOCTOU surface distinct from the one every real profile write already
 * carries and has already been reviewed against.
 */
async function writeBackupMeta(
  installRoot: string,
  operationId: string,
  record: BackupMetaRecord,
): Promise<void> {
  validateOperationId(operationId);
  const { canonicalInstallRoot, metaPath } = await resolveBackupMetaPath(
    installRoot,
    operationId,
  );
  const tempPath = path.join(
    canonicalInstallRoot,
    `${RESERVED_FILE_PREFIX}meta-tmp-${randomUUID()}.json`,
  );

  await writeFile(tempPath, JSON.stringify(record), {
    encoding: 'utf8',
    flag: 'wx', // exclusive create: fails if anything (incl. a symlink) already exists there
  });
  try {
    const tempInfo = await lstat(tempPath);
    if (tempInfo.isSymbolicLink()) {
      throw makeError(
        'pathRestricted',
        'Backup metadata temp file was redirected; refused.',
      );
    }
    if (backupMetaWriteRaceHookForTests) {
      await backupMetaWriteRaceHookForTests(metaPath);
    }
    await rename(tempPath, metaPath);
  } catch (error) {
    try {
      await rm(tempPath, { force: true });
    } catch {
      // Ignore cleanup failures.
    }
    throw error;
  }
}

/**
 * Test-only hook invoked by `readFileWithIdentityPin`, once the initial
 * `lstat` has confirmed a path is presently a regular (non-symlink) file,
 * immediately before `open()` resolves that same path. Lets a regression
 * test swap the path for a symlink at exactly the instant `open()` is
 * about to run, deterministically simulating the race a reviewer
 * identified rather than depending on real scheduling. No-op in
 * production; never set outside tests.
 */
let identityPinPreOpenHookForTests:
  ((filePath: string) => Promise<void> | void) | null = null;

export function __setIdentityPinPreOpenHookForTests(
  hook: ((filePath: string) => Promise<void> | void) | null,
): void {
  identityPinPreOpenHookForTests = hook;
}

/**
 * Test-only hook invoked by `readFileWithIdentityPin` immediately after
 * `open()` succeeds — so a file descriptor already exists and its
 * identity is permanently bound to whatever `open()` actually resolved —
 * but before this function inspects that identity via `fstat`. Lets a
 * regression test restore the path to its original, legitimate file at
 * this exact point, proving that doing so cannot retroactively change
 * what the already-open descriptor reports and therefore cannot un-poison
 * a mismatch already captured at `open()` time. This is precisely the
 * "swap in a symlink, let the read follow it, then swap back before the
 * recheck notices" attack a reviewer identified against the previous
 * lstat-before/read/lstat-after bracket: that approach re-resolved the
 * path a second time, so restoring it before the second `lstat` defeated
 * the check. Pinning identity to a file descriptor removes the second
 * path resolution entirely, so there is nothing left for a swap-back to
 * defeat. No-op in production; never set outside tests.
 */
let identityPinPostOpenHookForTests:
  ((filePath: string) => Promise<void> | void) | null = null;

export function __setIdentityPinPostOpenHookForTests(
  hook: ((filePath: string) => Promise<void> | void) | null,
): void {
  identityPinPostOpenHookForTests = hook;
}

/**
 * Test-only hook invoked by `findBackupByOperationId` immediately after it
 * has read and parsed the durable metadata record, but before its final,
 * fresh `ensureInstallRootSafeCanonical` re-check. Lets a regression test
 * swap `installRoot` for a junction at exactly the point in the middle of
 * this function's own execution that a real attacker would need to hit —
 * proving the re-validation this function performs right before its last
 * use of the canonical root (see its doc comment, round-5 finding) closes
 * the window even for a swap that happens *during* this call, not merely
 * one already in place before it starts (which the old top-of-function-only
 * validation would have caught anyway, making that scenario an insufficient
 * regression test on its own). No-op in production; never set outside
 * tests.
 */
let findBackupByOperationIdPreRevalidateHookForTests:
  (() => Promise<void> | void) | null = null;

export function __setFindBackupByOperationIdPreRevalidateHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  findBackupByOperationIdPreRevalidateHookForTests = hook;
}

/**
 * Read `filePath`'s bytes in a way that cannot be defeated by a symlink
 * swapped in and back out again around the read (a "swap-in/swap-back"
 * TOCTOU).
 *
 * Reviewer finding (Ripley, round 3): the previous approach used
 * throughout this module — `lstat` the path, read it, `lstat` it again —
 * only detects a symlink if one happens to be present at either `lstat`'s
 * specific instant. An attacker who swaps the path to a symlink strictly
 * *between* the two `lstat` calls, lets the read follow the symlink, then
 * swaps the path back to the original, legitimate file before the second
 * `lstat` runs, passes both checks while the actual read still went
 * through the attacker's symlink. A path-based recheck can never close
 * this, because the path alone carries no memory of what was true at the
 * instant the read syscall itself executed — every recheck re-resolves
 * the path fresh, so restoring it before the recheck erases all evidence
 * of the swap.
 *
 * The fix pins identity to a file descriptor instead of a path: `lstat`
 * the path once to confirm it is presently a regular (non-symlink) file
 * and capture its device+inode, then `open()` that same path and `fstat`
 * the resulting handle. A file descriptor's identity is bound permanently
 * to whatever `open()` actually resolved to at the single instant it ran
 * — no later path swap can change what that descriptor reports. If the
 * path was a symlink at that instant, the descriptor is bound to the
 * symlink's *target*, whose device+inode will not match what the initial
 * `lstat` captured (barring the attacker also controlling a hard link
 * with the legitimate file's exact device+inode, which they cannot,
 * since they do not control the legitimate file). Comparing the two
 * closes the swap-in/swap-back window entirely: the only thing that
 * matters is what `open()` actually resolved to, not what the path
 * looked like before or after — so restoring the path afterward, as in
 * the attack above, changes nothing.
 *
 * `fstat` is checked *before* the bytes are read, so a mismatch is
 * detected — and the descriptor closed without ever reading through it —
 * before any attacker-controlled content is even retrieved.
 *
 * Device and inode are compared as `bigint` (via `{ bigint: true }` on
 * both `lstat` and the descriptor's `stat`), not the default `number`.
 * Windows NTFS/ReFS file indices are 64-bit and can exceed
 * `Number.MAX_SAFE_INTEGER`; representing them as plain JS numbers can
 * silently lose precision, which could make two genuinely different
 * files round-trip to the *same* JS number and defeat this comparison
 * entirely on a volume where that precision loss occurs. `bigint` stats
 * carry the full 64-bit value with no rounding, so the comparison stays
 * exact regardless of the underlying volume's file-index magnitude.
 *
 * Used both for the durable backup-metadata record (`readBackupMetaFileSafely`)
 * and for the backup file itself at restore time (`restoreOrcaProfileWindows`),
 * since both were shown to have this exact class of gap.
 */
async function readFileWithIdentityPin(
  filePath: string,
): Promise<Buffer | null> {
  let expectedDev: bigint;
  let expectedIno: bigint;
  try {
    const before = await lstat(filePath, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile()) {
      return null;
    }
    expectedDev = before.dev;
    expectedIno = before.ino;
  } catch {
    return null;
  }

  if (identityPinPreOpenHookForTests) {
    await identityPinPreOpenHookForTests(filePath);
  }

  let handle: FileHandle;
  try {
    handle = await open(filePath, 'r');
  } catch {
    return null;
  }
  try {
    if (identityPinPostOpenHookForTests) {
      await identityPinPostOpenHookForTests(filePath);
    }
    const opened = await handle.stat({ bigint: true });
    if (opened.dev !== expectedDev || opened.ino !== expectedIno) {
      // open() resolved to a different file than the one lstat validated
      // — whether via a symlink present at that instant (regardless of
      // what the path looks like before or after) or any other
      // substitution. Refuse without ever reading its content.
      return null;
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/**
 * Test-only hook invoked by `readFileWithRootPin` immediately after it
 * captures `canonicalInstallRoot`'s device+inode, but before it lstats
 * the target file's parent directory. Lets a regression test swap the
 * parent for a junction at exactly this point, deterministically
 * simulating the narrowest possible ancestor-directory race (see that
 * function's doc comment). No-op in production; never set outside tests.
 */
let readFileWithRootPinRaceHookForTests: (() => Promise<void> | void) | null =
  null;

export function __setReadFileWithRootPinRaceHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  readFileWithRootPinRaceHookForTests = hook;
}

/**
 * Read `filePath`'s bytes, refusing to trust them unless (a) the
 * directory that actually contains `filePath` has the same on-disk
 * identity (device+inode) as `canonicalInstallRoot` at the moment this
 * function runs, and (b) the leaf file's own identity survives a
 * swap-in/swap-back around the read (`readFileWithIdentityPin`). Used for
 * both the durable backup-metadata record and the backup file itself at
 * restore time — both need exactly this protection, and both used to
 * duplicate it (as `readBackupFileWithRootPin`, restore-only) until a
 * round-7 finding showed the metadata-read call site needed it too.
 *
 * Round-6 reviewer finding (Vasquez): the previous approach validated the
 * ancestor directory in the *caller* — via a separately computed
 * `realpath(dirname(backupPath))` string compared against
 * `canonicalInstallRoot` — and only then called `readFileWithIdentityPin`
 * as an entirely distinct step. Folding both checks into one function
 * closes two things at once: it removes any chance of unrelated logic
 * being interposed between the ancestor check and the leaf read by a
 * caller that does other work around this call, and it switches the
 * ancestor check itself from a resolved-*path-string* comparison to a
 * device+inode *identity* comparison — the same primitive the OS itself
 * uses to decide whether two opens reference the same object, and
 * strictly stronger than comparing canonicalized path strings (which can
 * be fooled by anything that normalizes two different strings to the same
 * text, the exact class of surprise a Windows CI runner's 8.3/short-name
 * behavior already produced once in this file's history for a legitimate,
 * non-attacked path).
 *
 * Round-7 reviewer finding (Vasquez): this protection originally only
 * covered the backup *file* read in `restoreOrcaProfileWindows`. But
 * `findBackupByOperationId` reads the durable *metadata* record first —
 * via `resolveBackupMetaPath`'s one-time validation — and that metadata
 * read was still only leaf-identity-pinned (`readFileWithIdentityPin`
 * directly), not ancestor-pinned. A swap landing between
 * `resolveBackupMetaPath`'s validation and the metadata read let an
 * attacker serve a forged metadata record (attacker-chosen `safeFilename`,
 * genuine `backupFileName` copied from the real record) through the
 * swapped directory, then swap the real directory back before the later
 * `ensureInstallRootSafeCanonical` re-check — which then saw the
 * legitimate root and passed, while `record.safeFilename` was already
 * poisoned. Renamed this function (from `readBackupFileWithRootPin`) and
 * routed the metadata read through it too, so both leaf reads this module
 * performs get the same ancestor-plus-leaf protection, at the point each
 * one actually happens rather than trusting an earlier validation.
 *
 * This does **not** — and, using only Node's public, portable `fs` API on
 * Windows, cannot — eliminate the residual window between this function's
 * ancestor `lstat` and its leaf `lstat` a few lines later: Node has no
 * `openat`-equivalent (opening a file relative to an already-held
 * directory handle), so there is no way to *pin* the ancestor's identity
 * the same way `readFileWithIdentityPin` pins the leaf's identity via an
 * open file descriptor. Every other TOCTOU window this module has closed
 * (rounds 1-5) spanned one or more real, awaited I/O operations — genuine
 * scheduling points an attacker's already-issued swap could land in. This
 * one does not: the ancestor `lstat` and the leaf `lstat` are issued
 * back-to-back with no other `await` in between, so any further reduction
 * of this specific window would require Windows-specific native code
 * (e.g. an addon calling `NtCreateFile` against a held directory handle),
 * not anything expressible through portable Node.
 */
async function readFileWithRootPin(
  canonicalInstallRoot: string,
  filePath: string,
): Promise<Buffer | null> {
  let rootStat: { dev: bigint; ino: bigint };
  try {
    const stat = await lstat(canonicalInstallRoot, { bigint: true });
    if (stat.isSymbolicLink()) return null;
    rootStat = { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }

  if (readFileWithRootPinRaceHookForTests) {
    await readFileWithRootPinRaceHookForTests();
  }

  let parentStat: { dev: bigint; ino: bigint };
  try {
    const stat = await lstat(path.dirname(filePath), { bigint: true });
    if (stat.isSymbolicLink()) return null;
    parentStat = { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
  if (parentStat.dev !== rootStat.dev || parentStat.ino !== rootStat.ino) {
    // filePath's actual parent is not, in fact, the validated install
    // root — whether due to a swap or a miscomputed path. Refuse without
    // ever touching the leaf file.
    return null;
  }
  return await readFileWithIdentityPin(filePath);
}

/**
 * Read the durable metadata record at `metaPath` back, refusing to trust
 * the content unless (a) `metaPath`'s actual parent directory identity
 * matches a *freshly* re-validated `installRoot` at the moment of the
 * read, and (b) the leaf file's own identity survives a swap-in/swap-back
 * around the read. Both are enforced by `readFileWithRootPin` — see its
 * doc comment for the full history.
 *
 * Round-7 reviewer finding (Vasquez): this used to trust `metaPath` as
 * computed by `resolveBackupMetaPath`'s one-time validation, several
 * `await`s before this function's own read — reading only leaf-identity
 * (`readFileWithIdentityPin(metaPath)` directly), with no ancestor check
 * of its own. A swap landing in that gap let a forged metadata record
 * (attacker-chosen `safeFilename`, genuine `backupFileName` copied from
 * the real record) be read as if legitimate, then the real directory
 * swapped back before `findBackupByOperationId`'s later root re-check —
 * which then saw the legitimate root and passed, while the poisoned
 * `safeFilename` had already been captured. This now re-validates
 * `installRoot` fresh, immediately before this exact read, rather than
 * trusting the validation `resolveBackupMetaPath` performed earlier for a
 * different purpose (constructing `metaPath`'s string).
 */
async function readBackupMetaFileSafely(
  installRoot: string,
  metaPath: string,
): Promise<string | null> {
  let canonicalInstallRoot: string;
  try {
    canonicalInstallRoot = await ensureInstallRootSafeCanonical(installRoot);
  } catch {
    return null;
  }
  const bytes = await readFileWithRootPin(canonicalInstallRoot, metaPath);
  if (bytes === null) {
    return null; // No record at this path, or the read was not safe to trust.
  }
  return bytes.toString('utf8');
}

/**
 * Resolve the backup that a specific install operation produced, purely
 * from the durable on-disk metadata record for `operationId`. Returns null
 * if there is no record, the record is malformed, the install root is
 * unsafe (e.g. a symlink/junction), or the backup file it points to no
 * longer exists.
 *
 * Round-5 reviewer finding (Vasquez): this used to reuse the
 * `canonicalInstallRoot` `resolveBackupMetaPath` validated at the very top,
 * several `await`s before this function's last use of it (reading and
 * parsing the metadata file happens in between) — a materially wider
 * validate-then-reuse window than the tight, back-to-back pattern
 * `installOrcaProfileWindows`/`restoreOrcaProfileWindows` use. This now
 * re-validates `installRoot` via `ensureInstallRootSafeCanonical`
 * immediately before its own last use of the canonical root (building and
 * `lstat`-ing `backupPath`), so a swap that happens anywhere in this
 * function's execution — not just before it starts — is still caught.
 */
export async function findBackupByOperationId(
  installRoot: string,
  operationId: string,
): Promise<LocatedBackup | null> {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    return null;
  }
  let metaPath: string;
  try {
    ({ metaPath } = await resolveBackupMetaPath(installRoot, operationId));
  } catch {
    return null; // Install root is unsafe or missing.
  }
  const raw = await readBackupMetaFileSafely(installRoot, metaPath);
  if (raw === null) {
    return null; // No record, or the read was not safe to trust.
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // Corrupt metadata; treat as not found rather than guessing.
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof (parsed as Record<string, unknown>)['safeFilename'] !== 'string' ||
    typeof (parsed as Record<string, unknown>)['backupFileName'] !== 'string'
  ) {
    return null;
  }
  const record = parsed as BackupMetaRecord;
  // Reject any backupFileName containing path separators — this record is
  // read back from disk and must never be trusted to escape installRoot.
  if (
    record.backupFileName.includes('/') ||
    record.backupFileName.includes('\\') ||
    record.backupFileName.includes('\0')
  ) {
    return null;
  }
  if (findBackupByOperationIdPreRevalidateHookForTests) {
    await findBackupByOperationIdPreRevalidateHookForTests();
  }
  // Re-validate installRoot fresh, immediately before this function's last
  // use of it — see this function's doc comment for why reusing the
  // validation from the top (an arbitrary number of `await`s ago) is not
  // tight enough.
  let canonicalInstallRoot: string;
  try {
    canonicalInstallRoot = await ensureInstallRootSafeCanonical(installRoot);
  } catch {
    return null;
  }
  const backupPath = path.join(canonicalInstallRoot, record.backupFileName);
  try {
    const info = await lstat(backupPath);
    if (info.isSymbolicLink()) return null; // Never follow a symlink here.
  } catch {
    return null; // The backup file itself is gone.
  }
  return { backupPath, safeFilename: record.safeFilename };
}

/**
 * Restore a profile from a previously created backup file.
 * Verifies the backup hash before overwriting the target.
 *
 * Round-3 reviewer finding (Ripley): `backupPath` here comes from a
 * separate, earlier call to `findBackupByOperationId`, which does its own
 * lstat-based symlink check before returning it — but that check is not
 * this function's to trust. Any time gap between that call returning and
 * this function actually reading `backupPath` (however small in practice)
 * is a window in which the path could be swapped for a symlink, and
 * nothing here re-validated it. Rather than trust a previous check made
 * at a distance, this reads `backupPath` via `readFileWithIdentityPin`,
 * which performs its own fresh, atomically-consistent-at-the-syscall
 * check immediately adjacent to the read — safe regardless of what any
 * earlier caller observed or how long ago it observed it.
 *
 * Round-4 reviewer finding (Ripley): the leaf-file fix above does not
 * cover an ancestor-directory swap. `findBackupByOperationId` and
 * `restoreOrcaProfileWindows` are invoked as two genuinely separate IPC
 * round-trips (unlike `installOrcaProfileWindows`, where validation and
 * use happen within one function call), so the gap between them is not
 * bounded to a single syscall the way the rest of this file's TOCTOU
 * windows are — an attacker who swaps `installRoot` itself for a
 * junction in that window would have both `readFileWithIdentityPin`'s
 * `lstat` and its `open()` transparently follow the junction, since the
 * leaf file really is a plain file, just reached through the wrong
 * directory. This re-validates `installRoot` (via `ensureInstallRootSafe`,
 * the same one-time check `installOrcaProfileWindows` already relies on)
 * and confirms `backupPath`'s parent is exactly that freshly-canonicalized
 * root *before* trusting `backupPath` at all — matching this file's
 * existing "validate once, immediately before use" convention rather than
 * inventing a directory-identity bracket (a leaf-file bracket of that
 * shape was already shown, in this file's history, to be defeatable by a
 * swap-in-then-swap-back around the single operation it brackets).
 *
 * Round-6 reviewer finding (Vasquez): the round-4 fix above validated the
 * ancestor directory *here*, in this function, via a separately computed
 * `realpath(dirname(backupPath))` string comparison, and only called
 * `readFileWithIdentityPin` as a distinct, later step — leaving a small
 * but real window between the two in which the install root could be
 * swapped again. Both checks now happen inside `readFileWithRootPin`
 * (see its doc comment for the full reasoning): the ancestor check is
 * identity-based (device+inode) rather than string-based, and it is
 * issued immediately before the leaf's own identity-pinned read with no
 * caller logic able to run in between.
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

  const installRoot = getWindowsOrcaInstallRoot();
  // Re-validate installRoot now, immediately before trusting backupPath —
  // backupPath was computed by an earlier, separate call
  // (findBackupByOperationId), so the install root could have been
  // swapped for a junction in the gap since that call returned.
  const canonicalInstallRoot =
    await ensureInstallRootSafeCanonical(installRoot);

  // Verify the backup file's parent directory is genuinely the validated
  // install root (identity-based, not a path-string comparison), that the
  // backup file itself is not a symlink at the moment it is actually
  // opened (identity-pinned; see `readFileWithIdentityPin`), and that its
  // content matches the expected hash.
  const backupBytes = await readFileWithRootPin(
    canonicalInstallRoot,
    backupPath,
  );
  if (backupBytes === null) {
    throw makeError('pathRestricted', 'Backup file not found or unreadable.');
  }
  const actualBackupHash = sha256(backupBytes);
  if (actualBackupHash !== expectedBackupHash) {
    throw makeError(
      'verificationFailed',
      'Backup file hash does not match expected value; restore aborted.',
    );
  }

  const destPath = computeInstallPath(safeFilename, installRoot);

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
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: string }).code === 'ENOENT'
    ) {
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
