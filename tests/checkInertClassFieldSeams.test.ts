// #270. `useDefineForClassFields` (this project's ES2022 target) makes an
// optional class field emit an own `undefined` property on every instance,
// which shadows anything assigned to the prototype afterward. That silently
// breaks a field meant as a prototype-patchable capability seam --
// typecheck, lint, and every test exercising only the capability-absent path
// stay green. `scripts/check-inert-class-field-seams.mjs` is the general
// guard: every fixture below is a positive or negative control for one arm
// of its detection logic, so a future edit that widens or narrows the check
// cannot silently stop catching the shape it exists for.
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findInertSeamCandidates,
  formatViolation,
  listSourceFiles,
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

  it('POSITIVE CONTROL: flags a seam typed via a same-file callable type alias, not just an inline function type', () => {
    // Bishop/Ripley/Vasquez review finding on PR #706: the original check
    // only recognized an inline `(...) => R` type literal. A field typed via
    // a named type alias for a function type -- `type Handler = (id:
    // string) => Promise<void>;` used as `field?: Handler;` -- is the exact
    // same #270 shape and must be flagged too.
    const source = readFixture('typeAliasSeam.fixture.ts');
    const violations = findInertSeamCandidates(
      'typeAliasSeam.fixture.ts',
      source,
    );
    expect(violations.map((v) => v.name)).toEqual(['resolveConflict']);
    expect(violations[0]?.typeText).toBe('ResolveHandler');
  });

  it('POSITIVE CONTROL: flags a seam typed via a same-file callable interface (a call signature)', () => {
    // Same review finding: a field typed via an interface with a call
    // signature -- `interface Handler { (id: string): Promise<void>; }` --
    // is exactly as callable, and exactly as inert, as an inline function
    // type or a type alias to one.
    const source = readFixture('callableInterfaceSeam.fixture.ts');
    const violations = findInertSeamCandidates(
      'callableInterfaceSeam.fixture.ts',
      source,
    );
    expect(violations.map((v) => v.name)).toEqual(['resolveConflict']);
  });

  it('does not flag a field typed via a non-callable named type (a data interface or a type alias to a plain type)', () => {
    // Resolving named types must not become "any type reference is
    // function-typed" -- that would make the check noisy on the extremely
    // common case of an optional field typed via an interface or type
    // alias that is ordinary data, not a capability.
    const source = readFixture('nonCallableNamedType.fixture.ts');
    expect(
      findInertSeamCandidates('nonCallableNamedType.fixture.ts', source),
    ).toEqual([]);
  });

  it("does not flag a field assigned via bracket/computed property access (`this['foo'] = ...`)", () => {
    // Bishop's false-positive finding: the original self-assignment
    // detection only recognized the dotted `this.foo = ...` form. A field
    // the class assigns to itself via bracket notation is just as
    // self-managed and must not be flagged as an inert seam.
    const source = readFixture('bracketAssignedSeam.fixture.ts');
    expect(
      findInertSeamCandidates('bracketAssignedSeam.fixture.ts', source),
    ).toEqual([]);
  });

  it('does not flag a field assigned via `Object.assign(this, { foo: ... })`', () => {
    // Same false-positive class: `Object.assign` is another ordinary way a
    // class assigns its own fields to itself and must not read as an
    // external prototype patch.
    const source = readFixture('objectAssignSeam.fixture.ts');
    expect(
      findInertSeamCandidates('objectAssignSeam.fixture.ts', source),
    ).toEqual([]);
  });

  it('POSITIVE CONTROL: flags a seam typed via `typeof <identifier>` where the identifier resolves to an in-scope function', () => {
    // Vasquez's review finding on the re-review of PR #706: `field?: typeof
    // someFunction;` borrows a callable's type via a type query rather than
    // an inline function type, a type alias, or a callable interface, and
    // is exactly as inert once shadowed -- but was invisible to the check
    // until `collectCallableTypeNames` also tracked callable identifiers.
    const source = readFixture('typeofSeam.fixture.ts');
    const violations = findInertSeamCandidates('typeofSeam.fixture.ts', source);
    expect(violations.map((v) => v.name)).toEqual(['resolveConflict']);
    expect(violations[0]?.typeText).toBe('typeof resolveConflict');
  });

  it('does not flag a field typed via `typeof <identifier>` when the identifier is not callable', () => {
    // Resolving `typeof` identifiers must not become "any type query is
    // function-typed" -- `typeof aStringConstant` is ordinary data, not a
    // capability, and flagging it would make the check noisy on the common
    // "reuse a literal's inferred type" pattern.
    const source = readFixture('typeofNonCallable.fixture.ts');
    expect(
      findInertSeamCandidates('typeofNonCallable.fixture.ts', source),
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
 * Bishop's file-scan finding on PR #706: `git ls-files -- 'src/**\/*.ts'`
 * does NOT also match root-level `src/*.ts` files -- git's pathspec glob
 * requires `**` to span at least one full directory segment, so a
 * root-level file is invisible to that pattern alone. A scan that silently
 * skips files it should have scanned is exactly the #270-shaped failure
 * mode (a clean result must mean "genuinely nothing found", not "we never
 * looked here") -- so this is a real repo behavior to pin, not a fixture.
 */
describe('listSourceFiles', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(path.join(tmpdir(), 'inert-seam-scan-'));
    execFileSync('git', ['init', '--quiet'], { cwd: repoDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], {
      cwd: repoDir,
    });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoDir });
    mkdirSync(path.join(repoDir, 'src', 'nested'), { recursive: true });
    writeFileSync(
      path.join(repoDir, 'src', 'rootLevel.ts'),
      'export const rootLevel = true;\n',
    );
    writeFileSync(
      path.join(repoDir, 'src', 'nested', 'nestedFile.ts'),
      'export const nested = true;\n',
    );
    execFileSync('git', ['add', '.'], { cwd: repoDir });
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('includes both a root-level src/*.ts file and a nested src/**/*.ts file', () => {
    const files = listSourceFiles(repoDir);
    expect(files).toContain(path.posix.join('src', 'rootLevel.ts'));
    expect(files).toContain(path.posix.join('src', 'nested', 'nestedFile.ts'));
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
