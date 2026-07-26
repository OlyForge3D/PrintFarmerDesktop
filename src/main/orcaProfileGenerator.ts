/**
 * OrcaSlicer filament profile generator (issue #55).
 *
 * Applies calibrated patch entries from completed calibration observations to a
 * resolved base OrcaSlicer filament profile JSON, producing a deterministic,
 * canonical JSON representation and a SHA-256 content identity.
 *
 * Design constraints:
 * - Only fields explicitly supported by the calibration workflow are patched;
 *   all other fields (including unknown ones) are preserved verbatim.
 * - Serialization is canonical (sorted keys, no extra whitespace) and
 *   deterministic: identical semantic input always produces the same bytes.
 * - The generated profile identity (name, filename) is collision-safe and
 *   embeds the project and snapshot scope.
 * - No renderer-supplied path, name, or JSON is accepted; all inputs come
 *   from main-process–controlled calibration workspace state.
 *
 * Independently authored. Not derived from any approved third-party source.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Supported calibrated fields
// ---------------------------------------------------------------------------

/**
 * Fields that the calibration workflow is allowed to patch.
 * Only these keys may appear in a generated profile's diff from its base.
 * All other base fields pass through unchanged.
 */
export const SUPPORTED_CALIBRATION_FIELDS = [
  'nozzle_temperature',
  'filament_flow_ratio',
  'enable_pressure_advance',
  'pressure_advance',
  'filament_retraction_length',
  'filament_retraction_speed',
  'filament_max_volumetric_speed',
  'filament_shrink',
  'filament_shrinkage_compensation_z',
] as const;

export type SupportedCalibrationField =
  (typeof SUPPORTED_CALIBRATION_FIELDS)[number];

// ---------------------------------------------------------------------------
// Patch entry type
// ---------------------------------------------------------------------------

/**
 * A single field-level calibration patch entry. The key must be one of the
 * supported calibration fields. Values are typed as they appear in OrcaSlicer
 * profile JSON.
 */
export const OrcaPatchEntry = z
  .object({
    key: z.enum(SUPPORTED_CALIBRATION_FIELDS),
    /**
     * The patched value in OrcaSlicer's preferred format. For array fields
     * this is an array of string representations; for scalar fields this is a
     * string or number. The generator validates the type before writing.
     */
    value: z.union([
      z.string().max(256),
      z.number().finite(),
      z.array(z.union([z.string().max(256), z.number().finite()])).max(16),
    ]),
    /** Source stage for provenance (informational only, not written to file). */
    sourceStageId: z.string().max(64),
    /** Source attempt UUID for provenance. */
    sourceAttemptId: z.string().max(128),
    /** Source observation UUID for provenance. */
    sourceObservationId: z.string().max(128),
  })
  .strict();
export type OrcaPatchEntry = z.infer<typeof OrcaPatchEntry>;

// ---------------------------------------------------------------------------
// Value formatters (OrcaSlicer stores most numerics as string arrays)
// ---------------------------------------------------------------------------

/**
 * Format a numeric value as an OrcaSlicer-style array of string(s).
 * Most OrcaSlicer array fields have one element per extruder; for a single
 * toolhead setup we always produce a one-element array.
 */
function formatAsStringArray(value: number | string): string[] {
  const str = typeof value === 'number' ? String(value) : value;
  return [str];
}

/**
 * Format a boolean enable flag as OrcaSlicer style (0/1 strings).
 */
function formatBooleanArray(value: number | string | boolean): string[] {
  const num = typeof value === 'boolean' ? (value ? 1 : 0) : Number(value);
  return [String(Number.isFinite(num) ? (num !== 0 ? 1 : 0) : 0)];
}

// ---------------------------------------------------------------------------
// Patch application
// ---------------------------------------------------------------------------

/**
 * Apply a list of patch entries to a resolved base profile JSON object.
 * Returns the patched JSON object (a new object; base is not mutated).
 * Only supported calibration fields are written; all other fields pass through.
 */
export function applyPatchEntries(
  baseRaw: Record<string, unknown>,
  entries: readonly OrcaPatchEntry[],
): {
  patched: Record<string, unknown>;
  appliedCount: number;
  warnings: string[];
} {
  const patched: Record<string, unknown> = { ...baseRaw };
  const warnings: string[] = [];
  let appliedCount = 0;

  // Deduplicate: last entry for each key wins (consistent with reducer ordering).
  const byKey = new Map<SupportedCalibrationField, OrcaPatchEntry>();
  for (const entry of entries) {
    byKey.set(entry.key, entry);
  }

  for (const [key, entry] of byKey) {
    const raw = entry.value;

    switch (key) {
      case 'nozzle_temperature': {
        // OrcaSlicer stores nozzle_temperature as an array of string numbers.
        // Calibration provides a single temperature value (first-layer temp).
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal <= 0 || numVal > 500) {
          warnings.push(
            `nozzle_temperature value ${String(raw)} is out of range [0, 500]; skipped.`,
          );
          break;
        }
        const existing = patched['nozzle_temperature'];
        if (Array.isArray(existing) && existing.length > 1) {
          // Preserve existing other-layer values; update first-layer only.
          patched['nozzle_temperature'] = [
            String(numVal),
            ...existing.slice(1).map(String),
          ];
        } else {
          patched['nozzle_temperature'] = [String(numVal), String(numVal)];
        }
        appliedCount += 1;
        break;
      }

      case 'filament_flow_ratio': {
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal <= 0 || numVal > 2) {
          warnings.push(
            `filament_flow_ratio value ${String(raw)} is out of range (0, 2]; skipped.`,
          );
          break;
        }
        patched['filament_flow_ratio'] = formatAsStringArray(numVal);
        appliedCount += 1;
        break;
      }

      case 'enable_pressure_advance': {
        const enable =
          typeof raw === 'number'
            ? raw !== 0
            : typeof raw === 'string'
              ? raw !== '0' && raw !== 'false'
              : Boolean(raw);
        patched['enable_pressure_advance'] = formatBooleanArray(enable);
        appliedCount += 1;
        break;
      }

      case 'pressure_advance': {
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal < 0 || numVal > 2) {
          warnings.push(
            `pressure_advance value ${String(raw)} is out of range [0, 2]; skipped.`,
          );
          break;
        }
        patched['pressure_advance'] = formatAsStringArray(numVal);
        appliedCount += 1;
        break;
      }

      case 'filament_retraction_length': {
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal < 0 || numVal > 30) {
          warnings.push(
            `filament_retraction_length value ${String(raw)} is out of range [0, 30]; skipped.`,
          );
          break;
        }
        patched['filament_retraction_length'] = formatAsStringArray(numVal);
        appliedCount += 1;
        break;
      }

      case 'filament_retraction_speed': {
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal <= 0 || numVal > 300) {
          warnings.push(
            `filament_retraction_speed value ${String(raw)} is out of range (0, 300]; skipped.`,
          );
          break;
        }
        patched['filament_retraction_speed'] = formatAsStringArray(numVal);
        appliedCount += 1;
        break;
      }

      case 'filament_max_volumetric_speed': {
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal <= 0 || numVal > 200) {
          warnings.push(
            `filament_max_volumetric_speed value ${String(raw)} is out of range (0, 200]; skipped.`,
          );
          break;
        }
        patched['filament_max_volumetric_speed'] = formatAsStringArray(numVal);
        appliedCount += 1;
        break;
      }

      case 'filament_shrink': {
        // filament_shrink is an array with two values: [x_percent, y_percent].
        if (Array.isArray(raw) && raw.length >= 2) {
          const xVal = parseFloat(String(raw[0]));
          const yVal = parseFloat(String(raw[1]));
          if (
            !Number.isFinite(xVal) ||
            xVal < 50 ||
            xVal > 200 ||
            !Number.isFinite(yVal) ||
            yVal < 50 ||
            yVal > 200
          ) {
            warnings.push(
              `filament_shrink values [${String(raw[0])}, ${String(raw[1])}] are out of range [50, 200]; skipped.`,
            );
            break;
          }
          patched['filament_shrink'] = [String(xVal) + '%', String(yVal) + '%'];
          appliedCount += 1;
        } else {
          const numVal =
            typeof raw === 'number' ? raw : parseFloat(String(raw));
          if (!Number.isFinite(numVal) || numVal < 50 || numVal > 200) {
            warnings.push(
              `filament_shrink value ${String(raw)} is out of range [50, 200]; skipped.`,
            );
            break;
          }
          patched['filament_shrink'] = [
            String(numVal) + '%',
            String(numVal) + '%',
          ];
          appliedCount += 1;
        }
        break;
      }

      case 'filament_shrinkage_compensation_z': {
        const numVal = typeof raw === 'number' ? raw : parseFloat(String(raw));
        if (!Number.isFinite(numVal) || numVal < 50 || numVal > 200) {
          warnings.push(
            `filament_shrinkage_compensation_z value ${String(raw)} is out of range [50, 200]; skipped.`,
          );
          break;
        }
        patched['filament_shrinkage_compensation_z'] =
          formatAsStringArray(numVal);
        appliedCount += 1;
        break;
      }

      default: {
        // TypeScript narrows this to never; ensures exhaustive handling.
        const _exhaustive: never = key;
        void _exhaustive;
        warnings.push(`Unsupported patch field ${String(key)}; skipped.`);
      }
    }
  }

  return { patched, appliedCount, warnings };
}

// ---------------------------------------------------------------------------
// Canonical JSON serialization
// ---------------------------------------------------------------------------

/**
 * Serialize `value` to canonical JSON: object keys are sorted recursively,
 * arrays are preserved in order. Produces deterministic bytes for identical
 * semantic content.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sortedKeys = Object.keys(record).sort();
    const pairs = sortedKeys.map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`,
    );
    return `{${pairs.join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Collision-safe identity generation
// ---------------------------------------------------------------------------

/**
 * Generate a collision-safe OrcaSlicer profile name and a safe filename for
 * the generated profile. The identity encodes the source project and snapshot
 * to guarantee uniqueness across concurrent or replayed generations.
 *
 * Format: "<baseName> [PFD-<shortHash>]"
 * Where shortHash is the first 8 hex chars of SHA-256(projectId|snapshotId).
 */
export function generateProfileIdentity(
  baseOrcaProfileId: string,
  projectId: string,
  snapshotId: string,
): { displayName: string; safeFilename: string } {
  const scopeHash = createHash('sha256')
    .update(`${projectId}\x00${snapshotId}`)
    .digest('hex')
    .slice(0, 8);

  // Strip trailing @<nozzle> suffix from base name for a cleaner generated name.
  const baseName = baseOrcaProfileId
    .replace(/@\s*\d+(?:\.\d+)?\s*(?:mm\s*)?nozzle\s*$/i, '')
    .trim();

  const displayName = `${baseName} [PFD-${scopeHash}]`;

  // Build a filesystem-safe filename: replace path separators and control chars.
  const safeName = displayName
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 192); // Leave room for .json suffix (total 200 chars max)

  const safeFilename = `${safeName}.json`;
  return { displayName, safeFilename };
}

// ---------------------------------------------------------------------------
// Complete generation result
// ---------------------------------------------------------------------------

export interface OrcaProfileGenerationResult {
  /** Canonical JSON string of the generated profile. */
  readonly generatedJson: string;
  /** SHA-256 of generatedJson (content identity). */
  readonly profileJsonHash: string;
  /** Display name for the generated profile. */
  readonly displayName: string;
  /** Safe filename (no path separators, .json suffix). */
  readonly safeFilename: string;
  /** Number of patch fields successfully applied. */
  readonly patchedFieldCount: number;
  /** Non-blocking warnings. */
  readonly warnings: string[];
}

/**
 * Generate a calibrated OrcaSlicer filament profile.
 *
 * Takes the resolved base profile JSON, applies calibration patch entries,
 * injects the generated identity (name, type), and produces a deterministic
 * canonical JSON representation.
 *
 * The generated profile:
 * - Inherits all base fields verbatim (including unknown/unowned fields).
 * - Overrides only the calibrated fields with validated values.
 * - Has a collision-safe `name` different from the base to avoid overwriting it.
 * - Has `inherits` set to the base profile name for OrcaSlicer lineage.
 * - Is serialized canonically for deterministic SHA-256 identity.
 */
export function generateOrcaProfile(
  baseRaw: Record<string, unknown>,
  patchEntries: readonly OrcaPatchEntry[],
  projectId: string,
  snapshotId: string,
): OrcaProfileGenerationResult {
  const baseName =
    typeof baseRaw['name'] === 'string' ? baseRaw['name'] : 'Unknown Profile';

  const { displayName, safeFilename } = generateProfileIdentity(
    baseName,
    projectId,
    snapshotId,
  );

  // Apply patch.
  const { patched, appliedCount, warnings } = applyPatchEntries(
    baseRaw,
    patchEntries,
  );

  // Override identity fields.
  patched['name'] = displayName;
  // Set inherits to the base profile for OrcaSlicer lineage traceability.
  patched['inherits'] = baseName;
  // Ensure type is set for OrcaSlicer to recognize this as a filament profile.
  if (!patched['type']) {
    patched['type'] = 'filament';
  }

  // Serialize to canonical JSON.
  const generatedJson = canonicalJson(patched);
  const profileJsonHash = createHash('sha256')
    .update(generatedJson)
    .digest('hex');

  return {
    generatedJson,
    profileJsonHash,
    displayName,
    safeFilename,
    patchedFieldCount: appliedCount,
    warnings,
  };
}
