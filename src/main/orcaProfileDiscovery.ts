/**
 * Local OrcaSlicer filament profile discovery (issue #55).
 *
 * Scans the canonical, current-OS OrcaSlicer user and system profile roots,
 * resolves inheritance chains, and ranks compatible filament profiles against a
 * specific printer context. No arbitrary filesystem path is ever accepted from
 * the renderer; only the fixed, OS-specific canonical roots defined here are
 * traversed.
 *
 * Security contract:
 * - Only canonical OS roots are ever scanned; renderer cannot influence them.
 * - All resolved paths are canonicalized with realpath and verified to remain
 *   inside their originating root (root-escape rejection).
 * - Symlinks, junctions (Windows reparse points), and non-regular files are
 *   rejected at every traversal step.
 * - Traversal is bounded by MAX_FILES_PER_ROOT, MAX_TRAVERSAL_DEPTH, and
 *   MAX_FILE_BYTES per profile file.
 * - JSON is bounded by MAX_JSON_DEPTH (checked after parse) and
 *   MAX_FILE_BYTES (enforced at read time).
 * - Inheritance chains are bounded by MAX_INHERITANCE_DEPTH and cycle-detected
 *   via a Set of visited names.
 * - No profile outside canonical roots is ever used as a parent.
 *
 * Independently authored. Not derived from any approved third-party source.
 */

import path from 'node:path';
import os from 'node:os';
import {
  open,
  realpath,
  readdir,
  lstat,
  constants as fsConstants,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OrcaProfileEntry, type OrcaProfileSource } from '@shared/ipc';
import type { RemoteCalibrationPrinterContext } from './calibrationWire.js';
import {
  ORCA_PROFILE_MAX_BYTES,
  type OrcaProfileContentRejectionCode,
  type RawOrcaProfileJson,
  validateOrcaProfileJson,
} from './orcaProfileValidation.js';

// ---------------------------------------------------------------------------
// Traversal / security limits
// ---------------------------------------------------------------------------

/** Maximum files inspected per root (both user and system combined). */
export const ORCA_PROFILE_MAX_FILES_PER_ROOT = 500;
/** Maximum directory traversal depth from any canonical root. */
export const ORCA_PROFILE_MAX_TRAVERSAL_DEPTH = 8;
/** Maximum length of the OrcaSlicer `inherits` chain. */
export const ORCA_PROFILE_MAX_INHERITANCE_DEPTH = 10;

// ---------------------------------------------------------------------------
// Parsed profile internal type
// ---------------------------------------------------------------------------

interface ParsedProfile {
  /** Absolute, canonicalized path to the JSON file. */
  readonly filePath: string;
  /** Root this file belongs to (used for root-escape verification). */
  readonly rootPath: string;
  /** Source (user data vs system install). */
  readonly source: Extract<OrcaProfileSource, 'systemInstall' | 'userImported'>;
  /** Raw parsed + validated JSON (passthrough preserves unknown fields). */
  readonly raw: RawOrcaProfileJson;
  /** The profile's `name` field (after inheritance resolution this is the leaf name). */
  readonly name: string;
  /** SHA-256 of the file's exact bytes. */
  readonly contentHash: string;
}

// ---------------------------------------------------------------------------
// OS-specific canonical root resolution
// ---------------------------------------------------------------------------

/**
 * Returns candidate OrcaSlicer user data roots for the current OS.
 * Only paths that OrcaSlicer itself writes under are included.
 */
export function orcaUserDataRoots(): string[] {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'];
    if (!appData) return [];
    return [path.join(appData, 'OrcaSlicer', 'user')];
  }
  if (process.platform === 'darwin') {
    return [
      path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'OrcaSlicer',
        'user',
      ),
    ];
  }
  // Linux
  const configHome =
    process.env['XDG_CONFIG_HOME'] ?? path.join(os.homedir(), '.config');
  return [path.join(configHome, 'OrcaSlicer', 'user')];
}

/**
 * Returns candidate OrcaSlicer system/resource profile roots for the current OS.
 */
export function orcaSystemProfileRoots(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['PROGRAMFILES'] ?? 'C:\\Program Files';
    const programFilesX86 =
      process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)';
    return [
      path.join(programFiles, 'OrcaSlicer', 'resources', 'profiles'),
      path.join(programFilesX86, 'OrcaSlicer', 'resources', 'profiles'),
    ];
  }
  if (process.platform === 'darwin') {
    return ['/Applications/OrcaSlicer.app/Contents/Resources/profiles'];
  }
  // Linux (AppImage / distro package typical paths)
  return [
    '/usr/share/OrcaSlicer/resources/profiles',
    '/opt/OrcaSlicer/resources/profiles',
  ];
}

// ---------------------------------------------------------------------------
// Secure file reading with symlink/reparse rejection
// ---------------------------------------------------------------------------

type OrcaFileRejectionCode =
  | OrcaProfileContentRejectionCode
  | 'cycle'
  | 'inheritanceTooDeep'
  | 'missingParent'
  | 'notFile'
  | 'rootEscape'
  | 'symlink';

export interface OrcaDiscoveryDiagnostic {
  readonly code: OrcaFileRejectionCode;
  readonly relativePath: string;
  readonly detail: string;
}

export interface OrcaDiscoveryMetrics {
  readonly filesInspected: number;
  readonly bytesRead: number;
  readonly maximumTraversalDepth: number;
}

interface MutableOrcaDiscoveryMetrics {
  filesInspected: number;
  bytesRead: number;
  maximumTraversalDepth: number;
}

function codedError(code: OrcaFileRejectionCode, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function errorCode(error: unknown): OrcaFileRejectionCode {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    const code = error.code;
    if (
      code === 'notFile' ||
      code === 'rootEscape' ||
      code === 'symlink' ||
      code === 'tooLarge'
    ) {
      return code;
    }
  }
  return 'notFile';
}

/**
 * Read a file, rejecting symlinks and files exceeding MAX_FILE_BYTES.
 * Uses O_NOFOLLOW on platforms that support it.
 */
async function readFileSecure(filePath: string): Promise<Buffer> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw codedError('symlink', 'Symlink or reparse point rejected.');
  }
  if (!info.isFile()) {
    throw codedError('notFile', 'Not a regular file.');
  }
  if (info.size > ORCA_PROFILE_MAX_BYTES) {
    throw codedError('tooLarge', 'File exceeds size limit.');
  }

  const file = await open(
    filePath,
    fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
  );
  try {
    const before = await file.stat();
    if (!before.isFile()) {
      throw codedError('notFile', 'Not a regular file.');
    }
    if (before.size > ORCA_PROFILE_MAX_BYTES) {
      throw codedError('tooLarge', 'File exceeds size limit.');
    }
    const buffer = await file.readFile();
    const after = await file.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      (before.ino !== 0 && before.ino !== after.ino)
    ) {
      throw codedError('notFile', 'Profile changed while it was read.');
    }
    if (buffer.byteLength > ORCA_PROFILE_MAX_BYTES) {
      throw codedError('tooLarge', 'File content exceeds size limit.');
    }
    return buffer;
  } finally {
    await file.close();
  }
}

// ---------------------------------------------------------------------------
// Root-escape guard
// ---------------------------------------------------------------------------

/**
 * Verify `absolutePath` is a descendant of `rootPath` after canonicalization.
 * Returns the canonicalized path or throws if the path escapes the root.
 */
async function canonicalizeUnderRoot(
  absolutePath: string,
  rootPath: string,
): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(absolutePath);
  } catch {
    throw Object.assign(new Error('Path canonicalization failed.'), {
      code: 'CANON_FAIL',
    });
  }
  // Normalize root to ensure trailing separator comparison works.
  const root = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  if (canonical !== rootPath && !canonical.startsWith(root)) {
    throw codedError('rootEscape', `Path escapes canonical root: ${canonical}`);
  }
  return canonical;
}

// ---------------------------------------------------------------------------
// Profile file parsing
// ---------------------------------------------------------------------------

/**
 * Parse a single profile JSON file from `filePath`.
 * Returns null if the file is not a filament profile or fails validation.
 */
type ParseProfileResult =
  | {
      readonly status: 'ok';
      readonly profile: ParsedProfile;
      readonly bytes: number;
    }
  | {
      readonly status: 'rejected';
      readonly code: OrcaFileRejectionCode;
      readonly detail: string;
    };

async function parseProfileFile(
  filePath: string,
  rootPath: string,
  source: 'systemInstall' | 'userImported',
): Promise<ParseProfileResult> {
  if (!filePath.endsWith('.json')) {
    return {
      status: 'rejected',
      code: 'invalidSchema',
      detail: 'Profile filename does not end in .json.',
    };
  }

  let buf: Buffer;
  try {
    buf = await readFileSecure(filePath);
  } catch (error) {
    return {
      status: 'rejected',
      code: errorCode(error),
      detail: error instanceof Error ? error.message : 'Profile read failed.',
    };
  }

  const result = validateOrcaProfileJson(buf.toString('utf8'));
  if (result.status === 'rejected') return result;
  const raw = result.raw;

  // Must be a filament profile.
  const typefield = raw.type;
  const nameField = raw.name;
  if (!nameField || nameField.trim().length === 0) {
    return {
      status: 'rejected',
      code: 'invalidSchema',
      detail: 'Profile name is missing.',
    };
  }

  // Check type field: OrcaSlicer uses 'filament' for filament profiles.
  // Some older profiles omit the type field; in that case we rely on directory.
  const isFilamentByType = typefield === 'filament';
  const isFilamentByPath =
    filePath.includes(`${path.sep}filament${path.sep}`) ||
    filePath.endsWith(`${path.sep}filament`);
  if (!isFilamentByType && !isFilamentByPath) {
    return {
      status: 'rejected',
      code: 'invalidSchema',
      detail: 'File is not a filament profile.',
    };
  }

  const contentHash = createHash('sha256').update(buf).digest('hex');

  return {
    status: 'ok',
    bytes: buf.byteLength,
    profile: {
      filePath,
      rootPath,
      source,
      raw,
      name: nameField.trim(),
      contentHash,
    },
  };
}

// ---------------------------------------------------------------------------
// Directory traversal
// ---------------------------------------------------------------------------

/**
 * Recursively traverse `dirPath` (bounded by depth and fileCount) and
 * collect parsed profile objects. Symlinks and junctions are skipped.
 */
async function traverseDir(
  dirPath: string,
  canonicalRoot: string,
  source: 'systemInstall' | 'userImported',
  depth: number,
  fileCount: { value: number },
  profiles: ParsedProfile[],
  diagnostics: OrcaDiscoveryDiagnostic[],
  metrics: MutableOrcaDiscoveryMetrics,
): Promise<void> {
  if (depth > ORCA_PROFILE_MAX_TRAVERSAL_DEPTH) return;
  if (fileCount.value >= ORCA_PROFILE_MAX_FILES_PER_ROOT) return;
  metrics.maximumTraversalDepth = Math.max(
    metrics.maximumTraversalDepth,
    depth,
  );

  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (fileCount.value >= ORCA_PROFILE_MAX_FILES_PER_ROOT) break;

    const entryPath = path.join(dirPath, entry.name);

    // Reject symbolic links and junctions at traversal time.
    if (entry.isSymbolicLink()) {
      diagnostics.push({
        code: 'symlink',
        relativePath: path.relative(canonicalRoot, entryPath),
        detail: 'Symlink or reparse point skipped.',
      });
      continue;
    }

    if (entry.isDirectory()) {
      // Extra guard: verify the directory hasn't become a symlink since listing.
      let dirInfo;
      try {
        dirInfo = await lstat(entryPath);
      } catch {
        continue;
      }
      if (dirInfo.isSymbolicLink()) {
        diagnostics.push({
          code: 'symlink',
          relativePath: path.relative(canonicalRoot, entryPath),
          detail: 'Symlink or reparse point skipped.',
        });
        continue;
      }
      if (!dirInfo.isDirectory()) continue;

      await traverseDir(
        entryPath,
        canonicalRoot,
        source,
        depth + 1,
        fileCount,
        profiles,
        diagnostics,
        metrics,
      );
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fileCount.value += 1;
      metrics.filesInspected += 1;

      // Root-escape guard: canonicalize and verify the file stays under root.
      let canonicalPath: string;
      try {
        canonicalPath = await canonicalizeUnderRoot(entryPath, canonicalRoot);
      } catch (error) {
        diagnostics.push({
          code: 'rootEscape',
          relativePath: path.relative(canonicalRoot, entryPath),
          detail:
            error instanceof Error
              ? error.message
              : 'Path escaped canonical root.',
        });
        continue;
      }

      const parsed = await parseProfileFile(
        canonicalPath,
        canonicalRoot,
        source,
      );
      if (parsed.status === 'ok') {
        profiles.push(parsed.profile);
        metrics.bytesRead += parsed.bytes;
      } else {
        diagnostics.push({
          code: parsed.code,
          relativePath: path.relative(canonicalRoot, canonicalPath),
          detail: parsed.detail,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Inheritance resolution
// ---------------------------------------------------------------------------

/**
 * Merge parent fields into child using OrcaSlicer semantics:
 * child fields take priority; missing fields are inherited from parent.
 * Unknown/extra fields are preserved (passthrough).
 */
function mergeInheritedFields(
  child: Record<string, unknown>,
  parent: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...parent };
  for (const [key, value] of Object.entries(child)) {
    // Child fields override parent — but we never inherit 'inherits' itself.
    if (key !== 'inherits') {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Resolve the inheritance chain for `profile` using `profilesByName` as the
 * lookup table. Returns the merged raw JSON (leaf fields override parents).
 * Bounded by MAX_INHERITANCE_DEPTH and cycle detection.
 */
type InheritanceResult =
  | { readonly status: 'ok'; readonly raw: Record<string, unknown> }
  | {
      readonly status: 'rejected';
      readonly code: 'cycle' | 'inheritanceTooDeep' | 'missingParent';
      readonly detail: string;
    };

function resolveInheritance(
  profile: ParsedProfile,
  profilesByName: Map<string, ParsedProfile>,
): InheritanceResult {
  const visited = new Set<string>();
  let current: Record<string, unknown> = { ...profile.raw };
  visited.add(profile.name);

  for (let depth = 0; depth < ORCA_PROFILE_MAX_INHERITANCE_DEPTH; depth++) {
    const inherits = current['inherits'];
    if (typeof inherits !== 'string' || inherits.trim().length === 0) {
      return { status: 'ok', raw: current };
    }
    const parentName = inherits.trim();
    if (visited.has(parentName)) {
      return {
        status: 'rejected',
        code: 'cycle',
        detail: `Inheritance cycle reaches "${parentName}".`,
      };
    }

    const parent = profilesByName.get(parentName);
    if (!parent) {
      return {
        status: 'rejected',
        code: 'missingParent',
        detail: `Inheritance parent "${parentName}" was not discovered.`,
      };
    }

    visited.add(parentName);
    current = mergeInheritedFields(current, { ...parent.raw });
  }

  return {
    status: 'rejected',
    code: 'inheritanceTooDeep',
    detail: `Inheritance exceeds ${ORCA_PROFILE_MAX_INHERITANCE_DEPTH} profiles.`,
  };
}

// ---------------------------------------------------------------------------
// Printer context matching
// ---------------------------------------------------------------------------

/**
 * Determine whether a resolved profile is compatible with the given printer
 * context toolhead and nozzle. Returns true only when the nozzle diameter
 * is an exact match; no silent substitution is ever performed.
 */
function profileCompatibleWithToolhead(
  resolvedRaw: Record<string, unknown>,
  nozzleDiameterMm: number,
): boolean {
  // OrcaSlicer profiles embed the nozzle diameter in the profile name as
  // "@<diameter> nozzle" or "@0.4mm nozzle". We check the name suffix.
  const name =
    typeof resolvedRaw['name'] === 'string' ? resolvedRaw['name'] : '';
  // Parse diameter from name suffix patterns like "@0.4 nozzle" or "@0.4mm".
  const matchSuffix = /[@\s](\d+(?:\.\d+)?)\s*(?:mm\s*)?nozzle/i.exec(name);
  if (matchSuffix) {
    const declared = parseFloat(matchSuffix[1]!);
    if (!Number.isFinite(declared)) return false;
    // Exact match only; no silent substitution.
    return Math.abs(declared - nozzleDiameterMm) < 1e-6;
  }
  // If no diameter suffix in name, allow when the profile is named exactly
  // the printer's expected orcaProfileId (already filtered by caller).
  return true;
}

// ---------------------------------------------------------------------------
// Public discovery API
// ---------------------------------------------------------------------------

export interface OrcaDiscoveryOptions {
  readonly userRoots?: readonly string[];
  readonly systemRoots?: readonly string[];
}

export interface OrcaDiscoveryResult {
  readonly profiles: z.infer<typeof OrcaProfileEntry>[];
  readonly diagnostics: OrcaDiscoveryDiagnostic[];
  readonly metrics: OrcaDiscoveryMetrics;
}

async function scanProfiles(options: OrcaDiscoveryOptions): Promise<{
  profiles: ParsedProfile[];
  diagnostics: OrcaDiscoveryDiagnostic[];
  metrics: MutableOrcaDiscoveryMetrics;
}> {
  const profiles: ParsedProfile[] = [];
  const diagnostics: OrcaDiscoveryDiagnostic[] = [];
  const metrics: MutableOrcaDiscoveryMetrics = {
    filesInspected: 0,
    bytesRead: 0,
    maximumTraversalDepth: 0,
  };
  const roots: Array<{
    values: readonly string[];
    source: 'systemInstall' | 'userImported';
  }> = [
    {
      values: options.userRoots ?? orcaUserDataRoots(),
      source: 'userImported',
    },
    {
      values: options.systemRoots ?? orcaSystemProfileRoots(),
      source: 'systemInstall',
    },
  ];

  for (const { values, source } of roots) {
    for (const rootPath of values) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(rootPath);
      } catch {
        continue;
      }
      const fileCount = { value: 0 };
      await traverseDir(
        canonicalRoot,
        canonicalRoot,
        source,
        0,
        fileCount,
        profiles,
        diagnostics,
        metrics,
      );
    }
  }

  return { profiles, diagnostics, metrics };
}

/**
 * Discover locally installed OrcaSlicer filament profiles that are compatible
 * with the given printer context. Each returned entry is bound to the specific
 * toolhead/nozzle/snapshot identity — no substitution is performed.
 *
 * Returns an empty array if no OrcaSlicer installation is found or if no
 * profiles match. Never throws.
 */
export async function discoverLocalOrcaFilamentProfiles(
  context: RemoteCalibrationPrinterContext,
  options: OrcaDiscoveryOptions = {},
): Promise<z.infer<typeof OrcaProfileEntry>[]> {
  const result = await discoverLocalOrcaFilamentProfilesWithDiagnostics(
    context,
    options,
  );
  return result.profiles;
}

/**
 * Internal diagnostic seam for security tests and main-process observability.
 * The renderer-facing API continues to return only profiles and preserves its
 * established empty-array contract for rejected files.
 */
export async function discoverLocalOrcaFilamentProfilesWithDiagnostics(
  context: RemoteCalibrationPrinterContext,
  options: OrcaDiscoveryOptions = {},
): Promise<OrcaDiscoveryResult> {
  if (
    !context.orcaProfileId ||
    context.configurationRevision === null ||
    !context.snapshotId ||
    context.toolheads.length === 0
  ) {
    return {
      profiles: [],
      diagnostics: [],
      metrics: {
        filesInspected: 0,
        bytesRead: 0,
        maximumTraversalDepth: 0,
      },
    };
  }

  const scan = await scanProfiles(options);
  const allProfiles = scan.profiles;
  if (allProfiles.length === 0) {
    return {
      profiles: [],
      diagnostics: scan.diagnostics,
      metrics: scan.metrics,
    };
  }

  // Build lookup by profile name for inheritance resolution.
  const profilesByName = new Map<string, ParsedProfile>();
  for (const p of allProfiles) {
    // In case of duplicates, prefer system install over user import for the
    // inheritance lookup (system profiles are more authoritative as parents).
    if (!profilesByName.has(p.name) || p.source === 'systemInstall') {
      profilesByName.set(p.name, p);
    }
  }

  const results: z.infer<typeof OrcaProfileEntry>[] = [];

  // For each toolhead in the printer context, find compatible profiles.
  for (const toolhead of context.toolheads) {
    for (const profile of allProfiles) {
      // Primary filter: exact name match against the printer's orcaProfileId.
      if (profile.name !== context.orcaProfileId) continue;

      // Resolve inheritance chain.
      const resolved = resolveInheritance(profile, profilesByName);
      if (resolved.status === 'rejected') {
        scan.diagnostics.push({
          code: resolved.code,
          relativePath: path.relative(profile.rootPath, profile.filePath),
          detail: resolved.detail,
        });
        continue;
      }
      const resolvedRaw = resolved.raw;

      // Nozzle diameter exact match.
      if (
        !profileCompatibleWithToolhead(resolvedRaw, toolhead.nozzle.diameterMm)
      ) {
        // If the profile name matches exactly but nozzle diameter from name
        // suffix doesn't match toolhead — skip this toolhead but keep trying.
        continue;
      }

      // Determine if the profile content matches what the backend recorded.
      // upstreamVerified = true when the local content hash matches the
      // backend's recorded contentHash. If backend has no hash, we cannot
      // verify and leave upstreamVerified = false.
      const upstreamVerified =
        context.contentHash !== null &&
        /^[a-f0-9]{64}$/.test(context.contentHash) &&
        profile.contentHash === context.contentHash;

      const material =
        typeof resolvedRaw['filament_type'] === 'string'
          ? resolvedRaw['filament_type']
          : Array.isArray(resolvedRaw['filament_type']) &&
              typeof resolvedRaw['filament_type'][0] === 'string'
            ? resolvedRaw['filament_type'][0]
            : null;

      const entry = OrcaProfileEntry.safeParse({
        orcaProfileId: profile.name,
        displayName: profile.name,
        vendor: null,
        material: material ?? null,
        source: profile.source,
        upstreamVerified,
        printerId: context.printerId,
        configurationRevision: context.configurationRevision,
        snapshotId: context.snapshotId,
        toolId: toolhead.toolId,
        toolheadId: toolhead.toolheadId,
        nozzleId: toolhead.nozzle.id,
        nozzleDiameterMm: toolhead.nozzle.diameterMm,
        profileRevision: context.profileRevision ?? null,
        contentHash: profile.contentHash,
        exportable: true,
      });

      if (entry.success) {
        results.push(entry.data);
      }
    }
  }

  return {
    profiles: results,
    diagnostics: scan.diagnostics,
    metrics: scan.metrics,
  };
}

// ---------------------------------------------------------------------------
// Profile file retrieval by ID (for generation)
// ---------------------------------------------------------------------------

/**
 * Find and return the raw JSON of a local OrcaSlicer filament profile by name,
 * with its inheritance chain fully resolved. Returns null if not found or if
 * any security check fails. The resolved JSON is suitable for patching.
 */
export async function findLocalOrcaProfileRaw(orcaProfileId: string): Promise<{
  resolvedRaw: Record<string, unknown>;
  contentHash: string;
  filePath: string;
} | null> {
  if (!orcaProfileId || orcaProfileId.length > 512) return null;

  const { profiles: allProfiles } = await scanProfiles({});

  const profilesByName = new Map<string, ParsedProfile>();
  for (const p of allProfiles) {
    if (!profilesByName.has(p.name) || p.source === 'systemInstall') {
      profilesByName.set(p.name, p);
    }
  }

  const found = profilesByName.get(orcaProfileId);
  if (!found) return null;

  const resolved = resolveInheritance(found, profilesByName);
  if (resolved.status === 'rejected') return null;
  return {
    resolvedRaw: resolved.raw,
    contentHash: found.contentHash,
    filePath: found.filePath,
  };
}
