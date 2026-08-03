// @vitest-environment node

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildIsolatedEnvironment,
  runIsolatedReleaseCommand,
} from '../scripts/release-environment.mjs';
import { signMacRelease } from '../scripts/sign-macos-release.mjs';
import {
  signWindowsRelease,
  WINDOWS_TIMESTAMP_SERVER,
  windowsSignOptions,
} from '../scripts/sign-windows-release.mjs';
import {
  UNIVERSAL_MAC_TARGETS,
  UNIVERSAL_SIDECAR_PATH,
  verifyArchArgs,
} from '../scripts/build-universal-sidecar.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('isolated release processes', () => {
  it('passes only platform requirements and explicitly allowed credentials', () => {
    const source = {
      Path: 'system-path',
      SystemRoot: 'system-root',
      TEMP: 'temp',
      WINDOWS_CERTIFICATE_FILE: 'certificate.p12',
      WINDOWS_CERTIFICATE_PASSWORD: 'windows-password-material',
      APPLE_APP_SPECIFIC_PASSWORD: 'apple-password-material',
      CERTIFICATE_BASE64: 'prepared-certificate-material',
      UNRELATED_BUILD_VALUE: 'ordinary-build-input',
    };

    expect(
      buildIsolatedEnvironment(
        source,
        ['WINDOWS_CERTIFICATE_FILE', 'WINDOWS_CERTIFICATE_PASSWORD'],
        'win32',
      ),
    ).toEqual({
      Path: 'system-path',
      SystemRoot: 'system-root',
      TEMP: 'temp',
      WINDOWS_CERTIFICATE_FILE: 'certificate.p12',
      WINDOWS_CERTIFICATE_PASSWORD: 'windows-password-material',
    });
  });

  it('removes forbidden release material from an ordinary child process', async () => {
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), 'release-env-'),
    );
    temporaryDirectories.push(outputDirectory);
    const outputPath = path.join(outputDirectory, 'environment.json');
    const script = [
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(process.env));`,
    ].join('');

    await runIsolatedReleaseCommand({
      command: process.execPath,
      args: ['-e', script],
      allowedNames: ['ALLOWED_RELEASE_VALUE'],
      sourceEnvironment: {
        ...process.env,
        ALLOWED_RELEASE_VALUE: 'allowed',
        WINDOWS_CERTIFICATE_PASSWORD: 'windows-secret-material',
        APPLE_APP_SPECIFIC_PASSWORD: 'apple-secret-material',
        CERTIFICATE_BASE64: 'certificate-secret-material',
      },
    });

    const environment = await import('node:fs/promises').then(({ readFile }) =>
      readFile(outputPath, 'utf8'),
    );
    expect(environment).toContain('"ALLOWED_RELEASE_VALUE":"allowed"');
    expect(environment).not.toContain('WINDOWS_CERTIFICATE_PASSWORD');
    expect(environment).not.toContain('windows-secret-material');
    expect(environment).not.toContain('APPLE_APP_SPECIFIC_PASSWORD');
    expect(environment).not.toContain('apple-secret-material');
    expect(environment).not.toContain('CERTIFICATE_BASE64');
    expect(environment).not.toContain('certificate-secret-material');
  });
});

describe('dedicated platform signing', () => {
  it('fails closed when a Windows signing credential is missing', () => {
    expect(() =>
      windowsSignOptions({
        WINDOWS_CERTIFICATE_FILE: 'release.p12',
      }),
    ).toThrow('WINDOWS_CERTIFICATE_PASSWORD');
  });

  it('uses SHA-256 RFC3161 signing for the app and Squirrel construction', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'windows-sign-'));
    temporaryDirectories.push(root);
    const appDirectory = path.join(root, 'app');
    const outputDirectory = path.join(root, 'out');
    await mkdir(appDirectory);
    const calls: string[] = [];
    const signImplementation = vi.fn((options) => {
      calls.push('app-sign');
      expect(options).toMatchObject({
        appDirectory: path.resolve(appDirectory),
        certificatePassword: 'password',
        hashes: ['sha256'],
        timestampServer: WINDOWS_TIMESTAMP_SERVER,
      });
      return Promise.resolve();
    });
    const createInstallerImplementation = vi.fn((options) => {
      calls.push('squirrel');
      expect(options).toMatchObject({
        outputDirectory: path.resolve(outputDirectory),
        noMsi: true,
        windowsSign: {
          certificatePassword: 'password',
          hashes: ['sha256'],
          timestampServer: WINDOWS_TIMESTAMP_SERVER,
        },
      });
      return Promise.resolve();
    });

    await signWindowsRelease({
      appDirectory,
      outputDirectory,
      environment: {
        WINDOWS_CERTIFICATE_FILE: path.join(root, 'release.p12'),
        WINDOWS_CERTIFICATE_PASSWORD: 'password',
      },
      signImplementation,
      createInstallerImplementation,
    });

    expect(calls).toEqual(['app-sign', 'squirrel']);
  });

  it('signs the universal sidecar before the outer macOS application', async () => {
    const calls: string[] = [];
    const appPath = path.resolve('out', 'PrintFarmer Desktop.app');
    const sidecarPath = path.join(
      appPath,
      'Contents',
      'Resources',
      'sidecar',
      'model-core',
    );

    await signMacRelease({
      appPath,
      sidecarPath,
      environment: {
        APPLE_SIGNING_IDENTITY: 'Developer ID Application: Example (TEAMID)',
        APPLE_SIGNING_KEYCHAIN: '/tmp/release.keychain-db',
      },
      runCommandImplementation: (command, args) => {
        calls.push(`${command}:${args.join(' ')}`);
        return Promise.resolve();
      },
      signAppImplementation: (options) => {
        calls.push(`outer:${options.app}`);
        expect(options.binaries).toEqual([sidecarPath]);
        return Promise.resolve();
      },
    });

    expect(calls[0]).toContain(`/usr/bin/codesign:`);
    expect(calls[0]).toContain(sidecarPath);
    expect(calls.at(-1)).toBe(`outer:${appPath}`);
  });

  it('builds the sidecar for both macOS architectures before combining it', () => {
    expect(UNIVERSAL_MAC_TARGETS).toEqual([
      'x86_64-apple-darwin',
      'aarch64-apple-darwin',
    ]);
    expect(UNIVERSAL_SIDECAR_PATH).toContain(
      path.join('target', 'universal-apple-darwin', 'release', 'model-core'),
    );
  });

  it('verifies architectures with the lipo input file before the command', () => {
    expect(verifyArchArgs('/tmp/model-core')).toEqual([
      '/tmp/model-core',
      '-verify_arch',
      'x86_64',
      'arm64',
    ]);
  });
});
