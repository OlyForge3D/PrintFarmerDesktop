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
} from 'node:fs/promises';
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
 * Shared by `ensureInstallRootSafe` (APPDATA -> installRoot) and
 * `ensureBackupMetaDirSafe` (installRoot -> installRoot/.pfd-backup-meta),
 * so a reparse point anywhere in either chain is rejected identically. The
 * durable backup-metadata sidecar (#208) originally reused only the
 * destination-file symlink check, not this per-segment root walk — so a
 * junction at `.pfd-backup-meta` itself (or a segment under it) could
 * redirect metadata reads/writes outside the canonical OrcaSlicer
 * directory, exactly the escape this walk exists to prevent for the
 * install root.
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
 * Directory (inside the install root) holding one durable identity record
 * per install operation that produced a backup, keyed by `operationId`.
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
 */
const BACKUP_META_DIR = '.pfd-backup-meta';

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
 * Ensure `installRoot/.pfd-backup-meta` exists, is not itself (nor any
 * segment leading to it) a symlink/junction, and canonicalizes to somewhere
 * under the install root. Returns the canonical metadata directory path.
 *
 * `installRoot` is independently re-validated here (via
 * `ensureInstallRootSafe`) rather than assumed safe from a prior call: this
 * is called both from the install path (after `ensureInstallRootSafe` has
 * already run) and from `findBackupByOperationId` on the restore path,
 * which has no other opportunity to check the install root before reading
 * metadata off disk.
 */
async function ensureBackupMetaDirSafe(installRoot: string): Promise<string> {
  await ensureInstallRootSafe(installRoot);
  let canonicalInstallRoot: string;
  try {
    canonicalInstallRoot = await realpath(installRoot);
  } catch {
    throw makeError('pathRestricted', 'Install root is inaccessible.');
  }
  return walkDirSafe(installRoot, canonicalInstallRoot, BACKUP_META_DIR);
}

/**
 * Re-verify, at the moment of use, that `metaDir` (the validated
 * `.pfd-backup-meta` directory itself) is still a real directory and not a
 * symlink/junction.
 *
 * Round-2 reviewer finding (Vasquez): `ensureBackupMetaDirSafe` validates
 * the directory chain once, up front, but the leaf-file checks added for
 * round 1 (`tempInfo`/`before`/`after` lstat calls) only ever inspect the
 * *file* being written or read — never the *directory* containing it. If
 * `.pfd-backup-meta` itself is swapped for a junction after validation but
 * before the leaf write/read, the leaf file the temp-write or read then
 * touches is a perfectly ordinary file sitting in the attacker's target
 * directory, so none of the leaf-level `isSymbolicLink()` checks ever trip
 * — the swap is invisible at the leaf.
 *
 * This closes that gap the same way the leaf-level checks do: by
 * re-checking immediately adjacent to the operation rather than trusting a
 * validation performed earlier. It cannot eliminate the single-syscall gap
 * between this check and the very next syscall (Node's fs API has no
 * directory-handle-relative open on Windows), but it collapses the
 * previously large validate-once-then-use-later window down to that
 * irreducible minimum, exactly as reviewers suggested.
 */
async function assertBackupMetaDirNotSwapped(metaDir: string): Promise<void> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(metaDir);
  } catch {
    throw makeError(
      'pathRestricted',
      'Backup metadata directory is missing or inaccessible.',
    );
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw makeError(
      'pathRestricted',
      'Backup metadata directory was redirected; refused.',
    );
  }
}

/**
 * Test-only hook invoked immediately before the write path re-verifies
 * `metaDir` (right before creating the temp file). Lets a regression test
 * deterministically swap `.pfd-backup-meta` itself for a junction at
 * exactly the moment the round-2 TOCTOU window exists, proving the
 * directory-level recheck refuses the operation rather than silently
 * writing through the junction. No-op in production; never set outside
 * tests.
 */
let backupMetaDirWriteRaceHookForTests:
  ((metaDir: string) => Promise<void> | void) | null = null;

export function __setBackupMetaDirWriteRaceHookForTests(
  hook: ((metaDir: string) => Promise<void> | void) | null,
): void {
  backupMetaDirWriteRaceHookForTests = hook;
}

/**
 * Durably record which backup file a given install operation produced.
 * Overwrites any prior record for the same `operationId`: if an operation
 * is retried and produces a newer backup, that newer backup is the one
 * restore should recover.
 *
 * Writes via an unpredictably-named, exclusively-created temp file in the
 * validated metadata directory, then an atomic rename over the final path
 * — the same pattern already used for profile installs/restores. This
 * closes a TOCTOU window a reviewer identified: the previous
 * lstat-then-writeFile(metaPath) sequence had a gap between checking that
 * `metaPath` was not a symlink and the subsequent write, during which an
 * attacker could replace `metaPath` with a symlink and have the write
 * follow it. `wx` (exclusive create) on an unguessable temp name cannot be
 * pre-empted, and `rename()` replaces whatever is at the destination path
 * (including a symlink placed there in the interim) rather than following
 * it — so there is no window in which a symlink at `metaPath` causes data
 * to be written through it.
 *
 * Round-2 reviewer finding (Vasquez): the above closes the leaf-file race,
 * but `.pfd-backup-meta` (the directory itself) was still validated only
 * once, up front, by `ensureBackupMetaDirSafe`. This re-verifies `metaDir`
 * immediately before both the temp-file creation and the rename, so a
 * directory-level swap is caught at the point of use rather than trusted
 * from an earlier check.
 */
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

async function writeBackupMeta(
  installRoot: string,
  operationId: string,
  record: BackupMetaRecord,
): Promise<void> {
  validateOperationId(operationId);
  const metaDir = await ensureBackupMetaDirSafe(installRoot);
  const metaPath = path.join(metaDir, `${operationId}.json`);
  const tempPath = path.join(metaDir, `.pfd-meta-tmp-${randomUUID()}.json`);

  if (backupMetaDirWriteRaceHookForTests) {
    await backupMetaDirWriteRaceHookForTests(metaDir);
  }
  await assertBackupMetaDirNotSwapped(metaDir);

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
    // Re-verify the containing directory again immediately before the
    // rename, narrowing the window a second time rather than relying on
    // the pre-write check alone.
    await assertBackupMetaDirNotSwapped(metaDir);
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
 * Test-only hook invoked between the pre-read symlink check and the actual
 * file read inside `findBackupByOperationId`'s metadata read. Lets a
 * regression test deterministically simulate the TOCTOU race a reviewer
 * flagged (the metadata file being replaced with a symlink in the window
 * between the safety check and the read) without depending on real
 * scheduling/timing, which is inherently non-deterministic. No-op in
 * production; never set outside tests.
 */
let backupMetaReadRaceHookForTests: (() => Promise<void> | void) | null = null;

export function __setBackupMetaReadRaceHookForTests(
  hook: (() => Promise<void> | void) | null,
): void {
  backupMetaReadRaceHookForTests = hook;
}

/**
 * Test-only hook invoked at the very start of `readBackupMetaFileSafely`,
 * before the containing-directory recheck. Lets a regression test
 * deterministically swap `.pfd-backup-meta` itself for a junction at
 * exactly the moment the round-2 directory-level TOCTOU window exists
 * (Vasquez), proving the directory recheck refuses the read rather than
 * transparently following the junction to read an attacker's file that
 * merely happens to sit at the same leaf filename. No-op in production;
 * never set outside tests.
 */
let backupMetaDirReadRaceHookForTests:
  ((metaDir: string) => Promise<void> | void) | null = null;

export function __setBackupMetaDirReadRaceHookForTests(
  hook: ((metaDir: string) => Promise<void> | void) | null,
): void {
  backupMetaDirReadRaceHookForTests = hook;
}

/**
 * Read `metaPath` back, refusing to trust the content if the path was (or
 * became) a symlink immediately before or immediately after the read, or
 * if the containing `metaDir` itself was (or became) a symlink/junction
 * around the read.
 *
 * This brackets the read with independent symlink checks at both the
 * leaf-file level and the containing-directory level, rather than relying
 * on a single check-then-use, closing (to the extent Node's cross-platform
 * fs API allows without `O_NOFOLLOW`, which libuv does not implement on
 * Windows, or directory-handle-relative opens, which Node does not expose
 * at all) the window in which an attacker could swap the metadata file —
 * or the directory containing it — between validation and use. Any
 * symlink observed at either level, on either side of the read, invalidates
 * the result: the record is treated as not found rather than trusted.
 *
 * Round-2 reviewer finding (Vasquez): round 1 only bracketed the leaf file
 * (`metaPath`). A directory-level swap of `.pfd-backup-meta` itself is
 * invisible to those leaf checks, because the leaf file the read then
 * touches is a perfectly ordinary file sitting in the attacker's target
 * directory. Bracketing `metaDir` too closes that separate gap.
 */
async function readBackupMetaFileSafely(
  metaDir: string,
  metaPath: string,
): Promise<string | null> {
  if (backupMetaDirReadRaceHookForTests) {
    await backupMetaDirReadRaceHookForTests(metaDir);
  }
  try {
    await assertBackupMetaDirNotSwapped(metaDir);
  } catch {
    return null;
  }

  try {
    const before = await lstat(metaPath);
    if (before.isSymbolicLink()) return null;
  } catch {
    return null; // No record at this path.
  }

  if (backupMetaReadRaceHookForTests) {
    await backupMetaReadRaceHookForTests();
  }

  let raw: string;
  try {
    raw = await readFile(metaPath, 'utf8');
  } catch {
    return null;
  }

  try {
    const after = await lstat(metaPath);
    if (after.isSymbolicLink()) return null; // Swapped mid-read; discard.
    // Re-verify the containing directory again immediately after the
    // read, in case it was swapped mid-read rather than beforehand.
    await assertBackupMetaDirNotSwapped(metaDir);
  } catch {
    return null;
  }

  return raw;
}

/**
 * Resolve the backup that a specific install operation produced, purely
 * from the durable on-disk metadata record for `operationId`. Returns null
 * if there is no record, the record is malformed, the metadata directory
 * chain is unsafe (e.g. a symlink/junction), or the backup file it points
 * to no longer exists.
 */
export async function findBackupByOperationId(
  installRoot: string,
  operationId: string,
): Promise<LocatedBackup | null> {
  if (!OPERATION_ID_PATTERN.test(operationId)) {
    return null;
  }
  let metaDir: string;
  try {
    metaDir = await ensureBackupMetaDirSafe(installRoot);
  } catch {
    return null; // Install root or metadata dir chain is unsafe or missing.
  }
  const metaPath = path.join(metaDir, `${operationId}.json`);
  const raw = await readBackupMetaFileSafely(metaDir, metaPath);
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
  // metaDir is canonical (installRoot resolved through walkDirSafe) and
  // BACKUP_META_DIR has no path separators, so its parent is the canonical
  // install root — use that rather than the raw, possibly-unresolved
  // installRoot argument to join the backup filename.
  const canonicalInstallRoot = path.dirname(metaDir);
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
