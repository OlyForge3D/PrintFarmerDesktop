// #270. `useDefineForClassFields` (this project's ES2022 target) makes an
// optional class field emit an own `undefined` property on every instance,
// which shadows anything assigned to the prototype afterward. That silently
// breaks a field meant as a prototype-patchable capability seam --
// typecheck, lint, and every test exercising only the capability-absent path
// stay green. `scripts/check-inert-class-field-seams.mjs` is the general
// guard: every fixture below is a positive or negative control for one arm
// of its detection logic, so a future edit that widens or narrows the check
// cannot silently stop catching the shape it exists for.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  findInertSeamCandidates,
  formatViolation,
  scanRepository,
} from '../scripts/check-inert-class-field-seams.mjs';

const FIXTURE_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'inertClassFieldSeams',
);

function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

describe('findInertSeamCandidates', () => {
  it('POSITIVE CONTROL: flags an optional, function-typed, undeclared, self-unassigned field -- the exact #270 shape', () => {
    const source = readFixture('inertSeam.fixture.ts');
    const violations = findInertSeamCandidates('inertSeam.fixture.ts', source);

    expect(
      violations.map((v) => v.name),
      "the fixture is built to reproduce calibrationService.ts's original " +
        'defect shape; a check that does not flag it here would not have ' +
        'caught #270 either',
    ).toEqual(['resolveConflict']);
    expect(violations[0]?.typeText).toContain('=>');
  });

  it('does not flag the same field once it is `declare`d', () => {
    // The actual fix landed at calibrationService.ts:254-260. `declare`
    // tells TypeScript the field is defined elsewhere and suppresses the
    // emitted own-property entirely, which is why this is a legitimate fix
    // and not merely a way to silence the checker.
    const source = readFixture('declaredSeam.fixture.ts');
    expect(findInertSeamCandidates('declaredSeam.fixture.ts', source)).toEqual(
      [],
    );
  });

  it('does not flag a field the class assigns to itself', () => {
    // An optional callback threaded through a constructor argument and
    // assigned with `this.foo = options.foo` is ordinary optional data, not
    // a seam waiting for an external prototype patch. Flagging it would make
    // the check noisy on ordinary dependency injection.
    const source = readFixture('selfAssignedSeam.fixture.ts');
    expect(
      findInertSeamCandidates('selfAssignedSeam.fixture.ts', source),
    ).toEqual([]);
  });

  it('does not flag a non-function-typed optional field', () => {
    // The bug this check guards against is specific to a field a caller
    // "activates" by assigning a callable. An optional string/number field
    // is ordinary optional data with no comparable failure mode.
    const source = readFixture('nonFunctionField.fixture.ts');
    expect(
      findInertSeamCandidates('nonFunctionField.fixture.ts', source),
    ).toEqual([]);
  });

  it('does not flag a static field', () => {
    // Statics live on the constructor function, not on instances, and are
    // unaffected by useDefineForClassFields.
    const source = readFixture('staticSeam.fixture.ts');
    expect(findInertSeamCandidates('staticSeam.fixture.ts', source)).toEqual(
      [],
    );
  });

  it('does not flag a required (non-optional) function-typed field', () => {
    // A required field must be supplied at construction, so there is no
    // "silently absent capability" for useDefineForClassFields to hide --
    // the constructor cannot compile without providing it.
    const source = readFixture('requiredField.fixture.ts');
    expect(findInertSeamCandidates('requiredField.fixture.ts', source)).toEqual(
      [],
    );
  });

  it('does not flag a field already initialized with a default value', () => {
    // A field with an initializer already has an own property with a real
    // value, not `undefined` -- assigning to the prototype afterward would
    // never have worked regardless of useDefineForClassFields, so this is a
    // different (and already-visible) bug shape, not the silent one #270
    // names.
    const source = readFixture('initializedField.fixture.ts');
    expect(
      findInertSeamCandidates('initializedField.fixture.ts', source),
    ).toEqual([]);
  });
});

describe('formatViolation', () => {
  it('names the file, line, field, and the #270 mechanism', () => {
    const message = formatViolation({
      file: 'src/main/example.ts',
      line: 42,
      name: 'exampleSeam',
      typeText: '(() => void) | undefined',
    });
    expect(message).toContain('src/main/example.ts:42');
    expect(message).toContain('exampleSeam?:');
    expect(message).toContain('useDefineForClassFields');
    expect(message).toContain('declare');
  });
});

/**
 * The actually-fixed site stays green under the live check: this is the
 * regression control for the historical defect, run against the real
 * repository tree rather than a fixture, so a future revert of the `declare`
 * keyword (or of the method-based fix) at calibrationService.ts would be
 * caught by this file, not just by the fixtures above.
 */
describe('scanRepository against the live tree', () => {
  it('does not flag src/main/calibrationService.ts today', () => {
    const repoRoot = path.resolve(process.cwd());
    const violations = scanRepository(repoRoot).filter((violation) =>
      violation.file.includes('calibrationService.ts'),
    );
    expect(
      violations,
      'calibrationService.ts previously carried the #270 inert seam; if ' +
        'this now fails, either the `declare` keyword or the method-based ' +
        'fix at SidecarCalibrationAdapter has regressed',
    ).toEqual([]);
  });
});
