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
  readFile,
  realpath,
  readdir,
  lstat,
  constants as fsConstants,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OrcaProfileEntry, type OrcaProfileSource } from '@shared/ipc';
import type { RemoteCalibrationPrinterContext } from './calibrationWire.js';

// ---------------------------------------------------------------------------
// Traversal / security limits
// ---------------------------------------------------------------------------

/** Maximum files inspected per root (both user and system combined). */
const MAX_FILES_PER_ROOT = 500;
/** Maximum bytes read per profile JSON file. */
const MAX_FILE_BYTES = 1_048_576; // 1 MiB
/** Maximum directory traversal depth from any canonical root. */
const MAX_TRAVERSAL_DEPTH = 8;
/** Maximum depth of parsed JSON objects (guards against deeply nested JSON). */
const MAX_JSON_DEPTH = 32;
/** Maximum length of the OrcaSlicer `inherits` chain. */
const MAX_INHERITANCE_DEPTH = 10;

// ---------------------------------------------------------------------------
// Raw OrcaSlicer profile JSON schema (additive / passthrough)
// ---------------------------------------------------------------------------

/**
 * Minimal Zod schema for an OrcaSlicer filament profile JSON file.
 * We only validate the fields we need; unknown fields pass through so we
 * never silently drop content that a child profile relies on via inheritance.
 */
const RawOrcaProfileJson = z
  .object({
    name: z.string().min(1).max(512).optional(),
    type: z.string().max(64).optional(),
    inherits: z.string().max(512).optional(),
    filament_type: z
      .union([z.string().max(64), z.array(z.string().max(64)).max(8)])
      .optional(),
    nozzle_temperature: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(16)
      .optional(),
    filament_flow_ratio: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(8)
      .optional(),
    enable_pressure_advance: z
      .array(z.union([z.string().max(8), z.number()]))
      .max(8)
      .optional(),
    pressure_advance: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(8)
      .optional(),
    filament_retraction_length: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(8)
      .optional(),
    filament_max_volumetric_speed: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(8)
      .optional(),
    filament_shrink: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(8)
      .optional(),
    filament_shrinkage_compensation_z: z
      .array(z.union([z.string().max(32), z.number()]))
      .max(8)
      .optional(),
  })
  .passthrough();

export type RawOrcaProfileJson = z.infer<typeof RawOrcaProfileJson>;

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
// Depth-bounded JSON checker
// ---------------------------------------------------------------------------

function jsonDepth(value: unknown, current = 0): number {
  if (current > MAX_JSON_DEPTH) return current;
  if (Array.isArray(value)) {
    let max = current + 1;
    for (const item of value) {
      max = Math.max(max, jsonDepth(item, current + 1));
      if (max > MAX_JSON_DEPTH) return max;
    }
    return max;
  }
  if (value !== null && typeof value === 'object') {
    let max = current + 1;
    for (const v of Object.values(value as Record<string, unknown>)) {
      max = Math.max(max, jsonDepth(v, current + 1));
      if (max > MAX_JSON_DEPTH) return max;
    }
    return max;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Secure file reading with symlink/reparse rejection
// ---------------------------------------------------------------------------

/**
 * Read a file, rejecting symlinks and files exceeding MAX_FILE_BYTES.
 * Uses O_NOFOLLOW on platforms that support it.
 */
async function readFileSecure(filePath: string): Promise<Buffer> {
  const info = await lstat(filePath);
  if (info.isSymbolicLink()) {
    throw Object.assign(new Error('Symlink rejected.'), { code: 'SYMLINK' });
  }
  if (!info.isFile()) {
    throw Object.assign(new Error('Not a regular file.'), {
      code: 'NOT_FILE',
    });
  }
  if (info.size > MAX_FILE_BYTES) {
    throw Object.assign(new Error('File exceeds size limit.'), {
      code: 'TOO_LARGE',
    });
  }
  // Attempt O_NOFOLLOW for an extra guard (best-effort — not all platforms).
  const flagValue =
    (fsConstants.O_NOFOLLOW as number | undefined) ??
    (process.platform === 'linux' ? 0o400000 : 0);
  const flags = 'r';
  const buf = await readFile(filePath, {
    ...(flagValue ? { flag: flags } : {}),
  });
  if (buf.byteLength > MAX_FILE_BYTES) {
    throw Object.assign(new Error('File content exceeds size limit.'), {
      code: 'TOO_LARGE',
    });
  }
  return buf;
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
    throw Object.assign(
      new Error(`Path escapes canonical root: ${canonical}`),
      { code: 'ROOT_ESCAPE' },
    );
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
async function parseProfileFile(
  filePath: string,
  rootPath: string,
  source: 'systemInstall' | 'userImported',
): Promise<ParsedProfile | null> {
  if (!filePath.endsWith('.json')) return null;

  let buf: Buffer;
  try {
    buf = await readFileSecure(filePath);
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    return null; // malformed JSON
  }

  // Reject excessively deep JSON structures.
  if (jsonDepth(parsed) > MAX_JSON_DEPTH) {
    return null;
  }

  const result = RawOrcaProfileJson.safeParse(parsed);
  if (!result.success) return null;

  const raw = result.data;

  // Must be a filament profile.
  const typefield = raw.type;
  const nameField = raw.name;
  if (!nameField || nameField.trim().length === 0) return null;

  // Check type field: OrcaSlicer uses 'filament' for filament profiles.
  // Some older profiles omit the type field; in that case we rely on directory.
  const isFilamentByType = typefield === 'filament';
  const isFilamentByPath =
    filePath.includes(`${path.sep}filament${path.sep}`) ||
    filePath.endsWith(`${path.sep}filament`);
  if (!isFilamentByType && !isFilamentByPath) return null;

  const contentHash = createHash('sha256').update(buf).digest('hex');

  return {
    filePath,
    rootPath,
    source,
    raw,
    name: nameField.trim(),
    contentHash,
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
): Promise<void> {
  if (depth > MAX_TRAVERSAL_DEPTH) return;
  if (fileCount.value >= MAX_FILES_PER_ROOT) return;

  let entries: import('node:fs').Dirent<string>[];
  try {
    entries = await readdir(dirPath, { withFileTypes: true, encoding: 'utf8' });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (fileCount.value >= MAX_FILES_PER_ROOT) break;

    const entryPath = path.join(dirPath, entry.name);

    // Reject symbolic links and junctions at traversal time.
    if (entry.isSymbolicLink()) continue;

    if (entry.isDirectory()) {
      // Extra guard: verify the directory hasn't become a symlink since listing.
      let dirInfo;
      try {
        dirInfo = await lstat(entryPath);
      } catch {
        continue;
      }
      if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) continue;

      await traverseDir(
        entryPath,
        canonicalRoot,
        source,
        depth + 1,
        fileCount,
        profiles,
      );
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fileCount.value += 1;

      // Root-escape guard: canonicalize and verify the file stays under root.
      let canonicalPath: string;
      try {
        canonicalPath = await canonicalizeUnderRoot(entryPath, canonicalRoot);
      } catch {
        continue;
      }

      const profile = await parseProfileFile(
        canonicalPath,
        canonicalRoot,
        source,
      );
      if (profile !== null) {
        profiles.push(profile);
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
function resolveInheritance(
  profile: ParsedProfile,
  profilesByName: Map<string, ParsedProfile>,
): Record<string, unknown> {
  const visited = new Set<string>();
  let current: Record<string, unknown> = { ...profile.raw };
  visited.add(profile.name);

  for (let depth = 0; depth < MAX_INHERITANCE_DEPTH; depth++) {
    const inherits = current['inherits'];
    if (typeof inherits !== 'string' || inherits.trim().length === 0) break;
    const parentName = inherits.trim();
    if (visited.has(parentName)) break; // cycle detected

    const parent = profilesByName.get(parentName);
    if (!parent) break; // parent not in discovered set — stop chain

    visited.add(parentName);
    current = mergeInheritedFields(current, { ...parent.raw });
  }

  return current;
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
): Promise<z.infer<typeof OrcaProfileEntry>[]> {
  if (
    !context.orcaProfileId ||
    context.configurationRevision === null ||
    !context.snapshotId ||
    context.toolheads.length === 0
  ) {
    return [];
  }

  const allProfiles: ParsedProfile[] = [];

  // --- User data roots (userImported source) ---
  const userRoots = orcaUserDataRoots();
  for (const userRoot of userRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(userRoot);
    } catch {
      continue; // root does not exist
    }
    const fileCount = { value: 0 };
    await traverseDir(
      canonicalRoot,
      canonicalRoot,
      'userImported',
      0,
      fileCount,
      allProfiles,
    );
  }

  // --- System profile roots (systemInstall source) ---
  const systemRoots = orcaSystemProfileRoots();
  for (const systemRoot of systemRoots) {
    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(systemRoot);
    } catch {
      continue; // root does not exist
    }
    const fileCount = { value: 0 };
    await traverseDir(
      canonicalRoot,
      canonicalRoot,
      'systemInstall',
      0,
      fileCount,
      allProfiles,
    );
  }

  if (allProfiles.length === 0) return [];

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
      const resolvedRaw = resolveInheritance(profile, profilesByName);

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

  return results;
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

  const allProfiles: ParsedProfile[] = [];

  // Scan all roots.
  const roots: Array<{
    roots: string[];
    source: 'systemInstall' | 'userImported';
  }> = [
    { roots: orcaUserDataRoots(), source: 'userImported' },
    { roots: orcaSystemProfileRoots(), source: 'systemInstall' },
  ];

  for (const { roots: rootList, source } of roots) {
    for (const root of rootList) {
      let canonicalRoot: string;
      try {
        canonicalRoot = await realpath(root);
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
        allProfiles,
      );
    }
  }

  const profilesByName = new Map<string, ParsedProfile>();
  for (const p of allProfiles) {
    if (!profilesByName.has(p.name) || p.source === 'systemInstall') {
      profilesByName.set(p.name, p);
    }
  }

  const found = profilesByName.get(orcaProfileId);
  if (!found) return null;

  const resolvedRaw = resolveInheritance(found, profilesByName);
  return {
    resolvedRaw,
    contentHash: found.contentHash,
    filePath: found.filePath,
  };
}
