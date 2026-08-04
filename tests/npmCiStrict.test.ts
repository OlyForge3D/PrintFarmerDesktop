import { describe, expect, it } from 'vitest';

import {
  CLEANUP_WARNING_MARKER,
  NODE_MODULES_REMOVAL,
  NPM_PRODUCTION_TREE_COMMAND,
  appendStepSummary,
  extractCleanupPaths,
  findTreeProblems,
  findUnresolvedPackages,
  formatStepSummary,
  formatWarningAnnotation,
  hasCleanupFailure,
  npmInvocation,
  removeNodeModules,
  repairOutcome,
  writeRepairArtifact,
} from '../scripts/npm-ci-strict.mjs';

/**
 * Verbatim from the run that produced #195: run 30860812970, job 91842161902,
 * `Desktop (windows-latest)`, step `Install dependencies`, at `23:02:35.628Z`.
 *
 * The step's own conclusion was **success**. That is the defect this guard
 * exists for, and this fixture is the evidence it is matched against.
 */
const RECORDED_CLEANUP_FAILURE = String.raw`
npm warn cleanup Failed to remove some directories [
npm warn cleanup   [
npm warn cleanup     'D:\a\PrintFarmerDesktop\PrintFarmerDesktop\node_modules\parse-color',
npm warn cleanup     [Error: EPERM: operation not permitted, rmdir
                     'D:\a\PrintFarmerDesktop\PrintFarmerDesktop\node_modules\parse-color\node_modules\color-convert'] {
npm warn cleanup       errno: -4048,  code: 'EPERM',  syscall: 'rmdir',
npm warn cleanup     }
npm warn cleanup   ]
npm warn cleanup ]

added 1174 packages, and audited 1175 packages in 41s
`;

/**
 * A successful install on the same runner image. The negative control: if the
 * marker matched this, the guard would fail every job and would be removed
 * within a day.
 */
const CLEAN_INSTALL_OUTPUT = `
npm warn deprecated inflight@1.0.6: This module is not supported
added 1174 packages, and audited 1175 packages in 39s

208 packages are looking for funding
  run \`npm fund\` for details

found 0 vulnerabilities
`;

/** The real production tree, as measured by \`npm ls --omit=dev --all --json\`. */
const CLEAN_PRODUCTION_TREE = {
  version: '0.1.0-beta.2',
  name: 'printfarmer-desktop',
  dependencies: {
    'react-dom': {
      version: '18.3.1',
      dependencies: {
        'loose-envify': {
          version: '1.4.0',
          dependencies: { 'js-tokens': { version: '4.0.0' } },
        },
        react: { version: '18.3.1' },
        scheduler: {
          version: '0.23.2',
          dependencies: { 'loose-envify': { version: '1.4.0' } },
        },
      },
    },
    react: {
      version: '18.3.1',
      dependencies: { 'loose-envify': { version: '1.4.0' } },
    },
    three: { version: '0.169.0' },
    zod: { version: '3.25.76' },
  },
};

describe('the cleanup-failure marker is pinned to npm’s recorded wording', () => {
  it('fires on the exact output npm produced when the wipe failed', () => {
    expect(hasCleanupFailure(RECORDED_CLEANUP_FAILURE)).toBe(true);
  });

  it('does not fire on a successful install — the negative control', () => {
    // Without this, a marker that matched everything would look identical to a
    // marker that worked, until it failed every job in the repository at once.
    expect(hasCleanupFailure(CLEAN_INSTALL_OUTPUT)).toBe(false);
  });

  it('pins the substring itself, so an npm reword breaks this test rather than the guard', () => {
    // `CLEANUP_WARNING_MARKER` is the only text-matched thing in this guard.
    // If npm changes the message, this assertion fails loudly here instead of
    // the guard silently never firing again.
    expect(RECORDED_CLEANUP_FAILURE).toContain(CLEANUP_WARNING_MARKER);
  });

  it('is specific enough that a plausible reworded message does not match', () => {
    // Demonstrates the marker discriminates on the sentence rather than on the
    // words `npm warn`, which appear in ordinary deprecation notices.
    const reworded =
      'npm warn cleanup Could not delete some folders [ ... ]\nadded 1174 packages';
    expect(hasCleanupFailure(reworded)).toBe(false);
  });

  it('ignores non-string input rather than throwing', () => {
    expect(hasCleanupFailure(undefined)).toBe(false);
    expect(hasCleanupFailure(null)).toBe(false);
  });
});

describe('the directories npm named are reported as context', () => {
  it('names the package from the recorded failure', () => {
    expect(extractCleanupPaths(RECORDED_CLEANUP_FAILURE)).toContain(
      'parse-color',
    );
  });

  it('returns nothing for output that names no node_modules path', () => {
    expect(extractCleanupPaths(CLEAN_INSTALL_OUTPUT)).toEqual([]);
  });
});

describe('the structural walk detects a tree npm cannot resolve', () => {
  it('passes the real clean production tree — the negative control', () => {
    // An assertion that only ever fires on broken input cannot distinguish
    // "tree is clean" from "walk is broken". This is the other half.
    expect(findUnresolvedPackages(CLEAN_PRODUCTION_TREE)).toEqual([]);
  });

  it('names a dependency node that carries no version', () => {
    // This is the shape the SBOM gate threw on: `cannot identify npm ls
    // package parse-color`. Detected here at install time instead.
    const stale = {
      ...CLEAN_PRODUCTION_TREE,
      dependencies: {
        ...CLEAN_PRODUCTION_TREE.dependencies,
        'parse-color': {},
      },
    };
    expect(findUnresolvedPackages(stale)).toEqual(['parse-color']);
  });

  it('names a nested dependency, not only a top-level one', () => {
    const stale = {
      dependencies: {
        react: {
          version: '18.3.1',
          dependencies: { 'loose-envify': { version: '' } },
        },
      },
    };
    expect(findUnresolvedPackages(stale)).toEqual(['loose-envify']);
  });

  it('names a package npm marked extraneous even when it has a version', () => {
    // A leftover directory that still parses is exactly what a partial wipe
    // leaves behind, and it is not in the lockfile tree.
    const stale = {
      dependencies: {
        'parse-color': { version: '1.0.0', extraneous: true },
      },
    };
    expect(findUnresolvedPackages(stale)).toEqual(['parse-color']);
  });

  it('names a package npm marked invalid, in the shape npm actually emits', () => {
    // Measured, not invented. npm emits `invalid` as a STRING naming the range
    // that is not satisfied, and it emits it alongside a perfectly good
    // `version` — so neither `=== true` nor the version check catches this.
    //
    //   package.json says ^7.0.0, node_modules holds 6.3.1:
    //     "semver": { "version": "6.3.1",
    //                 "invalid": "\"^7.0.0\" from the root project" }
    //
    // That is what a partial wipe leaves: a real, parseable, wrong version.
    const stale = {
      dependencies: {
        semver: {
          version: '6.3.1',
          invalid: '"^7.0.0" from the root project',
        },
      },
    };
    expect(findUnresolvedPackages(stale)).toEqual(['semver']);
  });

  it('does not flag a node whose `invalid` npm left as false', () => {
    // The other half: reading `invalid` as truthy must not turn an explicitly
    // negative flag into a failure, or the guard fails every clean install.
    const fine = {
      dependencies: {
        semver: { version: '7.6.0', invalid: false, extraneous: false },
      },
    };
    expect(findUnresolvedPackages(fine)).toEqual([]);
  });

  it('fails closed when `dependencies` is a shape npm does not emit', () => {
    // `typeof [] === 'object'`, so an array used to walk to zero entries and
    // report success. Every malformed tree was a pass.
    expect(findUnresolvedPackages({ dependencies: [] })).not.toEqual([]);
    expect(findUnresolvedPackages({ dependencies: 'broken' })).not.toEqual([]);
    expect(findUnresolvedPackages({ dependencies: null })).not.toEqual([]);
  });

  it('names the parent when a nested `dependencies` is malformed', () => {
    const stale = {
      dependencies: { react: { version: '18.3.1', dependencies: 7 } },
    };
    expect(findUnresolvedPackages(stale)).toEqual([
      'react (npm ls returned a number for its `dependencies`)',
    ]);
  });

  it('reports nothing for a tree with no dependencies at all', () => {
    expect(findUnresolvedPackages({ name: 'x', version: '1.0.0' })).toEqual([]);
  });

  it('terminates on a self-referential tree', () => {
    const cyclic: Record<string, unknown> = { version: '1.0.0' };
    cyclic.dependencies = { self: cyclic };
    expect(findUnresolvedPackages({ dependencies: { root: cyclic } })).toEqual(
      [],
    );
  });
});

describe('npm’s own verdict on the tree is read, not just the tree', () => {
  it('passes the real clean production tree — the negative control', () => {
    // Measured against real npm on this repository: a healthy tree carries no
    // `problems` and no `error` key at all. Without this, a check that fired on
    // every install would be indistinguishable from one that worked.
    expect(findTreeProblems(CLEAN_PRODUCTION_TREE)).toEqual([]);
  });

  it('reports an extraneous package that npm flagged while exiting 0', () => {
    // Measured: an undeclared package in node_modules makes `npm ls` print
    // `problems` and still exit 0. The exit code alone would clear this.
    const tree = {
      ...CLEAN_PRODUCTION_TREE,
      problems: ['extraneous: ghost@9.9.9 /repo/node_modules/ghost'],
    };
    expect(findTreeProblems(tree)).toEqual([
      'extraneous: ghost@9.9.9 /repo/node_modules/ghost',
    ]);
  });

  it('reports npm’s error code and summary when npm set one', () => {
    const tree = {
      ...CLEAN_PRODUCTION_TREE,
      error: { code: 'ELSPROBLEMS', summary: 'invalid: left-pad@' },
    };
    expect(findTreeProblems(tree)).toContain(
      'npm reported ELSPROBLEMS: invalid: left-pad@',
    );
  });

  it('reports a tree that carries an error and no dependencies at all', () => {
    // An unparseable `package.json` yields valid JSON with no `dependencies`
    // key. A structural walk finds nothing to walk and reports success, so this
    // is the case the walk structurally cannot see.
    const tree = {
      invalid: true,
      problems: ['error in /repo/package.json'],
      error: { code: 'EJSONPARSE', summary: 'Unexpected token' },
    };
    expect(findTreeProblems(tree).length).toBeGreaterThan(0);
    expect(findUnresolvedPackages(tree)).toEqual([]);
  });

  it('reports a root that is not an object, rather than passing it', () => {
    for (const root of [null, [], 'broken', 42]) {
      expect(findTreeProblems(root).length).toBeGreaterThan(0);
    }
  });
});

describe('npm is invoked the way the other scripts in this repo invoke it', () => {
  it('routes through the Windows command interpreter, where npm is a .cmd shim', () => {
    const invocation = npmInvocation(NPM_PRODUCTION_TREE_COMMAND);
    if (process.platform === 'win32') {
      expect(invocation.args).toEqual([
        '/d',
        '/s',
        '/c',
        NPM_PRODUCTION_TREE_COMMAND,
      ]);
    } else {
      expect(invocation.command).toBe('npm');
      expect(invocation.args[0]).toBe('ls');
    }
  });

  it('reads the same production tree the SBOM gate reads', () => {
    // If these ever diverge, this guard would certify a different tree from the
    // one the supply-chain gate later refuses, and the earlier check would be
    // answering a neighbouring question.
    expect(NPM_PRODUCTION_TREE_COMMAND).toBe('npm ls --omit=dev --all --json');
  });
});

describe('the discharge path removes node_modules with an EPERM-tolerant wipe (#274)', () => {
  it('passes recursive/force and the retry options fs.rmSync honours on EPERM', () => {
    // The whole point of the wipe is that npm lost a race with a Windows file
    // lock. fs.rmSync retries EPERM only when `recursive` is set and only up to
    // `maxRetries`, so a wipe missing those would give up exactly where npm did.
    const calls: Array<{ dir: string; options: Record<string, unknown> }> = [];
    const fakeRm = ((dir: string, options: Record<string, unknown>) => {
      calls.push({ dir, options });
    }) as unknown as typeof import('node:fs').rmSync;

    removeNodeModules('/repo/node_modules', { rm: fakeRm });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.dir).toBe('/repo/node_modules');
    expect(call?.options).toMatchObject({
      recursive: true,
      force: true,
      maxRetries: NODE_MODULES_REMOVAL.maxRetries,
      retryDelay: NODE_MODULES_REMOVAL.retryDelay,
    });
  });

  it('retries more than once — a single attempt is what npm already did', () => {
    // A maxRetries of 0 or 1 would not distinguish this wipe from npm's own
    // failed in-place cleanup. Measured lower bound, not a style preference.
    expect(NODE_MODULES_REMOVAL.maxRetries).toBeGreaterThan(1);
  });
});

describe('the repair decides on the reinstalled tree, not on the warning (#274)', () => {
  const clean = {
    secondExitCode: 0,
    secondWarned: false,
    problems: [],
    unresolved: [],
  };

  it('succeeds when every direct check on the reinstalled tree is clean', () => {
    // This is the residue case: npm could not delete a directory, but a clean
    // reinstall resolves it. The proxy said "broken"; the direct measurement
    // says "fine". The repair must trust the direct measurement.
    expect(repairOutcome(clean)).toEqual({ succeeded: true, reasons: [] });
  });

  it('fails when the second npm ci did not exit 0', () => {
    const outcome = repairOutcome({ ...clean, secondExitCode: 1 });
    expect(outcome.succeeded).toBe(false);
    expect(outcome.reasons).toContain(
      'the second `npm ci` exited 1 rather than 0',
    );
  });

  it('fails when npm warned again after the explicit wipe', () => {
    const outcome = repairOutcome({ ...clean, secondWarned: true });
    expect(outcome.succeeded).toBe(false);
    expect(outcome.reasons).toContain(
      'npm again reported it could not finish removing node_modules after the explicit wipe',
    );
  });

  it('fails and surfaces every structural problem npm ls reported', () => {
    const outcome = repairOutcome({
      ...clean,
      problems: ['extraneous: ghost@9.9.9 /repo/node_modules/ghost'],
    });
    expect(outcome.succeeded).toBe(false);
    expect(outcome.reasons).toContain(
      'extraneous: ghost@9.9.9 /repo/node_modules/ghost',
    );
  });

  it('fails and names each unresolvable package — the #195 shape', () => {
    // parse-color is the exact package the SBOM gate died on in #195. A repair
    // that left it unresolvable must not report success.
    const outcome = repairOutcome({ ...clean, unresolved: ['parse-color'] });
    expect(outcome.succeeded).toBe(false);
    expect(outcome.reasons).toContain(
      'npm cannot resolve `parse-color` in the reinstalled tree',
    );
  });
});

describe('the repair records that it happened, durably enough for the job log (#274)', () => {
  const passRecord = {
    firstPaths: ['parse-color', 'color-convert'],
    secondExitCode: 0,
    secondWarned: false,
    problems: [],
    unresolved: [],
    succeeded: true,
  };

  it('writes a PASS summary that names the repaired directories and cites #274', () => {
    // The load-bearing judgement of this change is that a repair which PASSES is
    // recorded rather than hidden. If the summary did not mark PASS, the record
    // would not distinguish the repaired-clean case from the ordinary one.
    const summary = formatStepSummary(passRecord);
    expect(summary).toContain('**PASS**');
    expect(summary).toContain('parse-color');
    expect(summary).toContain('#274');
  });

  it('writes a FAIL summary that says re-running will not help', () => {
    const summary = formatStepSummary({
      ...passRecord,
      unresolved: ['parse-color'],
      succeeded: false,
    });
    expect(summary).toContain('**FAIL**');
    expect(summary).toContain('will not help');
  });

  it('emits a ::warning:: annotation carrying the outcome and #274', () => {
    const annotation = formatWarningAnnotation(passRecord);
    expect(annotation.startsWith('::warning ')).toBe(true);
    expect(annotation).toContain('PASS');
    expect(annotation).toContain('#274');
  });

  it('appends to $GITHUB_STEP_SUMMARY when the runner set it', () => {
    const writes: Array<{ target: string; body: string }> = [];
    const append = ((target: string, body: string) => {
      writes.push({ target, body });
    }) as unknown as typeof import('node:fs').appendFileSync;

    const wrote = appendStepSummary('hello', {
      env: { GITHUB_STEP_SUMMARY: '/tmp/summary.md' },
      append,
    });

    expect(wrote).toBe(true);
    expect(writes).toEqual([{ target: '/tmp/summary.md', body: 'hello\n' }]);
  });

  it('does nothing when $GITHUB_STEP_SUMMARY is unset — as it is off CI', () => {
    // The other half: locally there is no summary file, and the script must not
    // throw trying to append to undefined.
    let called = false;
    const append = (() => {
      called = true;
    }) as unknown as typeof import('node:fs').appendFileSync;

    const wrote = appendStepSummary('hello', { env: {}, append });

    expect(wrote).toBe(false);
    expect(called).toBe(false);
  });

  it('serialises the repair record as JSON for the uploaded artifact', () => {
    let written = '';
    const write = ((_target: string, body: string) => {
      written = body;
    }) as unknown as typeof import('node:fs').writeFileSync;

    writeRepairArtifact(passRecord, '/repo/npm-ci-strict-repair.json', {
      write,
    });

    expect(JSON.parse(written)).toMatchObject({
      firstPaths: ['parse-color', 'color-convert'],
      succeeded: true,
    });
  });
});
