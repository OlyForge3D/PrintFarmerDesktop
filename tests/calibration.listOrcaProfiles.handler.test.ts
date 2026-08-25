// @vitest-environment node

/**
 * Placeholder: the selected-printer Orca profile resolution surface this file
 * originally exercised depended on `GET /api/printers/calibration-candidates`
 * and `GET /api/printers/{id}/calibration-context` — both retired by
 * `OlyForge3D/PrintFarmer#1943`. The pre-Path-D orchestration (list
 * preliminarily, read one context, resolve one exact triple) can no longer be
 * driven end-to-end through the desktop handler under the surviving server
 * surface. Legitimate concerns the earlier file guarded — bounded truncation
 * evidence retention, selected-context parse failure surfacing,
 * malformed-candidate accounting — will need to be re-expressed against the
 * server-orchestrated wizard when it lands.
 */

import { describe, expect, it } from 'vitest';

describe.skip('CalibrationListOrcaProfiles selected-only resolution (Path D: routes retired)', () => {
  it('kept as skipped intent — see file header for context', () => {
    expect(true).toBe(true);
  });
});
