// @vitest-environment node

import { createHash } from 'node:crypto';
import {
  access,
  copyFile,
  mkdtemp,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildVerifiedInstallerScript,
  launchVerifiedWindowsInstaller,
} from '../src/main/windowsInstaller';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function waitForFile(filePath: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      )) {
        throw error;
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('operation rejected with a non-Error value');
  }
  throw new Error('operation unexpectedly succeeded');
}

describe('descriptor-bound Windows installer launch', () => {
  it('hashes and starts while a no-write/no-delete share remains open', () => {
    const script = buildVerifiedInstallerScript('C:\\updates\\Setup.exe', {
      fileName: 'Setup.exe',
      sha256: 'a'.repeat(64),
      size: 123,
    });

    const open = script.indexOf('[IO.FileShare]::Read');
    const hash = script.indexOf('ComputeHash($stream)');
    const start = script.indexOf('[Diagnostics.Process]::Start');
    const close = script.indexOf('$stream.Dispose()', start);
    expect(open).toBeGreaterThan(-1);
    expect(hash).toBeGreaterThan(open);
    expect(start).toBeGreaterThan(hash);
    expect(close).toBeGreaterThan(start);
    expect(script).not.toContain('C:\\updates\\Setup.exe');
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
      const readyPath = path.join(directory, 'verified.ready');
      const continuePath = path.join(directory, 'continue.ready');
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

      const launch = launchVerifiedWindowsInstaller(installerPath, artifact, {
        synchronization: { readyPath, continuePath },
      });
      await waitForFile(readyPath);
      try {
        const unlinkError = await rejectedError(unlink(installerPath));
        const renameError = await rejectedError(
          rename(installerPath, renamedPath),
        );
        expect('code' in unlinkError ? unlinkError.code : undefined).toMatch(
          /^(?:EACCES|EBUSY|EPERM)$/,
        );
        expect('code' in renameError ? renameError.code : undefined).toMatch(
          /^(?:EACCES|EBUSY|EPERM)$/,
        );
      } finally {
        await writeFile(continuePath, 'continue');
      }

      await expect(launch).resolves.toBeUndefined();
      await expect(readFile(installerPath)).resolves.toEqual(verifiedBytes);
    },
    120_000,
  );
});
