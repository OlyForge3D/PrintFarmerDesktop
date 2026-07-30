import { execFileSync } from 'node:child_process';
import {
  cpus,
  platform as hostPlatform,
  release as osRelease,
  version as osVersion,
} from 'node:os';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

const matrixUrl = new URL('./release-gpu-matrix.json', import.meta.url);
const VENDOR_PATTERNS = {
  nvidia: /nvidia|geforce|quadro|\brtx\b|\bgtx\b/i,
  amd: /\bamd\b|radeon|advanced micro devices/i,
  intel: /\bintel\b|iris|uhd graphics|\barc\b/i,
  apple: /\bapple\b|metal renderer:\s*apple/i,
};
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|microsoft basic render|lavapipe|virgl|virtualbox|vmware|parallels/i;

export const GPU_QUALIFICATION_MATRIX = validateMatrix(
  JSON.parse(readFileSync(matrixUrl, 'utf8')),
);

export function githubGpuMatrix() {
  return {
    include: GPU_QUALIFICATION_MATRIX.map(({ id, runnerLabels }) => ({
      profileId: id,
      runnerLabels,
    })),
  };
}

export function normalizeWindowsGpuAdapters(value) {
  const entries = Array.isArray(value) ? value : [value];
  return entries
    .filter(isRecord)
    .map((entry) => ({
      name: stringValue(entry.Name),
      vendor: stringValue(entry.AdapterCompatibility),
      driverVersion: nullableString(entry.DriverVersion),
      driverDate: nullableString(entry.DriverDate),
      deviceId: nullableString(entry.PNPDeviceID),
      metalSupport: null,
    }))
    .filter(({ name, vendor }) => name !== '' || vendor !== '');
}

export function normalizeMacGpuAdapters(value) {
  if (!isRecord(value) || !Array.isArray(value.SPDisplaysDataType)) {
    return [];
  }
  return value.SPDisplaysDataType.filter(isRecord)
    .map((entry) => ({
      name: stringValue(entry.sppci_model ?? entry._name),
      vendor: stringValue(
        entry.sppci_vendor ?? entry.spdisplays_vendor ?? entry._name,
      ),
      driverVersion: null,
      driverDate: null,
      deviceId: nullableString(
        entry['spdisplays_device-id'] ?? entry.sppci_device_type,
      ),
      metalSupport: nullableString(entry.spdisplays_metal),
    }))
    .filter(({ name, vendor }) => name !== '' || vendor !== '');
}

export function buildGpuQualificationReport(
  rawEvidence,
  adapters,
  system = currentSystemMetadata(),
  source = sourceMetadataFromEnvironment(),
) {
  const { profile, evidence } = validateRawEvidence(rawEvidence);
  if (!Array.isArray(adapters) || adapters.length === 0) {
    throw new Error(
      `Physical GPU profile ${profile.id} did not report a system graphics adapter.`,
    );
  }
  const normalizedAdapters = adapters.map(normalizeAdapterRecord);
  const matchingAdapters = normalizedAdapters.filter((adapter) =>
    matchesVendor(profile.vendor, `${adapter.vendor} ${adapter.name}`),
  );
  if (matchingAdapters.length === 0) {
    throw new Error(
      `Physical GPU profile ${profile.id} expected a ${profile.vendor} system adapter; inventory reported ${normalizedAdapters.map((adapter) => `"${adapter.vendor} ${adapter.name}"`).join(', ')}.`,
    );
  }
  requirePlatformDriverEvidence(profile, matchingAdapters);

  return {
    schemaVersion: 1,
    profile: {
      id: profile.id,
      platform: profile.platform,
      architecture: profile.architecture,
      vendor: profile.vendor,
    },
    gitSha: evidence.gitSha,
    observed: evidence.observed,
    checks: evidence.checks,
    system: {
      osRelease: requiredNonEmptyString(system.osRelease, 'system.osRelease'),
      osVersion: requiredNonEmptyString(system.osVersion, 'system.osVersion'),
      cpuModel: requiredNonEmptyString(system.cpuModel, 'system.cpuModel'),
    },
    adapters: normalizedAdapters,
    source: {
      repository: nullableString(source.repository),
      runId: nullableString(source.runId),
      runAttempt: nullableString(source.runAttempt),
      runnerName: nullableString(source.runnerName),
    },
    capturedAt: new Date().toISOString(),
  };
}

export function verifyGpuQualificationReports(
  reports,
  { gitSha, repository = null, runId = null, runAttempt = null },
) {
  const expectedSha = exactGitSha(gitSha, 'expected Git SHA');
  if (!Array.isArray(reports)) {
    throw new Error('GPU qualification reports must be an array.');
  }
  const byProfile = new Map();
  for (const report of reports) {
    const validated = validateFinalReport(report);
    const profileId = validated.profile.id;
    if (byProfile.has(profileId)) {
      throw new Error(`Duplicate GPU qualification evidence for ${profileId}.`);
    }
    if (validated.gitSha !== expectedSha) {
      throw new Error(
        `GPU qualification evidence for ${profileId} targets ${validated.gitSha}, expected ${expectedSha}.`,
      );
    }
    requireSourceMatch(validated, 'repository', repository);
    requireSourceMatch(validated, 'runId', runId);
    requireSourceMatch(validated, 'runAttempt', runAttempt);
    byProfile.set(profileId, validated);
  }

  const missing = GPU_QUALIFICATION_MATRIX.filter(
    ({ id }) => !byProfile.has(id),
  ).map(({ id }) => id);
  if (missing.length > 0) {
    throw new Error(
      `Missing GPU qualification evidence for: ${missing.join(', ')}.`,
    );
  }

  return {
    schemaVersion: 1,
    gitSha: expectedSha,
    repository,
    runId,
    runAttempt,
    profiles: GPU_QUALIFICATION_MATRIX.map(({ id }) => {
      const report = byProfile.get(id);
      return {
        id,
        vendor: report.profile.vendor,
        platform: report.profile.platform,
        architecture: report.profile.architecture,
        renderer: report.observed.capability.renderer,
        driverVersions: report.adapters
          .map(({ driverVersion }) => driverVersion)
          .filter((value) => value !== null),
      };
    }),
  };
}

function validateMatrix(value) {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('GPU qualification matrix must use schemaVersion 1.');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error('GPU qualification matrix must contain profiles.');
  }
  const ids = new Set();
  return value.profiles.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`GPU qualification profile ${index} must be an object.`);
    }
    const id = requiredField(candidate, 'id', `profile ${index}`);
    const platform = requiredField(candidate, 'platform', id);
    const architecture = requiredField(candidate, 'architecture', id);
    const vendor = requiredField(candidate, 'vendor', id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) {
      throw new Error(`GPU qualification profile id "${id}" is invalid.`);
    }
    ids.add(id);
    if (!['win32', 'darwin'].includes(platform)) {
      throw new Error(`GPU qualification profile ${id} has invalid platform.`);
    }
    if (!['x64', 'arm64'].includes(architecture)) {
      throw new Error(
        `GPU qualification profile ${id} has invalid architecture.`,
      );
    }
    if (!(vendor in VENDOR_PATTERNS)) {
      throw new Error(`GPU qualification profile ${id} has invalid vendor.`);
    }
    if (
      !Array.isArray(candidate.runnerLabels) ||
      candidate.runnerLabels.some(
        (label) => typeof label !== 'string' || label.trim() === '',
      )
    ) {
      throw new Error(
        `GPU qualification profile ${id} must contain runner labels.`,
      );
    }
    const runnerLabels = [...candidate.runnerLabels];
    const requiredLabels = [
      'self-hosted',
      'printfarmer-gpu',
      platform === 'win32' ? 'Windows' : 'macOS',
      architecture === 'arm64' ? 'ARM64' : 'X64',
      vendor,
    ];
    for (const label of requiredLabels) {
      if (!runnerLabels.includes(label)) {
        throw new Error(
          `GPU qualification profile ${id} is missing runner label ${label}.`,
        );
      }
    }
    return { id, platform, architecture, vendor, runnerLabels };
  });
}

function validateRawEvidence(value) {
  const evidence = requireRecord(value, 'raw GPU evidence');
  if (evidence.schemaVersion !== 1) {
    throw new Error('Raw GPU evidence must use schemaVersion 1.');
  }
  const profileId = requiredField(evidence, 'profileId', 'raw GPU evidence');
  const profile = profileById(profileId);
  const expected = requireRecord(evidence.expected, `${profileId}.expected`);
  requireEqual(expected, 'platform', profile.platform, profileId);
  requireEqual(expected, 'architecture', profile.architecture, profileId);
  requireEqual(expected, 'vendor', profile.vendor, profileId);
  const observed = requireRecord(evidence.observed, `${profileId}.observed`);
  requireEqual(observed, 'platform', profile.platform, profileId);
  requireEqual(observed, 'architecture', profile.architecture, profileId);
  requireEqual(observed, 'gpuMode', 'default', profileId);
  const capability = requireRecord(
    observed.capability,
    `${profileId}.observed.capability`,
  );
  if (capability.webgl2 !== true) {
    throw new Error(`${profileId} did not report WebGL2.`);
  }
  const identity = `${requiredField(capability, 'vendor', profileId)} ${requiredField(capability, 'renderer', profileId)}`;
  if (SOFTWARE_RENDERER.test(identity)) {
    throw new Error(
      `Physical GPU profile ${profileId} rejected software or virtual renderer "${identity}".`,
    );
  }
  if (!matchesVendor(profile.vendor, identity)) {
    throw new Error(
      `Physical GPU profile ${profileId} expected ${profile.vendor} WebGL hardware, but reported "${identity}".`,
    );
  }
  requiredField(capability, 'version', profileId);
  requiredField(capability, 'shadingLanguageVersion', profileId);
  const checks = requireRecord(evidence.checks, `${profileId}.checks`);
  for (const name of [
    'modelRendered',
    'orbitChangedImage',
    'resetRestoredImage',
    'viewerRemainedResponsive',
  ]) {
    if (checks[name] !== true) {
      throw new Error(`${profileId} did not pass scenario check ${name}.`);
    }
  }
  return {
    profile,
    evidence: {
      ...evidence,
      gitSha: exactGitSha(evidence.gitSha, `${profileId}.gitSha`),
      observed: {
        ...observed,
        capability: {
          ...capability,
          vendor: capability.vendor,
          renderer: capability.renderer,
        },
      },
      checks,
    },
  };
}

function validateFinalReport(value) {
  const report = requireRecord(value, 'GPU qualification report');
  if (report.schemaVersion !== 1) {
    throw new Error('GPU qualification report must use schemaVersion 1.');
  }
  const profileNode = requireRecord(report.profile, 'report.profile');
  const profileId = requiredField(profileNode, 'id', 'report.profile');
  const profile = profileById(profileId);
  requireEqual(profileNode, 'platform', profile.platform, profileId);
  requireEqual(profileNode, 'architecture', profile.architecture, profileId);
  requireEqual(profileNode, 'vendor', profile.vendor, profileId);
  const raw = validateRawEvidence({
    schemaVersion: 1,
    profileId,
    gitSha: report.gitSha,
    expected: profileNode,
    observed: report.observed,
    checks: report.checks,
  }).evidence;
  if (!Array.isArray(report.adapters) || report.adapters.length === 0) {
    throw new Error(`${profileId} did not include system adapter evidence.`);
  }
  const adapters = report.adapters.map(normalizeAdapterRecord);
  if (
    !adapters.some((adapter) =>
      matchesVendor(profile.vendor, `${adapter.vendor} ${adapter.name}`),
    )
  ) {
    throw new Error(
      `${profileId} did not include a matching ${profile.vendor} system adapter.`,
    );
  }
  requirePlatformDriverEvidence(
    profile,
    adapters.filter((adapter) =>
      matchesVendor(profile.vendor, `${adapter.vendor} ${adapter.name}`),
    ),
  );
  const source = requireRecord(report.source, `${profileId}.source`);
  return {
    ...report,
    profile,
    gitSha: raw.gitSha,
    observed: raw.observed,
    checks: raw.checks,
    adapters,
    source: {
      repository: nullableString(source.repository),
      runId: nullableString(source.runId),
      runAttempt: nullableString(source.runAttempt),
      runnerName: nullableString(source.runnerName),
    },
  };
}

function captureSystemGpuAdapters(platform = hostPlatform()) {
  if (platform === 'win32') {
    const command = [
      "$ErrorActionPreference = 'Stop'",
      '[Console]::OutputEncoding = [Text.UTF8Encoding]::new()',
      '$items = @(Get-CimInstance Win32_VideoController | Select-Object Name, AdapterCompatibility, DriverVersion, @{Name = "DriverDate"; Expression = { if ($null -eq $_.DriverDate) { $null } else { $_.DriverDate.ToUniversalTime().ToString("o") } }}, PNPDeviceID)',
      'ConvertTo-Json -InputObject $items -Compress -Depth 4',
    ].join('; ');
    return normalizeWindowsGpuAdapters(
      JSON.parse(
        execFileSync(
          'powershell.exe',
          ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
          { encoding: 'utf8', maxBuffer: 1024 * 1024 },
        ),
      ),
    );
  }
  if (platform === 'darwin') {
    return normalizeMacGpuAdapters(
      JSON.parse(
        execFileSync(
          '/usr/sbin/system_profiler',
          ['SPDisplaysDataType', '-json'],
          { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
        ),
      ),
    );
  }
  throw new Error(
    `Physical GPU adapter capture supports win32 and darwin, not ${platform}.`,
  );
}

function currentSystemMetadata() {
  return {
    osRelease: osRelease(),
    osVersion: osVersion(),
    cpuModel: cpus()[0]?.model ?? 'unknown',
  };
}

function sourceMetadataFromEnvironment(environment = process.env) {
  return {
    repository: environment.GITHUB_REPOSITORY ?? null,
    runId: environment.GITHUB_RUN_ID ?? null,
    runAttempt: environment.GITHUB_RUN_ATTEMPT ?? null,
    runnerName: environment.RUNNER_NAME ?? null,
  };
}

function normalizeAdapterRecord(value) {
  const adapter = requireRecord(value, 'GPU adapter');
  return {
    name: requiredNonEmptyString(adapter.name, 'GPU adapter name'),
    vendor: requiredNonEmptyString(adapter.vendor, 'GPU adapter vendor'),
    driverVersion: nullableString(adapter.driverVersion),
    driverDate: nullableString(adapter.driverDate),
    deviceId: nullableString(adapter.deviceId),
    metalSupport: nullableString(adapter.metalSupport),
  };
}

function profileById(id) {
  const profile = GPU_QUALIFICATION_MATRIX.find(
    (candidate) => candidate.id === id,
  );
  if (!profile) {
    throw new Error(`Unknown GPU qualification profile "${id}".`);
  }
  return profile;
}

function matchesVendor(vendor, identity) {
  return VENDOR_PATTERNS[vendor].test(identity);
}

function requirePlatformDriverEvidence(profile, matchingAdapters) {
  if (
    profile.platform === 'win32' &&
    !matchingAdapters.some(
      ({ driverVersion, driverDate }) =>
        driverVersion !== null && driverDate !== null,
    )
  ) {
    throw new Error(
      `Physical GPU profile ${profile.id} did not include Windows driver version and date evidence.`,
    );
  }
  if (
    profile.platform === 'darwin' &&
    !matchingAdapters.some(({ metalSupport }) => metalSupport !== null)
  ) {
    throw new Error(
      `Physical GPU profile ${profile.id} did not include macOS Metal support evidence.`,
    );
  }
}

function requireSourceMatch(report, field, expected) {
  if (expected === null) {
    return;
  }
  if (report.source[field] !== expected) {
    throw new Error(
      `GPU qualification evidence for ${report.profile.id} has source ${field} ${report.source[field] ?? '<missing>'}, expected ${expected}.`,
    );
  }
}

function requireEqual(record, key, expected, context) {
  if (record[key] !== expected) {
    throw new Error(
      `${context}.${key} must be ${expected}, received ${String(record[key])}.`,
    );
  }
}

function requiredField(record, key, context) {
  return requiredNonEmptyString(record[key], `${context}.${key}`);
}

function requiredNonEmptyString(value, context) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

function exactGitSha(value, context) {
  const sha = requiredNonEmptyString(value, context).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${context} must be an exact 40-character Git SHA.`);
  }
  return sha;
}

function nullableString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function stringValue(value) {
  return nullableString(value) ?? '';
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value, context) {
  if (!isRecord(value)) {
    throw new Error(`${context} must be an object.`);
  }
  return value;
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function jsonFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const resolved = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...jsonFiles(resolved));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(resolved);
    }
  }
  return files.sort();
}

function optionOrEnvironment(value, environmentName) {
  const resolved = value ?? process.env[environmentName];
  if (typeof resolved !== 'string' || resolved.trim() === '') {
    throw new Error(
      `Missing --${environmentName.toLowerCase().replaceAll('_', '-')} or ${environmentName}.`,
    );
  }
  return path.resolve(resolved);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'matrix') {
    const { values } = parseArgs({
      args,
      options: { 'github-output': { type: 'boolean', default: false } },
    });
    const matrix = JSON.stringify(githubGpuMatrix());
    console.log(values['github-output'] ? `matrix=${matrix}` : matrix);
    return;
  }
  if (command === 'capture') {
    const { values } = parseArgs({
      args,
      options: {
        webgl: { type: 'string' },
        output: { type: 'string' },
      },
    });
    const webgl = optionOrEnvironment(
      values.webgl,
      'PRINTFARMER_E2E_GPU_REPORT',
    );
    const output = optionOrEnvironment(
      values.output,
      'PRINTFARMER_GPU_EVIDENCE_REPORT',
    );
    const rawEvidence = readJson(webgl);
    const report = buildGpuQualificationReport(
      rawEvidence,
      captureSystemGpuAdapters(),
    );
    mkdirSync(path.dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`Wrote physical GPU evidence for ${report.profile.id}.`);
    return;
  }
  if (command === 'verify') {
    const { values } = parseArgs({
      args,
      options: {
        reports: { type: 'string' },
        sha: { type: 'string' },
        repository: { type: 'string' },
        'run-id': { type: 'string' },
        'run-attempt': { type: 'string' },
        summary: { type: 'string' },
      },
    });
    const reportsDirectory = optionOrEnvironment(
      values.reports,
      'PRINTFARMER_GPU_EVIDENCE_DIRECTORY',
    );
    const sha = values.sha ?? process.env.PRINTFARMER_GPU_EXPECTED_SHA ?? '';
    const repository =
      values.repository ??
      process.env.PRINTFARMER_GPU_EXPECTED_REPOSITORY ??
      null;
    const runId =
      values['run-id'] ?? process.env.PRINTFARMER_GPU_EXPECTED_RUN_ID ?? null;
    const runAttempt =
      values['run-attempt'] ??
      process.env.PRINTFARMER_GPU_EXPECTED_RUN_ATTEMPT ??
      null;
    const reports = jsonFiles(reportsDirectory).map(readJson);
    const summary = verifyGpuQualificationReports(reports, {
      gitSha: sha,
      repository,
      runId,
      runAttempt,
    });
    const summaryPath =
      values.summary ?? process.env.PRINTFARMER_GPU_SUMMARY_REPORT;
    if (summaryPath) {
      const resolvedSummary = path.resolve(summaryPath);
      mkdirSync(path.dirname(resolvedSummary), { recursive: true });
      writeFileSync(
        resolvedSummary,
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf8',
      );
    }
    console.log(
      `Qualified ${summary.profiles.length} physical GPU profiles for ${summary.gitSha}.`,
    );
    return;
  }
  throw new Error(
    'usage: release-gpu-qualification.mjs <matrix|capture|verify> [options]',
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
