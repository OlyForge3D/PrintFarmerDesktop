// @vitest-environment node

import { spawn } from 'node:child_process';
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
  identityAnnotation = '',
  failLabels = [],
  onSigning,
}: {
  validIdentity?: boolean;
  identityPresent?: boolean;
  identityAnnotation?: string;
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
          ? `  1) ${fingerprint} "${identity}"${isValidQuery ? '' : identityAnnotation}\n     ${validIdentity ? 1 : 0} valid identities found\n`
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
  it.runIf(process.platform !== 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'restores temporary state when the workflow Bash entry process receives %s',
    async (signal) => {
      const root = await temporaryRoot();
      const workflow = await readFile(
        new URL('../.github/workflows/release.yml', import.meta.url),
        'utf8',
      );
      const signingStep = workflow
        .split(
          '      - name: Sign universal sidecar and macOS application\n',
        )[1]
        ?.split('\n      - name:')[0];
      const runBlock = signingStep?.split('        run: |\n')[1];
      if (!runBlock) throw new Error('macOS signing step run block missing');
      const helperPath = path.join(root, 'test-helper.mjs');
      const stepPath = path.join(root, 'test-step.sh');
      await writeFile(
        stepPath,
        runBlock
          .replace(/^ {10}/gm, '')
          .replace(
            'scripts/macos-signing-keychain.mjs',
            JSON.stringify(helperPath),
          ),
      );
      const moduleUrl = new URL(
        '../scripts/macos-signing-keychain.mjs',
        import.meta.url,
      ).href;
      const script = `
        import { withMacSigningKeychain } from ${JSON.stringify(moduleUrl)};
        import { writeFile, rm } from 'node:fs/promises';
        import path from 'node:path';
        const root = ${JSON.stringify(root)};
        const statePath = path.join(root, 'search-list.json');
        const original = ${JSON.stringify(originalKeychains)};
        await writeFile(statePath, JSON.stringify(original));
        const runProcessImplementation = async (command, args, options) => {
          let stdout = '';
          if (command === 'test-signer') {
            return await new Promise((resolve) => {
              const keepAlive = setInterval(() => {}, 1000);
              options.cancellationSignal.addEventListener('abort', () => {
                clearInterval(keepAlive);
                resolve({
                  code: null,
                  signal: options.cancellationSignal.reason.signal,
                  stdout: '',
                });
              }, { once: true });
              process.stdout.write('READY ' + process.pid + '\\n');
            });
          }
          if (args[0] === 'create-keychain') {
            await writeFile(args[3], 'fake-keychain');
          } else if (args[0] === 'delete-keychain') {
            await rm(args[1]);
          } else if (args[0] === 'list-keychains') {
            if (args[3] === '-s') {
              await writeFile(statePath, JSON.stringify(args.slice(4)));
            } else {
              stdout = original.map((item) => JSON.stringify(item)).join('\\n');
            }
          } else if (args[0] === 'find-identity') {
            stdout = ${JSON.stringify(`  1) ${fingerprint} "${identity}"\n`)};
          }
          return { code: 0, signal: null, stdout };
        };
        try {
          await withMacSigningKeychain({
            command: 'test-signer',
            args: [],
            environment: ${JSON.stringify(environment(root))},
            runProcessImplementation,
          });
        } catch (error) {
          process.stderr.write(error.message);
          process.exitCode = 1;
        }
      `;
      await writeFile(helperPath, script);
      const child = spawn(
        '/bin/bash',
        ['--noprofile', '--norc', '-e', '-o', 'pipefail', stepPath],
        {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...environment(root),
            PATH: `${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );
      const closed = new Promise<[number | null, NodeJS.Signals | null]>(
        (resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, exitSignal) =>
            resolve([code, exitSignal]),
          );
        },
      );
      let output = '';
      let diagnostic = '';
      let signalSent = false;
      const timeout = setTimeout(() => {
        const helperPid = /READY (\d+)\n/.exec(output)?.[1];
        if (helperPid && Number(helperPid) !== child.pid) {
          process.kill(Number(helperPid), 'SIGKILL');
        }
        child.kill('SIGKILL');
      }, 3_000);
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (!signalSent && /READY \d+\n/.test(output)) {
          signalSent = true;
          child.kill(signal);
        }
      });
      child.stderr.on('data', (chunk: string) => {
        diagnostic += chunk;
      });
      try {
        const [code, exitSignal] = await closed;
        expect(signalSent).toBe(true);
        expect(output).toContain(`READY ${child.pid}\n`);
        expect(code).toBe(1);
        expect(exitSignal).toBeNull();
        expect(diagnostic).toContain(signal);
        expect(
          JSON.parse(
            await readFile(path.join(root, 'search-list.json'), 'utf8'),
          ),
        ).toEqual(originalKeychains);
        expect((await readdir(root)).sort()).toEqual([
          'search-list.json',
          'test-helper.mjs',
          'test-step.sh',
        ]);
      } finally {
        clearTimeout(timeout);
      }
    },
  );

  it.each([' \tpassword with whitespace \n', '   '])(
    'passes a nonempty PKCS#12 password unchanged: %j',
    async (password) => {
      const root = await temporaryRoot();
      const runner = makeProcess();
      await withMacSigningKeychain({
        command: 'node',
        args: ['sign-release.mjs'],
        environment: {
          ...environment(root),
          CERTIFICATE_PASSWORD: password,
        },
        runProcessImplementation: runner.runProcessImplementation,
      });
      const importCall = runner.calls.find(({ label }) => label === 'import');
      expect(importCall).toBeDefined();
      if (!importCall) throw new Error('certificate import missing');
      expect(importCall.args[importCall.args.indexOf('-P') + 1]).toBe(password);
      expect(await readdir(root)).toEqual([]);
    },
  );

  it('rejects an empty password before creating temporary material', async () => {
    const root = await temporaryRoot();
    const runner = makeProcess();
    await expect(
      withMacSigningKeychain({
        command: 'node',
        args: ['sign-release.mjs'],
        environment: { ...environment(root), CERTIFICATE_PASSWORD: '' },
        runProcessImplementation: runner.runProcessImplementation,
      }),
    ).rejects.toThrow('CERTIFICATE_PASSWORD is required');
    expect(runner.calls).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  });

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

  it.each(['', ' (CSSMERR_TP_NOT_TRUSTED)', ' (CSSMERR_TP_CERT_EXPIRED)   '])(
    'distinguishes invalid%s and missing identities without exposing identity or secrets',
    async (identityAnnotation) => {
      const root = await temporaryRoot();
      const process = makeProcess({ validIdentity: false, identityAnnotation });
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
      expect(invalidIdentityError).not.toContain('CSSMERR');
      expect(process.calls.some(({ command }) => command === 'node')).toBe(
        false,
      );
      expect(process.searchList()).toEqual(originalKeychains);

      const missingIdentityProcess = makeProcess({
        identityPresent: false,
        identityAnnotation,
      });
      const missingIdentityError = await withMacSigningKeychain({
        ...options,
        runProcessImplementation:
          missingIdentityProcess.runProcessImplementation,
      }).then(
        () => '',
        (error: Error) => error.message,
      );
      expect(missingIdentityError).toContain(
        'No matching code-signing identity',
      );
      expect(missingIdentityError).not.toContain(identity);
      expect(missingIdentityError).not.toContain(fingerprint);
      expect(missingIdentityError).not.toContain('certificate-password-secret');
      expect(missingIdentityProcess.searchList()).toEqual(originalKeychains);
      expect(await readdir(root)).toEqual([]);
      expect(
        process.calls.some(({ environment: childEnvironment }) =>
          Object.values(childEnvironment).includes(
            'certificate-password-secret',
          ),
        ),
      ).toBe(false);
      expect(process.searchList()).toEqual(originalKeychains);
    },
  );

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
