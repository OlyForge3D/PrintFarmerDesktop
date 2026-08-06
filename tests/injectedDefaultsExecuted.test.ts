// @vitest-environment node

/**
 * Execute the unexported injected defaults. Origin: #447.
 *
 * #447 measured that every collaborator these three scripts inject has an
 * unexported default that no test ever runs: each arm substitutes a stub, so
 * `runNpmCi`, `readProductionTree`, `fail`, `staple` and `runCommand` could all
 * throw unconditionally and both suites stayed green. Its acceptance criterion
 * is exact:
 *
 *   > At least one arm per script must run the entry point with no injected
 *   > collaborators, so each default executes at least once.
 *
 * ## Why this mocks modules instead of adding a seam
 *
 * #447 names the trap in the obvious remedy: injecting a *further* collaborator
 * to make the current default testable moves the untested floor down one level
 * rather than closing it, because the new default is then the thing nothing
 * runs. So these arms add **no production parameter at all** — the scripts are
 * unchanged. Every entry point below is called with data only, and the process
 * boundary is replaced at the module boundary (`node:child_process`,
 * `@electron/osx-sign`, `@electron/notarize`).
 *
 * That distinction is the whole point. An injection parameter is a permanent
 * hole in the shipping path that the suite cannot see below; a module mock is a
 * property of this test file and adds no floor. The defaults here therefore run
 * as written, and what is asserted is the thing that was previously invisible:
 * the exact argv they build, and the exact diagnostics they raise.
 *
 * ## What was actually unreachable
 *
 * These are not paraphrases of the entry points. Every assertion below covers a
 * line that no other arm in the suite executes:
 *
 *   - the two `codesign` argument vectors, which are built inside the default
 *     and never seen by a test that injects `runCommandImplementation`;
 *   - `stapler`'s argv, which no test imported `notarizeMacRelease` to observe;
 *   - `code ?? 1` in `runNpmCi`'s `close` handler — the signal-kill case, where
 *     npm's exit code is `null` and reading it as a success would be silent;
 *   - `readProductionTree`'s two throw sites, which are the only place npm's
 *     first stderr line reaches an operator;
 *   - `fail` writing to stderr and exiting non-zero.
 *
 * ## Controls
 *
 * A count is only evidence if zero is reachable, so `records nothing before an
 * entry point runs` asserts the recorder is empty at the start of a test. Every
 * arm then pins an exact call count rather than a lower bound, which is what
 * makes "the default did not run" a failure rather than an absence.
 */

import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SpawnRecord = {
  command: string;
  args: readonly string[];
  options: Record<string, unknown>;
};

type SpawnSyncResult = {
  stdout?: string;
  stderr?: string;
  status?: number | null;
};

const mocks = vi.hoisted(() => ({
  spawnCalls: [] as SpawnRecord[],
  spawnSyncCalls: [] as SpawnRecord[],
  spawnSyncResults: [] as SpawnSyncResult[],
  childScripts: [] as Array<(child: FakeChild) => void>,
  osxSignCalls: [] as Array<Record<string, unknown>>,
  notarizeCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock('node:child_process', () => ({
  spawn: (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    mocks.spawnCalls.push({ command, args, options });
    const child = new FakeChild();
    const script = mocks.childScripts.shift();
    // Deferred so the subject finishes attaching its listeners first: both
    // defaults call `spawn` inside a promise executor and register `error`,
    // `exit`/`close` on the following lines.
    queueMicrotask(() => script?.(child));
    return child;
  },
  spawnSync: (
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    mocks.spawnSyncCalls.push({ command, args, options });
    return (
      mocks.spawnSyncResults.shift() ?? { stdout: '', stderr: '', status: 0 }
    );
  },
}));

vi.mock('@electron/osx-sign', () => ({
  signAsync: (options: Record<string, unknown>) => {
    mocks.osxSignCalls.push(options);
    return Promise.resolve();
  },
}));

vi.mock('@electron/notarize', () => ({
  notarize: (options: Record<string, unknown>) => {
    mocks.notarizeCalls.push(options);
    return Promise.resolve();
  },
}));

import { signMacRelease } from '../scripts/sign-macos-release.mjs';
import { notarizeMacRelease } from '../scripts/notarize-macos-release.mjs';
import {
  CLEANUP_EVIDENCE_OUTPUT,
  CLEANUP_FAILURE_ANCHOR,
  CLEANUP_FAILURE_DIAGNOSTIC,
  NPM_PRODUCTION_TREE_COMMAND,
  main,
  npmInvocation,
} from '../scripts/npm-ci-strict.mjs';

type Listener = (...args: unknown[]) => void;

class FakeEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const existing = this.listeners.get(event) ?? [];
    existing.push(listener);
    this.listeners.set(event, existing);
    return this;
  }

  once(event: string, listener: Listener): this {
    return this.on(event, listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      listener(...args);
    }
  }
}

class FakeChild extends FakeEmitter {
  readonly stdout = new FakeEmitter();
  readonly stderr = new FakeEmitter();
}

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/**
 * Read a recorded call, failing by name rather than by `undefined`.
 *
 * An arm that asserts on `calls[1]` when only one call happened should say the
 * default did not run a second time, not `cannot read property of undefined`.
 */
function at<T>(items: readonly T[], index: number, what: string): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(
      `expected a ${what} at index ${index}, but only ${items.length} were recorded`,
    );
  }
  return item;
}

let exitCodes: number[] = [];
let stderrChunks: string[] = [];
let stdoutChunks: string[] = [];
const temporaryDirectories: string[] = [];

beforeEach(() => {
  mocks.spawnCalls.length = 0;
  mocks.spawnSyncCalls.length = 0;
  mocks.spawnSyncResults.length = 0;
  mocks.childScripts.length = 0;
  mocks.osxSignCalls.length = 0;
  mocks.notarizeCalls.length = 0;
  exitCodes = [];
  stderrChunks = [];
  stdoutChunks = [];

  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined;
  }) as unknown as typeof process.exit);
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('injected-default execution control', () => {
  it('records nothing before an entry point runs', () => {
    // Every arm below asserts an exact call count. That is only a measurement
    // if the recorder can report zero, so this pins the empty case.
    expect(mocks.spawnCalls).toHaveLength(0);
    expect(mocks.spawnSyncCalls).toHaveLength(0);
    expect(mocks.osxSignCalls).toHaveLength(0);
    expect(mocks.notarizeCalls).toHaveLength(0);
  });
});

describe('sign-macos-release runCommand, executed', () => {
  const environment = {
    APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (ABCDE12345)',
    APPLE_SIGNING_KEYCHAIN: '/tmp/example.keychain-db',
  };

  const exitCleanly = (child: FakeChild) => child.emit('exit', 0, null);

  it('builds both codesign argument vectors from the real default', async () => {
    mocks.childScripts.push(exitCleanly, exitCleanly);

    await signMacRelease({
      appPath: 'out/Example.app',
      sidecarPath: 'out/sidecar',
      environment,
    });

    expect(mocks.spawnCalls).toHaveLength(2);
    const sidecar = path.resolve('out/sidecar');
    const signCall = at(mocks.spawnCalls, 0, 'codesign --sign spawn');
    const verifyCall = at(mocks.spawnCalls, 1, 'codesign --verify spawn');

    expect(signCall.command).toBe('/usr/bin/codesign');
    expect(signCall.args).toEqual([
      '--force',
      '--timestamp',
      '--options',
      'runtime',
      '--keychain',
      environment.APPLE_SIGNING_KEYCHAIN,
      '--sign',
      environment.APPLE_SIGNING_IDENTITY,
      sidecar,
    ]);
    expect(signCall.options.stdio).toBe('inherit');

    expect(verifyCall.command).toBe('/usr/bin/codesign');
    expect(verifyCall.args).toEqual([
      '--verify',
      '--strict',
      '--verbose=2',
      sidecar,
    ]);

    expect(mocks.osxSignCalls).toHaveLength(1);
    expect(at(mocks.osxSignCalls, 0, 'signAsync call')).toMatchObject({
      app: path.resolve('out/Example.app'),
      identity: environment.APPLE_SIGNING_IDENTITY,
      keychain: environment.APPLE_SIGNING_KEYCHAIN,
      hardenedRuntime: true,
      binaries: [sidecar],
    });
  });

  it('refuses a non-zero codesign exit before the app is signed', async () => {
    mocks.childScripts.push((child) => child.emit('exit', 3, null));

    await expect(
      signMacRelease({
        appPath: 'out/Example.app',
        sidecarPath: 'out/sidecar',
        environment,
      }),
    ).rejects.toThrow('/usr/bin/codesign exited with code 3');

    // The failure has to stop the sequence, not just be reported: a sidecar
    // that failed to sign must never reach the app-signing call.
    expect(mocks.spawnCalls).toHaveLength(1);
    expect(mocks.osxSignCalls).toHaveLength(0);
  });

  it('names the signal when codesign is killed rather than exiting', async () => {
    mocks.childScripts.push((child) => child.emit('exit', null, 'SIGKILL'));

    await expect(
      signMacRelease({
        appPath: 'out/Example.app',
        sidecarPath: 'out/sidecar',
        environment,
      }),
    ).rejects.toThrow('/usr/bin/codesign terminated by SIGKILL');
    expect(mocks.osxSignCalls).toHaveLength(0);
  });

  it('propagates a spawn error rather than hanging', async () => {
    mocks.childScripts.push((child) =>
      child.emit('error', new Error('codesign not found')),
    );

    await expect(
      signMacRelease({
        appPath: 'out/Example.app',
        sidecarPath: 'out/sidecar',
        environment,
      }),
    ).rejects.toThrow('codesign not found');
    expect(mocks.osxSignCalls).toHaveLength(0);
  });
});

describe('notarize-macos-release staple, executed', () => {
  const environment = {
    APPLE_ID: 'releases@example.com',
    APPLE_APP_SPECIFIC_PASSWORD: 'abcd-efgh-ijkl-mnop',
    APPLE_TEAM_ID: 'ABCDE12345',
  };

  it('staples with the real default after notarizing', async () => {
    mocks.childScripts.push((child) => child.emit('exit', 0, null));

    await notarizeMacRelease({ appPath: 'out/Example.app', environment });

    const resolved = path.resolve('out/Example.app');
    expect(mocks.notarizeCalls).toHaveLength(1);
    expect(at(mocks.notarizeCalls, 0, 'notarize call')).toMatchObject({
      appPath: resolved,
      appleId: environment.APPLE_ID,
      appleIdPassword: environment.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: environment.APPLE_TEAM_ID,
    });

    expect(mocks.spawnCalls).toHaveLength(1);
    const stapleCall = at(mocks.spawnCalls, 0, 'stapler spawn');
    expect(stapleCall.command).toBe('/usr/bin/xcrun');
    expect(stapleCall.args).toEqual(['stapler', 'staple', resolved]);
    expect(stapleCall.options.stdio).toBe('inherit');
  });

  it('refuses a non-zero stapler exit', async () => {
    mocks.childScripts.push((child) => child.emit('exit', 2, null));

    await expect(
      notarizeMacRelease({ appPath: 'out/Example.app', environment }),
    ).rejects.toThrow('stapler exited with code 2');
  });

  it('names the signal when stapler is killed rather than exiting', async () => {
    mocks.childScripts.push((child) => child.emit('exit', null, 'SIGTERM'));

    await expect(
      notarizeMacRelease({ appPath: 'out/Example.app', environment }),
    ).rejects.toThrow('stapler terminated by SIGTERM');
  });

  it('propagates a spawn error rather than hanging', async () => {
    mocks.childScripts.push((child) =>
      child.emit('error', new Error('xcrun not found')),
    );

    await expect(
      notarizeMacRelease({ appPath: 'out/Example.app', environment }),
    ).rejects.toThrow('xcrun not found');
  });
});

describe('npm-ci-strict runNpmCi, readProductionTree and fail, executed', () => {
  const cleanTree = (tree: unknown, status: number | null = 0) => {
    mocks.spawnSyncResults.push({
      stdout: JSON.stringify(tree),
      stderr: '',
      status,
    });
  };

  it('spawns npm ci through npmInvocation and accepts a clean tree', async () => {
    mocks.childScripts.push((child) => {
      child.stdout.emit('data', 'added 1 package\n');
      child.stderr.emit('data', 'npm notice\n');
      child.emit('close', 0);
    });
    cleanTree({ name: 'printfarmer', version: '0.0.0' });

    await main();

    const expected = npmInvocation('npm ci');
    expect(mocks.spawnCalls).toHaveLength(1);
    const installCall = at(mocks.spawnCalls, 0, 'npm ci spawn');
    expect(installCall.command).toBe(expected.command);
    expect(installCall.args).toEqual(expected.args);
    expect(installCall.options.cwd).toBe(repoRoot);
    expect(installCall.options.shell).toBe(false);

    // The default echoes both streams as it accumulates them.
    expect(stdoutChunks.join('')).toContain('added 1 package');
    expect(stderrChunks.join('')).toContain('npm notice');

    const treeRead = npmInvocation(NPM_PRODUCTION_TREE_COMMAND);
    expect(mocks.spawnSyncCalls).toHaveLength(1);
    const treeCall = at(mocks.spawnSyncCalls, 0, 'npm ls spawnSync');
    expect(treeCall.command).toBe(treeRead.command);
    expect(treeCall.args).toEqual(treeRead.args);
    expect(treeCall.options.encoding).toBe('utf8');

    expect(exitCodes).toEqual([]);
  });

  it('treats a signal-killed npm ci as a failure rather than a success', async () => {
    // `close` carries a null code when npm is killed by a signal. The default
    // coalesces it to 1; reading it as 0 would report a successful install for
    // a process that never finished.
    mocks.childScripts.push((child) => child.emit('close', null));

    await main();

    expect(exitCodes).toEqual([1]);
    // The tree is never read, because the install did not complete.
    expect(mocks.spawnSyncCalls).toHaveLength(0);
  });

  it('exits with npm ci own non-zero code', async () => {
    mocks.childScripts.push((child) => child.emit('close', 7));

    await main();

    expect(exitCodes).toEqual([7]);
  });

  it('reports npm first stderr line when the tree read prints no JSON', async () => {
    mocks.childScripts.push((child) => child.emit('close', 0));
    mocks.spawnSyncResults.push({
      stdout: '   ',
      stderr: 'npm error code ELSPROBLEMS\nnpm error extraneous: left@1.0.0\n',
      status: 1,
    });

    await expect(main()).rejects.toThrow(
      `npm-ci-strict: \`${NPM_PRODUCTION_TREE_COMMAND}\` produced no JSON output: npm error code ELSPROBLEMS`,
    );
  });

  it('reports unparseable tree output as such', async () => {
    mocks.childScripts.push((child) => child.emit('close', 0));
    mocks.spawnSyncResults.push({
      stdout: '{ not json',
      stderr: '',
      status: 0,
    });

    await expect(main()).rejects.toThrow(
      `npm-ci-strict: \`${NPM_PRODUCTION_TREE_COMMAND}\` output was not valid JSON`,
    );
  });

  it('writes the diagnostic to stderr and exits 1 through the real fail', async () => {
    mocks.childScripts.push((child) => child.emit('close', 0));
    cleanTree({ problems: ['extraneous: left-pad@1.3.0'] });

    await main();

    const written = stderrChunks.join('');
    expect(written).toContain(
      'npm-ci-strict: npm itself reported problems with the installed tree.',
    );
    expect(written).toContain('  - extraneous: left-pad@1.3.0');
    // `fail` terminates the job; a diagnostic without a non-zero exit is the
    // failure this whole script exists to prevent.
    expect(exitCodes).toEqual([1]);
  });

  it('runs the whole entry point with no injected collaborators at all', async () => {
    // The criterion in #447, taken literally: `main()` with an empty dependency
    // set, so `runNpmCi`, `retryCleanupRemovals`, `writeCleanupEvidence`,
    // `markCleanupEvidenceOutput` and `fail` all run as shipped. Only the
    // process boundary and the two evidence paths are redirected.
    const directory = await mkdtemp(
      path.join(os.tmpdir(), 'npm-ci-strict-defaults-'),
    );
    temporaryDirectories.push(directory);
    const evidencePath = path.join(directory, 'evidence.json');
    const outputPath = path.join(directory, 'github-output.txt');
    vi.stubEnv('NPM_CLEANUP_EVIDENCE_PATH', evidencePath);
    vi.stubEnv('GITHUB_OUTPUT', outputPath);

    mocks.childScripts.push((child) => {
      // Split across two chunks: the default has to concatenate them before
      // the marker is detectable at all.
      child.stdout.emit('data', 'npm warn clean');
      child.stdout.emit('data', 'up Failed to remove some directories\n');
      child.emit('close', 0);
    });

    await main();

    const written = stderrChunks.join('');
    expect(written).toContain(CLEANUP_FAILURE_ANCHOR);
    expect(exitCodes).toEqual([1]);

    // The defaults really wrote their evidence, rather than being stubbed out.
    // `warningExcerpt` is the load-bearing field here: it holds the marker line
    // whole, which is only possible if the two stdout chunks above were
    // concatenated before the match ran.
    const evidence: unknown = JSON.parse(await readFile(evidencePath, 'utf8'));
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      anchor: CLEANUP_FAILURE_ANCHOR,
      diagnostic: CLEANUP_FAILURE_DIAGNOSTIC,
      warningExcerpt: ['npm warn cleanup Failed to remove some directories'],
      recovery: { attempted: false, recovered: false },
    });
    expect(await readFile(outputPath, 'utf8')).toContain(
      `${CLEANUP_EVIDENCE_OUTPUT}=true`,
    );

    vi.unstubAllEnvs();
  });
});
