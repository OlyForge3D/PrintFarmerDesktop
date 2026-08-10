import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { conflictResolutionsFor } from '../src/main/calibrationService.js';
import type { CalibrationConflictResolution } from '@shared/ipc';

/**
 * The per-kind resolution policy used to exist twice (issue #304): TypeScript
 * advertised it in a hard-coded table inside `conflictResolutionsFor`, Rust
 * enforced a second, independently-written table in
 * `CalibrationConflictKind::available_resolutions`. Nothing failed when they
 * diverged, because each side was individually self-consistent.
 *
 * That table is gone from TypeScript now, not merely tested against a
 * cross-language comparison. The store is the only place the policy is
 * written down: `CalibrationConflictDto` and `CalibrationConflictResolutionDto`
 * (`native/model-core/src/calibration.rs`) both carry an
 * `availableResolutions` field populated by calling
 * `available_resolutions()` -- the exact function `sqlite_catalog.rs` rejects
 * against -- and `conflictResolutionsFor` on the TypeScript side does nothing
 * with a conflict kind at all; it only gates the store-provided list on
 * transport capability.
 *
 * This file's job changed shape along with the fix, per the design recorded
 * on issue #304: with one table there is nothing left to compare two
 * *tables* against, so what is verified instead is that the duplication
 * cannot silently return -- that no per-kind literal exists on either side of
 * the wire, and that TypeScript passes through whatever the store says rather
 * than filtering or amending it. The equivalent of "remove a kind from the
 * Rust table and something must fail" now lives in
 * `native/model-core/src/sqlite_catalog.rs`'s
 * `wire_available_resolutions_is_never_anything_but_the_ratified_policy` test,
 * which is the only place left where the enforcement table and the
 * DTO-population sites could still be written independently of one another.
 */

const repoRoot = path.resolve(import.meta.dirname, '..');

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, ...relativePath.split('/')), 'utf8');
}

const SYNC_RS = 'native/model-core/src/sync.rs';
const CATALOG_RS = 'native/model-core/src/sqlite_catalog.rs';
const CALIBRATION_SERVICE_TS = 'src/main/calibrationService.ts';

/**
 * Rust variant names, kept only to sanity-check that the policy function this
 * file cites actually exists and covers all six kinds -- not to build a
 * second copy of the table.
 */
const KIND_VARIANTS = [
  'ProjectMetadata',
  'StepOrdering',
  'StepDraft',
  'OutcomeSelection',
  'StalePrinterSnapshot',
  'DeletionVsLocalEdit',
] as const;

/**
 * Confirms `CalibrationConflictKind::available_resolutions` still exists,
 * still dispatches on `match self`, and still names all six kinds. This does
 * not re-derive the policy -- it only guards the other assertions in this file
 * against silently describing a function that no longer exists in that shape.
 */
function assertRustPolicyFunctionIsIntact(): void {
  const source = readText(SYNC_RS);
  const fnIndex = source.indexOf('pub fn available_resolutions(');
  if (fnIndex === -1) {
    throw new Error(
      `${SYNC_RS}: available_resolutions no longer exists under that name.`,
    );
  }
  const matchIndex = source.indexOf('match self {', fnIndex);
  if (matchIndex === -1) {
    throw new Error(
      `${SYNC_RS}: available_resolutions no longer dispatches on 'match self'.`,
    );
  }
  const closingIndex = source.indexOf('\n}', matchIndex);
  if (closingIndex === -1) {
    throw new Error(`${SYNC_RS}: could not find the end of the match body.`);
  }
  const body = source.slice(matchIndex, closingIndex);
  for (const variant of KIND_VARIANTS) {
    if (!body.includes(`Self::${variant}`)) {
      throw new Error(
        `${SYNC_RS}: available_resolutions no longer covers Self::${variant}.`,
      );
    }
  }
}

describe('calibration resolution policy: one table, at the store', () => {
  it('the Rust policy function this file cites still exists and is exhaustive', () => {
    expect(() => assertRustPolicyFunctionIsIntact()).not.toThrow();
  });

  it('keeps the store as the enforcing side', () => {
    // If this call site disappears, the wire field and the enforcement it is
    // supposed to mirror could drift apart with nothing to notice: the field
    // would still be populated from available_resolutions(), but nothing
    // would reject a resolution the field did not advertise.
    expect(readText(CATALOG_RS)).toContain(
      'if !kind.available_resolutions().contains(&params.resolution)',
    );
  });

  it('every DTO site that leaves the store populates availableResolutions from available_resolutions(), not a literal', () => {
    const fullSource = readText(CATALOG_RS);
    // Restrict to production code -- the test module below (added by this
    // same change) asserts against `.available_resolutions` field reads,
    // which incidentally match the same shorthand-comma pattern but are not
    // DTO construction sites.
    const testModuleStart = fullSource.indexOf('#[cfg(test)]');
    const source =
      testModuleStart === -1
        ? fullSource
        : fullSource.slice(0, testModuleStart);
    // The three construction sites: the list path
    // (calibration_conflict_from_row) and the two resolve_calibration_conflict
    // returns (replay, and the normal write path). Each must derive the field
    // from the shared function -- a hand-written array literal here would be
    // exactly the second table issue #304 removed, just moved one file over.
    //
    // Two sites write `available_resolutions: kind.available_resolutions()...`
    // inline; the list path instead assigns a local `available_resolutions`
    // variable a few lines above the struct literal and uses Rust's field-init
    // shorthand (`available_resolutions,`), so both forms are accepted here as
    // long as each is textually paired with a call to `available_resolutions()`.
    const inlineSites = [
      ...source.matchAll(/available_resolutions:\s*([^,\n]+)/g),
    ].map((match) => match[1]?.trim());
    const shorthandSites = [...source.matchAll(/\bavailable_resolutions,/g)];
    expect(
      inlineSites.length + shorthandSites.length,
      'expected exactly three `available_resolutions` construction sites in ' +
        `${CATALOG_RS} (list path + two resolve_calibration_conflict returns)`,
    ).toBe(3);
    for (const rhs of inlineSites) {
      expect(
        rhs,
        `${CATALOG_RS}: an available_resolutions field must be computed by ` +
          'calling available_resolutions(), not written as a literal',
      ).toMatch(/available_resolutions\(\)/);
    }
    // No hand-written array literal anywhere in the file, inline or assigned
    // to a local variable before a field-init shorthand use.
    expect(source).not.toMatch(/available_resolutions\s*[:=]\s*(vec!\[|&\[)/);
    for (const shorthand of shorthandSites) {
      const precedingText = source.slice(0, shorthand.index);
      const localAssignment = /let\s+available_resolutions\s*=[^;]*;/gs;
      const lastAssignment = [...precedingText.matchAll(localAssignment)].pop();
      expect(
        lastAssignment?.[0],
        `${CATALOG_RS}: the local \`available_resolutions\` variable used via ` +
          'field-init shorthand must be computed by calling ' +
          'available_resolutions(), not written as a literal',
      ).toMatch(/available_resolutions\(\)/);
    }
  });

  it('conflictResolutionsFor contains no per-kind resolution literal', () => {
    const source = readText(CALIBRATION_SERVICE_TS);
    const fnStart = source.indexOf('export function conflictResolutionsFor(');
    expect(fnStart, 'conflictResolutionsFor no longer exists there').not.toBe(
      -1,
    );
    const fnEnd = source.indexOf('\n}', fnStart);
    const body = source.slice(fnStart, fnEnd);
    // If this function ever again branches on a conflict kind or spells out a
    // resolution name, that is the defect issue #304 removed reappearing.
    expect(body).not.toMatch(/kind\s*===/);
    for (const resolution of [
      'acceptServer',
      'keepLocalAsNewRevision',
      'manualFieldMerge',
    ]) {
      expect(body.includes(`'${resolution}'`)).toBe(false);
    }
  });

  it('conflictResolutionsFor is a pure capability gate: identity when capable, [] otherwise', () => {
    const incapable = {};
    const capable = { resolveCalibrationConflict: () => undefined };

    const fixtures: CalibrationConflictResolution[][] = [
      [],
      ['acceptServer'],
      ['acceptServer', 'keepLocalAsNewRevision'],
      ['acceptServer', 'keepLocalAsNewRevision', 'manualFieldMerge'],
      ['manualFieldMerge'],
    ];
    for (const resolutions of fixtures) {
      expect(
        conflictResolutionsFor(incapable, resolutions),
        `an incapable transport must report nothing for ${JSON.stringify(resolutions)}`,
      ).toEqual([]);
      expect(
        conflictResolutionsFor(capable, resolutions),
        `a capable transport must pass ${JSON.stringify(resolutions)} through unchanged`,
      ).toEqual(resolutions);
    }
  });
});
