import { describe, expect, it } from 'vitest';

import {
  CLEANUP_WARNING_MARKER,
  MAX_INSTALL_ATTEMPTS,
  NPM_PRODUCTION_TREE_COMMAND,
  REMOVAL_RETRY,
  exhaustedFailureLines,
  extractCleanupPaths,
  findTreeProblems,
  findUnresolvedPackages,
  hasCleanupFailure,
  npmInvocation,
  planInstallOutcome,
  recoveryNotice,
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

describe('the gate has a discharge path it can execute itself (#274)', () => {
  it('accepts a clean install — the negative control', () => {
    // Without this, every assertion below is satisfied by a function that
    // returns 'retry' or 'fail' unconditionally.
    expect(planInstallOutcome(CLEAN_INSTALL_OUTPUT, 1)).toEqual({
      action: 'accept',
      paths: [],
    });
  });

  it('retries the recorded failure instead of failing on first sight', () => {
    const outcome = planInstallOutcome(RECORDED_CLEANUP_FAILURE, 1);
    expect(outcome.action).toBe('retry');
    // The paths are carried through, so the recovery notice can name them.
    expect(outcome.paths).toContain('parse-color');
  });

  it('fails once the budget is spent, on the same input that retried', () => {
    // Same output, different attempt number: the attempt counter is what
    // separates these, so a plan that ignored it would fail one of the two.
    expect(planInstallOutcome(RECORDED_CLEANUP_FAILURE, 1).action).toBe(
      'retry',
    );
    expect(
      planInstallOutcome(RECORDED_CLEANUP_FAILURE, MAX_INSTALL_ATTEMPTS).action,
    ).toBe('fail');
  });

  it('fails closed when the attempt counter is not a positive integer', () => {
    // A NaN counter must not read as "attempt < max" and loop forever.
    for (const attempt of [0, -1, 1.5, Number.NaN, undefined, '1']) {
      expect(
        planInstallOutcome(RECORDED_CLEANUP_FAILURE, attempt as number).action,
      ).toBe('fail');
    }
  });

  it('budgets at least one retry, or the discharge path does not exist', () => {
    expect(MAX_INSTALL_ATTEMPTS).toBeGreaterThanOrEqual(2);
    expect(REMOVAL_RETRY.maxRetries).toBeGreaterThan(0);
    expect(REMOVAL_RETRY.retryDelay).toBeGreaterThan(0);
  });

  it('records the failure in the log even when the retry rescues the run', () => {
    // #274 defect 2: a recovered run is green, so if the notice were silent the
    // wipe failure would leave no trace anywhere.
    const notice = recoveryNotice(['parse-color'], 1, 2).join('\n');
    expect(notice).toContain('attempt 1 of 2');
    expect(notice).toContain('parse-color');
    // It must distinguish itself from the forbidden action, not resemble it.
    expect(notice).toContain('same job');
    expect(notice).toContain('#274');
  });

  it('states what was already tried when the budget is spent', () => {
    const lines = exhaustedFailureLines(['parse-color'], 2);
    const text = lines.join('\n');
    // The original message forbade re-running and named no alternative. This one
    // has to say the cheap remedy is spent, or it is the same deadlock.
    expect(text).toContain('already removed node_modules and reinstalled');
    expect(text).toContain('2 attempts');
    expect(text).toContain('Escalate');
    expect(text).toContain('parse-color');
  });

  it('cites the live issue and not only the closed one', () => {
    // #274 defect 3: `See #195` sends a reader to a CLOSED issue for the
    // explanation of a control that is still live.
    const text = exhaustedFailureLines([], 2).join('\n');
    expect(text).toContain('#274');
    expect(text).toContain('#195');
  });

  it('omits the directory line when npm named nothing, without a blank gap', () => {
    const text = exhaustedFailureLines([], 2).join('\n');
    expect(text).not.toContain('Directories npm named');
    expect(text).not.toContain('\n\n\n');
  });
});
