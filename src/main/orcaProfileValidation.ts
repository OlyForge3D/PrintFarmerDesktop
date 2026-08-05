import { z } from 'zod';
import {
  findDuplicateJsonObjectKey,
  findUnsafeJsonNumber,
  isPathShapedIdentifier,
  measureJsonDepth,
} from './untrustedJson.js';

export const ORCA_PROFILE_MAX_BYTES = 1_048_576;
export const ORCA_PROFILE_MAX_JSON_DEPTH = 32;

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

export type OrcaProfileContentRejectionCode =
  | 'duplicateKey'
  | 'invalidJson'
  | 'invalidSchema'
  | 'tooDeep'
  | 'tooLarge'
  | 'unsafeInheritance'
  | 'unsafeNumber';

export type OrcaProfileContentResult =
  | { readonly status: 'ok'; readonly raw: RawOrcaProfileJson }
  | {
      readonly status: 'rejected';
      readonly code: OrcaProfileContentRejectionCode;
      readonly detail: string;
    };

export function validateOrcaProfileJson(
  jsonText: string,
): OrcaProfileContentResult {
  if (Buffer.byteLength(jsonText, 'utf8') > ORCA_PROFILE_MAX_BYTES) {
    return {
      status: 'rejected',
      code: 'tooLarge',
      detail: `Profile exceeds ${ORCA_PROFILE_MAX_BYTES} bytes.`,
    };
  }

  const duplicateKey = findDuplicateJsonObjectKey(jsonText);
  if (duplicateKey !== null) {
    return {
      status: 'rejected',
      code: 'duplicateKey',
      detail: `Profile contains duplicate object key "${duplicateKey}".`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText) as unknown;
  } catch {
    return {
      status: 'rejected',
      code: 'invalidJson',
      detail: 'Profile is not valid JSON.',
    };
  }

  const depth = measureJsonDepth(parsed, ORCA_PROFILE_MAX_JSON_DEPTH);
  if (depth > ORCA_PROFILE_MAX_JSON_DEPTH) {
    return {
      status: 'rejected',
      code: 'tooDeep',
      detail: `Profile depth ${depth} exceeds ${ORCA_PROFILE_MAX_JSON_DEPTH}.`,
    };
  }

  const unsafeNumber = findUnsafeJsonNumber(parsed);
  if (unsafeNumber !== null) {
    return {
      status: 'rejected',
      code: 'unsafeNumber',
      detail: `Profile contains ${unsafeNumber.reason} number at ${unsafeNumber.path}.`,
    };
  }

  const result = RawOrcaProfileJson.safeParse(parsed);
  if (!result.success) {
    return {
      status: 'rejected',
      code: 'invalidSchema',
      detail: result.error.issues[0]?.message ?? 'Profile schema is invalid.',
    };
  }

  if (
    typeof result.data.inherits === 'string' &&
    isPathShapedIdentifier(result.data.inherits.trim())
  ) {
    return {
      status: 'rejected',
      code: 'unsafeInheritance',
      detail: 'Profile inheritance must be a profile name, not a path.',
    };
  }

  return { status: 'ok', raw: result.data };
}
