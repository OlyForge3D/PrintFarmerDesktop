// @vitest-environment node

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  security: undefined as ((args: string[]) => SecurityChild) | undefined,
  onSigning: undefined as ((child: ChildProcess) => void) | undefined,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn(command: string, args: string[], options: SpawnOptions) {
      if (command === '/usr/bin/security') {
        if (!state.security) throw new Error('security mock not configured');
        return state.security(args);
      }
      const child = actual.spawn(command, args, options);
      state.onSigning?.(child);
      return child;
    },
  };
});

import { withMacSigningKeychain } from '../scripts/macos-signing-keychain.mjs';

class SecurityChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
}

const directories: string[] = [];
const identity = 'Developer ID Application: Example (TEAMID)';
const originalKeychains = [
  '/tmp/example first.keychain-db',
  '/tmp/second.keychain-db',
];

afterEach(async () => {
  state.security = undefined;
  state.onSigning = undefined;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mac-signing-process-'));
  directories.push(root);
  let searchList = [...originalKeychains];
  const calls: string[] = [];
  let lateOutputs = 0;
  let signingClosed = false;
  let onOperation: ((args: string[]) => void) | undefined;
  state.security = (args) => {
    const child = new SecurityChild();
    queueMicrotask(() => {
      void (async () => {
        const operation = args[0];
        calls.push(operation ?? '');
        let output = '';
        if (operation === 'list-keychains') {
          if (args[3] === '-s') searchList = args.slice(4);
          else output = searchList.map((item) => `    "${item}"\n`).join('');
        } else if (operation === 'create-keychain') {
          const keychain = args[3];
          if (!keychain) throw new Error('keychain path missing');
          await writeFile(keychain, 'fake-keychain');
        } else if (operation === 'delete-keychain') {
          const keychain = args[1];
          if (!keychain) throw new Error('keychain path missing');
          await rm(keychain);
        } else if (operation === 'find-identity') {
          output = `  1) ${'A'.repeat(40)} "${identity}"\n`;
        }
        onOperation?.(args);
        child.emit('exit', 0, null);
        // Node permits pipe output after exit and before close.
        setImmediate(() => {
          if (output) lateOutputs += 1;
          child.stdout.end(output);
          child.stderr.end();
          child.emit('close', 0, null);
        });
      })().catch((error: unknown) => child.emit('error', error));
    });
    return child;
  };
  return {
    root,
    calls,
    lateOutputs: () => lateOutputs,
    searchList: () => searchList,
    signingClosed: () => signingClosed,
    markSigningClosed: () => {
      signingClosed = true;
    },
    onOperation: (handler: (args: string[]) => void) => {
      onOperation = handler;
    },
    options: {
      command: process.execPath,
      args: ['-e', ''],
      environment: {
        HOME: os.homedir(),
        PATH: process.env.PATH,
        CERTIFICATE_BASE64: Buffer.from('fake-certificate').toString('base64'),
        CERTIFICATE_PASSWORD: 'fake-password',
        APPLE_SIGNING_IDENTITY: identity,
      },
      temporaryDirectory: root,
    },
  };
}

describe('real macOS signing process lifecycle', () => {
  it('waits for close so late identity and search-list output is parsed completely', async () => {
    const context = await fixture();
    await withMacSigningKeychain(context.options);
    expect(context.lateOutputs()).toBe(3);
    expect(context.searchList()).toEqual(originalKeychains);
    expect(context.calls).toContain('delete-keychain');
    expect(await readdir(context.root)).toEqual([]);
  });

  it.runIf(process.platform !== 'win32').each(['SIGINT', 'SIGTERM'] as const)(
    'forwards %s to the signing child, awaits close, and restores/removes temporary state',
    async (signal) => {
      const context = await fixture();
      const before = {
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
      };
      state.onSigning = (child) => {
        child.once('close', () => context.markSigningClosed());
        child.once('spawn', () => {
          expect(context.searchList()).toHaveLength(
            originalKeychains.length + 1,
          );
          // Exercise the registered handler without signalling the test runner.
          process.emit(signal, signal);
        });
      };
      await expect(
        withMacSigningKeychain({
          ...context.options,
          args: ['-e', 'setInterval(() => {}, 1000)'],
        }),
      ).rejects.toThrow(signal);
      expect(context.signingClosed()).toBe(true);
      expect(context.searchList()).toEqual(originalKeychains);
      expect(context.calls).toContain('delete-keychain');
      expect(await readdir(context.root)).toEqual([]);
      expect(process.listenerCount('SIGINT')).toBe(before.SIGINT);
      expect(process.listenerCount('SIGTERM')).toBe(before.SIGTERM);
    },
  );

  it.each(['create-keychain', 'import', 'search-list update'])(
    'cleans up cancellation during %s without starting signing',
    async (operation) => {
      const context = await fixture();
      const signing = vi.fn();
      state.onSigning = signing;
      let interrupted = false;
      context.onOperation((args) => {
        const label =
          args[0] === 'list-keychains' && args[3] === '-s'
            ? 'search-list update'
            : args[0];
        if (!interrupted && label === operation) {
          interrupted = true;
          process.emit('SIGTERM', 'SIGTERM');
        } else if (interrupted) {
          // A second signal must not interrupt restoration/deletion commands.
          process.emit('SIGINT', 'SIGINT');
        }
      });
      await expect(withMacSigningKeychain(context.options)).rejects.toThrow(
        'SIGTERM',
      );
      expect(interrupted).toBe(true);
      expect(signing).not.toHaveBeenCalled();
      expect(context.searchList()).toEqual(originalKeychains);
      expect(context.calls).toContain('delete-keychain');
      expect(await readdir(context.root)).toEqual([]);
    },
  );
});
