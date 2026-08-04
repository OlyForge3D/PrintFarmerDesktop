// @vitest-environment node

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  runCiInstall,
  type NpmCommandResult,
  type NpmRunner,
} from '../scripts/ci-install.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const installCommand = 'node scripts/ci-install.mjs';
const cleanupWarning = [
  'npm warn cleanup Failed to remove some directories [',
  "npm warn cleanup   'D:\\repo\\node_modules\\parse-color',",
  "npm warn cleanup   [Error: EPERM: operation not permitted, rmdir 'D:\\repo\\node_modules\\parse-color\\node_modules\\color-convert']",
  ']',
].join('\n');

function commandResult({
  status = 0,
  stdout = null,
  stderr = null,
}: {
  status?: number;
  stdout?: string | null;
  stderr?: string | null;
} = {}): NpmCommandResult {
  return { status, signal: null, stdout, stderr };
}

function cleanTree(): object {
  return {
    name: 'printfarmer-desktop',
    version: '0.1.0-beta.2',
    dependencies: {
      react: {
        version: '18.3.1',
        dependencies: {
          scheduler: { version: '0.23.2' },
        },
      },
    },
  };
}

describe('CI dependency install integrity guard', () => {
  it('accepts a structurally complete tree without parsing npm cleanup warning text', () => {
    const runNpm = vi
      .fn<NpmRunner>()
      .mockReturnValueOnce(commandResult({ stderr: cleanupWarning }))
      .mockReturnValueOnce(
        commandResult({ stdout: JSON.stringify(cleanTree()) }),
      );
    const log = vi.fn();
    const logError = vi.fn();

    expect(
      runCiInstall({
        cwd: 'D:\\repo',
        runNpm,
        log,
        logError,
      }),
    ).toBe(0);
    expect(runNpm).toHaveBeenNthCalledWith(
      1,
      ['ci'],
      expect.objectContaining({ cwd: 'D:\\repo', stdio: 'inherit' }),
    );
    expect(runNpm).toHaveBeenNthCalledWith(
      2,
      ['ls', '--omit=dev', '--all', '--json'],
      expect.objectContaining({
        cwd: 'D:\\repo',
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    );
    expect(log).toHaveBeenCalledWith(
      '[ci-install] OK: npm ci completed and npm ls verified the installed production dependency tree',
    );
    expect(logError).not.toHaveBeenCalled();
  });

  it('stops the install step when npm ci exits zero but cleanup leaves a versionless package', () => {
    const brokenTree = cleanTree() as {
      dependencies: Record<string, object>;
    };
    brokenTree.dependencies['parse-color'] = {
      problems: ['invalid: parse-color@ D:\\repo\\node_modules\\parse-color'],
    };
    const runNpm = vi
      .fn<NpmRunner>()
      .mockReturnValueOnce(commandResult({ stderr: cleanupWarning }))
      .mockReturnValueOnce(
        commandResult({
          status: 1,
          stdout: JSON.stringify(brokenTree),
          stderr: 'npm error code ELSPROBLEMS',
        }),
      );
    const log = vi.fn();
    const logError = vi.fn();

    expect(
      runCiInstall({
        cwd: 'D:\\repo',
        runNpm,
        log,
        logError,
      }),
    ).toBe(1);
    expect(logError).toHaveBeenCalledWith(
      '[ci-install] FAILED: installed production dependency tree is incomplete: npm ls package "parse-color" at "parse-color" has no version after npm ci',
    );
    expect(log).not.toHaveBeenCalled();
    expect(runNpm).toHaveBeenCalledTimes(2);
  });

  it('stops before tree verification when npm ci itself exits non-zero', () => {
    const runNpm = vi
      .fn<NpmRunner>()
      .mockReturnValueOnce(commandResult({ status: 37 }));
    const logError = vi.fn();

    expect(runCiInstall({ runNpm, logError })).toBe(1);
    expect(logError).toHaveBeenCalledWith(
      '[ci-install] FAILED: npm ci exited with code 37',
    );
    expect(runNpm).toHaveBeenCalledTimes(1);
  });
});

describe('workflow dependency install contract', () => {
  it.each([
    { file: 'ci.yml', installs: 3 },
    { file: 'release.yml', installs: 2 },
    { file: 'release-gpu-qualification.yml', installs: 1 },
  ])(
    '$file routes all $installs installs through the integrity guard',
    ({ file, installs }) => {
      const workflow = readFileSync(
        path.join(repoRoot, '.github', 'workflows', file),
        'utf8',
      );
      const commands = [
        ...workflow.matchAll(
          /- name: Install dependencies\r?\n\s+run:\s*([^\r\n]+)/g,
        ),
      ].map((match) => match[1]);

      expect(commands).toEqual(
        Array.from({ length: installs }, () => installCommand),
      );
      expect(workflow).not.toMatch(/\brun:\s*npm ci(?:\s|$)/);
    },
  );

  it('keeps the SBOM policy as a distinct fail-closed step after guarded installation', () => {
    const workflow = readFileSync(
      path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
      'utf8',
    );
    const packageJob = workflow.slice(
      workflow.indexOf('  package:'),
      workflow.indexOf('  advisories:'),
    );
    const install = packageJob.indexOf(`run: ${installCommand}`);
    const sbom = packageJob.indexOf('run: npm run verify:sbom');

    expect(install).toBeGreaterThan(-1);
    expect(sbom).toBeGreaterThan(install);
    expect(packageJob).not.toContain('continue-on-error');
  });
});
