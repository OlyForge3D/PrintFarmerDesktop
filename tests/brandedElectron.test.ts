// @vitest-environment node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { prepareBrandedElectron } from '../scripts/prepare-branded-electron.mjs';

const temporaryDirectories: string[] = [];

function fixture() {
  const root = path.join(
    os.tmpdir(),
    `printfarmer-branded-electron-${process.pid}-${temporaryDirectories.length}`,
  );
  temporaryDirectories.push(root);
  const sourceDist = path.join(root, 'electron', 'dist');
  const sourceApp = path.join(sourceDist, 'Electron.app');
  const sourceExecutable = path.join(
    sourceApp,
    'Contents',
    'MacOS',
    'Electron',
  );
  mkdirSync(path.dirname(sourceExecutable), { recursive: true });
  writeFileSync(sourceExecutable, 'fixture');
  writeFileSync(
    path.join(sourceDist, '..', 'package.json'),
    JSON.stringify({ version: '33.2.1' }),
  );
  return {
    root,
    sourceExecutable,
    cacheRoot: path.join(root, 'cache'),
  };
}

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('branded Electron development bundle', () => {
  it('is disabled outside macOS', () => {
    const { sourceExecutable, cacheRoot } = fixture();
    expect(
      prepareBrandedElectron({
        platform: 'win32',
        sourceExecutable,
        cacheRoot,
      }),
    ).toBeNull();
  });

  it('clones, rebrands, signs, and caches the Electron bundle', () => {
    const { sourceExecutable, cacheRoot } = fixture();
    const commands: Array<{ command: string; args: string[] }> = [];
    const options = {
      platform: 'darwin' as const,
      sourceExecutable,
      cacheRoot,
      copyApp: (source: string, target: string) =>
        cpSync(source, target, { recursive: true }),
      runCommand: (command: string, args: string[]) => {
        commands.push({ command, args });
      },
    };

    const first = prepareBrandedElectron(options);
    expect(first).toBe(path.join(cacheRoot, `33.2.1-${process.arch}`));
    expect(commands.map(({ command }) => command)).toEqual([
      '/usr/libexec/PlistBuddy',
      '/usr/libexec/PlistBuddy',
      '/usr/libexec/PlistBuddy',
      'codesign',
    ]);
    expect(commands[0]?.args[1]).toBe(
      'Set :CFBundleExecutable PrintFarmer Desktop',
    );
    expect(commands[1]?.args[1]).toBe('Set :CFBundleName PrintFarmer Desktop');
    expect(commands[2]?.args[1]).toBe(
      'Set :CFBundleDisplayName PrintFarmer Desktop',
    );
    const macOsDirectory = path.join(
      first!,
      'PrintFarmer Desktop.app',
      'Contents',
      'MacOS',
    );
    expect(existsSync(path.join(macOsDirectory, 'PrintFarmer Desktop'))).toBe(
      true,
    );
    expect(existsSync(path.join(macOsDirectory, 'Electron'))).toBe(false);
    expect(
      JSON.parse(readFileSync(path.join(first!, 'brand.json'), 'utf8')),
    ).toEqual({
      schemaVersion: 3,
      electronVersion: '33.2.1',
      productName: 'PrintFarmer Desktop',
    });

    commands.length = 0;
    expect(prepareBrandedElectron(options)).toBe(first);
    expect(commands).toEqual([]);
  });
});
