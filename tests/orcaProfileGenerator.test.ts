/**
 * Unit tests for the OrcaSlicer profile generator (issue #55).
 *
 * Covers: supported patch fields, deterministic canonical JSON, SHA-256 hash
 * stability, collision-safe identity, partial calibration, value validation,
 * unknown-field preservation, and array shape preservation.
 *
 * Independently authored test suite.
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  generateOrcaProfile,
  applyPatchEntries,
  canonicalJson,
  generateProfileIdentity,
  SUPPORTED_CALIBRATION_FIELDS,
  type OrcaPatchEntry,
} from '../src/main/orcaProfileGenerator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_PROFILE: Record<string, unknown> = {
  name: 'Generic PLA @0.4 nozzle',
  type: 'filament',
  inherits: 'Generic PLA',
  nozzle_temperature: ['215', '210'],
  filament_flow_ratio: ['1.0'],
  enable_pressure_advance: ['0'],
  pressure_advance: ['0.02'],
  filament_retraction_length: ['0.5'],
  filament_max_volumetric_speed: ['12'],
  filament_shrink: ['100%', '100%'],
  filament_type: ['PLA'],
  // Unknown fields — must be preserved verbatim
  some_unknown_vendor_field: 'preserve_me',
  another_unknown: { nested: true, value: 42 },
};

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
const SNAPSHOT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-222222222222';

function patchEntry(
  key: OrcaPatchEntry['key'],
  value: OrcaPatchEntry['value'],
  stageId = 'temperature',
): OrcaPatchEntry {
  return {
    key,
    value,
    sourceStageId: stageId,
    sourceAttemptId: 'attempt-001',
    sourceObservationId: 'obs-001',
  };
}

// ---------------------------------------------------------------------------
// canonicalJson
// ---------------------------------------------------------------------------

describe('canonicalJson', () => {
  it('sorts object keys alphabetically', () => {
    const out = canonicalJson({ b: 1, a: 2, c: 3 });
    expect(out).toBe('{"a":2,"b":1,"c":3}');
  });

  it('preserves array order', () => {
    const out = canonicalJson(['z', 'a', 'm']);
    expect(out).toBe('["z","a","m"]');
  });

  it('handles nested objects recursively', () => {
    const out = canonicalJson({ z: { y: 1, x: 2 }, a: 3 });
    expect(out).toBe('{"a":3,"z":{"x":2,"y":1}}');
  });

  it('handles null values', () => {
    expect(canonicalJson(null)).toBe('null');
  });

  it('handles booleans', () => {
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(false)).toBe('false');
  });

  it('produces identical output for semantically identical input', () => {
    const a = canonicalJson({ name: 'foo', value: 42 });
    const b = canonicalJson({ value: 42, name: 'foo' });
    expect(a).toBe(b);
  });

  it('produces deterministic SHA-256 for identical content', () => {
    const content = canonicalJson(BASE_PROFILE);
    const hash1 = createHash('sha256').update(content).digest('hex');
    const hash2 = createHash('sha256').update(content).digest('hex');
    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// generateProfileIdentity
// ---------------------------------------------------------------------------

describe('generateProfileIdentity', () => {
  it('produces a display name with [PFD-<hash>] suffix', () => {
    const { displayName } = generateProfileIdentity(
      'Generic PLA @0.4 nozzle',
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    expect(displayName).toContain('[PFD-');
    expect(displayName).toMatch(/\[PFD-[a-f0-9]{8}\]/);
  });

  it('strips the nozzle suffix from the base name', () => {
    const { displayName } = generateProfileIdentity(
      'Generic PLA @0.4 nozzle',
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    // "@0.4 nozzle" should be stripped from the display name
    expect(displayName).not.toContain('@0.4 nozzle');
    expect(displayName).toContain('Generic PLA');
  });

  it('produces a safe filename with .json suffix and no path separators', () => {
    const { safeFilename } = generateProfileIdentity(
      'Generic PLA @0.4 nozzle',
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    expect(safeFilename).toMatch(/\.json$/);
    expect(safeFilename).not.toContain('/');
    expect(safeFilename).not.toContain('\\');
    expect(safeFilename.length).toBeLessThanOrEqual(200);
  });

  it('is deterministic for same inputs', () => {
    const a = generateProfileIdentity('Base Profile', PROJECT_ID, SNAPSHOT_ID);
    const b = generateProfileIdentity('Base Profile', PROJECT_ID, SNAPSHOT_ID);
    expect(a.displayName).toBe(b.displayName);
    expect(a.safeFilename).toBe(b.safeFilename);
  });

  it('produces collision-safe names for different projects', () => {
    const a = generateProfileIdentity('Base Profile', PROJECT_ID, SNAPSHOT_ID);
    const b = generateProfileIdentity(
      'Base Profile',
      'cccccccc-cccc-4ccc-8ccc-333333333333',
      SNAPSHOT_ID,
    );
    expect(a.displayName).not.toBe(b.displayName);
    expect(a.safeFilename).not.toBe(b.safeFilename);
  });
});

// ---------------------------------------------------------------------------
// applyPatchEntries
// ---------------------------------------------------------------------------

describe('applyPatchEntries', () => {
  it('applies nozzle_temperature as first-layer update preserving other layers', () => {
    const base = { ...BASE_PROFILE, nozzle_temperature: ['215', '210', '205'] };
    const { patched } = applyPatchEntries(base, [
      patchEntry('nozzle_temperature', 220, 'temperature'),
    ]);
    expect(patched['nozzle_temperature']).toEqual(['220', '210', '205']);
  });

  it('creates two-element array when base has one element', () => {
    const base = { ...BASE_PROFILE, nozzle_temperature: ['215'] };
    const { patched } = applyPatchEntries(base, [
      patchEntry('nozzle_temperature', 220),
    ]);
    expect(patched['nozzle_temperature']).toEqual(['220', '220']);
  });

  it('rejects nozzle_temperature out of range', () => {
    const { patched, warnings } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('nozzle_temperature', 600),
    ]);
    expect(warnings.some((w) => w.includes('nozzle_temperature'))).toBe(true);
    // Base value unchanged
    expect(patched['nozzle_temperature']).toEqual(
      BASE_PROFILE.nozzle_temperature,
    );
  });

  it('applies filament_flow_ratio as string array', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_flow_ratio', 0.95, 'flowPass2'),
    ]);
    expect(patched['filament_flow_ratio']).toEqual(['0.95']);
  });

  it('rejects flow ratio outside (0, 2]', () => {
    const { warnings } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_flow_ratio', 3.0),
    ]);
    expect(warnings.some((w) => w.includes('filament_flow_ratio'))).toBe(true);
  });

  it('applies enable_pressure_advance as 0/1 string array from number', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('enable_pressure_advance', 1),
    ]);
    expect(patched['enable_pressure_advance']).toEqual(['1']);
  });

  it('applies enable_pressure_advance from boolean-like 0', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('enable_pressure_advance', 0),
    ]);
    expect(patched['enable_pressure_advance']).toEqual(['0']);
  });

  it('applies pressure_advance as string array', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('pressure_advance', 0.05, 'pressureAdvance'),
    ]);
    expect(patched['pressure_advance']).toEqual(['0.05']);
  });

  it('rejects pressure_advance outside [0, 2]', () => {
    const { warnings } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('pressure_advance', -0.1),
    ]);
    expect(warnings.some((w) => w.includes('pressure_advance'))).toBe(true);
  });

  it('applies filament_retraction_length', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_retraction_length', 0.8, 'retraction'),
    ]);
    expect(patched['filament_retraction_length']).toEqual(['0.8']);
  });

  it('applies filament_max_volumetric_speed', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_max_volumetric_speed', 15, 'maximumVolumetricSpeed'),
    ]);
    expect(patched['filament_max_volumetric_speed']).toEqual(['15']);
  });

  it('applies filament_shrink as two-element array', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_shrink', [99.5, 98.8], 'shrinkage'),
    ]);
    expect(patched['filament_shrink']).toEqual(['99.5%', '98.8%']);
  });

  it('applies filament_shrink from scalar (same value for both axes)', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_shrink', 99.2),
    ]);
    expect(patched['filament_shrink']).toEqual(['99.2%', '99.2%']);
  });

  it('rejects filament_shrink out of [50, 200] range', () => {
    const { warnings } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_shrink', [200.1, 100]),
    ]);
    expect(warnings.some((w) => w.includes('filament_shrink'))).toBe(true);
  });

  it('applies filament_shrinkage_compensation_z', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_shrinkage_compensation_z', 100.5),
    ]);
    expect(patched['filament_shrinkage_compensation_z']).toEqual(['100.5']);
  });

  it('preserves unknown fields from base', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('nozzle_temperature', 220),
    ]);
    expect(patched['some_unknown_vendor_field']).toBe('preserve_me');
    expect(patched['another_unknown']).toEqual({ nested: true, value: 42 });
  });

  it('uses last entry for duplicate keys (consistent with reducer order)', () => {
    const { patched } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('filament_flow_ratio', 0.95),
      patchEntry('filament_flow_ratio', 1.02),
    ]);
    expect(patched['filament_flow_ratio']).toEqual(['1.02']);
  });

  it('returns appliedCount = number of successfully applied entries', () => {
    const { appliedCount } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('nozzle_temperature', 220),
      patchEntry('filament_flow_ratio', 0.98),
    ]);
    expect(appliedCount).toBe(2);
  });

  it('counts only successful entries (not rejected ones)', () => {
    const { appliedCount } = applyPatchEntries(BASE_PROFILE, [
      patchEntry('nozzle_temperature', 220), // valid
      patchEntry('filament_flow_ratio', 99.0), // out of range → skipped
    ]);
    expect(appliedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// generateOrcaProfile — full integration
// ---------------------------------------------------------------------------

describe('generateOrcaProfile', () => {
  it('produces deterministic output for identical inputs', () => {
    const entries: OrcaPatchEntry[] = [
      patchEntry('nozzle_temperature', 220),
      patchEntry('filament_flow_ratio', 0.98),
    ];
    const a = generateOrcaProfile(
      BASE_PROFILE,
      entries,
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    const b = generateOrcaProfile(
      BASE_PROFILE,
      entries,
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    expect(a.generatedJson).toBe(b.generatedJson);
    expect(a.profileJsonHash).toBe(b.profileJsonHash);
  });

  it('produces a valid SHA-256 hash', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    expect(result.profileJsonHash).toMatch(/^[a-f0-9]{64}$/);
    // Verify hash matches content
    const actualHash = createHash('sha256')
      .update(result.generatedJson)
      .digest('hex');
    expect(result.profileJsonHash).toBe(actualHash);
  });

  it('sets inherits to the base profile name', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    const parsed = JSON.parse(result.generatedJson) as Record<string, unknown>;
    expect(parsed['inherits']).toBe('Generic PLA @0.4 nozzle');
  });

  it('sets a unique display name different from the base name', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    const parsed = JSON.parse(result.generatedJson) as Record<string, unknown>;
    expect(parsed['name']).not.toBe('Generic PLA @0.4 nozzle');
    expect(parsed['name']).toBe(result.displayName);
  });

  it('preserves all base fields not in patch entries', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    const parsed = JSON.parse(result.generatedJson) as Record<string, unknown>;
    expect(parsed['filament_type']).toEqual(['PLA']);
    expect(parsed['some_unknown_vendor_field']).toBe('preserve_me');
    expect(parsed['another_unknown']).toEqual({ nested: true, value: 42 });
  });

  it('applies patches and records count', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [
        patchEntry('nozzle_temperature', 225),
        patchEntry('filament_flow_ratio', 1.05),
        patchEntry('pressure_advance', 0.04),
      ],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    expect(result.patchedFieldCount).toBe(3);
    const parsed = JSON.parse(result.generatedJson) as Record<string, unknown>;
    expect(parsed['nozzle_temperature']).toEqual(['225', '210']); // preserves other layers
    expect(parsed['filament_flow_ratio']).toEqual(['1.05']);
    expect(parsed['pressure_advance']).toEqual(['0.04']);
  });

  it('handles partial calibration (only some stages completed)', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [patchEntry('nozzle_temperature', 220)],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    // Only nozzle_temperature should change
    const parsed = JSON.parse(result.generatedJson) as Record<string, unknown>;
    expect(parsed['filament_flow_ratio']).toEqual(['1.0']); // unchanged from base
    expect(parsed['nozzle_temperature']).toEqual(['220', '210']);
    expect(result.patchedFieldCount).toBe(1);
  });

  it('produces valid parseable JSON', () => {
    const result = generateOrcaProfile(
      BASE_PROFILE,
      [
        patchEntry('nozzle_temperature', 220),
        patchEntry('filament_flow_ratio', 0.98),
        patchEntry('filament_shrink', [99.5, 98.5]),
      ],
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    // Must not throw
    const parsed: unknown = JSON.parse(result.generatedJson);
    expect(typeof parsed).toBe('object');
  });

  it('adds type: filament when missing from base', () => {
    const baseNoType = { name: 'Base Profile', filament_flow_ratio: ['1.0'] };
    const result = generateOrcaProfile(baseNoType, [], PROJECT_ID, SNAPSHOT_ID);
    const parsed = JSON.parse(result.generatedJson) as Record<string, unknown>;
    expect(parsed['type']).toBe('filament');
  });

  it('produces different output for different snapshot IDs', () => {
    const entries: OrcaPatchEntry[] = [patchEntry('nozzle_temperature', 220)];
    const a = generateOrcaProfile(
      BASE_PROFILE,
      entries,
      PROJECT_ID,
      SNAPSHOT_ID,
    );
    const b = generateOrcaProfile(
      BASE_PROFILE,
      entries,
      PROJECT_ID,
      'cccccccc-cccc-4ccc-8ccc-000000000000',
    );
    expect(a.generatedJson).not.toBe(b.generatedJson);
    expect(a.profileJsonHash).not.toBe(b.profileJsonHash);
  });

  it('lists all supported calibration fields', () => {
    // Verify the supported field list matches what applyPatchEntries handles.
    const expected = [
      'nozzle_temperature',
      'filament_flow_ratio',
      'enable_pressure_advance',
      'pressure_advance',
      'filament_retraction_length',
      'filament_retraction_speed',
      'filament_max_volumetric_speed',
      'filament_shrink',
      'filament_shrinkage_compensation_z',
    ];
    expect([...SUPPORTED_CALIBRATION_FIELDS]).toEqual(expected);
  });
});
