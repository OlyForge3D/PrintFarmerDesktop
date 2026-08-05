import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SCRIPT_DIRECTORY,
  UNENFORCED_CHECKS,
  UNINVOKED_SCRIPTS,
  evaluateCheckEnforcement,
  evaluateScriptReachability,
  formatFindings,
  invocationKinds,
  readTrackedFiles,
  runCommandLines,
} from '../scripts/check-script-reachability.mjs';

/**
 * A guard that is never invoked is indistinguishable from one that is invoked
 * and always passes. These tests exist to keep that true of the repository and
 * of this checker itself: several assert the FAILING side, because a suite that
 * only ever exercises the clean case cannot tell an enforced rule from an
 * absent one.
 */

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

const files = readTrackedFiles(repoRoot);
const scripts = files
  .map(({ path: filePath }) => filePath)
  .filter(
    (filePath) =>
      filePath.startsWith(`${SCRIPT_DIRECTORY}/`) && filePath.endsWith('.mjs'),
  );

const packageJson = files.find(
  ({ path: filePath }) => filePath === 'package.json',
);
const workflows = files.filter(({ path: filePath }) =>
  filePath.startsWith('.github/workflows/'),
);

function definedScripts(): Record<string, string> {
  const parsed: unknown = JSON.parse(packageJson?.contents ?? '{}');
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('scripts' in parsed) ||
    typeof parsed.scripts !== 'object' ||
    parsed.scripts === null
  ) {
    return {};
  }
  return parsed.scripts as Record<string, string>;
}

describe('the corpus this checker reads', () => {
  it('finds scripts on disk, so every assertion below has something to bind to', () => {
    expect(scripts.length).toBeGreaterThan(10);
  });

  it('finds workflows on disk', () => {
    expect(workflows.length).toBeGreaterThan(0);
  });

  it('enumerates scripts from disk rather than a list, so a new script is covered without editing this file', () => {
    // The transcribed-list defect: a hard-coded roster silently stops covering
    // whatever is added after it was written.
    expect(scripts).toContain(
      `${SCRIPT_DIRECTORY}/check-script-reachability.mjs`,
    );
    expect(scripts).toContain(`${SCRIPT_DIRECTORY}/npm-ci-strict.mjs`);
  });
});

describe('runCommandLines', () => {
  it('collects the continuation lines of a `run:` block scalar', () => {
    // release.yml invokes two scripts this way. A line-anchored matcher reports
    // both as dead code, which is the false positive that gets a check deleted.
    const lines = runCommandLines(
      [
        'jobs:',
        '  a:',
        '    steps:',
        '      - name: Notarize',
        '        run: |',
        '          node scripts/release-environment.mjs \\',
        '            -- node scripts/notarize-macos-release.mjs',
        '      - name: Next',
        '        uses: actions/checkout@v4',
      ].join('\n'),
    );

    expect(lines.join('\n')).toContain('notarize-macos-release.mjs');
  });

  it('stops at the end of the block, so a later step is not absorbed into it', () => {
    const lines = runCommandLines(
      [
        '      - name: One',
        '        run: |',
        '          echo inside',
        '      - name: Two',
        '        uses: actions/checkout@v4',
      ].join('\n'),
    );

    expect(lines.join('\n')).toContain('echo inside');
    expect(lines.join('\n')).not.toContain('actions/checkout');
  });

  it('ignores a line that merely mentions a command outside any `run:`', () => {
    const lines = runCommandLines(
      ['# run: node scripts/nope.mjs', 'env:', '  A: b'].join('\n'),
    );

    expect(lines.join('\n')).not.toContain('nope.mjs');
  });

  it('returns nothing for a workflow with no run steps, so the matcher is not constant', () => {
    expect(
      runCommandLines(
        ['on: push', 'jobs:', '  a:', '    steps: []'].join('\n'),
      ),
    ).toEqual([]);
  });
});

describe('invocationKinds separates invoking from mentioning', () => {
  it('counts a call that passes the filename as an argument', () => {
    expect(
      invocationKinds({
        basename: 'stage-compliance.mjs',
        filePath: 'forge.config.ts',
        contents: "runBuildScript('stage-compliance.mjs', 'staging');",
      }),
    ).toEqual([{ kind: 'dynamic', where: 'forge.config.ts' }]);
  });

  it('does NOT count a comment explaining how to run it by hand', () => {
    // The real line in forge.config.ts. Counting occurrences instead of
    // classifying them marks this script reachable and reports nothing.
    expect(
      invocationKinds({
        basename: 'generate-installer-gif.mjs',
        filePath: 'forge.config.ts',
        contents:
          '// Regenerate with `npx electron scripts/generate-installer-gif.mjs`.',
      }),
    ).toEqual([]);
  });

  it('does NOT count an eslint config entry naming the file', () => {
    expect(
      invocationKinds({
        basename: 'generate-installer-gif.mjs',
        filePath: 'eslint.config.js',
        contents: "files: ['scripts/generate-installer-gif.mjs'],",
      }),
    ).toEqual([]);
  });

  it('counts a static import', () => {
    expect(
      invocationKinds({
        basename: 'supply-chain.mjs',
        filePath: 'scripts/verify-sbom.mjs',
        contents: "import { read } from './supply-chain.mjs';",
      }),
    ).toEqual([{ kind: 'import', where: 'scripts/verify-sbom.mjs' }]);
  });

  it('counts an npm script value but not an unrelated key', () => {
    expect(
      invocationKinds({
        basename: 'npm-ci-strict.mjs',
        filePath: 'package.json',
        contents: JSON.stringify({
          scripts: { install: 'node scripts/npm-ci-strict.mjs', other: 'echo' },
        }),
      }),
    ).toEqual([{ kind: 'npm', where: 'package.json:scripts.install' }]);
  });

  it('does NOT count a yaml `paths:` filter that names the script', () => {
    expect(
      invocationKinds({
        basename: 'npm-ci-strict.mjs',
        filePath: '.github/workflows/ci.yml',
        contents: [
          'on:',
          '  push:',
          '    paths:',
          '      - scripts/npm-ci-strict.mjs',
        ].join('\n'),
      }),
    ).toEqual([]);
  });
});

describe('the repository has no undeclared dead scripts', () => {
  const reachability = evaluateScriptReachability({ scripts, files });

  it('leaves no script uninvoked and undeclared', () => {
    expect(reachability.orphans.map(({ basename }) => basename)).toEqual([]);
  });

  it('actually resolves most scripts to a real invocation, so the pass is not vacuous', () => {
    expect(reachability.invoked.length).toBeGreaterThan(20);
  });

  it('reports an unknown orphan rather than ignoring it', () => {
    const report = evaluateScriptReachability({
      scripts: [`${SCRIPT_DIRECTORY}/nobody-calls-me.mjs`],
      files: [{ path: 'package.json', contents: '{"scripts":{}}' }],
      allowlist: {},
    });

    expect(report.orphans).toEqual([{ basename: 'nobody-calls-me.mjs' }]);
    expect(
      formatFindings({
        reachability: report,
        enforcement: { unenforced: [], declared: [], enforced: [] },
      }),
    ).toHaveLength(1);
  });

  it('does not let a script vouch for itself', () => {
    const report = evaluateScriptReachability({
      scripts: [`${SCRIPT_DIRECTORY}/self.mjs`],
      files: [
        {
          path: `${SCRIPT_DIRECTORY}/self.mjs`,
          contents: "run('self.mjs');",
        },
      ],
      allowlist: {},
    });

    expect(report.orphans).toEqual([{ basename: 'self.mjs' }]);
  });
});

describe('every check:*/verify:* npm script is actually run somewhere', () => {
  const enforcement = evaluateCheckEnforcement({
    packageScripts: definedScripts(),
    workflows,
  });

  it('leaves no check unenforced and undeclared', () => {
    expect(enforcement.unenforced.map(({ key }) => key)).toEqual([]);
  });

  it('resolves several checks to a real workflow, so the pass is not vacuous', () => {
    expect(enforcement.enforced.length).toBeGreaterThan(3);
  });

  it('runs this very check in CI — the checker must not be the thing it detects', () => {
    const self = enforcement.enforced.find(
      ({ key }) => key === 'check:script-reachability',
    );
    expect(
      self,
      'check:script-reachability must be invoked by a workflow',
    ).toBeDefined();
    expect(self?.workflows.length).toBeGreaterThan(0);
  });

  it('reports a defined-but-never-run check', () => {
    const report = evaluateCheckEnforcement({
      packageScripts: { 'check:ghost': 'node scripts/ghost.mjs' },
      workflows: [{ path: '.github/workflows/ci.yml', contents: 'jobs: {}' }],
      allowlist: {},
    });

    expect(report.unenforced).toEqual([{ key: 'check:ghost' }]);
  });

  it('finds the check when a workflow does run it, so the negative above is not constant', () => {
    const report = evaluateCheckEnforcement({
      packageScripts: { 'check:ghost': 'node scripts/ghost.mjs' },
      workflows: [
        {
          path: '.github/workflows/ci.yml',
          contents: '    steps:\n      - run: npm run check:ghost\n',
        },
      ],
      allowlist: {},
    });

    expect(report.unenforced).toEqual([]);
    expect(report.enforced).toHaveLength(1);
  });

  it('ignores npm scripts that are not checks', () => {
    const report = evaluateCheckEnforcement({
      packageScripts: { build: 'tsc', 'test:watch': 'vitest' },
      workflows: [],
      allowlist: {},
    });

    expect(report.unenforced).toEqual([]);
  });
});

describe('the allowlists cannot rot quietly', () => {
  it('gives every uninvoked script a non-empty reason', () => {
    for (const [basename, reason] of Object.entries(UNINVOKED_SCRIPTS)) {
      expect(
        reason.trim().length,
        `${basename} needs a reason`,
      ).toBeGreaterThan(40);
    }
  });

  it('gives every unenforced check a non-empty reason', () => {
    for (const [key, reason] of Object.entries(UNENFORCED_CHECKS)) {
      expect(reason.trim().length, `${key} needs a reason`).toBeGreaterThan(40);
    }
  });

  it('names only scripts that still exist', () => {
    // An entry outliving its file silently pre-authorises a future script of
    // the same name — a suppression that outlives its cause is a hole.
    const present = new Set(scripts.map((filePath) => path.basename(filePath)));
    for (const basename of Object.keys(UNINVOKED_SCRIPTS)) {
      expect(
        present.has(basename),
        `${basename} is allowlisted but absent`,
      ).toBe(true);
    }
  });

  it('names only checks that still exist in package.json', () => {
    const defined = definedScripts();
    for (const key of Object.keys(UNENFORCED_CHECKS)) {
      expect(
        Object.prototype.hasOwnProperty.call(defined, key),
        `${key} is allowlisted but not defined`,
      ).toBe(true);
    }
  });

  it('holds no entry that is in fact invoked, so a stale exemption is caught', () => {
    const reachability = evaluateScriptReachability({ scripts, files });
    const invoked = new Set(
      reachability.invoked.map(({ basename }) => basename),
    );
    for (const basename of Object.keys(UNINVOKED_SCRIPTS)) {
      expect(
        invoked.has(basename),
        `${basename} is allowlisted as uninvoked but something does invoke it — remove the entry`,
      ).toBe(false);
    }
  });

  // The block above is the same guarantee for UNINVOKED_SCRIPTS, and it was the
  // only one. This block's name is plural and one of the two allowlists had no
  // rot guard at all: UNENFORCED_CHECKS was checked for a reason and for
  // existence in package.json, never for whether a workflow had since started
  // running it. Measured before this test was written — a stale
  // `check:citation-reachability` entry, present while
  // .github/workflows/citation-reachability.yml invokes it, left all 28 tests
  // green.
  //
  // It is not caught downstream either. `evaluateCheckEnforcement` sorts a wired
  // check into `enforced` before it consults the allowlist, so the entry is
  // never read and the checker exits 0. A dead justification is worse than a
  // missing one: it is the only account of policy a reader will find, and it
  // states the opposite of what CI now does.
  it('holds no check that a workflow now runs, so a stale exemption is caught', () => {
    const report = evaluateCheckEnforcement({
      packageScripts: definedScripts(),
      workflows,
      allowlist: UNENFORCED_CHECKS,
    });
    const enforced = new Set(report.enforced.map(({ key }) => key));

    // Positive control on the loop below: an empty allowlist would satisfy the
    // assertion by having nothing to assert about, and would read identically.
    expect(
      Object.keys(UNENFORCED_CHECKS).length,
      'UNENFORCED_CHECKS is empty, so the loop below cannot fail — delete this test or restore the allowlist',
    ).toBeGreaterThan(0);

    for (const key of Object.keys(UNENFORCED_CHECKS)) {
      expect(
        enforced.has(key),
        `${key} is allowlisted as unenforced but ${report.enforced
          .filter(({ key: enforcedKey }) => enforcedKey === key)
          .flatMap(({ workflows: paths }) => paths)
          .join(
            ', ',
          )} now runs it — remove the entry, its reason is no longer true`,
      ).toBe(false);
    }
  });
});
