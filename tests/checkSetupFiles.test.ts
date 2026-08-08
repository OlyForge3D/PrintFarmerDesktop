// @vitest-environment node
//
// This file spins up real vite dev servers via vitest's own `createVitest`
// (see scripts/check-setup-files.mjs), which needs a real `TextEncoder` the
// same way `loadConfigFromFile` does; node does not have that problem, and
// this file has no DOM dependency of its own, so it opts out of the jsdom
// default the same way tests/checkTestNarrowing.test.ts and
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
//
// PR #642 REVIEW (Vasquez): the first version of this gate resolved
// vitest.config.ts with vite's bare `loadConfigFromFile`, which only
// evaluates the exported config module -- it does not set up a real vitest
// invocation context, and does not run vite's plugin pipeline. That let a
// committed config detect "am I being read by the gate, or actually run?"
// via `process.argv`/`process.env`, or inject an extra setup file via a
// plugin's `config()` hook -- and answer "clean" to the gate while
// executing an unallowlisted file for real. The `argvGated`, `envGated`,
// and `pluginInjected` fixtures below pin exactly those three bypasses.
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  EXPECTED_SETUP_FILES,
  checkSetupFiles,
  defaultCreateVitest,
  diffSetupFiles,
  formatReport,
  resolveCommittedSetupFiles,
  resolveVitestBinPath,
} from '../scripts/check-setup-files.mjs';
import type { CreateVitestImpl } from '../scripts/check-setup-files.d.mts';

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'setupFiles');

const createVitestImpl: CreateVitestImpl = defaultCreateVitest;

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

describe('resolveVitestBinPath', () => {
  it('resolves the real installed vitest.mjs binary', () => {
    const binPath = resolveVitestBinPath({ cwd: process.cwd() });
    expect(binPath.replaceAll('\\', '/')).toMatch(/vitest\/vitest\.mjs$/);
  });

  it('falls back to the conventional install path when resolution throws', () => {
    const binPath = resolveVitestBinPath({
      cwd: 'C:\\fake-root',
      requireImpl: {
        resolve: () => {
          throw new Error('not found');
        },
      },
    });
    expect(binPath.replaceAll('\\', '/')).toBe(
      'C:/fake-root/node_modules/vitest/vitest.mjs',
    );
  });
});

describe('resolveCommittedSetupFiles: reads vitest.config.ts the way vitest itself resolves it', () => {
  it('CONTROL: reads the live vitest.config.ts, which is exactly the allowlist', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(process.cwd(), 'vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
    });
    expect(setupFiles).toEqual(EXPECTED_SETUP_FILES);
  });

  it('CONTROL: reads a clean fixture matching the allowlist', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'clean.vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
    });
    expect(setupFiles).toEqual(['./tests/setup.ts']);
  });

  it('POSITIVE CONTROL: resolves a planted extra entry, proving the gate is not blind to it', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'spoofed.vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
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
      createVitestImpl,
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
      createVitestImpl,
    });
    expect(setupFiles).toEqual([]);
  });

  it('POSITIVE CONTROL (#642 review, bypass 1): resolves an argv-gated extra entry -- the config cannot hide behind "this is not really vitest running"', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'argvGated.vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
    });
    expect(setupFiles).toEqual([
      './tests/setup.ts',
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
  });

  it('POSITIVE CONTROL (#642 review, bypass 2): resolves an env-gated extra entry -- process.env.VITEST is set before resolution, matching a real run', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'envGated.vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
    });
    expect(setupFiles).toEqual([
      './tests/setup.ts',
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
  });

  it('POSITIVE CONTROL (#642 review, bypass 3): resolves a plugin-injected extra entry -- the full vite plugin pipeline runs, not just the exported config object', async () => {
    const setupFiles = await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'pluginInjected.vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
    });
    expect(setupFiles).toContain(
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    );
  });

  it('restores process.argv and process.env after resolving, even for a config that reads them', async () => {
    const originalArgv = [...process.argv];
    const originalEnv = {
      VITEST: process.env.VITEST,
      TEST: process.env.TEST,
      NODE_ENV: process.env.NODE_ENV,
    };
    await resolveCommittedSetupFiles({
      configPath: path.join(FIXTURE_DIR, 'argvGated.vitest.config.ts'),
      cwd: process.cwd(),
      createVitestImpl,
    });
    expect(process.argv).toEqual(originalArgv);
    expect(process.env.VITEST).toBe(originalEnv.VITEST);
    expect(process.env.TEST).toBe(originalEnv.TEST);
    expect(process.env.NODE_ENV).toBe(originalEnv.NODE_ENV);
  });
});

describe('checkSetupFiles: the aggregate gate', () => {
  it('CONTROL: the live repository tree matches its own allowlist', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(process.cwd(), 'vitest.config.ts'),
      createVitestImpl,
    });
    expect(diff).toEqual({ unexpected: [], missing: [] });
  });

  it('POSITIVE CONTROL: goes red for a planted unexpected setupFiles entry', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'spoofed.vitest.config.ts'),
      createVitestImpl,
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
      createVitestImpl,
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
      createVitestImpl,
    });
    expect(diff.unexpected).toEqual([]);
    expect(diff.missing).toEqual(['./tests/setup.ts']);
  });

  it('POSITIVE CONTROL (#642 review, bypass 1): goes red for an argv-gated planted entry', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'argvGated.vitest.config.ts'),
      createVitestImpl,
    });
    expect(diff.unexpected).toEqual([
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('POSITIVE CONTROL (#642 review, bypass 2): goes red for an env-gated planted entry', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'envGated.vitest.config.ts'),
      createVitestImpl,
    });
    expect(diff.unexpected).toEqual([
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('POSITIVE CONTROL (#642 review, bypass 3): goes red for a plugin-injected planted entry', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'pluginInjected.vitest.config.ts'),
      createVitestImpl,
    });
    expect(diff.unexpected).toEqual([
      './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
    ]);
    expect(diff.missing).toEqual([]);
  });

  it('respects a custom expected allowlist rather than only the module default', async () => {
    const diff = await checkSetupFiles({
      cwd: process.cwd(),
      configPath: path.join(FIXTURE_DIR, 'spoofed.vitest.config.ts'),
      expected: [
        './tests/setup.ts',
        './tests/fixtures/setupFiles/spoofPlatformWitnesses.ts',
      ],
      createVitestImpl,
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
