import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { macAppPaths } from './adhoc-sign-macos-app.mjs';

const STAGES = {
  alpha: { offset: 0, maximum: 7 },
  beta: { offset: 8, maximum: 29 },
  rc: { offset: 38, maximum: 9 },
};
const STABLE_STAGE = 48;
const STAGES_PER_VERSION = 49;
const FIRST_BUILD = 100;

export function macBundleVersionOptions(version) {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.exec(
      version,
    );
  if (!match || match[0] !== version) {
    throw new Error(
      `Unsupported macOS bundle version ${JSON.stringify(version)}: expected MAJOR.MINOR.PATCH[-{alpha|beta|rc}.N] without build metadata`,
    );
  }

  const [, majorText, minorText, patchText, stageName, stageText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const patch = Number(patchText);
  const stage = stageName === undefined ? undefined : STAGES[stageName];
  const stageNumber = stageText === undefined ? undefined : Number(stageText);
  if (
    major > 1 ||
    minor > 9 ||
    patch > 9 ||
    (stage && stageNumber > stage.maximum)
  ) {
    throw new Error(
      `Unsupported macOS bundle version ${JSON.stringify(version)}: supported ranges are major 0–1, minor and patch 0–9, alpha.0–7, beta.0–29, and rc.0–9`,
    );
  }

  // The legacy Core Foundation numeric parser accepts only NN.N.N. Reserve
  // 49 ordered prerelease/final slots per version and keep the first digit > 0.
  const core = major * 100 + minor * 10 + patch;
  const stageIndex = stage ? stage.offset + stageNumber : STABLE_STAGE;
  const build = FIRST_BUILD + core * STAGES_PER_VERSION + stageIndex;
  return {
    appVersion: `${majorText}.${minorText}.${patchText}`,
    buildVersion: `${Math.floor(build / 100)}.${Math.floor((build % 100) / 10)}.${build % 10}`,
  };
}

export function configureMacBundleVersions(config, platform, readVersion) {
  if (platform !== 'darwin') return;
  const options = macBundleVersionOptions(readVersion());
  config.packagerConfig = { ...config.packagerConfig, ...options };
}

export function macHelperAppPaths(
  appPath,
  readDirectory = (directory) =>
    readdirSync(directory, { withFileTypes: true }),
) {
  const frameworks = path.join(appPath, 'Contents', 'Frameworks');
  return readDirectory(frameworks)
    .filter(
      (entry) =>
        entry.isDirectory() &&
        entry.name.startsWith('PrintFarmer Desktop Helper') &&
        entry.name.endsWith('.app'),
    )
    .map((entry) => path.join(frameworks, entry.name))
    .sort();
}

function readPlistValue(plistPath, key) {
  const result = spawnSync(
    '/usr/bin/plutil',
    ['-extract', key, 'raw', '-expect', 'string', '-o', '-', plistPath],
    { encoding: 'utf8' },
  );
  if (result.error || result.status !== 0) {
    throw new Error(
      `Cannot read ${key} from ${plistPath}: ${result.error?.message ?? result.stderr.trim()}`,
    );
  }
  return result.stdout.replace(/\r?\n$/, '');
}

export function verifyMacBundleVersions(
  outputPaths,
  version,
  {
    listHelpersImplementation = macHelperAppPaths,
    readPlistValueImplementation = readPlistValue,
  } = {},
) {
  if (outputPaths.length === 0) {
    throw new Error('No packaged macOS application was produced');
  }
  const { appVersion, buildVersion } = macBundleVersionOptions(version);
  for (const appPath of macAppPaths(outputPaths)) {
    const helpers = listHelpersImplementation(appPath);
    if (helpers.length === 0) {
      throw new Error(
        `No packaged macOS helper applications found in ${appPath}`,
      );
    }
    for (const bundlePath of [appPath, ...helpers]) {
      const plistPath = path.join(bundlePath, 'Contents', 'Info.plist');
      for (const [key, expected] of [
        ['CFBundleShortVersionString', appVersion],
        ['CFBundleVersion', buildVersion],
      ]) {
        const actual = readPlistValueImplementation(plistPath, key);
        if (actual !== expected) {
          throw new Error(
            `${plistPath}: ${key} is ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
          );
        }
      }
    }
  }
}
