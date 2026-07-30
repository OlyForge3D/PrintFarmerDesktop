import { notarize } from '@electron/notarize';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

function requireEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for macOS notarization`);
  }
  return value;
}

async function staple(appPath) {
  const child = spawn('/usr/bin/xcrun', ['stapler', 'staple', appPath], {
    env: process.env,
    stdio: 'inherit',
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`stapler terminated by ${signal}`));
      else resolve(code);
    });
  });
  if (exitCode !== 0) {
    throw new Error(`stapler exited with code ${exitCode}`);
  }
}

export async function notarizeMacRelease({
  appPath,
  environment = process.env,
  notarizeImplementation = notarize,
  stapleImplementation = staple,
}) {
  const resolvedAppPath = path.resolve(appPath);
  await notarizeImplementation({
    appPath: resolvedAppPath,
    appleId: requireEnvironment(environment, 'APPLE_ID'),
    appleIdPassword: requireEnvironment(
      environment,
      'APPLE_APP_SPECIFIC_PASSWORD',
    ),
    teamId: requireEnvironment(environment, 'APPLE_TEAM_ID'),
  });
  await stapleImplementation(resolvedAppPath);
}

async function main() {
  const { values } = parseArgs({
    options: { app: { type: 'string' } },
  });
  if (!values.app) {
    throw new Error('--app is required');
  }
  await notarizeMacRelease({ appPath: values.app });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
