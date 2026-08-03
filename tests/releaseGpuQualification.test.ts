// @vitest-environment node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertPhysicalGpuCapability,
  createHardwareGpuEvidence,
  gpuQualificationProfiles,
  hardwareGpuRequestFromEnvironment,
  writeHardwareGpuEvidence,
  type GraphicsCapability,
  type GpuQualificationProfile,
} from '../e2e/helpers/gpuQualification';
import {
  buildGpuQualificationReport,
  githubGpuMatrix,
  normalizeMacGpuAdapters,
  normalizeWindowsGpuAdapters,
  verifyGpuQualificationReports,
  type GpuQualificationReport,
  type SystemGpuAdapter,
} from '../scripts/release-gpu-qualification.mjs';

const sha = 'a'.repeat(40);
const repository = 'OlyForge3D/PrintFarmerDesktop';
const runId = '12345';
const runAttempt = '2';
const temporaryRoots: string[] = [];
const hardwareWorkflow = readFileSync(
  path.resolve(
    import.meta.dirname,
    '..',
    '.github',
    'workflows',
    'release-gpu-qualification.yml',
  ),
  'utf8',
);

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('physical GPU request and WebGL evidence', () => {
  it('keeps ordinary default and SwiftShader CI outside hardware qualification', () => {
    expect(
      hardwareGpuRequestFromEnvironment({
        PRINTFARMER_E2E_GPU_MODE: 'swiftshader',
      }),
    ).toBeNull();
  });

  it('rejects a partial hardware request with an activation diagnostic', () => {
    expect(() =>
      hardwareGpuRequestFromEnvironment({
        PRINTFARMER_E2E_GPU_PROFILE: 'windows-x64-nvidia',
      }),
    ).toThrow(
      'Physical GPU qualification requires PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE=1',
    );
  });

  it('rejects software rendering even when the runner profile is physical', () => {
    const request = requestFor(profile('windows-x64-nvidia'));
    expect(() =>
      assertPhysicalGpuCapability(
        request,
        capability(
          'Google Inc. (Google)',
          'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device))',
        ),
        'default',
        'win32',
        'x64',
      ),
    ).toThrow(
      'Physical GPU profile windows-x64-nvidia rejected software or virtual renderer',
    );
  });

  it('rejects the wrong physical vendor with the observed renderer', () => {
    const request = requestFor(profile('windows-x64-nvidia'));
    expect(() =>
      assertPhysicalGpuCapability(
        request,
        capability(
          'Google Inc. (Intel)',
          'ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11)',
        ),
        'default',
        'win32',
        'x64',
      ),
    ).toThrow(
      'expected nvidia hardware, but WebGL reported "Google Inc. (Intel) ANGLE (Intel, Intel(R) UHD Graphics 770 Direct3D11)"',
    );
  });

  it('writes evidence only after every packaged viewer check passes', () => {
    const target = profile('macos-arm64-apple');
    const request = requestFor(target);
    const evidence = createHardwareGpuEvidence(
      request,
      capability(
        'Apple Inc.',
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)',
      ),
      'default',
      {
        modelRendered: true,
        orbitChangedImage: true,
        resetRestoredImage: true,
        viewerRemainedResponsive: true,
      },
      'darwin',
      'arm64',
    );
    writeHardwareGpuEvidence(request, evidence);

    expect(JSON.parse(readFileSync(request.reportPath, 'utf8'))).toEqual(
      evidence,
    );
  });
});

describe('physical GPU matrix and aggregate gate', () => {
  it('pins every supported Windows/macOS architecture and GPU vendor profile', () => {
    expect(gpuQualificationProfiles.map(({ id }) => id)).toEqual([
      'windows-x64-nvidia',
      'windows-x64-amd',
      'windows-x64-intel',
      'macos-arm64-apple',
      'macos-x64-intel',
      'macos-x64-amd',
    ]);
    expect(githubGpuMatrix().include).toEqual(
      gpuQualificationProfiles.map(({ id, runnerLabels }) => ({
        profileId: id,
        runnerLabels: [...runnerLabels],
      })),
    );
  });

  it('normalizes Windows driver and macOS Metal inventory evidence', () => {
    expect(
      normalizeWindowsGpuAdapters({
        Name: 'NVIDIA GeForce RTX 4080',
        AdapterCompatibility: 'NVIDIA',
        DriverVersion: '32.0.15.7216',
        DriverDate: '2026-07-01',
        PNPDeviceID: 'PCI\\VEN_10DE',
      }),
    ).toEqual([
      {
        name: 'NVIDIA GeForce RTX 4080',
        vendor: 'NVIDIA',
        driverVersion: '32.0.15.7216',
        driverDate: '2026-07-01',
        deviceId: 'PCI\\VEN_10DE',
        metalSupport: null,
      },
    ]);
    expect(
      normalizeMacGpuAdapters({
        SPDisplaysDataType: [
          {
            sppci_model: 'Apple M3 Pro',
            sppci_vendor: 'Apple (0x106b)',
            'spdisplays_device-id': '0x0001',
            spdisplays_metal: 'Supported, feature set macOS GPUFamily2 v1',
          },
        ],
      }),
    ).toEqual([
      {
        name: 'Apple M3 Pro',
        vendor: 'Apple (0x106b)',
        driverVersion: null,
        driverDate: null,
        deviceId: '0x0001',
        metalSupport: 'Supported, feature set macOS GPUFamily2 v1',
      },
    ]);
  });

  it('accepts one same-run report for every required physical profile', () => {
    const reports = gpuQualificationProfiles.map(reportFor);
    const summary = verifyGpuQualificationReports(reports, {
      gitSha: sha,
      repository,
      runId,
      runAttempt,
    });

    expect(summary.profiles.map(({ id }) => id)).toEqual(
      gpuQualificationProfiles.map(({ id }) => id),
    );
    expect(summary.gitSha).toBe(sha);
  });

  it('rejects the first missing profile with a specific diagnostic', () => {
    const reports = gpuQualificationProfiles.slice(0, -1).map(reportFor);
    expect(() =>
      verifyGpuQualificationReports(reports, {
        gitSha: sha,
        repository,
        runId,
        runAttempt,
      }),
    ).toThrow('Missing GPU qualification evidence for: macos-x64-amd.');
  });

  it('rejects evidence from a different commit before qualifying the matrix', () => {
    const reports = gpuQualificationProfiles.map(reportFor);
    reports[0] = {
      ...reports[0]!,
      gitSha: 'b'.repeat(40),
    };
    expect(() =>
      verifyGpuQualificationReports(reports, {
        gitSha: sha,
        repository,
        runId,
        runAttempt,
      }),
    ).toThrow(
      `GPU qualification evidence for windows-x64-nvidia targets ${'b'.repeat(40)}, expected ${sha}.`,
    );
  });

  it('rejects duplicate profile evidence instead of choosing one report', () => {
    const reports = gpuQualificationProfiles.map(reportFor);
    reports.push(reports[0]!);
    expect(() =>
      verifyGpuQualificationReports(reports, {
        gitSha: sha,
        repository,
        runId,
        runAttempt,
      }),
    ).toThrow('Duplicate GPU qualification evidence for windows-x64-nvidia.');
  });

  it('rejects a report retained from an earlier workflow attempt', () => {
    const reports = gpuQualificationProfiles.map(reportFor);
    reports[0] = {
      ...reports[0]!,
      source: {
        ...reports[0]!.source,
        runAttempt: '1',
      },
    };
    expect(() =>
      verifyGpuQualificationReports(reports, {
        gitSha: sha,
        repository,
        runId,
        runAttempt,
      }),
    ).toThrow(
      'GPU qualification evidence for windows-x64-nvidia has source runAttempt 1, expected 2.',
    );
  });

  it('rejects WebGL evidence without a matching physical system adapter', () => {
    const target = profile('windows-x64-nvidia');
    const raw = rawEvidenceFor(target);
    expect(() =>
      buildGpuQualificationReport(raw, [
        adapter('Intel UHD Graphics', 'Intel', '31.0.101.5590'),
      ]),
    ).toThrow(
      'Physical GPU profile windows-x64-nvidia expected a nvidia system adapter',
    );
  });

  it('rejects a matching Windows adapter without driver version and date', () => {
    const target = profile('windows-x64-nvidia');
    const raw = rawEvidenceFor(target);
    expect(() =>
      buildGpuQualificationReport(raw, [
        adapter('NVIDIA GeForce RTX 4080', 'NVIDIA', null),
      ]),
    ).toThrow(
      'Physical GPU profile windows-x64-nvidia did not include Windows driver version and date evidence.',
    );
  });

  it('rejects a matching macOS adapter without Metal support evidence', () => {
    const target = profile('macos-arm64-apple');
    const raw = rawEvidenceFor(target);
    expect(() =>
      buildGpuQualificationReport(raw, [
        {
          ...adapter('Apple M3 Pro', 'Apple', null),
          metalSupport: null,
        },
      ]),
    ).toThrow(
      'Physical GPU profile macos-arm64-apple did not include macOS Metal support evidence.',
    );
  });
});

describe('physical GPU workflow contract', () => {
  it('is manual-only and schedules the committed self-hosted matrix', () => {
    expect(hardwareWorkflow).toContain('workflow_dispatch:');
    expect(hardwareWorkflow).not.toContain('pull_request:');
    expect(hardwareWorkflow).not.toContain('\n  push:');
    expect(hardwareWorkflow).toContain(
      'node scripts/release-gpu-qualification.mjs matrix --github-output',
    );
    expect(hardwareWorkflow).toContain('runs-on: ${{ matrix.runnerLabels }}');
    expect(hardwareWorkflow).toContain('fail-fast: false');
  });

  it('packages the real app and fails closed on incomplete hardware evidence', () => {
    expect(hardwareWorkflow).toContain('npm run package');
    expect(hardwareWorkflow).toContain(
      "PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE: '1'",
    );
    expect(hardwareWorkflow).toContain(
      'npx playwright test e2e/release.gpu.spec.ts',
    );
    expect(hardwareWorkflow).toContain(
      'node scripts/release-gpu-qualification.mjs capture',
    );
    expect(hardwareWorkflow).toContain('npm run verify:gpu-qualification');
    expect(hardwareWorkflow).toContain(
      'PRINTFARMER_GPU_EXPECTED_SHA: ${{ github.sha }}',
    );
    expect(hardwareWorkflow).toContain(
      'gpu-qualification-*-attempt-${{ github.run_attempt }}',
    );
    expect(hardwareWorkflow).not.toContain('continue-on-error');
  });
});

function profile(id: string): GpuQualificationProfile {
  const target = gpuQualificationProfiles.find(
    (candidate) => candidate.id === id,
  );
  if (target === undefined) {
    throw new Error(`Missing test profile ${id}.`);
  }
  return target;
}

function requestFor(target: GpuQualificationProfile) {
  const root = mkdtempSync(path.join(tmpdir(), 'pf-gpu-contract-'));
  temporaryRoots.push(root);
  const request = hardwareGpuRequestFromEnvironment({
    PRINTFARMER_E2E_GPU_REQUIRE_HARDWARE: '1',
    PRINTFARMER_E2E_GPU_PROFILE: target.id,
    PRINTFARMER_E2E_GPU_REPORT: path.join(root, 'webgl.json'),
    PRINTFARMER_E2E_COMMIT_SHA: sha,
  });
  if (request === null) {
    throw new Error('Hardware request unexpectedly disabled.');
  }
  return request;
}

function capability(vendor: string, renderer: string): GraphicsCapability {
  return {
    webgl2: true,
    vendor,
    renderer,
    version: 'WebGL 2.0 (OpenGL ES 3.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 3.00',
    antialias: true,
  };
}

function vendorCapability(target: GpuQualificationProfile): GraphicsCapability {
  switch (target.vendor) {
    case 'nvidia':
      return capability(
        'Google Inc. (NVIDIA)',
        'ANGLE (NVIDIA, NVIDIA GeForce RTX 4080 Direct3D11)',
      );
    case 'amd':
      return capability(
        'Google Inc. (AMD)',
        'ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11)',
      );
    case 'intel':
      return capability(
        'Google Inc. (Intel)',
        'ANGLE (Intel, Intel Iris Xe Graphics)',
      );
    case 'apple':
      return capability(
        'Apple Inc.',
        'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Pro)',
      );
  }
}

function rawEvidenceFor(target: GpuQualificationProfile) {
  return createHardwareGpuEvidence(
    requestFor(target),
    vendorCapability(target),
    'default',
    {
      modelRendered: true,
      orbitChangedImage: true,
      resetRestoredImage: true,
      viewerRemainedResponsive: true,
    },
    target.platform,
    target.architecture,
  );
}

function adapter(
  name: string,
  vendor: string,
  driverVersion: string | null,
): SystemGpuAdapter {
  return {
    name,
    vendor,
    driverVersion,
    driverDate: driverVersion === null ? null : '2026-07-01',
    deviceId: 'device-id',
    metalSupport: vendor === 'Apple' ? 'Supported' : null,
  };
}

function adapterFor(target: GpuQualificationProfile): SystemGpuAdapter {
  let result: SystemGpuAdapter;
  switch (target.vendor) {
    case 'nvidia':
      result = adapter('NVIDIA GeForce RTX 4080', 'NVIDIA', '32.0.15.7216');
      break;
    case 'amd':
      result = adapter('AMD Radeon RX 7900 XTX', 'AMD', '32.0.21023.2010');
      break;
    case 'intel':
      result = adapter('Intel Iris Xe Graphics', 'Intel', '31.0.101.5590');
      break;
    case 'apple':
      result = adapter('Apple M3 Pro', 'Apple', null);
      break;
  }
  return target.platform === 'darwin'
    ? { ...result, metalSupport: 'Supported' }
    : result;
}

function reportFor(target: GpuQualificationProfile): GpuQualificationReport {
  return buildGpuQualificationReport(
    rawEvidenceFor(target),
    [adapterFor(target)],
    {
      osRelease: 'test-release',
      osVersion: 'test-version',
      cpuModel: 'test-cpu',
    },
    {
      repository,
      runId,
      runAttempt,
      runnerName: target.id,
    },
  );
}
