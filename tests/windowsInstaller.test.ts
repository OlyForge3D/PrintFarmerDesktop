// @vitest-environment node

import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { renameSync, unlinkSync } from 'node:fs';
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

function rejectedError(operation: () => void): Error {
  try {
    operation();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('operation rejected with a non-Error value');
  }
  throw new Error('operation unexpectedly succeeded');
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
    const start = script.indexOf('[Diagnostics.Process]::Start');
    const close = script.indexOf('$stream.Dispose()', start);
    expect(open).toBeGreaterThan(-1);
    expect(hash).toBeGreaterThan(open);
    expect(verified).toBeGreaterThan(hash);
    expect(continuation).toBeGreaterThan(verified);
    expect(start).toBeGreaterThan(continuation);
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
});
