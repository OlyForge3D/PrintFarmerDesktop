// @vitest-environment node

/**
 * #493 — "capability flags are truthful in monolith and split deployments"
 * is the last undischarged clause of #42's Definition of Done. It has no
 * child issue and no test. This file is that pinning suite for the property,
 * not just the parsing of one fixture — the deliverable per the issue is the
 * property (PrintFarmer API integration truthfulness).
 *
 * SCOPE. Confirming this against a *live* PrintFarmer server actually
 * deployed in both a monolith and a split topology needs infrastructure no
 * agent session has, and is explicitly out of scope per the issue (a #42
 * close-condition for a human with both deployments). What this file proves
 * instead: given response *shapes* representative of each topology — a
 * split deployment is one where a capability's backing field can be
 * unreachable, unrouted or unauthorised while the flag would otherwise
 * appear enabled — the desktop client reports each flag truthfully, never
 * defaulting a silent field to "available".
 *
 * AC1 (enumeration from production, not hand-listed): `FLAG_NAMES` below is
 * `Object.keys(CALIBRATION_FLAG_SOURCES)`, imported from
 * `calibrationWire.ts`. If production adds a flag to that map, this suite
 * picks it up automatically through the `it.each` loops — nothing here
 * needs editing. The vacuous-pass guard proves the loops are not silently
 * empty.
 *
 * AC2 (per-flag fixture pair): for every flag, a monolith fixture (all
 * backing fields `true`) and a split-shaped fixture with only that flag's
 * backing field forced to `false` (simulating that capability being
 * unreachable in a split deployment while everything else stays intact).
 *
 * AC3 (negative control): one fixture with ALL backing fields `true` but
 * shaped like a split deployment (`deploymentMode: 'split'`) asserts every
 * flag reports available. Without this, a client that always reports
 * unavailable would wrongly pass AC2.
 *
 * AC4 (unknown vs false): for every flag, a fixture pair where the backing
 * field is explicitly `false` vs. entirely absent from the response body.
 * `flagAdvertisement` must read `'false'` for the former and `'unknown'` for
 * the latter — provably different values, not the same falsy result — while
 * `flags` (the fail-closed gate) stays `false` in both, so nothing here
 * weakens the existing fail-closed behaviour.
 *
 * AC5 (mutation proof): every assertion added by this file was manually
 * confirmed to fail when the guard it covers was deleted from
 * `calibrationWire.ts`; see the comments beside each `it.each` block for the
 * measured result, following this repo's `packaging.fuses.test.ts`
 * convention rather than adding a generic mutation-harness dependency.
 */

import { describe, expect, it } from 'vitest';
import {
  CALIBRATION_FLAG_SOURCES,
  RemoteCalibrationCapabilities,
  type CalibrationFlagName,
} from '../src/main/calibrationWire.js';
import { printFarmerCapabilitiesResponse } from './fixtures/printFarmerCapabilities.js';

// AC1: read the flag set from production, not from a list maintained here.
const FLAG_NAMES = Object.keys(
  CALIBRATION_FLAG_SOURCES,
) as CalibrationFlagName[];

function parse(
  overrides: Record<string, unknown> = {},
): ReturnType<typeof RemoteCalibrationCapabilities.parse> {
  return RemoteCalibrationCapabilities.parse(
    printFarmerCapabilitiesResponse(overrides),
  );
}

describe('capability flags are truthful in split deployment (#493)', () => {
  it('enumerates at least one flag from production (vacuity guard)', () => {
    // A `FLAG_NAMES.length === 0` would make every `it.each` below register
    // zero tests and the whole file would exit green having asserted
    // nothing — the same defect the issue calls out for a checker that
    // passes on an empty corpus. Measured: emptying
    // `CALIBRATION_FLAG_SOURCES` in calibrationWire.ts drops every `it.each`
    // test in this file to zero registered cases; only this assertion
    // catches that, because an `it.each([])` loop simply registers nothing
    // and reports no failure.
    expect(FLAG_NAMES.length).toBeGreaterThan(0);
    expect(new Set(FLAG_NAMES).size).toBe(FLAG_NAMES.length);
  });

  describe.each(FLAG_NAMES)('flag %s', (flag) => {
    const sourceField = CALIBRATION_FLAG_SOURCES[flag];

    // AC2 — per-flag fixture pair. Measured: replacing
    // `flags[flagName] = raw === true;` in calibrationWire.ts with
    // `flags[flagName] = true;` (a stuck-on guard) turns every
    // "unreachable in split deployment" row below RED while the monolith
    // row stays green, which is exactly the failure this pair exists to
    // catch — a flag that reports available when its capability is not.
    it(`reports available in a monolith-shaped response`, () => {
      const caps = parse({ deploymentMode: 'monolith' });
      expect(caps.flags[flag]).toBe(true);
    });

    it(`reports unavailable when unreachable in a split-shaped response`, () => {
      const caps = parse({
        deploymentMode: 'split',
        [sourceField]: false,
      });
      expect(caps.flags[flag]).toBe(false);
    });
  });

  // AC3 — negative control, in the same run as AC2's split-unavailable
  // assertions above. Measured: a client hard-coded to report every flag
  // unavailable makes every AC2 "unreachable" row pass while this block
  // alone goes RED for every flag — proving the suite is not one-sided.
  it('reports every flag available in a split-shaped response where all capabilities are reachable', () => {
    const caps = parse({ deploymentMode: 'split' });
    for (const flag of FLAG_NAMES) {
      expect(caps.flags[flag]).toBe(true);
    }
  });

  describe.each(FLAG_NAMES)('flag %s — unknown vs false (AC4)', (flag) => {
    const sourceField = CALIBRATION_FLAG_SOURCES[flag];

    // Measured: changing the `raw === undefined ? 'unknown' : ...` branch
    // in calibrationWire.ts to unconditionally return `'false'` (collapsing
    // absent into false, the pre-#493 behaviour) turns every "field is
    // absent" row below RED while the "field is explicitly false" row
    // stays green — proving these two rows are not redundant with each
    // other and that `flagAdvertisement` actually distinguishes them.
    it('reports false advertisement when the backing field is explicitly false', () => {
      const body = printFarmerCapabilitiesResponse({
        deploymentMode: 'split',
        [sourceField]: false,
      });
      const caps = RemoteCalibrationCapabilities.parse(body);
      expect(caps.flagAdvertisement[flag]).toBe('false');
      // The fail-closed gate stays false either way; this pair is about
      // `flagAdvertisement`, not about weakening `flags`.
      expect(caps.flags[flag]).toBe(false);
    });

    it('reports unknown advertisement when the backing field is absent, distinguishable from false', () => {
      const body = printFarmerCapabilitiesResponse({
        deploymentMode: 'split',
      });
      delete body[sourceField];
      const caps = RemoteCalibrationCapabilities.parse(body);
      expect(caps.flagAdvertisement[flag]).toBe('unknown');
      expect(caps.flagAdvertisement[flag]).not.toBe('false');
      expect(caps.flags[flag]).toBe(false);
    });
  });
});
