/**
 * Direct unit coverage for `filterCustomFilamentsForMachine`
 * (`src/renderer/calibration/profileSelection.ts:71-79`).
 *
 * WHY THIS EXISTS
 *
 * Flagged by Hicks during #757 review (MED, non-blocking): the function has
 * one consumer (`ProfileSelectionSection.tsx:372`) and zero direct unit
 * tests. Indirect coverage through the wizard suites means a change to the
 * filter's semantics could pass CI as long as the caller still renders
 * *something* — the exact "test-green / user-wrong" gap this repo's
 * mutation-control convention exists to close. See #760.
 *
 * THE THREE ARMS (per Hicks' #757 follow-up ranking)
 *
 *  1. Matched-machine profile — `compatiblePrinters` includes the chosen
 *     machine name — IS returned.
 *  2. Mismatched profile — `compatiblePrinters` names only a different
 *     machine — is NOT returned.
 *  3. `compatiblePrinters === null` — the profile declared no compatible
 *     machines at all — is NOT returned. This is "the failure mode the
 *     docstring calls out": including everything by default when a profile
 *     is undeclared is the unsafe behaviour (owner directive 2026-08-22),
 *     unlike the *machine/process* filter's permissive `printerModelId: null`
 *     fallback (`profileSelection.ts:49-53`, covered separately by
 *     `tests/calibrationPrinterModelIdWiring.test.tsx`). Filament is the one
 *     category where a wrong pick is not caught by the slicer — it can
 *     produce a print-ruining mismatch — so the fail-safe default is
 *     exclusion, not inclusion.
 *
 * A fourth arm covers the "identity unknown" input case distinct from arm 3:
 * `chosenMachineName === ''` (no machine chosen yet) must return an empty
 * list outright, regardless of what any candidate profile declares — the
 * explicit early return at `profileSelection.ts:75`.
 *
 * MUTATION-CONTROL PROOF (per #760 verification requirement)
 *
 * Before finalizing, the implementation was temporarily mutated two ways and
 * the suite below was re-run against each mutant to confirm every test fails
 * in the expected direction (then the mutation was reverted — no mutation
 * ships in this diff):
 *
 *   MUTANT A — "return everything": the whole body (including the
 *     `chosenMachineName === ''` early return) replaced with
 *     `return profiles;`. Result: arm 2 (mismatch-excluded), arm 3
 *     (null-excluded), arm 4 (empty-name), and the paired test all failed,
 *     because nothing was filtered out regardless of input. Only arm 1
 *     (matched-included) still passed — trivially, since the matching
 *     profile is included either way — which is exactly why arm 1 alone
 *     cannot discriminate this mutant.
 *   MUTANT B — "return nothing": body replaced with `return [];`.
 *     Result: arm 1 (matched-included) and the paired test's matched-name
 *     assertion both failed, because the matching profile was dropped.
 *     Arms 2, 3, and 4 still passed by coincidence (an always-empty result
 *     trivially satisfies "excluded"/"empty"), which is exactly why arm 1
 *     is required — arms 2-4 alone cannot discriminate this mutant.
 *   MUTANT C — "first-element only": `.includes(chosenMachineName)`
 *     replaced with `[0] === chosenMachineName`. All fixtures now put the
 *     chosen/mismatched machine name at a NON-zero index of a multi-entry
 *     `compatiblePrinters` array specifically to catch this: with the
 *     original single-element fixtures this mutant passed every arm
 *     undetected (a real "test-green / implementation-wrong" gap caught in
 *     review). With the multi-entry fixtures, arm 1 and the paired test's
 *     matched-name assertion both failed, because the match was no longer
 *     at index 0.
 *
 * Every arm below is therefore load-bearing: no single arm passes against
 * any of the three mutants, but the full set fails at least one arm against
 * each.
 */

import { describe, expect, it } from 'vitest';
import type { CalibrationCustomProfileRef } from '@shared/ipc';
import { filterCustomFilamentsForMachine } from '../src/renderer/calibration/profileSelection';

function customFilament(
  overrides: Partial<CalibrationCustomProfileRef> & { id: string },
): CalibrationCustomProfileRef {
  return {
    id: overrides.id,
    name: overrides.name ?? `Custom filament ${overrides.id}`,
    profileType: 'filament',
    printerModelId: overrides.printerModelId ?? null,
    compatiblePrinters: overrides.compatiblePrinters ?? null,
    createdAt: overrides.createdAt ?? null,
  };
}

const CHOSEN_MACHINE = 'Bambu Lab X1 Carbon';
const OTHER_MACHINE = 'Prusa MK4';

describe('filterCustomFilamentsForMachine', () => {
  it('arm 1 (matched-included): a custom filament whose compatiblePrinters includes the chosen machine IS returned', () => {
    // The chosen machine is deliberately NOT at index 0 — a broken
    // implementation that checks only `compatiblePrinters[0]` (instead of
    // membership across the whole array) must fail this arm.
    const matched = customFilament({
      id: '11111111-1111-4111-8111-111111111111',
      compatiblePrinters: ['Elegoo Neptune 4', OTHER_MACHINE, CHOSEN_MACHINE],
    });

    const result = filterCustomFilamentsForMachine([matched], CHOSEN_MACHINE);

    expect(result).toEqual([matched]);
  });

  it('arm 2 (mismatch-excluded): a custom filament whose compatiblePrinters names only other machines is NOT returned', () => {
    const forOtherMachine = customFilament({
      id: '22222222-2222-4222-8222-222222222222',
      compatiblePrinters: ['Elegoo Neptune 4', OTHER_MACHINE],
    });

    const result = filterCustomFilamentsForMachine(
      [forOtherMachine],
      CHOSEN_MACHINE,
    );

    expect(result).toEqual([]);
  });

  it('arm 3 (null-excluded): a custom filament with compatiblePrinters === null is NOT returned — the failure mode the docstring calls out', () => {
    const undeclared = customFilament({
      id: '33333333-3333-4333-8333-333333333333',
      compatiblePrinters: null,
    });

    const result = filterCustomFilamentsForMachine(
      [undeclared],
      CHOSEN_MACHINE,
    );

    expect(result).toEqual([]);
  });

  it('arm 4 (identity-unknown): an empty chosenMachineName returns no custom filaments, even ones that would otherwise match', () => {
    const wouldOtherwiseMatch = customFilament({
      id: '44444444-4444-4444-8444-444444444444',
      compatiblePrinters: [OTHER_MACHINE, CHOSEN_MACHINE],
    });

    const result = filterCustomFilamentsForMachine([wouldOtherwiseMatch], '');

    expect(result).toEqual([]);
  });

  it('same candidate list, only chosenMachineName differs: matched name selects the profile, mismatched name does not', () => {
    const candidates: readonly CalibrationCustomProfileRef[] = [
      customFilament({
        id: '55555555-5555-4555-8555-555555555555',
        compatiblePrinters: ['Elegoo Neptune 4', CHOSEN_MACHINE],
      }),
    ];

    const matchedResult = filterCustomFilamentsForMachine(
      candidates,
      CHOSEN_MACHINE,
    );
    const mismatchedResult = filterCustomFilamentsForMachine(
      candidates,
      OTHER_MACHINE,
    );

    expect(matchedResult).toEqual(candidates);
    expect(mismatchedResult).toEqual([]);
  });
});
