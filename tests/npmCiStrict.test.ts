import { describe, expect, it } from 'vitest';

import {
  CLEANUP_WARNING_MARKER,
  NPM_PRODUCTION_TREE_COMMAND,
  extractCleanupPaths,
  findUnresolvedPackages,
  hasCleanupFailure,
  npmInvocation,
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

  it('names a package npm marked invalid', () => {
    const stale = {
      dependencies: { three: { version: '0.1.0', invalid: true } },
    };
    expect(findUnresolvedPackages(stale)).toEqual(['three']);
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
