import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getCoverageManifest,
  summarizeCoverage,
  validateCoverageManifest,
} from '../e2e/coverageManifest.js';

describe('UI visual/accessibility coverage manifest', () => {
  it('maps every inventoried state to a scenario, test evidence or explicit gap', () => {
    const manifest = getCoverageManifest();
    expect(validateCoverageManifest(manifest)).toEqual([]);

    const summary = summarizeCoverage(manifest);
    expect(summary.surfaceCount).toBe(manifest.surfaces.length);
    expect(summary.stateCount).toBe(
      manifest.surfaces.reduce(
        (total, surface) => total + surface.states.length,
        0,
      ),
    );
    expect(summary.scenarioCount).toBe(manifest.scenarios.length);
    expect(summary.statusCounts['scenario-group']).toBeGreaterThan(0);
    expect(summary.statusCounts['not-rendered']).toBeGreaterThan(0);
    expect(summary.statusCounts['blocked-native']).toBeGreaterThan(0);
    expect(manifest.structuralCounts.every((count) => count.overlaps)).toBe(
      true,
    );
    expect(
      manifest.surfaces
        .flatMap((surface) => surface.states)
        .filter((state) => state.coverage.status === 'unit-test')
        .every(
          (state) =>
            state.coverage.tests?.length &&
            state.coverage.visualBlocker?.length,
        ),
    ).toBe(true);
    expect(
      manifest.scenarios.every(
        (scenario) =>
          scenario.dimensionsExercised.length > 0 &&
          scenario.dimensionsExercised.every((dimension) => dimension.trim()),
      ),
    ).toBe(true);
    expect(manifest.countingPolicy.prohibition).toContain(
      'Never add workspace',
    );
  });

  it('keeps the published inventory counts aligned with the authoritative manifest', () => {
    const summary = summarizeCoverage(getCoverageManifest());
    const document = readFileSync(
      path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        'docs',
        'ui',
        'visual-accessibility-gate.md',
      ),
      'utf8',
    );
    expect(document.replace(/\s+/g, ' ')).toContain(
      `**${summary.surfaceCount} surfaces, ${summary.stateCount} named rows and ${summary.scenarioCount} candidate scenarios**`,
    );
    for (const [status, count] of Object.entries(summary.statusCounts)) {
      expect(document).toMatch(
        new RegExp('\\| `' + status + '`\\s*\\|\\s*' + count + '\\s*\\|'),
      );
    }
  });

  it('requires stable IDs, source states and a matching test scenario mapping', () => {
    const manifest = structuredClone(getCoverageManifest());
    manifest.scenarios[0]!.stateId = 'missing-state';
    const problems = validateCoverageManifest(manifest);
    expect(problems).toContain(
      `${manifest.scenarios[0]!.id} references missing state ${manifest.scenarios[0]!.surfaceId}/missing-state`,
    );
  });

  it('pins scenario-specific rendering profiles from the manifest', () => {
    const manifest = structuredClone(getCoverageManifest());
    const compactScenario = manifest.scenarios.find(
      (scenario) => scenario.id === 'organization.wide-layout-zoom',
    );
    expect(compactScenario?.renderingProfileId).toBe(
      'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1',
    );
    expect(validateCoverageManifest(manifest)).toEqual([]);

    compactScenario!.renderingProfileId = 'unlisted-profile';
    expect(validateCoverageManifest(manifest)).toContain(
      'organization.wide-layout-zoom references unknown rendering profile unlisted-profile',
    );
  });

  it.each(['', '   ', undefined, null, 42])(
    'rejects an invalid axe scope (%s) while accepting the documented scope',
    (scope) => {
      const manifest = structuredClone(getCoverageManifest());
      const scenario = manifest.scenarios[0]!;
      expect(validateCoverageManifest(manifest)).toEqual([]);
      Reflect.set(scenario, 'axe', scope);
      expect(validateCoverageManifest(manifest)).toContain(
        `${scenario.id} requires an explicit axe scope`,
      );
    },
  );

  it('does not silently accept a state without a blocker or test reference', () => {
    const manifest = structuredClone(getCoverageManifest());
    const state = manifest.surfaces[0]!.states[0]!;
    state.coverage = { status: 'unverified' };
    expect(validateCoverageManifest(manifest)).toContain(
      `${manifest.surfaces[0]!.id}/${state.id} requires an explicit reason`,
    );
  });

  it('requires explicit visual blockers for unit-test-only evidence', () => {
    const manifest = structuredClone(getCoverageManifest());
    const state = manifest.surfaces[0]!.states[0]!;
    state.coverage = {
      status: 'unit-test',
      tests: ['tests/uiCoverageManifest.test.ts'],
    };
    expect(validateCoverageManifest(manifest)).toContain(
      `${manifest.surfaces[0]!.id}/${state.id} unit-test evidence requires an explicit visual blocker`,
    );
  });

  it('references executable scenarios in composite rows without inventing captures', () => {
    const manifest = structuredClone(getCoverageManifest());
    const surface = manifest.surfaces[0]!;
    const state = surface.states[0]!;
    const count = summarizeCoverage(manifest).scenarioCount;
    state.coverage = {
      status: 'scenario-group',
      scenarioIds: [manifest.scenarios[0]!.id],
      reason:
        'Composite inventory row; only referenced assertions are exercised.',
    };
    expect(validateCoverageManifest(manifest)).toEqual([]);
    expect(summarizeCoverage(manifest).scenarioCount).toBe(count);
    state.coverage.scenarioIds = ['missing-scenario'];
    expect(validateCoverageManifest(manifest)).toContain(
      `${surface.id}/${state.id} references missing scenario missing-scenario`,
    );
    state.coverage.scenarioIds = [];
    expect(validateCoverageManifest(manifest)).toContain(
      `${surface.id}/${state.id} scenario-group requires scenarioIds`,
    );
    state.coverage.scenarioIds = [
      manifest.scenarios[0]!.id,
      manifest.scenarios[0]!.id,
    ];
    expect(validateCoverageManifest(manifest)).toContain(
      `${surface.id}/${state.id} scenario-group contains duplicate references`,
    );
    delete state.coverage.reason;
    expect(validateCoverageManifest(manifest)).toContain(
      `${surface.id}/${state.id} requires an explicit reason`,
    );
    state.coverage.status = 'unverified';
    expect(validateCoverageManifest(manifest)).toContain(
      `${surface.id}/${state.id} non-group status cannot claim scenarioIds`,
    );
  });

  it('requires review-only artifacts without approval or pixel-baseline state', () => {
    const manifest = structuredClone(getCoverageManifest());
    expect(manifest.scenarios).toHaveLength(331);
    expect(
      manifest.scenarios.every(
        (scenario) => scenario.screenshotPolicy === 'temporary-review-evidence',
      ),
    ).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('visualBaseline');
    Reflect.set(manifest.scenarios[0]!, 'screenshotPolicy', 'approved');
    expect(validateCoverageManifest(manifest)).toContain(
      manifest.scenarios[0]!.id +
        ' requires temporary review evidence without a baseline gate',
    );
    Reflect.set(manifest.screenshotPolicy, 'humanApprovalGate', true);
    expect(validateCoverageManifest(manifest)).toContain(
      'screenshots must remain temporary evidence without a baseline gate',
    );
  });

  it('keeps new screenshot capture out of baseline comparison and tracked image paths', () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
    );
    const helper = readFileSync(
      path.join(root, 'e2e', 'helpers', 'visualCoverage.ts'),
      'utf8',
    );
    for (const primitive of [
      'toMatchSnapshot',
      'toHaveScreenshot',
      'snapshotPath',
      'REQUIRE_APPROVED_VISUAL_BASELINES',
      'visual-baseline-approvals.json',
    ])
      expect(helper).not.toContain(primitive);
    expect(
      existsSync(path.join(root, 'e2e', 'visual-baseline-approvals.json')),
    ).toBe(false);
    const ignore = readFileSync(path.join(root, '.gitignore'), 'utf8').split(
      /\r?\n/,
    );
    expect(ignore).toContain('test-results/');
    expect(ignore).toContain('/artifacts/ui-coverage-review/');
    expect(helper).toContain("'test-results'");
    expect(helper).toContain("'ui-coverage-review'");
  });
});
