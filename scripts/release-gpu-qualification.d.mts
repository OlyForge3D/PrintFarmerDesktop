export type PhysicalGpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple';
export type QualifiedGpuPlatform = 'win32' | 'darwin';
export type QualifiedGpuArchitecture = 'x64' | 'arm64';

export interface GpuQualificationProfile {
  id: string;
  platform: QualifiedGpuPlatform;
  architecture: QualifiedGpuArchitecture;
  vendor: PhysicalGpuVendor;
  runnerLabels: string[];
}

export interface SystemGpuAdapter {
  name: string;
  vendor: string;
  driverVersion: string | null;
  driverDate: string | null;
  deviceId: string | null;
  metalSupport: string | null;
}

export interface GpuQualificationReport {
  schemaVersion: 1;
  profile: Omit<GpuQualificationProfile, 'runnerLabels'>;
  gitSha: string;
  observed: {
    platform: QualifiedGpuPlatform;
    architecture: QualifiedGpuArchitecture;
    gpuMode: 'default';
    capability: {
      webgl2: true;
      vendor: string;
      renderer: string;
      version: string;
      shadingLanguageVersion: string;
      antialias: boolean;
    };
  };
  checks: {
    modelRendered: true;
    orbitChangedImage: true;
    resetRestoredImage: true;
    viewerRemainedResponsive: true;
  };
  system: {
    osRelease: string;
    osVersion: string;
    cpuModel: string;
  };
  adapters: SystemGpuAdapter[];
  source: {
    repository: string | null;
    runId: string | null;
    runAttempt: string | null;
    runnerName: string | null;
  };
  capturedAt: string;
}

export const GPU_QUALIFICATION_MATRIX: GpuQualificationProfile[];

export function githubGpuMatrix(): {
  include: Array<{
    profileId: string;
    runnerLabels: string[];
  }>;
};

export function normalizeWindowsGpuAdapters(value: unknown): SystemGpuAdapter[];
export function normalizeMacGpuAdapters(value: unknown): SystemGpuAdapter[];

export function buildGpuQualificationReport(
  rawEvidence: unknown,
  adapters: SystemGpuAdapter[],
  system?: {
    osRelease: string;
    osVersion: string;
    cpuModel: string;
  },
  source?: {
    repository?: string | null;
    runId?: string | null;
    runAttempt?: string | null;
    runnerName?: string | null;
  },
): GpuQualificationReport;

export function verifyGpuQualificationReports(
  reports: unknown[],
  options: {
    gitSha: string;
    repository?: string | null;
    runId?: string | null;
    runAttempt?: string | null;
  },
): {
  schemaVersion: 1;
  gitSha: string;
  repository: string | null;
  runId: string | null;
  runAttempt: string | null;
  profiles: Array<{
    id: string;
    vendor: PhysicalGpuVendor;
    platform: QualifiedGpuPlatform;
    architecture: QualifiedGpuArchitecture;
    renderer: string;
    driverVersions: string[];
  }>;
};
