import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  CLEANUP_FAILURE_DIAGNOSTIC,
  CLEANUP_FAILURE_ANCHOR,
  CLEANUP_WARNING_MARKER,
  NPM_PRODUCTION_TREE_COMMAND,
  createCleanupEvidence,
  extractCleanupDirectories,
  extractCleanupPaths,
  findTreeExitProblems,
  findTreeProblems,
  findUnresolvedPackages,
  hasCleanupFailure,
  main,
  markCleanupEvidenceOutput,
  npmInvocation,
  retryCleanupRemovals,
  writeCleanupEvidence,
  type CleanupRecovery,
  type MainDependencies,
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

interface OrchestrationHarnessOptions {
  install?: { code: number; output: string };
  recovery?: CleanupRecovery;
  tree?: unknown;
  treeStatus?: unknown;
  treeStderr?: string;
}

function createOrchestrationHarness({
  install = { code: 0, output: CLEAN_INSTALL_OUTPUT },
  recovery = {
    attempted: true,
    recovered: true,
    directories: ['parse-color'],
    reason: null,
  },
  tree = CLEAN_PRODUCTION_TREE,
  treeStatus = 0,
  treeStderr = '',
}: OrchestrationHarnessOptions = {}) {
  const calls: string[] = [];
  const runNpmCi = vi.fn(() => {
    calls.push('npm-ci');
    return Promise.resolve(install);
  });
  const retryCleanupRemovalsImpl = vi.fn(() => {
    calls.push('cleanup-retry');
    return Promise.resolve(recovery);
  });
  const writeCleanupEvidenceImpl = vi.fn(() => {
    calls.push('write-evidence');
    return Promise.resolve('C:\\temp\\npm-cleanup-evidence.json');
  });
  const markCleanupEvidenceOutputImpl = vi.fn(() => {
    calls.push('mark-evidence');
    return Promise.resolve(true);
  });
  const readProductionTree = vi.fn(() => {
    calls.push('production-tree');
    return { tree, status: treeStatus, stderr: treeStderr };
  });
  const fail = vi.fn((lines: string[]) => {
    calls.push('fail');
    expect(lines).not.toEqual([]);
  });
  const exit = vi.fn((code: number) => {
    calls.push(`exit:${code}`);
  });
  const writeStderr = vi.fn(() => {
    calls.push('stderr');
  });
  const dependencies = {
    runNpmCi,
    retryCleanupRemovals: retryCleanupRemovalsImpl,
    writeCleanupEvidence: writeCleanupEvidenceImpl,
    markCleanupEvidenceOutput: markCleanupEvidenceOutputImpl,
    readProductionTree,
    fail,
    exit,
    writeStderr,
  } satisfies Partial<MainDependencies>;

  return {
    calls,
    dependencies,
    exit,
    fail,
    markCleanupEvidenceOutput: markCleanupEvidenceOutputImpl,
    readProductionTree,
    retryCleanupRemovals: retryCleanupRemovalsImpl,
    runNpmCi,
    writeCleanupEvidence: writeCleanupEvidenceImpl,
    writeStderr,
  };
}

describe('npm-ci-strict main orchestration', () => {
  it('exits immediately with the first npm ci nonzero code', async () => {
    const harness = createOrchestrationHarness({
      install: { code: 37, output: RECORDED_CLEANUP_FAILURE },
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual(['npm-ci', 'exit:37']);
    expect(harness.exit).toHaveBeenCalledWith(37);
    expect(harness.retryCleanupRemovals).not.toHaveBeenCalled();
    expect(harness.readProductionTree).not.toHaveBeenCalled();
  });

  it('bypasses cleanup recovery for a clean install and validates the production tree', async () => {
    const harness = createOrchestrationHarness();

    await main(harness.dependencies);

    expect(harness.calls).toEqual(['npm-ci', 'production-tree']);
    expect(harness.retryCleanupRemovals).not.toHaveBeenCalled();
    expect(harness.fail).not.toHaveBeenCalled();
  });

  it('routes the exact cleanup warning to bounded recovery before tree validation', async () => {
    const harness = createOrchestrationHarness({
      install: { code: 0, output: RECORDED_CLEANUP_FAILURE },
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual([
      'npm-ci',
      'cleanup-retry',
      'stderr',
      'production-tree',
    ]);
    expect(harness.retryCleanupRemovals).toHaveBeenCalledWith(
      RECORDED_CLEANUP_FAILURE,
    );
    expect(harness.writeStderr).toHaveBeenCalledWith(
      "npm-ci-strict: retried npm's requested Windows removal for parse-color; validating the resulting tree before continuing.\n",
    );
    expect(harness.fail).not.toHaveBeenCalled();
  });

  it('validates and rejects an unresolved production tree after cleanup recovery', async () => {
    const harness = createOrchestrationHarness({
      install: { code: 0, output: RECORDED_CLEANUP_FAILURE },
      tree: {
        ...CLEAN_PRODUCTION_TREE,
        dependencies: {
          ...CLEAN_PRODUCTION_TREE.dependencies,
          'parse-color': {},
        },
      },
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual([
      'npm-ci',
      'cleanup-retry',
      'stderr',
      'production-tree',
      'fail',
    ]);
    expect(harness.fail).toHaveBeenCalledWith(
      expect.arrayContaining([
        'npm-ci-strict: the installed production tree contains packages npm cannot resolve.',
        'Unresolvable: parse-color',
      ]),
    );
  });

  it('stages and marks evidence before hard-failing unrecovered cleanup', async () => {
    const recovery = {
      attempted: true,
      recovered: false,
      directories: ['parse-color'],
      reason: 'retry failed: EPERM still locked',
    };
    const harness = createOrchestrationHarness({
      install: { code: 0, output: RECORDED_CLEANUP_FAILURE },
      recovery,
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual([
      'npm-ci',
      'cleanup-retry',
      'write-evidence',
      'mark-evidence',
      'fail',
    ]);
    expect(harness.writeCleanupEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        cleanupDirectories: recovery.directories,
        diagnostic: CLEANUP_FAILURE_DIAGNOSTIC,
        recovery: {
          attempted: recovery.attempted,
          recovered: recovery.recovered,
          reason: recovery.reason,
        },
      }),
    );
    expect(harness.markCleanupEvidenceOutput).toHaveBeenCalledOnce();
    expect(harness.fail).toHaveBeenCalledWith([
      '',
      CLEANUP_FAILURE_DIAGNOSTIC,
      '',
      'The installed tree is therefore neither the lockfile tree nor a clean one,',
      'and every later step in this job would run against it.',
      'Directories npm named: parse-color, color-convert',
      'Automatic recovery: retry failed: EPERM still locked.',
      'Durable evidence staged at C:\\temp\\npm-cleanup-evidence.json.',
      '',
      'Do not rerun this job directly. Follow docs/npm-cleanup-recovery.md;',
      'the discharge workflow requires a justification, preserves the failed job',
      'reference on #274, and refuses to rerun mixed or policy failures.',
      '',
    ]);
    expect(harness.readProductionTree).not.toHaveBeenCalled();
  });

  it('hard-fails when npm reports production-tree problems after a clean install', async () => {
    const problem = 'extraneous: ghost@9.9.9 D:\\repo\\node_modules\\ghost';
    const harness = createOrchestrationHarness({
      tree: { ...CLEAN_PRODUCTION_TREE, problems: [problem] },
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual(['npm-ci', 'production-tree', 'fail']);
    expect(harness.fail).toHaveBeenCalledWith(
      expect.arrayContaining([
        'npm-ci-strict: npm itself reported problems with the installed tree.',
        `  - ${problem}`,
      ]),
    );
  });
  it('hard-fails on a non-zero `npm ls` exit even when npm set no problems', async () => {
    // The load-bearing test for #255. The tree is the real clean one, so
    // `findTreeProblems` returns nothing and the exit-status check is the only
    // thing in the guard that can fire. The control below is what makes that
    // claim readable rather than asserted: same tree, status 0, guard passes.
    expect(findTreeProblems(CLEAN_PRODUCTION_TREE)).toEqual([]);

    const harness = createOrchestrationHarness({
      tree: CLEAN_PRODUCTION_TREE,
      treeStatus: 1,
      treeStderr: 'npm error code ELSPROBLEMS\n',
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual(['npm-ci', 'production-tree', 'fail']);
    const lines: string[] = harness.fail.mock.calls[0]?.[0] ?? [];
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.includes('exited 1'))).toBe(true);
    expect(lines.some((line) => line.includes('ELSPROBLEMS'))).toBe(true);
  });

  it('passes the same tree when npm exits 0 — the control for the test above', async () => {
    const harness = createOrchestrationHarness({
      tree: CLEAN_PRODUCTION_TREE,
      treeStatus: 0,
    });

    await main(harness.dependencies);

    expect(harness.calls).toEqual(['npm-ci', 'production-tree']);
    expect(harness.fail).not.toHaveBeenCalled();
  });

  it('keeps npm’s problem strings in the message when both channels fire', async () => {
    // The exit status says the tree was refused; `problems` says which package.
    // Reporting only the first would trade an actionable message for a status.
    const problem = 'invalid: semver@6.3.1 D:\\repo\\node_modules\\semver';
    const harness = createOrchestrationHarness({
      tree: { ...CLEAN_PRODUCTION_TREE, problems: [problem] },
      treeStatus: 1,
    });

    await main(harness.dependencies);

    expect(harness.fail).toHaveBeenCalledWith(
      expect.arrayContaining([`  - ${problem}`]),
    );
  });
});

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

  it('keeps the diagnostic anchor distinct from the constant-positive script header', () => {
    expect(CLEANUP_FAILURE_ANCHOR).toBe(
      'could not finish removing node_modules',
    );
    expect('Run node scripts/npm-ci-strict.mjs').not.toContain(
      CLEANUP_FAILURE_ANCHOR,
    );
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

  it('bounds the retry to the shallowest npm-named directory', () => {
    expect(extractCleanupDirectories(RECORDED_CLEANUP_FAILURE)).toEqual([
      'parse-color',
    ]);
  });

  it('rejects a quoted path that escapes node_modules', () => {
    const hostile = String.raw`npm warn cleanup 'D:\repo\node_modules\..\package.json'`;
    expect(extractCleanupDirectories(hostile)).toEqual([]);
  });

  it('ignores quoted paths outside the retryable EPERM cleanup block', () => {
    const output = `${RECORDED_CLEANUP_FAILURE}
postinstall: diagnostic 'D:\\repo\\node_modules\\unrelated-tool'`;
    expect(extractCleanupDirectories(output)).toEqual(['parse-color']);
  });

  it('does not retry a neighbouring non-EPERM entry in the same cleanup block', () => {
    const mixed = String.raw`
npm warn cleanup Failed to remove some directories [
npm warn cleanup   [
npm warn cleanup     'D:\repo\node_modules\unrelated-tool',
npm warn cleanup     [Error: EACCES: permission denied, unlink
                     'D:\repo\node_modules\unrelated-tool\locked.file'] {
npm warn cleanup       code: 'EACCES', syscall: 'unlink',
npm warn cleanup     }
npm warn cleanup   ]
npm warn cleanup   [
npm warn cleanup     'D:\repo\node_modules\parse-color',
npm warn cleanup     [Error: EPERM: operation not permitted, rmdir
                     'D:\repo\node_modules\parse-color\node_modules\color-convert'] {
npm warn cleanup       code: 'EPERM', syscall: 'rmdir',
npm warn cleanup     }
npm warn cleanup   ]
npm warn cleanup ]`;
    expect(extractCleanupDirectories(mixed)).toEqual(['parse-color']);
  });
});

describe('Windows cleanup recovery retries removal without weakening validation', () => {
  it('retries only the bounded directory with Windows EPERM retry options', async () => {
    const rmImpl = vi.fn().mockResolvedValue(undefined);
    const result = await retryCleanupRemovals(RECORDED_CLEANUP_FAILURE, {
      platform: 'win32',
      root: path.resolve('C:\\repo'),
      rmImpl,
    });

    expect(result).toEqual({
      attempted: true,
      recovered: true,
      directories: ['parse-color'],
      reason: null,
    });
    expect(rmImpl).toHaveBeenCalledOnce();
    expect(rmImpl).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]node_modules[\\/]parse-color$/),
      {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 250,
      },
    );
  });

  it('does not apply the Windows remedy on another platform', async () => {
    const rmImpl = vi.fn();
    const result = await retryCleanupRemovals(RECORDED_CLEANUP_FAILURE, {
      platform: 'darwin',
      rmImpl,
    });

    expect(result.recovered).toBe(false);
    expect(result.reason).toContain('restricted to Windows');
    expect(rmImpl).not.toHaveBeenCalled();
  });

  it('does not retry a non-EPERM cleanup warning', async () => {
    const eacces = RECORDED_CLEANUP_FAILURE.replaceAll('EPERM', 'EACCES');
    const rmImpl = vi.fn();
    const result = await retryCleanupRemovals(eacces, {
      platform: 'win32',
      rmImpl,
    });

    expect(result.recovered).toBe(false);
    expect(result.reason).toContain('EPERM/rmdir');
    expect(rmImpl).not.toHaveBeenCalled();
  });

  it('surfaces a removal failure instead of treating the warning as recovered', async () => {
    const rmImpl = vi.fn().mockRejectedValue(new Error('EPERM still locked'));
    await expect(
      retryCleanupRemovals(RECORDED_CLEANUP_FAILURE, {
        platform: 'win32',
        rmImpl,
      }),
    ).rejects.toThrow('EPERM still locked');
  });
});

describe('cleanup failure evidence is staged for durable publication', () => {
  const environment = {
    GITHUB_REPOSITORY: 'OlyForge3D/PrintFarmerDesktop',
    GITHUB_RUN_ID: '30917030009',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: 'b'.repeat(40),
    GITHUB_JOB: 'package',
    GITHUB_WORKFLOW: 'CI',
    GITHUB_SERVER_URL: 'https://github.com',
    RUNNER_OS: 'Windows',
    RUNNER_NAME: 'GitHub Actions 7',
    NPM_CLEANUP_EVIDENCE_PATH: 'C:\\temp\\npm-cleanup-evidence.json',
    GITHUB_OUTPUT: 'C:\\temp\\github-output.txt',
  };
  const recovery = {
    attempted: true,
    recovered: false,
    directories: ['parse-color'],
    reason: 'retry failed: EPERM still locked',
  };

  it('records the exact anchor and run attempt reference', () => {
    const evidence = createCleanupEvidence({
      output: RECORDED_CLEANUP_FAILURE,
      recovery,
      environment,
      recordedAt: '2026-08-04T14:00:00.000Z',
    });

    expect(evidence.anchor).toBe(CLEANUP_FAILURE_ANCHOR);
    expect(evidence.diagnostic).toBe(CLEANUP_FAILURE_DIAGNOSTIC);
    expect(evidence.runUrl).toBe(
      'https://github.com/OlyForge3D/PrintFarmerDesktop/actions/runs/30917030009/attempts/1',
    );
    expect(evidence.cleanupPaths).toEqual(['parse-color', 'color-convert']);
    expect(evidence.warningExcerpt.join('\n')).toContain('EPERM');
  });

  it('writes the evidence before marking the failing step for publication', async () => {
    const operations: string[] = [];
    const evidence = createCleanupEvidence({
      output: RECORDED_CLEANUP_FAILURE,
      recovery,
      environment,
    });
    await writeCleanupEvidence(evidence, {
      environment,
      mkdirImpl: vi.fn(() => {
        operations.push('mkdir');
        return Promise.resolve();
      }),
      writeFileImpl: vi.fn((_file, contents) => {
        operations.push('write');
        expect(contents).toContain(CLEANUP_FAILURE_ANCHOR);
        return Promise.resolve();
      }),
    });
    await markCleanupEvidenceOutput(
      environment,
      vi.fn((_file, contents) => {
        operations.push('output');
        expect(contents).toContain('cleanup_evidence=true');
        return Promise.resolve();
      }),
    );

    expect(operations).toEqual(['mkdir', 'write', 'output']);
  });

  it('fails recording loudly when the evidence file cannot be written', async () => {
    const evidence = createCleanupEvidence({
      output: RECORDED_CLEANUP_FAILURE,
      recovery,
      environment,
    });
    await expect(
      writeCleanupEvidence(evidence, {
        environment,
        mkdirImpl: vi.fn().mockResolvedValue(undefined),
        writeFileImpl: vi.fn().mockRejectedValue(new Error('disk full')),
      }),
    ).rejects.toThrow('disk full');
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

describe('npm’s exit status is read, not only the JSON it printed', () => {
  it('passes a status of 0 — the negative control', () => {
    // Without this the check would be indistinguishable from one that fires on
    // every read, and every assertion below would pass for the wrong reason.
    expect(findTreeExitProblems(0, '')).toEqual([]);
  });

  it('reports a non-zero status, naming the code', () => {
    const problems = findTreeExitProblems(1, '');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('exited 1');
  });

  it('carries npm’s first non-empty stderr line into the message', () => {
    // A bare exit code sends the reader back to the terminal. npm's own first
    // line usually names the package, which is the actionable half.
    const problems = findTreeExitProblems(
      1,
      '\n\nnpm error code ELSPROBLEMS\nnpm error invalid: semver@6.3.1\n',
    );
    expect(problems[0]).toContain('npm error code ELSPROBLEMS');
    expect(problems[0]).not.toContain('\n');
  });

  it('fails closed on null, which spawnSync reports for a killed child', () => {
    // `status` is null when the child died on a signal and when the spawn never
    // happened. Neither produced a tree anyone should walk, and a predicate
    // written as `status > 0` or `status === 1` clears both.
    expect(findTreeExitProblems(null, '').length).toBeGreaterThan(0);
    expect(findTreeExitProblems(undefined, '').length).toBeGreaterThan(0);
  });

  it('does not depend on stderr being a string', () => {
    expect(findTreeExitProblems(1, undefined)).toHaveLength(1);
    expect(findTreeExitProblems(1, null)).toHaveLength(1);
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
