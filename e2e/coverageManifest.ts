import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type CoverageStatus =
  | 'scenario'
  | 'scenario-group'
  | 'unit-test'
  | 'unverified'
  | 'not-rendered'
  | 'blocked-native'
  | 'retired'
  | 'external';

export interface CoverageState {
  id: string;
  label: string;
  coverage: {
    status: CoverageStatus;
    scenarioId?: string;
    scenarioIds?: string[];
    tests?: string[];
    reason?: string;
    visualBlocker?: string;
  };
}

export interface CoverageSurface {
  id: string;
  label: string;
  reachability: string;
  sourceRefs: string[];
  states: CoverageState[];
}

export interface VisualScenario {
  id: string;
  surfaceId: string;
  stateId: string;
  testRef: string;
  fixture: string;
  trigger: string;
  expectedState: string;
  axe: string;
  dimensionsExercised: string[];
  renderingProfileId?: string;
  screenshotPolicy: 'temporary-review-evidence';
}

export interface VisualRenderingProfile {
  id: string;
  viewportCssPixels: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezone: string;
  colorSchemePreference: 'dark' | 'light';
  reducedMotion: 'reduce' | 'no-preference';
}

export interface CoverageManifest {
  schemaVersion: number;
  screenshotPolicy: {
    mode: 'temporary-review-evidence';
    pixelComparison: false;
    humanApprovalGate: false;
    committedPngBaselines: false;
    artifactRoots: string[];
    retention: string;
  };
  inventorySource: {
    inventoryDate: string;
    inspectedRevision: string;
    evidenceScope: string;
  };
  countingPolicy: {
    unit: string;
    structuralCountsAreOverlapping: boolean;
    prohibition: string;
    stateProducts: string;
  };
  renderingProfile: VisualRenderingProfile;
  additionalRenderingProfiles: VisualRenderingProfile[];
  structuralCounts: Array<{
    kind: string;
    count: number;
    overlaps: boolean;
  }>;
  surfaces: CoverageSurface[];
  scenarios: VisualScenario[];
}

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function existingRepoFile(reference: string): boolean {
  const file = reference.split(':', 1)[0] ?? '';
  return existsSync(path.resolve(repoRoot, file));
}

export const coverageManifest = JSON.parse(
  readFileSync(
    path.join(repoRoot, 'docs', 'ui', 'coverage-manifest.json'),
    'utf8',
  ),
) as CoverageManifest;

export function getCoverageManifest(): CoverageManifest {
  const problems = validateCoverageManifest(coverageManifest);
  if (problems.length > 0) {
    throw new Error(
      `Invalid visual coverage manifest:\n${problems.map((problem) => `- ${problem}`).join('\n')}`,
    );
  }
  return coverageManifest;
}

export function validateCoverageManifest(manifest: CoverageManifest): string[] {
  const problems: string[] = [];
  if (
    manifest.screenshotPolicy?.mode !== 'temporary-review-evidence' ||
    manifest.screenshotPolicy.pixelComparison !== false ||
    manifest.screenshotPolicy.humanApprovalGate !== false ||
    manifest.screenshotPolicy.committedPngBaselines !== false
  ) {
    problems.push(
      'screenshots must remain temporary evidence without a baseline gate',
    );
  }
  const renderingProfiles = [
    manifest.renderingProfile,
    ...manifest.additionalRenderingProfiles,
  ];
  const renderingProfileIds = new Set<string>();
  for (const profile of renderingProfiles) {
    if (!profile.id || renderingProfileIds.has(profile.id)) {
      problems.push(`duplicate or empty rendering profile id: ${profile.id}`);
    }
    renderingProfileIds.add(profile.id);
    if (
      !Number.isSafeInteger(profile.viewportCssPixels.width) ||
      profile.viewportCssPixels.width < 1 ||
      !Number.isSafeInteger(profile.viewportCssPixels.height) ||
      profile.viewportCssPixels.height < 1 ||
      !Number.isFinite(profile.deviceScaleFactor) ||
      profile.deviceScaleFactor <= 0 ||
      !profile.locale ||
      !profile.timezone ||
      !['dark', 'light'].includes(profile.colorSchemePreference) ||
      !['reduce', 'no-preference'].includes(profile.reducedMotion)
    ) {
      problems.push(`invalid rendering profile: ${profile.id}`);
    }
  }
  const validStatuses = new Set<CoverageStatus>([
    'scenario',
    'scenario-group',
    'unit-test',
    'unverified',
    'not-rendered',
    'blocked-native',
    'retired',
    'external',
  ]);
  if (manifest.schemaVersion !== 2) {
    problems.push('schemaVersion must be 2');
  }
  if (!manifest.inventorySource.inspectedRevision.match(/^[a-f0-9]{40}$/)) {
    problems.push('inventory inspectedRevision must be a full Git SHA');
  }
  if (manifest.countingPolicy.structuralCountsAreOverlapping !== true) {
    problems.push('structural counts must be explicitly marked overlapping');
  }

  const surfaces = new Map<string, CoverageSurface>();
  const states = new Map<string, CoverageState>();
  for (const surface of manifest.surfaces) {
    if (!surface.id || surfaces.has(surface.id)) {
      problems.push(`duplicate or empty surface id: ${surface.id}`);
      continue;
    }
    surfaces.set(surface.id, surface);
    if (!surface.sourceRefs.length || !surface.states.length) {
      problems.push(`${surface.id} requires source refs and state rows`);
    }
    for (const reference of surface.sourceRefs) {
      if (!existingRepoFile(reference)) {
        problems.push(`${surface.id} source path does not exist: ${reference}`);
      }
    }
    for (const state of surface.states) {
      const stateKey = `${surface.id}/${state.id}`;
      if (!state.id || states.has(stateKey)) {
        problems.push(`duplicate or empty state id: ${stateKey}`);
        continue;
      }
      states.set(stateKey, state);
      if (!validStatuses.has(state.coverage.status)) {
        problems.push(`${stateKey} has an unknown coverage status`);
      }
      if (state.coverage.status === 'scenario') {
        if (!state.coverage.scenarioId) {
          problems.push(`${stateKey} scenario status requires scenarioId`);
        }
      } else if (state.coverage.scenarioId) {
        problems.push(
          `${stateKey} non-scenario status cannot claim scenarioId`,
        );
      } else if (
        state.coverage.status === 'unit-test' &&
        !state.coverage.tests?.length
      ) {
        problems.push(`${stateKey} unit-test status requires test refs`);
      } else if (
        state.coverage.status === 'unit-test' &&
        !state.coverage.visualBlocker
      ) {
        problems.push(
          `${stateKey} unit-test evidence requires an explicit visual blocker`,
        );
      } else if (
        [
          'scenario-group',
          'unverified',
          'not-rendered',
          'blocked-native',
          'retired',
          'external',
        ].includes(state.coverage.status) &&
        !state.coverage.reason
      ) {
        problems.push(`${stateKey} requires an explicit reason`);
      }
      if (state.coverage.status === 'scenario-group') {
        const references = state.coverage.scenarioIds;
        if (!references?.length) {
          problems.push(`${stateKey} scenario-group requires scenarioIds`);
        } else if (new Set(references).size !== references.length) {
          problems.push(
            `${stateKey} scenario-group contains duplicate references`,
          );
        }
      } else if (state.coverage.scenarioIds) {
        problems.push(`${stateKey} non-group status cannot claim scenarioIds`);
      }
      for (const testRef of state.coverage.tests ?? []) {
        if (!existingRepoFile(testRef)) {
          problems.push(`${stateKey} test path does not exist: ${testRef}`);
        }
      }
    }
  }

  const scenarios = new Map<string, VisualScenario>();
  const scenarioStateKeys = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(scenario.id)) {
      problems.push(`invalid stable scenario id: ${scenario.id}`);
    }
    if (scenarios.has(scenario.id)) {
      problems.push(`duplicate scenario id: ${scenario.id}`);
    }
    scenarios.set(scenario.id, scenario);
    const stateKey = `${scenario.surfaceId}/${scenario.stateId}`;
    if (scenarioStateKeys.has(stateKey)) {
      problems.push(`multiple scenarios map to ${stateKey}`);
    }
    scenarioStateKeys.add(stateKey);
    const state = states.get(stateKey);
    if (!state) {
      problems.push(`${scenario.id} references missing state ${stateKey}`);
    } else if (
      state.coverage.status !== 'scenario' ||
      state.coverage.scenarioId !== scenario.id
    ) {
      problems.push(
        `${scenario.id} does not match ${stateKey} scenario mapping`,
      );
    }
    if (
      !scenario.testRef ||
      !scenario.fixture ||
      !scenario.trigger ||
      !scenario.expectedState
    ) {
      problems.push(`${scenario.id} requires test, fixture, trigger and state`);
    }
    if (typeof scenario.axe !== 'string' || !scenario.axe.trim()) {
      problems.push(`${scenario.id} requires an explicit axe scope`);
    }
    if (
      !Array.isArray(scenario.dimensionsExercised) ||
      scenario.dimensionsExercised.length === 0 ||
      scenario.dimensionsExercised.some(
        (dimension) => typeof dimension !== 'string' || !dimension.trim(),
      )
    ) {
      problems.push(
        `${scenario.id} requires explicit exercised dimensions; untested combinations must not be implied`,
      );
    }
    if (
      scenario.renderingProfileId &&
      !renderingProfileIds.has(scenario.renderingProfileId)
    ) {
      problems.push(
        `${scenario.id} references unknown rendering profile ${scenario.renderingProfileId}`,
      );
    }
    if (scenario.testRef && !existingRepoFile(scenario.testRef)) {
      problems.push(
        `${scenario.id} test path does not exist: ${scenario.testRef}`,
      );
    }
    if (scenario.screenshotPolicy !== 'temporary-review-evidence') {
      problems.push(
        `${scenario.id} requires temporary review evidence without a baseline gate`,
      );
    }
  }

  for (const [stateKey, state] of states) {
    if (state.coverage.status === 'scenario-group') {
      for (const reference of state.coverage.scenarioIds ?? []) {
        if (!scenarios.has(reference)) {
          problems.push(`${stateKey} references missing scenario ${reference}`);
        }
      }
    }
    if (
      state.coverage.status === 'scenario' &&
      (!state.coverage.scenarioId ||
        scenarios.get(state.coverage.scenarioId)?.surfaceId !==
          stateKey.slice(0, stateKey.indexOf('/')) ||
        scenarios.get(state.coverage.scenarioId)?.stateId !==
          stateKey.slice(stateKey.indexOf('/') + 1))
    ) {
      problems.push(`${stateKey} is not mapped to an executable scenario`);
    }
  }

  for (const count of manifest.structuralCounts) {
    if (
      !Number.isSafeInteger(count.count) ||
      count.count < 0 ||
      count.overlaps !== true
    ) {
      problems.push(
        `${count.kind} structural count must be non-negative and overlapping`,
      );
    }
  }
  return problems;
}

export function summarizeCoverage(manifest: CoverageManifest) {
  const statusCounts: Record<CoverageStatus, number> = {
    scenario: 0,
    'scenario-group': 0,
    'unit-test': 0,
    unverified: 0,
    'not-rendered': 0,
    'blocked-native': 0,
    retired: 0,
    external: 0,
  };
  for (const surface of manifest.surfaces) {
    for (const state of surface.states) {
      statusCounts[state.coverage.status] += 1;
    }
  }
  return {
    surfaceCount: manifest.surfaces.length,
    stateCount: Object.values(statusCounts).reduce(
      (sum, count) => sum + count,
      0,
    ),
    scenarioCount: manifest.scenarios.length,
    statusCounts,
  };
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}
