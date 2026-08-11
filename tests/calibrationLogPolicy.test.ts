// @vitest-environment node

/**
 * Source-level policy for calibration logging (issue #159).
 *
 * Issue #159 requires that every calibration operation which previously called
 * `console.error` with a bracket prefix emits a structured record instead, and
 * that a test fails if a bare `console.*` call remains in the calibration
 * main-process modules.
 *
 * This is a source scan rather than a runtime scan on purpose: a runtime scan
 * only proves the call sites a test happens to execute are clean, and the whole
 * risk here is the site nobody exercised. The scan follows the `readFileSync`
 * precedent in `tests/supplyChainPolicy.test.ts`.
 *
 * Scope, agreed with the coordinator: the calibration surface. That is every
 * `src/main/calibration*.ts`, plus the three modules issue #159 quotes by name
 * (`syncEngine.ts`, `serverProfiles.ts`, `sidecar.ts`) and `ipc.ts`, which owns
 * the calibration handlers. `sceneCache.ts`, `updates.ts` and `main.ts` are
 * deliberately out of scope — main.ts forwards the *renderer's* console, which
 * is a different problem.
 *
 * ## Why the surface is named, and then checked against disk
 *
 * A surface resolved only by glob can silently cover nothing: rename a module,
 * or let a path pattern drift, and the scan runs over fewer files — or zero —
 * and still passes every "no offender" assertion. Planting a console call
 * proves the detector fires for a file *still in the set*; it says nothing
 * about the files that dropped out.
 *
 * So the list below is written out by name, and two assertions guard it from
 * both sides: every named file must exist on disk, and the disk must contain no
 * calibration module the list omits. One side going empty breaks the other.
 */

import path from 'node:path';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainDir = path.join(repoRoot, 'src', 'main');

/**
 * The calibration surface, named rather than globbed. See the module docblock:
 * a glob that resolves to fewer files still passes every scan below.
 */
const CALIBRATION_SURFACE: readonly string[] = [
  'calibrationActionGate.ts',
  'calibrationAssetManifest.ts',
  'calibrationBedClearLedger.ts',
  'calibrationCorrelation.ts',
  'calibrationDiagnostics.ts',
  'calibrationEngine.ts',
  'calibrationFreshness.ts',
  'calibrationHttp.ts',
  'calibrationImportV4.ts',
  'calibrationLog.ts',
  'calibrationPhotos.ts',
  'calibrationSelectionCache.ts',
  'calibrationService.ts',
  'calibrationWire.ts',
  'syncEngine.ts',
  'serverProfiles.ts',
  'sidecar.ts',
  'ipc.ts',
];

/** The cardinality the list above is expected to have, pinned so a deletion is loud. */
const EXPECTED_SURFACE_SIZE = 18;

/**
 * Direct stream writes are the obvious way to evade a console ban, so the two
 * legitimate ones are pinned by name. `calibrationLog.ts` is the sink itself;
 * `sidecar.ts` pipes the Rust child's stderr through unchanged, because that is
 * the crate's own log stream and carries no identifier to put in a record.
 */
const PERMITTED_STREAM_WRITERS = ['calibrationLog.ts', 'sidecar.ts'];

/**
 * Removes block and line comments so a policy regex matches code, not prose.
 *
 * Without this, a module that *documents* the rule it obeys is indicted by the
 * rule. #177 hit this exactly: a docblock explaining that `serverDetail` must
 * never be logged made `calibrationLog.ts` look like it read `serverDetail`.
 *
 * Deliberately not a parser. It over-strips inside string literals containing
 * comment markers, which is why every caller asserts the stripped source still
 * contains a known code landmark before concluding anything from an absence.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function read(file: string): string {
  return readFileSync(path.join(mainDir, file), 'utf8');
}

function offendingLines(source: string, pattern: RegExp): number[] {
  const hits: number[] = [];
  source.split('\n').forEach((line, index) => {
    // Strip a line comment before matching, so prose mentioning a console call
    // does not register as one.
    const code = line.replace(/\/\/.*$/, '');
    if (pattern.test(code)) hits.push(index + 1);
  });
  return hits;
}

describe('calibration logging policy', () => {
  it('resolves a non-empty calibration surface including every quoted module', () => {
    // Without this the scan below is vacuous: an empty or shrunken file list
    // passes every "no offender" assertion while proving nothing at all.
    expect(CALIBRATION_SURFACE.length).toBe(EXPECTED_SURFACE_SIZE);
    for (const required of [
      'calibrationHttp.ts',
      'calibrationEngine.ts',
      'calibrationLog.ts',
      'syncEngine.ts',
      'serverProfiles.ts',
      'sidecar.ts',
      'ipc.ts',
    ]) {
      expect(CALIBRATION_SURFACE).toContain(required);
    }
  });

  it('scans only files that exist on disk', () => {
    // A named list can drift the other way: an entry that no longer exists
    // would throw on read, or worse, be quietly skipped by a future refactor.
    const missing = CALIBRATION_SURFACE.filter(
      (file) => !existsSync(path.join(mainDir, file)),
    );
    expect(
      missing,
      `calibration surface names files that are not on disk: ${missing.join(', ') || '(none)'}`,
    ).toEqual([]);
  });

  it('names every calibration module on disk', () => {
    // The other half of the symmetry. A new calibration module that nobody adds
    // to the list would otherwise be exempt from the console ban forever.
    const onDisk = readdirSync(mainDir).filter(
      (name) => name.startsWith('calibration') && name.endsWith('.ts'),
    );
    const unlisted = onDisk.filter(
      (name) => !CALIBRATION_SURFACE.includes(name),
    );
    expect(
      unlisted,
      `calibration modules exist that the surface list omits: ${unlisted.join(', ') || '(none)'}`,
    ).toEqual([]);
  });

  it('detects a bare console call when one is present', () => {
    // Proves the detector can fail. Without this, "no offenders" is
    // indistinguishable from "the regex never matches anything".
    const planted =
      "  console.error('[sync] scheduled synchronization failed');";
    expect(offendingLines(planted, BARE_CONSOLE)).toEqual([1]);
  });

  it('has no bare console call anywhere on the calibration surface', () => {
    const offenders: string[] = [];
    for (const file of CALIBRATION_SURFACE) {
      for (const line of offendingLines(read(file), BARE_CONSOLE)) {
        offenders.push(`src/main/${file}:${String(line)}`);
      }
    }
    expect(
      offenders,
      'a bare console call remains on the calibration surface; emit a structured record instead',
    ).toEqual([]);
  });

  it('writes directly to a process stream only from the two permitted modules', () => {
    const writers = CALIBRATION_SURFACE.filter(
      (file) => offendingLines(read(file), STREAM_WRITE).length > 0,
    );
    expect(
      writers.sort(),
      'a module started writing to a process stream directly, which is how a console ban gets evaded',
    ).toEqual([...PERMITTED_STREAM_WRITERS].sort());
  });

  it('never logs an error message or the raw server detail', () => {
    // Before #177, `CalibrationHttpError.message` carried the backend's
    // ProblemDetails `detail`. It no longer does -- but the untrusted text did
    // not cease to exist, it moved to `serverDetail`. A guard that named only
    // the old field would have gone on passing while the value it was written
    // to stop walked past it under a new name.
    //
    // Comments are stripped first. Both assertions below match raw source, so
    // a docblock *explaining* that the module must not read `serverDetail`
    // fires the guard against the module for describing the rule it obeys --
    // which is what happened when #177 documented the change here.
    const source = stripComments(read('calibrationLog.ts'));
    // Positive control: a stripper that over-matches would empty the file and
    // every `not.toMatch` below would pass on nothing.
    expect(
      source,
      'comment stripping removed the module body, so the assertions below are vacuous',
    ).toMatch(/export function emitCalibrationLog/);
    expect(source).not.toMatch(/candidate\.message|error\.message/);
    expect(
      source,
      'calibrationLog.ts reads serverDetail, which is verbatim server-controlled text',
    ).not.toMatch(/serverDetail/);
  });
});

/** A `console.<channel>(` call. */
const BARE_CONSOLE = /\bconsole\.(log|info|warn|error|debug|trace)\(/;
const STREAM_WRITE = /\bprocess\.(stdout|stderr)\.write\(/;
