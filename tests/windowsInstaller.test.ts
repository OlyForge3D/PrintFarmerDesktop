// @vitest-environment node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
} from 'node:fs/promises';
import { renameSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildVerifiedInstallerScript,
  launchVerifiedWindowsInstaller,
} from '../src/main/windowsInstaller';

const temporaryDirectories: string[] = [];
const runningProcessIds: number[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  for (const processId of runningProcessIds.splice(0)) {
    try {
      process.kill(processId);
      await waitForProcessExit(processId);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ESRCH'
      )) {
        throw error;
      }
    }
  }
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
    ),
  );
});

async function waitForProcessExit(processId: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    try {
      process.kill(processId, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        return;
      }
      throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(`process ${processId} did not exit after termination`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function rejectedError(operation: () => void): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('operation rejected with a non-Error value');
  }
  throw new Error('operation unexpectedly succeeded');
}

function powershellPath(): string {
  return path.join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
}

async function runPowerShell(script: string): Promise<string> {
  const encodedCommand = Buffer.from(script, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync(
    powershellPath(),
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedCommand,
    ],
    { windowsHide: true },
  );
  return stdout.trim();
}

async function stageLongRunningInstaller(outputPath: string): Promise<void> {
  await copyFile(
    path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'wscript.exe',
    ),
    outputPath,
  );
}

async function processImagePath(processId: number): Promise<string> {
  return runPowerShell(`(Get-Process -Id ${processId} -ErrorAction Stop).Path`);
}

function expectProcessAlive(processId: number): void {
  expect(() => process.kill(processId, 0)).not.toThrow();
}

describe('descriptor-bound Windows installer launch', () => {
  it('hashes and starts while a no-write/no-delete share remains open', () => {
    const script = buildVerifiedInstallerScript(
      'C:\\updates\\Setup.exe',
      {
        fileName: 'Setup.exe',
        sha256: 'a'.repeat(64),
        size: 123,
      },
      true,
    );

    const open = script.indexOf('[IO.FileShare]::Read');
    const hash = script.indexOf('ComputeHash($stream)');
    const verified = script.indexOf("WriteLine('VERIFIED')");
    const continuation = script.indexOf('[Console]::In.ReadLine()');
    const canonical = script.indexOf('GetFinalPathNameByHandleW');
    const canonicalStart = script.indexOf(
      '$startInfo.FileName = $canonicalPath',
    );
    const detachedHandles = script.indexOf(
      '$startInfo.UseShellExecute = $true',
    );
    const start = script.indexOf('[Diagnostics.Process]::Start');
    const close = script.indexOf('$stream.Dispose()', start);
    expect(open).toBeGreaterThan(-1);
    expect(hash).toBeGreaterThan(open);
    expect(canonical).toBeGreaterThan(hash);
    expect(verified).toBeGreaterThan(hash);
    expect(continuation).toBeGreaterThan(verified);
    expect(canonicalStart).toBeGreaterThan(continuation);
    expect(detachedHandles).toBeGreaterThan(canonicalStart);
    expect(start).toBeGreaterThan(continuation);
    expect(close).toBeGreaterThan(start);
    expect(script).not.toContain('RedirectStandard');
    expect(script).not.toContain('Add-Type');
    expect(script).not.toContain('$startInfo.FileName = $installerPath');
    expect(script).not.toContain('C:\\updates\\Setup.exe');
  });

  it('keeps the production helper unsynchronized and protocol-only', () => {
    const script = buildVerifiedInstallerScript('C:\\updates\\Setup.exe', {
      fileName: 'Setup.exe',
      sha256: 'a'.repeat(64),
      size: 123,
    });

    expect(script).not.toContain("WriteLine('VERIFIED')");
    expect(script).not.toContain('[Console]::In.ReadLine()');
    expect(script).toContain('$startInfo.FileName = $canonicalPath');
    expect(script).toContain('$startInfo.UseShellExecute = $true');
    expect(script).toContain('[Console]::Out.WriteLine("STARTED:');
    expect(script).not.toContain('RedirectStandard');
  });

  it.runIf(process.platform === 'win32')(
    'prevents unlink and rename substitution after verification begins',
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'windows-installer-race-'),
      );
      temporaryDirectories.push(directory);
      const installerPath = path.join(directory, 'Setup.exe');
      const attackerPath = path.join(directory, 'attacker.exe');
      const renamedPath = path.join(directory, 'verified-renamed.exe');
      const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
      await copyFile(
        path.join(systemRoot, 'System32', 'where.exe'),
        installerPath,
      );
      const commandPath =
        process.env.ComSpec ?? path.join(systemRoot, 'System32', 'cmd.exe');
      await copyFile(commandPath, attackerPath);
      const verifiedBytes = await readFile(installerPath);
      const artifact = {
        fileName: 'Setup.exe',
        sha256: createHash('sha256').update(verifiedBytes).digest('hex'),
        size: verifiedBytes.length,
      };

      let unlinkError: Error | undefined;
      let renameError: Error | undefined;
      await launchVerifiedWindowsInstaller(installerPath, artifact, {
        synchronization: {
          afterVerification: () => {
            unlinkError = rejectedError(() => unlinkSync(installerPath));
            renameError = rejectedError(() =>
              renameSync(installerPath, renamedPath),
            );
          },
        },
      });
      expect(
        unlinkError && 'code' in unlinkError ? unlinkError.code : undefined,
      ).toMatch(/^(?:EACCES|EBUSY|EPERM)$/);
      expect(
        renameError && 'code' in renameError ? renameError.code : undefined,
      ).toMatch(/^(?:EACCES|EBUSY|EPERM)$/);
      await expect(readFile(installerPath)).resolves.toEqual(verifiedBytes);
    },
    30_000,
  );

  it.runIf(process.platform === 'win32')(
    'launches the handle-resolved image after an updates junction is repointed',
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'windows-installer-junction-'),
      );
      temporaryDirectories.push(directory);
      const legitimateDirectory = path.join(directory, 'legitimate');
      const attackerDirectory = path.join(directory, 'attacker');
      const updatesJunction = path.join(directory, 'updates');
      const legitimateInstaller = path.join(legitimateDirectory, 'Setup.exe');
      const attackerInstaller = path.join(attackerDirectory, 'Setup.exe');
      const publicInstaller = path.join(updatesJunction, 'Setup.exe');
      await Promise.all([mkdir(legitimateDirectory), mkdir(attackerDirectory)]);
      await stageLongRunningInstaller(legitimateInstaller);
      await copyFile(
        path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'where.exe',
        ),
        attackerInstaller,
      );
      await symlink(legitimateDirectory, updatesJunction, 'junction');
      const legitimateBytes = await readFile(legitimateInstaller);
      const attackerBytes = await readFile(attackerInstaller);
      const artifact = {
        fileName: 'Setup.exe',
        sha256: createHash('sha256').update(legitimateBytes).digest('hex'),
        size: legitimateBytes.length,
      };
      let processId = 0;

      await launchVerifiedWindowsInstaller(publicInstaller, artifact, {
        synchronization: {
          afterVerification: () => {
            rmdirSync(updatesJunction);
            symlinkSync(attackerDirectory, updatesJunction, 'junction');
          },
        },
        onStarted: (startedProcessId) => {
          processId = startedProcessId;
          runningProcessIds.push(startedProcessId);
        },
      });

      expect(processId).toBeGreaterThan(0);
      expectProcessAlive(processId);
      expect(
        path.resolve(await processImagePath(processId)).toLowerCase(),
      ).toBe(path.resolve(legitimateInstaller).toLowerCase());
      await expect(readFile(publicInstaller)).resolves.toEqual(attackerBytes);
      expect(
        createHash('sha256')
          .update(await readFile(publicInstaller))
          .digest('hex'),
      ).not.toBe(artifact.sha256);
    },
    30_000,
  );

  it.runIf(process.platform === 'win32')(
    'resolves and permits app quit while a long-running installer remains alive',
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'windows-installer-detach-'),
      );
      temporaryDirectories.push(directory);
      const installerPath = path.join(directory, 'Setup.exe');
      await stageLongRunningInstaller(installerPath);
      const installerBytes = await readFile(installerPath);
      const artifact = {
        fileName: 'Setup.exe',
        sha256: createHash('sha256').update(installerBytes).digest('hex'),
        size: installerBytes.length,
      };
      let processId = 0;
      const app = { quit: vi.fn() };
      const startedAt = performance.now();

      await launchVerifiedWindowsInstaller(installerPath, artifact, {
        onStarted: (startedProcessId) => {
          processId = startedProcessId;
          runningProcessIds.push(startedProcessId);
        },
      });
      app.quit();
      const elapsedMs = performance.now() - startedAt;

      expect(elapsedMs).toBeLessThan(5_000);
      expect(app.quit).toHaveBeenCalledOnce();
      expectProcessAlive(processId);
    },
    30_000,
  );

  it.runIf(process.platform === 'win32')(
    'times out, reaps the helper, and releases the verified handle',
    async () => {
      const directory = await mkdtemp(
        path.join(os.tmpdir(), 'windows-installer-timeout-'),
      );
      temporaryDirectories.push(directory);
      const installerPath = path.join(directory, 'Setup.exe');
      const renamedPath = path.join(directory, 'renamed.exe');
      await copyFile(
        path.join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'where.exe',
        ),
        installerPath,
      );
      const installerBytes = await readFile(installerPath);

      await expect(
        launchVerifiedWindowsInstaller(
          installerPath,
          {
            fileName: 'Setup.exe',
            sha256: createHash('sha256').update(installerBytes).digest('hex'),
            size: installerBytes.length,
          },
          {
            helperTimeoutMs: 250,
            synchronization: {
              afterVerification: () => new Promise(() => undefined),
            },
          },
        ),
      ).rejects.toThrow('timed out after 250ms');
      expect(() => renameSync(installerPath, renamedPath)).not.toThrow();
    },
    30_000,
  );
});
