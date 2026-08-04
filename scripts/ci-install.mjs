#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const NPM_TREE_ARGS = Object.freeze(['ls', '--omit=dev', '--all', '--json']);
const MAX_NPM_TREE_BYTES = 64 * 1024 * 1024;

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function firstDiagnosticLine(stderr) {
  return typeof stderr === 'string'
    ? (stderr.trim().split(/\r?\n/, 1)[0] ?? '')
    : '';
}

export function executeNpm(args, options) {
  const command =
    process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm';
  const commandArgs =
    process.platform === 'win32'
      ? ['/d', '/s', '/c', `npm ${args.join(' ')}`]
      : [...args];
  return spawnSync(command, commandArgs, {
    windowsHide: true,
    ...options,
  });
}

export function assertCompleteNpmTree(tree) {
  if (!isRecord(tree)) {
    throw new Error(
      'installed production dependency tree is malformed: npm ls output root is not an object after npm ci',
    );
  }

  const walk = (node, ancestors) => {
    const dependencies = node.dependencies;
    if (dependencies === undefined) return;
    if (!isRecord(dependencies)) {
      const location =
        ancestors.length === 0 ? '<root>' : ancestors.join(' > ');
      throw new Error(
        `installed production dependency tree is malformed: npm ls dependencies at "${location}" are not an object after npm ci`,
      );
    }

    for (const [name, child] of Object.entries(dependencies)) {
      const packagePath = [...ancestors, name];
      if (!isRecord(child) || !isNonEmptyString(child.version)) {
        throw new Error(
          `installed production dependency tree is incomplete: npm ls package "${name}" at "${packagePath.join(' > ')}" has no version after npm ci`,
        );
      }
      walk(child, packagePath);
    }
  };

  walk(tree, []);
}

function requireCommandSuccess(command, result) {
  if (result.error) {
    throw new Error(
      `${command} could not start: ${errorMessage(result.error)}`,
    );
  }
  if (result.signal) {
    throw new Error(`${command} terminated by ${result.signal}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} exited with code ${result.status ?? 'unknown'}`,
    );
  }
}

export function installDependencies({
  cwd = process.cwd(),
  runNpm = executeNpm,
} = {}) {
  const install = runNpm(['ci'], {
    cwd,
    stdio: 'inherit',
  });
  requireCommandSuccess('npm ci', install);

  const inspected = runNpm(NPM_TREE_ARGS, {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_NPM_TREE_BYTES,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (inspected.error) {
    throw new Error(
      `npm ls could not start after npm ci: ${errorMessage(inspected.error)}`,
    );
  }
  if (inspected.signal) {
    throw new Error(`npm ls terminated by ${inspected.signal} after npm ci`);
  }

  const stdout = typeof inspected.stdout === 'string' ? inspected.stdout : '';
  if (!stdout.trim()) {
    const detail = firstDiagnosticLine(inspected.stderr);
    throw new Error(
      `npm ls produced no dependency tree after npm ci${detail ? `: ${detail}` : ''}`,
    );
  }

  let tree;
  try {
    tree = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `npm ls produced invalid JSON after npm ci: ${errorMessage(error)}`,
    );
  }
  assertCompleteNpmTree(tree);

  if (inspected.status !== 0) {
    const detail = firstDiagnosticLine(inspected.stderr);
    throw new Error(
      `npm ls rejected the installed dependency tree after npm ci with code ${inspected.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`,
    );
  }
}

export function runCiInstall({
  cwd = process.cwd(),
  runNpm = executeNpm,
  log = console.log,
  logError = console.error,
} = {}) {
  try {
    installDependencies({ cwd, runNpm });
    log(
      '[ci-install] OK: npm ci completed and npm ls verified the installed production dependency tree',
    );
    return 0;
  } catch (error) {
    logError(`[ci-install] FAILED: ${errorMessage(error)}`);
    return 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exitCode = runCiInstall();
}
