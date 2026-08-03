import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PackagedGpuMode } from './packagedApp';

export type PhysicalGpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple';
export type QualifiedGpuPlatform = 'win32' | 'darwin';
export type QualifiedGpuArchitecture = 'x64' | 'arm64';

export interface GpuQualificationProfile {
  id: string;
  platform: QualifiedGpuPlatform;
  architecture: QualifiedGpuArchitecture;
  vendor: PhysicalGpuVendor;
  runnerLabels: readonly string[];
}

export interface GraphicsCapability {
  webgl2: boolean;
  vendor: string;
  renderer: string;
  version: string;
  shadingLanguageVersion: string;
  antialias: boolean;
}

export interface HardwareGpuQualificationRequest {
  profile: GpuQualificationProfile;
  gitSha: string;
  reportPath: string;
}

export interface GpuScenarioChecks {
  modelRendered: boolean;
  orbitChangedImage: boolean;
  resetRestoredImage: boolean;
  viewerRemainedResponsive: boolean;
}

export interface RawHardwareGpuEvidence {
  schemaVersion: 1;
  profileId: string;
  gitSha: string;
  expected: {
    platform: QualifiedGpuPlatform;
    architecture: QualifiedGpuArchitecture;
    vendor: PhysicalGpuVendor;
  };
  observed: {
    platform: NodeJS.Platform;
    architecture: string;
    gpuMode: PackagedGpuMode;
    capability: GraphicsCapability;
  };
  checks: GpuScenarioChecks;
}

const VENDORS = new Set<PhysicalGpuVendor>(['nvidia', 'amd', 'intel', 'apple']);
const PLATFORMS = new Set<QualifiedGpuPlatform>(['win32', 'darwin']);
const ARCHITECTURES = new Set<QualifiedGpuArchitecture>(['x64', 'arm64']);
const SOFTWARE_RENDERER =
  /swiftshader|llvmpipe|softpipe|software rasterizer|software adapter|microsoft basic render|lavapipe|virgl|virtualbox|vmware|parallels/i;
const VENDOR_PATTERNS: Readonly<Record<PhysicalGpuVendor, RegExp>> = {
  nvidia: /nvidia|geforce|quadro|\brtx\b|\bgtx\b/i,
  amd: /\bamd\b|radeon|advanced micro devices/i,
  intel: /\bintel\b|iris|uhd graphics|\barc\b/i,
  apple: /\bapple\b|metal renderer:\s*apple/i,
};
const HARDWARE_ENVIRONMENT_NAMES = [
  'PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE',
  'PRINTFARMER_E2E_GPU_PROFILE',
  'PRINTFARMER_E2E_GPU_REPORT',
  'PRINTFARMER_E2E_COMMIT_SHA',
] as const;

const matrixManifest: unknown = JSON.parse(
  readFileSync(
    new URL('../../scripts/release-gpu-matrix.json', import.meta.url),
    'utf8',
  ),
);
export const gpuQualificationProfiles = parseProfiles(matrixManifest);

export function hardwareGpuRequestFromEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): HardwareGpuQualificationRequest | null {
  const configuredNames = HARDWARE_ENVIRONMENT_NAMES.filter((name) => {
    const value = environment[name];
    return value !== undefined && value.trim() !== '';
  });
  if (configuredNames.length === 0) {
    return null;
  }
  if (environment.PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE !== '1') {
    throw new Error(
      'Physical GPU qualification requires PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE=1; partial hardware qualification settings are not accepted.',
    );
  }

  const profileId = requiredEnvironmentValue(
    environment,
    'PRINTFARMER_E2E_GPU_PROFILE',
  );
  const profile = gpuQualificationProfiles.find(
    (candidate) => candidate.id === profileId,
  );
  if (profile === undefined) {
    throw new Error(
      `Unknown physical GPU profile "${profileId}". Expected one of: ${gpuQualificationProfiles.map(({ id }) => id).join(', ')}.`,
    );
  }
  const gitSha = requiredEnvironmentValue(
    environment,
    'PRINTFARMER_E2E_COMMIT_SHA',
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(gitSha)) {
    throw new Error(
      'PRINTFARMER_E2E_COMMIT_SHA must be an exact 40-character Git commit SHA.',
    );
  }

  return {
    profile,
    gitSha,
    reportPath: path.resolve(
      requiredEnvironmentValue(environment, 'PRINTFARMER_E2E_GPU_REPORT'),
    ),
  };
}

export function assertPhysicalGpuCapability(
  request: HardwareGpuQualificationRequest,
  capability: GraphicsCapability,
  gpuMode: PackagedGpuMode,
  actualPlatform: NodeJS.Platform = process.platform,
  actualArchitecture = process.arch,
): void {
  const { profile } = request;
  if (gpuMode !== 'default') {
    throw new Error(
      `Physical GPU profile ${profile.id} requires host-default rendering, not ${gpuMode}.`,
    );
  }
  if (actualPlatform !== profile.platform) {
    throw new Error(
      `Physical GPU profile ${profile.id} requires platform ${profile.platform}, but the runner reported ${actualPlatform}.`,
    );
  }
  if (actualArchitecture !== profile.architecture) {
    throw new Error(
      `Physical GPU profile ${profile.id} requires architecture ${profile.architecture}, but the runner reported ${actualArchitecture}.`,
    );
  }
  if (!capability.webgl2) {
    throw new Error(
      `Physical GPU profile ${profile.id} did not create a WebGL2 context.`,
    );
  }

  const graphicsIdentity = `${capability.vendor} ${capability.renderer}`.trim();
  if (SOFTWARE_RENDERER.test(graphicsIdentity)) {
    throw new Error(
      `Physical GPU profile ${profile.id} rejected software or virtual renderer "${graphicsIdentity}".`,
    );
  }
  if (!VENDOR_PATTERNS[profile.vendor].test(graphicsIdentity)) {
    throw new Error(
      `Physical GPU profile ${profile.id} expected ${profile.vendor} hardware, but WebGL reported "${graphicsIdentity}".`,
    );
  }
  for (const [field, value] of [
    ['vendor', capability.vendor],
    ['renderer', capability.renderer],
    ['version', capability.version],
    ['shadingLanguageVersion', capability.shadingLanguageVersion],
  ] as const) {
    if (value.trim() === '') {
      throw new Error(
        `Physical GPU profile ${profile.id} reported an empty WebGL ${field}.`,
      );
    }
  }
}

export function createHardwareGpuEvidence(
  request: HardwareGpuQualificationRequest,
  capability: GraphicsCapability,
  gpuMode: PackagedGpuMode,
  checks: GpuScenarioChecks,
  actualPlatform: NodeJS.Platform = process.platform,
  actualArchitecture = process.arch,
): RawHardwareGpuEvidence {
  assertPhysicalGpuCapability(
    request,
    capability,
    gpuMode,
    actualPlatform,
    actualArchitecture,
  );
  for (const [name, passed] of Object.entries(checks)) {
    if (passed !== true) {
      throw new Error(
        `Physical GPU profile ${request.profile.id} did not complete scenario check ${name}.`,
      );
    }
  }

  return {
    schemaVersion: 1,
    profileId: request.profile.id,
    gitSha: request.gitSha,
    expected: {
      platform: request.profile.platform,
      architecture: request.profile.architecture,
      vendor: request.profile.vendor,
    },
    observed: {
      platform: actualPlatform,
      architecture: actualArchitecture,
      gpuMode,
      capability,
    },
    checks: { ...checks },
  };
}

export function writeHardwareGpuEvidence(
  request: HardwareGpuQualificationRequest,
  evidence: RawHardwareGpuEvidence,
): void {
  mkdirSync(path.dirname(request.reportPath), { recursive: true });
  writeFileSync(
    request.reportPath,
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
}

function parseProfiles(value: unknown): GpuQualificationProfile[] {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('GPU qualification matrix must use schemaVersion 1.');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length === 0) {
    throw new Error('GPU qualification matrix must contain profiles.');
  }

  const ids = new Set<string>();
  return value.profiles.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw new Error(`GPU qualification profile ${index} must be an object.`);
    }
    const id = requiredString(candidate, 'id', `profile ${index}`);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || ids.has(id)) {
      throw new Error(`GPU qualification profile id "${id}" is invalid.`);
    }
    ids.add(id);
    const platform = requiredString(candidate, 'platform', id);
    const architecture = requiredString(candidate, 'architecture', id);
    const vendor = requiredString(candidate, 'vendor', id);
    if (!PLATFORMS.has(platform as QualifiedGpuPlatform)) {
      throw new Error(`GPU qualification profile ${id} has invalid platform.`);
    }
    if (!ARCHITECTURES.has(architecture as QualifiedGpuArchitecture)) {
      throw new Error(
        `GPU qualification profile ${id} has invalid architecture.`,
      );
    }
    if (!VENDORS.has(vendor as PhysicalGpuVendor)) {
      throw new Error(`GPU qualification profile ${id} has invalid vendor.`);
    }
    if (!isNonEmptyStringArray(candidate.runnerLabels)) {
      throw new Error(
        `GPU qualification profile ${id} must contain runner labels.`,
      );
    }

    return {
      id,
      platform: platform as QualifiedGpuPlatform,
      architecture: architecture as QualifiedGpuArchitecture,
      vendor: vendor as PhysicalGpuVendor,
      runnerLabels: [...candidate.runnerLabels],
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (entry: unknown) => typeof entry === 'string' && entry.trim() !== '',
    )
  );
}

function requiredString(
  record: Readonly<Record<string, unknown>>,
  key: string,
  context: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${context}.${key} must be a non-empty string.`);
  }
  return value.trim();
}

function requiredEnvironmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: (typeof HARDWARE_ENVIRONMENT_NAMES)[number],
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(`Physical GPU qualification requires ${name}.`);
  }
  return value;
}
