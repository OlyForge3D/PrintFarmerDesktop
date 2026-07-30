import { signAsync } from '@electron/osx-sign';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

function requireEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for macOS release signing`);
  }
  return value;
}

async function runCommand(command, args) {
  const child = spawn(command, args, {
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} terminated by ${signal}`));
      else resolve(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`${command} exited with code ${exitCode}`);
  }
}

export async function signMacRelease({
  appPath,
  sidecarPath,
  environment = process.env,
  runCommandImplementation = runCommand,
  signAppImplementation = signAsync,
}) {
  const identity = requireEnvironment(environment, 'APPLE_SIGNING_IDENTITY');
  const keychain = requireEnvironment(environment, 'APPLE_SIGNING_KEYCHAIN');
  const resolvedAppPath = path.resolve(appPath);
  const resolvedSidecarPath = path.resolve(sidecarPath);

  await runCommandImplementation('/usr/bin/codesign', [
    '--force',
    '--timestamp',
    '--options',
    'runtime',
    '--keychain',
    keychain,
    '--sign',
    identity,
    resolvedSidecarPath,
  ]);
  await runCommandImplementation('/usr/bin/codesign', [
    '--verify',
    '--strict',
    '--verbose=2',
    resolvedSidecarPath,
  ]);
  await signAppImplementation({
    app: resolvedAppPath,
    identity,
    keychain,
    hardenedRuntime: true,
    binaries: [resolvedSidecarPath],
  });
}

async function main() {
  const { values } = parseArgs({
    options: {
      app: { type: 'string' },
      sidecar: { type: 'string' },
    },
  });
  if (!values.app || !values.sidecar) {
    throw new Error('--app and --sidecar are required');
  }
  await signMacRelease({ appPath: values.app, sidecarPath: values.sidecar });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
