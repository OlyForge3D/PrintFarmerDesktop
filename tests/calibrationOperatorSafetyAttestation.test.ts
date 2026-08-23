/**
 * Proves that the operator's three physical-interlock confirmations —
 * emergency stop, thermal protection, ventilation — flow through the whole
 * chain end-to-end.
 *
 * # The defect this test exists to catch
 *
 * PrintFarmer's `CalibrationContextDto` publishes real machine limits (bed
 * volume, temperatures, max flow) but has no member for the three
 * interlock booleans, because the server has no way to know them. The wire
 * transform in `calibrationWire.ts` correctly emits `false` for all three as
 * an absent-evidence default. The wizard collects the operator's real
 * attestations in three checkboxes, then a defect in `bindingFromContext`
 * threw those attestations away — the binding carried the wire's `false`
 * triple straight through, so `bindingDiagnostics` failed with
 * `INCOMPLETE_SAFETY_CONTEXT` every time an operator clicked Create against
 * a real server.
 *
 * The fix wires the operator's confirmations through as a fifth argument to
 * `bindingFromContext`, treating the operator as the authoritative source
 * (they are: only a human standing next to the printer can attest to these).
 *
 * # What this test asserts
 *
 * Given a `CalibrationContextDto` shaped exactly as PrintFarmer serialises
 * one — with `safety.emergencyStopAvailable` etc. hardcoded to `false` by
 * the wire, as the real server produces — passed through the real Zod
 * transform and projected exactly as the renderer receives it:
 *
 * 1. **Positive:** with the operator's three confirmations supplied to
 *    `bindingFromContext`, `createCalibrationState` reports **zero**
 *    `INCOMPLETE_SAFETY_CONTEXT` diagnostics. This is the operator-visible
 *    outcome — the wizard's Create button does not blow up in the operator's
 *    face on real hardware.
 *
 * 2. **Matching-predicate control:** with the confirmations withheld, the
 *    same data yields exactly one `INCOMPLETE_SAFETY_CONTEXT` diagnostic —
 *    the current-code behaviour, and the sanity check the repo's
 *    "known-lying-commands" rule mandates: every positive predicate gets an
 *    opposite predicate on the same fixture, or the fixture is broken rather
 *    than the code being fixed.
 *
 * Both drive the SAME parsed context so the fixture is proven to produce
 * the intended state — a `context.safety` with the three booleans `false`,
 * which is what the wire actually emits. Existing calibration tests either
 * hand-set `emergencyStopAvailable: true` (which is the pattern that let
 * this defect land through three green PRs) or bypass the wire and
 * hand-build a binding directly. This test does neither.
 *
 * # Why this file is not scoped to the derived-source manifest
 *
 * It exercises orchestration and UI wiring (`bindingFromContext`,
 * `createCalibrationState`, the wire projection), which per the compliance
 * manifest at `compliance/printer-calibration-provenance.json` and
 * `docs/CONTRIBUTING.md` §Provenance stays outside the derived roots.
 */

import { describe, expect, it } from 'vitest';

import {
  projectCalibrationPrinterContext,
  RemoteCalibrationPrinterContext,
} from '../src/main/calibrationWire.js';
import { bindingFromContext } from '../src/renderer/calibration/projectEligibility.js';
import { createCalibrationState } from '../src/renderer/calibration/domain/reducer.js';
import type { CalibrationDiagnostic } from '../src/renderer/calibration/domain/types.js';
import { calibrationContextDto } from './fixtures/calibrationContract.js';
import {
  PROFILE_ID,
  TOOLHEAD_GUID,
} from './fixtures/calibrationWorkspacePayload.js';

const PROJECT_ID = '77777777-7777-4777-8777-777777777777';
const NOW = '2026-08-22T20:00:00.000Z';

const FILAMENT = {
  filamentProjectId: '88888888-8888-4888-8888-888888888888',
  provider: 'PrintFarmer',
  product: 'PLA',
  sku: 'PLA-BLACK',
} as const;

const BASELINE = {
  nozzleTemperatureC: 210,
  flowRatio: 1.0,
  pressureAdvance: 0.04,
  retractionLengthMm: 0.8,
  maximumVolumetricRateMm3S: 20,
  shrinkageCompensationXPercent: 0,
  shrinkageCompensationYPercent: 0,
  shrinkageCompensationZPercent: 0,
} as const;

function incompleteSafety(
  diagnostics: readonly CalibrationDiagnostic[],
): CalibrationDiagnostic[] {
  return diagnostics.filter(
    (diagnostic) => diagnostic.code === 'INCOMPLETE_SAFETY_CONTEXT',
  );
}

describe('operator safety confirmations flow through the wire → binding → domain chain', () => {
  // Parsed exactly as the renderer receives it: through the real Zod transform,
  // starting from a DTO shape that carries no safety block (as PrintFarmer's
  // does not) and letting the wire's hardcoded `false` triple stand.
  const remote = RemoteCalibrationPrinterContext.parse(calibrationContextDto());
  const context = projectCalibrationPrinterContext(remote);

  it('fixture control: the projected context carries safety with the three interlock booleans false', () => {
    // The load-bearing property of the fixture. If this ever changes the
    // positive test below stops proving anything, because the operator's
    // confirmations would be satisfying a check that was already satisfied by
    // the wire. Kept as its own assertion so a fixture drift surfaces here
    // rather than as a mysterious pass of both predicates below.
    expect(context.safety).not.toBeNull();
    expect(context.safety?.emergencyStopAvailable).toBe(false);
    expect(context.safety?.thermalProtectionConfirmed).toBe(false);
    expect(context.safety?.ventilationAssessed).toBe(false);
  });

  it('with operator confirmations supplied, createCalibrationState reports NO INCOMPLETE_SAFETY_CONTEXT diagnostic', () => {
    // The failing-before-fix path. Before this change, `bindingFromContext`
    // admitted no channel for the operator's confirmations; the binding
    // carried `context.safety` verbatim (all three booleans false), and
    // `createCalibrationState` reported `INCOMPLETE_SAFETY_CONTEXT`. This is
    // exactly the "huge error message on every printer" symptom the field
    // reported.
    const binding = bindingFromContext(
      PROFILE_ID,
      context,
      TOOLHEAD_GUID,
      FILAMENT,
      {
        emergencyStopAvailable: true,
        thermalProtectionConfirmed: true,
        ventilationAssessed: true,
      },
    );
    expect(binding).not.toBeNull();
    const state = createCalibrationState({
      projectId: PROJECT_ID,
      createdAt: NOW,
      mode: 'coach',
      baseline: BASELINE,
      // The `!` is safe because the assertion above is a hard `not.toBeNull`;
      // if the wiring regresses the assertion above fires first and this line
      // never runs.
      binding: binding!,
    });
    expect(
      incompleteSafety(state.diagnostics),
      'With the operator having attested to E-stop, thermal protection, and ' +
        'ventilation in the wizard, the binding must record those true values ' +
        'and INCOMPLETE_SAFETY_CONTEXT must not fire. If this fails the ' +
        'operator sees a wall of red on every real PrintFarmer printer.',
    ).toEqual([]);
  });

  it('control: with confirmations withheld, the same context yields exactly one INCOMPLETE_SAFETY_CONTEXT diagnostic', () => {
    // The matching-predicate control. This is the identical parsed context;
    // only the operator's answers change. If BOTH tests pass with the same
    // answers the fixture is broken, not the code fixed — the `.squad`
    // known-lying-commands rule made explicit.
    const binding = bindingFromContext(
      PROFILE_ID,
      context,
      TOOLHEAD_GUID,
      FILAMENT,
      {
        emergencyStopAvailable: false,
        thermalProtectionConfirmed: false,
        ventilationAssessed: false,
      },
    );
    expect(binding).not.toBeNull();
    const state = createCalibrationState({
      projectId: PROJECT_ID,
      createdAt: NOW,
      mode: 'coach',
      baseline: BASELINE,
      binding: binding!,
    });
    const diagnostics = incompleteSafety(state.diagnostics);
    expect(
      diagnostics,
      'With the operator refusing the interlock checks, the binding must ' +
        'record false values and INCOMPLETE_SAFETY_CONTEXT must fire. If ' +
        'this fails the safety semantics have been lost — no attestation is ' +
        'now sufficient to open the wizard.',
    ).toHaveLength(1);
    expect(diagnostics[0]?.field).toBe('safety');
  });
});
