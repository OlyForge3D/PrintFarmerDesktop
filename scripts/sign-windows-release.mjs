import { sign } from '@electron/windows-sign';
import { createWindowsInstaller } from 'electron-winstaller';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

export const WINDOWS_TIMESTAMP_SERVER = 'http://timestamp.digicert.com';

function requireEnvironment(environment, name) {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required for Windows release signing`);
  }
  return value;
}

export function windowsSignOptions(environment = process.env) {
  return {
    certificateFile: path.resolve(
      requireEnvironment(environment, 'WINDOWS_CERTIFICATE_FILE'),
    ),
    certificatePassword: requireEnvironment(
      environment,
      'WINDOWS_CERTIFICATE_PASSWORD',
    ),
    hashes: ['sha256'],
    timestampServer: WINDOWS_TIMESTAMP_SERVER,
  };
}

export async function signWindowsRelease({
  appDirectory,
  outputDirectory,
  environment = process.env,
  signImplementation = sign,
  createInstallerImplementation = createWindowsInstaller,
}) {
  const packageJson = JSON.parse(
    await readFile(path.resolve('package.json'), 'utf8'),
  );
  const signing = windowsSignOptions(environment);
  const resolvedAppDirectory = path.resolve(appDirectory);
  const resolvedOutputDirectory = path.resolve(outputDirectory);

  await signImplementation({
    appDirectory: resolvedAppDirectory,
    ...signing,
  });

  const installerInput = await mkdtemp(
    path.join(os.tmpdir(), 'printfarmer-squirrel-'),
  );
  try {
    await cp(resolvedAppDirectory, installerInput, { recursive: true });
    await createInstallerImplementation({
      appDirectory: installerInput,
      outputDirectory: resolvedOutputDirectory,
      name: packageJson.name.replaceAll('-', '_'),
      title: packageJson.productName,
      authors: packageJson.author,
      description: packageJson.description,
      version: packageJson.version,
      exe: `${packageJson.productName}.exe`,
      setupExe: `${packageJson.productName}-${packageJson.version} Setup.exe`,
      setupIcon: path.resolve('assets', 'icon.ico'),
      iconUrl:
        'https://raw.githubusercontent.com/OlyForge3D/PrintFarmerDesktop/development/assets/icon.ico',
      noMsi: true,
      windowsSign: signing,
    });
  } finally {
    await rm(installerInput, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      'app-directory': { type: 'string' },
      'output-directory': { type: 'string' },
    },
  });
  if (!values['app-directory'] || !values['output-directory']) {
    throw new Error('--app-directory and --output-directory are required');
  }
  await signWindowsRelease({
    appDirectory: values['app-directory'],
    outputDirectory: values['output-directory'],
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
