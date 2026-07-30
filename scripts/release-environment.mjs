import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const REQUIRED_PLATFORM_ENVIRONMENT = {
  win32: [
    'ComSpec',
    'Path',
    'PATHEXT',
    'SystemDrive',
    'SystemRoot',
    'TEMP',
    'TMP',
  ],
  darwin: ['HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR'],
  linux: ['HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR'],
};

export function buildIsolatedEnvironment(
  source,
  allowedNames,
  platform = process.platform,
) {
  const required = REQUIRED_PLATFORM_ENVIRONMENT[platform] ?? [];
  const environment = {};
  for (const name of [...required, ...allowedNames]) {
    const value = source[name];
    if (value !== undefined) {
      environment[name] = value;
    }
  }
  return environment;
}

export async function runIsolatedReleaseCommand({
  command,
  args,
  allowedNames,
  sourceEnvironment = process.env,
  platform = process.platform,
}) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    env: buildIsolatedEnvironment(sourceEnvironment, allowedNames, platform),
    stdio: 'inherit',
    windowsHide: true,
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`isolated release command terminated by ${signal}`));
      } else {
        resolve(code);
      }
    });
  });
  if (exitCode !== 0) {
    throw new Error(`isolated release command exited with code ${exitCode}`);
  }
}

async function main() {
  const separator = process.argv.indexOf('--');
  if (separator < 0 || separator === process.argv.length - 1) {
    throw new Error(
      'usage: release-environment.mjs --allow NAME -- command ...',
    );
  }
  const { values } = parseArgs({
    args: process.argv.slice(2, separator),
    options: {
      allow: { type: 'string', multiple: true, default: [] },
    },
  });
  const [command, ...args] = process.argv.slice(separator + 1);
  await runIsolatedReleaseCommand({
    command,
    args,
    allowedNames: values.allow,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
