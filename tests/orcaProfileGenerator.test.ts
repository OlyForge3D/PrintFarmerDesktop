/**
 * Unit tests for `generateProfileIdentity` (issue #55; trimmed by #791).
 *
 * `generateOrcaProfile`, `applyPatchEntries`, `canonicalJson`,
 * `SUPPORTED_CALIBRATION_FIELDS` and the `OrcaPatchEntry` schema were deleted
 * as dead code in #791 — they had zero production callers. Only
 * `generateProfileIdentity` remains, retained because
 * `tests/calibrationMaliciousInputCorpus.test.ts` still exercises it as a
 * hostile-input source for `computeInstallPath`'s filename-safety guard. See
 * the docblock in `src/main/orcaProfileGenerator.ts` for the full rationale.
 */

import { describe, it, expect } from 'vitest';
import { generateProfileIdentity } from '../src/main/orcaProfileGenerator.js';

const PROJECT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-111111111111';
const SNAPSHOT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-222222222222';

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
