import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, chmod, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

function requiredEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for macOS release signing`);
  }
  return value;
}

function decodeCertificate(value) {
  const encoded = value.replace(/\s/g, '');
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('Apple signing certificate secret is not valid base64');
  }
  const certificate = Buffer.from(encoded, 'base64');
  if (
    certificate.length === 0 ||
    certificate.toString('base64').replace(/=+$/, '') !==
      encoded.replace(/=+$/, '')
  ) {
    throw new Error('Apple signing certificate secret is not valid base64');
  }
  return certificate;
}

function parseKeychainList(output) {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const quoted = /^"(.*)"$/.exec(line);
      return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : line;
    });
}

function identityRows(output) {
  return output
    .split(/\r?\n/)
    .map((line) => /^\s*\d+\)\s+([0-9a-f]{40,64})\s+"(.*)"$/i.exec(line))
    .filter(Boolean)
    .map((match) => ({ fingerprint: match[1], name: match[2] }));
}

function matchesIdentity(row, identity) {
  return (
    row.name === identity ||
    row.fingerprint.toUpperCase() === identity.replace(/\s/g, '').toUpperCase()
  );
}

function runProcess(command, args, { environment, captureOutput = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: environment,
      stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      windowsHide: true,
    });
    let stdout = '';
    if (captureOutput) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.resume();
    }
    child.once('error', () =>
      reject(new Error('process could not be started')),
    );
    child.once('exit', (code, signal) => {
      resolve({ code, signal, stdout });
    });
  });
}

function safeProcessError(label, result) {
  if (result?.signal) {
    return new Error(`${label} terminated by ${result.signal}`);
  }
  if (Number.isInteger(result?.code) && result.code !== 0) {
    return new Error(`${label} failed (exit code ${result.code})`);
  }
  return new Error(`${label} failed`);
}

async function runSecurity(
  args,
  label,
  { environment, runProcessImplementation },
) {
  let result;
  try {
    result = await runProcessImplementation('/usr/bin/security', args, {
      environment: Object.fromEntries(
        ['HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR']
          .filter((name) => environment[name] !== undefined)
          .map((name) => [name, environment[name]]),
      ),
      captureOutput: true,
    });
  } catch {
    throw new Error(`macOS keychain ${label} failed`);
  }
  if (result.code !== 0 || result.signal) {
    throw safeProcessError(`macOS keychain ${label}`, result);
  }
  return result.stdout;
}

async function attemptCleanup(label, action, failures) {
  try {
    await action();
  } catch {
    failures.push(label);
  }
}

export async function withMacSigningKeychain({
  command,
  args,
  environment = process.env,
  runProcessImplementation = runProcess,
  temporaryDirectory = environment.RUNNER_TEMP || os.tmpdir(),
}) {
  if (!command) throw new Error('A macOS signing command is required');

  const certificateBase64 = requiredEnvironment(
    environment,
    'CERTIFICATE_BASE64',
  );
  const certificatePassword = requiredEnvironment(
    environment,
    'CERTIFICATE_PASSWORD',
  );
  const identity = requiredEnvironment(environment, 'APPLE_SIGNING_IDENTITY');
  const certificate = decodeCertificate(certificateBase64);

  let workspace;
  let certificatePath;
  let keychainPath;
  let keychainCreationAttempted = false;
  let originalKeychains;
  let primaryFailure;

  try {
    workspace = await mkdtemp(
      path.join(temporaryDirectory, 'printfarmer-signing-'),
    );
    await chmod(workspace, 0o700);
    certificatePath = path.join(workspace, 'release.p12');
    keychainPath = path.join(workspace, 'signing.keychain-db');
    await writeFile(certificatePath, certificate, { mode: 0o600, flag: 'wx' });

    originalKeychains = parseKeychainList(
      await runSecurity(['list-keychains', '-d', 'user'], 'search-list read', {
        environment,
        runProcessImplementation,
      }),
    );

    const keychainPassword = randomBytes(24).toString('hex');
    keychainCreationAttempted = true;
    await runSecurity(
      ['create-keychain', '-p', keychainPassword, keychainPath],
      'creation',
      { environment, runProcessImplementation },
    );
    await runSecurity(
      ['set-keychain-settings', '-lut', '21600', keychainPath],
      'configuration',
      { environment, runProcessImplementation },
    );
    await runSecurity(
      ['unlock-keychain', '-p', keychainPassword, keychainPath],
      'unlock',
      { environment, runProcessImplementation },
    );
    await runSecurity(
      [
        'import',
        certificatePath,
        '-k',
        keychainPath,
        '-P',
        certificatePassword,
        '-T',
        '/usr/bin/codesign',
      ],
      'certificate import',
      { environment, runProcessImplementation },
    );
    await runSecurity(
      [
        'set-key-partition-list',
        '-S',
        'apple-tool:,apple:',
        '-s',
        '-k',
        keychainPassword,
        keychainPath,
      ],
      'private-key access configuration',
      { environment, runProcessImplementation },
    );
    const searchList = [
      keychainPath,
      ...originalKeychains.filter((item) => item !== keychainPath),
    ];
    await runSecurity(
      ['list-keychains', '-d', 'user', '-s', ...searchList],
      'search-list update',
      { environment, runProcessImplementation },
    );

    const allIdentities = identityRows(
      await runSecurity(
        ['find-identity', '-p', 'codesigning', keychainPath],
        'identity validation',
        { environment, runProcessImplementation },
      ),
    );
    const validIdentities = identityRows(
      await runSecurity(
        ['find-identity', '-v', '-p', 'codesigning', keychainPath],
        'identity validation',
        { environment, runProcessImplementation },
      ),
    );
    const matchingIdentity = allIdentities.some((row) =>
      matchesIdentity(row, identity),
    );
    if (!matchingIdentity) {
      throw new Error(
        'No matching code-signing identity is present in the temporary keychain.',
      );
    }
    if (!validIdentities.some((row) => matchesIdentity(row, identity))) {
      throw new Error(
        'The matching identity is not valid for code signing; verify certificate validity and its chain.',
      );
    }

    const signingEnvironment = Object.fromEntries(
      ['HOME', 'LANG', 'PATH', 'SHELL', 'TMPDIR', 'APPLE_SIGNING_IDENTITY']
        .filter((name) => environment[name] !== undefined)
        .map((name) => [name, environment[name]]),
    );
    signingEnvironment.APPLE_SIGNING_KEYCHAIN = keychainPath;
    let result;
    try {
      result = await runProcessImplementation(command, args, {
        environment: signingEnvironment,
        captureOutput: false,
      });
    } catch {
      throw new Error('macOS signing process failed');
    }
    if (result.code !== 0 || result.signal) {
      throw safeProcessError('macOS signing process', result);
    }
  } catch (error) {
    primaryFailure =
      error instanceof Error ? error : new Error('macOS signing setup failed');
  }

  const cleanupFailures = [];
  if (originalKeychains) {
    await attemptCleanup(
      'search-list restoration',
      () =>
        runSecurity(
          ['list-keychains', '-d', 'user', '-s', ...originalKeychains],
          'search-list restoration',
          { environment, runProcessImplementation },
        ),
      cleanupFailures,
    );
  }
  if (keychainCreationAttempted) {
    await attemptCleanup(
      'temporary keychain deletion',
      async () => {
        try {
          await runSecurity(
            ['delete-keychain', keychainPath],
            'temporary keychain deletion',
            { environment, runProcessImplementation },
          );
        } catch (error) {
          try {
            await access(keychainPath);
          } catch (fileError) {
            if (fileError.code === 'ENOENT') return;
          }
          throw error;
        }
      },
      cleanupFailures,
    );
  }
  if (certificatePath) {
    await attemptCleanup(
      'certificate file removal',
      () => rm(certificatePath, { force: true }),
      cleanupFailures,
    );
  }
  if (workspace) {
    await attemptCleanup(
      'temporary directory removal',
      () => rmdir(workspace),
      cleanupFailures,
    );
  }

  if (primaryFailure && cleanupFailures.length) {
    throw new Error(
      `${primaryFailure.message}; cleanup failed: ${cleanupFailures.join(', ')}`,
    );
  }
  if (primaryFailure) throw primaryFailure;
  if (cleanupFailures.length) {
    throw new Error(
      `macOS signing cleanup failed: ${cleanupFailures.join(', ')}`,
    );
  }
}

async function main() {
  const separator = process.argv.indexOf('--');
  const [command, ...args] =
    separator < 0 ? [] : process.argv.slice(separator + 1);
  if (!command) {
    throw new Error(
      'usage: macos-signing-keychain.mjs -- command [arguments ...]',
    );
  }
  await withMacSigningKeychain({ command, args });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
