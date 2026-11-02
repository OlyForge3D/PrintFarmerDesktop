// @vitest-environment node

import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { withMacSigningKeychain } from '../scripts/macos-signing-keychain.mjs';

const temporaryDirectories: string[] = [];
const identity = 'Developer ID Application: Example (TEAMID)';
const fingerprint = 'A'.repeat(40);
const originalKeychains = [
  '/Users/example/keychains/first.keychain-db',
  '/Users/example/Library/Keychains/login.keychain-db',
];

function argument(args: string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error(`missing argument ${index}`);
  return value;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryRoot() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mac-signing-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function makeProcess({
  validIdentity = true,
  identityPresent = true,
  failLabels = [],
  onSigning,
}: {
  validIdentity?: boolean;
  identityPresent?: boolean;
  failLabels?: string[];
  onSigning?: (environment: NodeJS.ProcessEnv) => void;
} = {}) {
  let searchList = [...originalKeychains];
  const calls: Array<{
    command: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
    label: string;
  }> = [];
  let searchListWrites = 0;
  const runProcessImplementation = async (
    command: string,
    args: string[],
    options: {
      environment: NodeJS.ProcessEnv;
      captureOutput?: boolean;
    },
  ) => {
    const operation = argument(args, 0);
    const label =
      operation === 'list-keychains'
        ? args[3] === '-s'
          ? searchListWrites++ === 0
            ? 'search-list update'
            : 'search-list restoration'
          : 'search-list read'
        : command === '/usr/bin/security'
          ? operation
          : command;
    calls.push({
      command,
      args,
      environment: options.environment,
      label,
    });
    if (failLabels.includes(label)) {
      return { code: 1, signal: null, stdout: '' };
    }
    if (args[0] === 'create-keychain') {
      await writeFile(argument(args, 3), 'temporary-keychain');
      return { code: 0, signal: null, stdout: '' };
    }
    if (args[0] === 'delete-keychain') {
      await rm(argument(args, 1));
      return { code: 0, signal: null, stdout: '' };
    }
    if (operation === 'list-keychains' && args[3] === '-s') {
      searchList = args.slice(4);
      return { code: 0, signal: null, stdout: '' };
    }
    if (operation === 'list-keychains') {
      return {
        code: 0,
        signal: null,
        stdout: `${searchList.map((item) => `"${item}"`).join('\n')}\n`,
      };
    }
    if (operation === 'find-identity') {
      const isValidQuery = args.includes('-v');
      const includeIdentity =
        identityPresent && (!isValidQuery || validIdentity);
      return {
        code: 0,
        signal: null,
        stdout: includeIdentity
          ? `  1) ${fingerprint} "${identity}"\n     1 valid identities found\n`
          : '     0 valid identities found\n',
      };
    }
    if (command !== '/usr/bin/security') {
      onSigning?.(options.environment);
    }
    return { code: 0, signal: null, stdout: '' };
  };
  return {
    calls,
    runProcessImplementation,
    searchList: () => searchList,
  };
}

const environment = (temporaryDirectory: string) => ({
  CERTIFICATE_BASE64: Buffer.from('fake-certificate').toString('base64'),
  CERTIFICATE_PASSWORD: 'certificate-password-secret',
  APPLE_SIGNING_IDENTITY: identity,
  HOME: '/Users/example',
  LANG: 'en_US.UTF-8',
  PATH: '/usr/bin:/bin',
  SHELL: '/bin/bash',
  TMPDIR: temporaryDirectory,
  RUNNER_TEMP: temporaryDirectory,
  OTHER_SECRET: 'do-not-forward',
});

describe('macOS signing keychain lifecycle', () => {
  it('preserves the user search list, exposes only signing inputs, and cleans up', async () => {
    const root = await temporaryRoot();
    const process = makeProcess({
      onSigning: (signingEnvironment) => {
        expect(signingEnvironment.APPLE_SIGNING_KEYCHAIN).toContain(root);
        expect(signingEnvironment.APPLE_SIGNING_IDENTITY).toBe(identity);
        expect(signingEnvironment.CERTIFICATE_BASE64).toBeUndefined();
        expect(signingEnvironment.CERTIFICATE_PASSWORD).toBeUndefined();
        expect(signingEnvironment.OTHER_SECRET).toBeUndefined();
        expect(process.searchList()[0]).toBe(
          signingEnvironment.APPLE_SIGNING_KEYCHAIN,
        );
        expect(process.searchList().slice(1)).toEqual(originalKeychains);
      },
    });

    await withMacSigningKeychain({
      command: 'node',
      args: ['sign-release.mjs'],
      environment: environment(root),
      runProcessImplementation: process.runProcessImplementation,
    });

    expect(process.searchList()).toEqual(originalKeychains);
    expect(process.calls.map(({ args }) => args[0])).toContain(
      'delete-keychain',
    );
    expect(
      process.calls.every(
        ({ environment: commandEnvironment }) =>
          commandEnvironment.CERTIFICATE_BASE64 === undefined &&
          commandEnvironment.CERTIFICATE_PASSWORD === undefined,
      ),
    ).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it('distinguishes invalid and missing identities without exposing identity or secrets', async () => {
    const root = await temporaryRoot();
    const process = makeProcess({ validIdentity: false });
    const options = {
      command: 'node',
      args: ['sign-release.mjs'],
      environment: environment(root),
      runProcessImplementation: process.runProcessImplementation,
    };

    const invalidIdentityError = await withMacSigningKeychain(options).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(invalidIdentityError).toContain('not valid for code signing');
    expect(invalidIdentityError).not.toContain(identity);
    expect(invalidIdentityError).not.toContain(fingerprint);
    expect(invalidIdentityError).not.toContain('certificate-password-secret');
    expect(process.searchList()).toEqual(originalKeychains);

    const missingIdentityProcess = makeProcess({ identityPresent: false });
    const missingIdentityError = await withMacSigningKeychain({
      ...options,
      runProcessImplementation: missingIdentityProcess.runProcessImplementation,
    }).then(
      () => '',
      (error: Error) => error.message,
    );
    expect(missingIdentityError).toContain('No matching code-signing identity');
    expect(missingIdentityError).not.toContain(identity);
    expect(missingIdentityError).not.toContain(fingerprint);
    expect(missingIdentityError).not.toContain('certificate-password-secret');
    expect(missingIdentityProcess.searchList()).toEqual(originalKeychains);
    expect(await readdir(root)).toEqual([]);
    expect(
      process.calls.some(({ environment: childEnvironment }) =>
        Object.values(childEnvironment).includes('certificate-password-secret'),
      ),
    ).toBe(false);
    expect(process.searchList()).toEqual(originalKeychains);
  });

  it('restores and removes temporary material when signing fails', async () => {
    const root = await temporaryRoot();
    const process = makeProcess({
      failLabels: ['node'],
    });

    await expect(
      withMacSigningKeychain({
        command: 'node',
        args: ['sign-release.mjs'],
        environment: environment(root),
        runProcessImplementation: process.runProcessImplementation,
      }),
    ).rejects.toThrow('macOS signing process failed');
    expect(process.searchList()).toEqual(originalKeychains);
    expect(await readdir(root)).toEqual([]);
  });

  it('reports restoration and keychain deletion failures', async () => {
    const root = await temporaryRoot();
    const process = makeProcess({
      failLabels: ['search-list restoration', 'delete-keychain'],
    });

    await expect(
      withMacSigningKeychain({
        command: 'node',
        args: ['sign-release.mjs'],
        environment: environment(root),
        runProcessImplementation: process.runProcessImplementation,
      }),
    ).rejects.toThrow(
      /cleanup failed: search-list restoration, temporary keychain deletion, temporary directory removal/,
    );
    expect(process.searchList()).toHaveLength(originalKeychains.length + 1);
    const [workspaceName] = await readdir(root);
    expect(workspaceName).toBeDefined();
    if (workspaceName === undefined)
      throw new Error('temporary workspace missing');
    const workspace = path.join(root, workspaceName);
    await expect(
      readFile(path.join(workspace, 'release.p12')),
    ).rejects.toThrow();
    expect(
      await readFile(path.join(workspace, 'signing.keychain-db'), 'utf8'),
    ).toBe('temporary-keychain');
  });
});
