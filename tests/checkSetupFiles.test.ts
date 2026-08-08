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
//
// PR #642 REVIEW (Ripley): even with that logic fixed, nothing wired
// `npm run check:setup-files` into a workflow that runs it against the
// LIVE repository tree from OUTSIDE any vitest worker -- this file's own
// "CONTROL: the live repository tree matches its own allowlist" test still
// runs from inside a vitest worker, which is the position #539 exists to
// distrust in the first place.
//
// The workflow file itself cannot be committed from this session: GitHub
// rejects any push touching `.github/workflows/*` from this OAuth App
// token ("without `workflow` scope"), the identical constraint already
// documented for check:closed-head-dispatch in docs/closed-head-dispatch.md.
// The full workflow text instead lives in
// docs/setup-files-allowlist-workflow.md as a fenced code block a
// maintainer with the right scope pastes in verbatim; the final describe
// block below reads that block directly off disk and pins its exact
// content, so the doc cannot drift from what this test suite expects
// without failing here first.
import { readFileSync } from 'node:fs';
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

// PR #642 REVIEW (Ripley): the describe block above proves the CHECKER's
// logic is correct against fixtures, entirely from inside a vitest worker --
// exactly the position #539 says not to trust, because a committed
// `setupFiles` entry runs before any test module in that same worker and
// could in principle interfere with the worker-side assertions themselves.
// Proving the script's logic is right is not the same as proving the LIVE
// REPOSITORY TREE is ever actually checked from OUTSIDE a vitest worker --
// and before this fix, nothing did: `npm run check:setup-files` existed but
// no workflow invoked it, so it was defined and never scheduled.
//
// This block pins the missing half. The workflow that would run
// `node scripts/check-setup-files.mjs` against the live tree in a plain
// `node`/`npm ci` job (never starting a vitest worker of its own) cannot be
// committed as a real `.github/workflows/*.yml` file from this session (see
// docs/setup-files-allowlist-workflow.md for why), so its exact text is
// pinned here instead, read directly off disk from that doc -- not through
// vitest's module graph, so nothing a setup file could touch -- so the doc
// cannot drift from what a maintainer is expected to paste in without
// failing this suite first.
describe('the outside-worker gate has a fully written, pinned CI wiring, not just fixture-proven logic', () => {
  const docPath = path.join(
    process.cwd(),
    'docs',
    'setup-files-allowlist-workflow.md',
  );
  const doc = readFileSync(docPath, 'utf8');
  const yamlBlockMatch = doc.match(/```yaml\n([\s\S]*?)\n```/);

  it('has a fenced yaml workflow block in the pending-wiring doc, so the assertions below are not vacuous', () => {
    expect(yamlBlockMatch).not.toBeNull();
  });

  const workflow = yamlBlockMatch?.[1] ?? '';

  it('invokes the npm script that runs the checker as a CLI, outside any vitest worker', () => {
    expect(workflow).toMatch(/run:\s*npm run check:setup-files\s*$/m);
  });

  it('never invokes `npm test`/`vitest run` itself, so its own job cannot be the worker #539 distrusts', () => {
    const runLines = workflow
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('run:') || line.startsWith('- run:'));
    for (const line of runLines) {
      expect(line).not.toMatch(/\bnpm (run )?test\b/);
      expect(line).not.toMatch(/\bvitest run\b/);
    }

    // Positive control: the assertion above must be capable of failing, not
    // merely finding nothing to complain about. A workflow whose only `run:`
    // step were `npm test` would be exactly the "checked from inside the
    // worker" failure this test exists to catch.
    const vacuousWorkflow = 'jobs:\n  x:\n    steps:\n      - run: npm test\n';
    const vacuousRunLines = vacuousWorkflow
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith('run:') || line.startsWith('- run:'));
    expect(
      vacuousRunLines.some((line) => /\bnpm (run )?test\b/.test(line)),
    ).toBe(true);
  });

  it('declares itself advisory, not wired into a required CI status context yet', () => {
    expect(workflow).toMatch(/^#\s*merge-queue:\s*advisory\s*$/m);
  });

  it('runs on pull_request, so it actually reports something for review to see', () => {
    expect(workflow).toMatch(/pull_request:/);
  });

  it('names the exact filename the discharge path tells a maintainer to create', () => {
    expect(doc).toContain('.github/workflows/setup-files-allowlist.yml');
    expect(doc).toMatch(/add\s+the\s+following\s+file\s+as/);
  });

  it('has a matching package.json script that runs the checker directly', () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(packageJson.scripts['check:setup-files']).toBe(
      'node scripts/check-setup-files.mjs',
    );
  });

  it('is recorded in UNENFORCED_CHECKS with an honest, measured reason rather than silently unwired', async () => {
    const { UNENFORCED_CHECKS } =
      await import('../scripts/check-script-reachability.mjs');
    expect(UNENFORCED_CHECKS['check:setup-files']).toBeDefined();
    expect(UNENFORCED_CHECKS['check:setup-files']).toContain('workflow');
  });
});
