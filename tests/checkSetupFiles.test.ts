// @vitest-environment node
//
// vite's `loadConfigFromFile` (used below) shells out to esbuild, which
// requires a real `TextEncoder`. Under this project's default `jsdom`
// environment that invariant does not hold and esbuild refuses to run; node
// does not have that problem, and this file has no DOM dependency of its
// own, so it opts out of the default the same way
// tests/checkTestNarrowing.test.ts and
// tests/retargetSweepRealContention.test.ts do for the same reason.
//
// #539. A committed `setupFiles` entry runs inside every vitest worker
// before any test module and can redefine `process.platform`,
// `process.execPath`, `path.sep`, and `os.EOL` -- every witness a test uses
// to cross-examine its own platform-conditional skip decision. This file
// proves scripts/check-setup-files.mjs refuses any committed setupFiles
// entry that is not on the explicit allowlist, using fixtures that commit
// a planted extra/removed/computed-key entry -- never the live tree, whose
// current setupFiles is exactly the allowlist and therefore proves nothing
// about the gate's ability to go red.
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_SETUP_FILES,
  checkSetupFiles,
  diffSetupFiles,
  formatReport,
  resolveCommittedSetupFiles,
} from '../scripts/check-setup-files.mjs';
import type { LoadConfigFromFile } from '../scripts/check-setup-files.d.mts';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'setupFiles');

const loadConfigFromFile: LoadConfigFromFile = async (...args) => {
  const vite = await import('vite');
  return vite.loadConfigFromFile(...args);
};

describe('diffSetupFiles', () => {
  it('CONTROL: reports no diff when actual matches expected exactly', () => {
    expect(diffSetupFiles(['./tests/setup.ts'], ['./tests/setup.ts'])).toEqual({
      unexpected: [],
      missing: [],
    });
  });

  it('CONTROL: order does not matter', () => {
    expect(diffSetupFiles(['./b.ts', './a.ts'], ['./a.ts', './b.ts'])).toEqual({
      unexpected: [],
      missing: [],
    });
  });

  it('POSITIVE CONTROL: flags an unexpected additional entry', () => {
    expect(
      diffSetupFiles(
        ['./tests/setup.ts', './tests/evil.ts'],
        ['./tests/setup.ts'],
      ),
    ).toEqual({ unexpected: ['./tests/evil.ts'], missing: [] });
  });

  it('POSITIVE CONTROL: flags a missing allowlisted entry', () => {
    expect(diffSetupFiles([], ['./tests/setup.ts'])).toEqual({
      unexpected: [],
      missing: ['./tests/setup.ts'],
    });
  });

  it('treats a non-array actual value as an empty list rather than throwing', () => {
    expect(diffSetupFiles(undefined, ['./tests/setup.ts'])).toEqual({
      unexpected: [],
      missing: ['./tests/setup.ts'],
    });
  });
});

describe('resolveCommittedSetupFiles: reads vitest.config.ts the way vitest itself resolves it', () => {
  it('CONTROL: reads the live vitest.config.ts, which is exactly the allowlist', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(process.cwd(), 'vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(setupFiles).toEqual(EXPECTED_SETUP_FILES);
  });

  it('CONTROL: reads a clean fixture matching the allowlist', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'clean.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(setupFiles).toEqual(['./tests/setup.ts']);
  });

  it('POSITIVE CONTROL: resolves a planted extra entry, proving the gate is not blind to it', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'spoofed.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(setupFiles).toEqual([
      './tests/setup.ts',
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
  });

  it('POSITIVE CONTROL: resolves a computed/spread-constructed entry identically to a literal one (#518 evasion)', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'spoofedComputed.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(setupFiles).toEqual([
      './tests/setup.ts',
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
  });

  it('resolves an emptied setupFiles list as an empty array, not undefined', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'missing.vitest.config.ts'),
      cwd: process.cwd(),
      loadConfigFromFile,
    });
    expect(setupFiles).toEqual([]);
  });
});

describe('checkSetupFiles: the aggregate gate', () => {
  it('CONTROL: the live repository tree matches its own allowlist', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(process.cwd(), 'vitest.config.ts'),
      loadConfigFromFile,
    });
    expect(diff).toEqual({ unexpected: [], missing: [] });
  });

  it('POSITIVE CONTROL: goes red for a planted unexpected setupFiles entry', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'spoofed.vitest.config.ts'),
      loadConfigFromFile,
    });
    expect(diff.unexpected).toEqual([
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('POSITIVE CONTROL: goes red for a planted entry added via spread/computed construction (#518 evasion)', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'spoofedComputed.vitest.config.ts'),
      loadConfigFromFile,
    });
    expect(diff.unexpected).toEqual([
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('POSITIVE CONTROL: goes red when the allowlisted setup file is silently dropped', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'missing.vitest.config.ts'),
      loadConfigFromFile,
    });
    expect(diff.unexpected).toEqual([]);
    expect(diff.missing).toEqual(['./tests/setup.ts']);
  });

  it('respects a custom expected allowlist rather than only the module default', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'spoofed.vitest.config.ts'),
      expected: [
        './tests/setup.ts',
        './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
      ],
      loadConfigFromFile,
    });
    expect(diff).toEqual({ unexpected: [], missing: [] });
  });
});

describe('formatReport', () => {
  it('states the allowlist is deliberate and explains how to update it', () => {
    const report = formatReport(
      { unexpected: ['./tests/evil.ts'], missing: [] },
      ['./tests/setup.ts'],
    );
    expect(report).toContain('deliberate allowlist');
    expect(report).toContain('EXPECTED_SETUP_FILES');
    expect(report).toContain('scripts/check-setup-files.mjs');
    expect(report).toContain('./tests/evil.ts');
  });

  it('lists both unexpected and missing entries when both are present', () => {
    const report = formatReport(
      { unexpected: ['./tests/evil.ts'], missing: ['./tests/setup.ts'] },
      ['./tests/setup.ts'],
    );
    expect(report).toContain('UNEXPECTED');
    expect(report).toContain('./tests/evil.ts');
    expect(report).toContain('MISSING');
    expect(report).toContain('./tests/setup.ts');
  });

  it('produces no UNEXPECTED/MISSING sections when both diffs are empty', () => {
    const report = formatReport({ unexpected: [], missing: [] }, [
      './tests/setup.ts',
    ]);
    expect(report).not.toContain('UNEXPECTED');
    expect(report).not.toContain('MISSING (');
  });
});
