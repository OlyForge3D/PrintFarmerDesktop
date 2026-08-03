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
 */

import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const mainDir = path.join(repoRoot, 'src', 'main');

/** The calibration surface, resolved from disk so a new module cannot slip past. */
const CALIBRATION_SURFACE: string[] = [
  ...readdirSync(mainDir).filter(
    (name) => name.startsWith('calibration') && name.endsWith('.ts'),
  ),
  'syncEngine.ts',
  'serverProfiles.ts',
  'sidecar.ts',
  'ipc.ts',
];

/**
 * Direct stream writes are the obvious way to evade a console ban, so the two
 * legitimate ones are pinned by name. `calibrationLog.ts` is the sink itself;
 * `sidecar.ts` pipes the Rust child's stderr through unchanged, because that is
 * the crate's own log stream and carries no identifier to put in a record.
 */
const PERMITTED_STREAM_WRITERS = ['calibrationLog.ts', 'sidecar.ts'];

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
    // Without this the scan below is vacuous: an empty file list passes every
    // "no offender" assertion while proving nothing at all.
    expect(CALIBRATION_SURFACE.length).toBeGreaterThan(8);
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

  it('never logs an error message field from the calibration log module', () => {
    // `CalibrationHttpError.message` carries the backend's ProblemDetails
    // `detail` (see `statusError`), so it is server-controlled text. The log
    // module must not read it.
    const source = read('calibrationLog.ts');
    expect(source).not.toMatch(/candidate\.message|error\.message/);
  });
});

/** A `console.<channel>(` call. */
const BARE_CONSOLE = /\bconsole\.(log|info|warn|error|debug|trace)\(/;
const STREAM_WRITE = /\bprocess\.(stdout|stderr)\.write\(/;
