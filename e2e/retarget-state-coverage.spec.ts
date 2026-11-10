import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { rmSync } from 'node:fs';
import type {
  RetargetBuildResponse,
  RetargetPreflightResponse,
  RetargetProfile,
} from '../src/shared/ipc';
import {
  applyCalibrationScenario,
  launchCalibrationApp,
  scanSurface,
} from './helpers/calibrationA11yFixture';
import {
  installIpcReplies,
  releaseIpcReply,
  type IpcReplies,
} from './helpers/syntheticIpc';
import {
  syntheticModelName,
  syntheticModelReplies,
  syntheticScene,
} from './helpers/syntheticModel';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage';

let app: ElectronApplication | null = null;
let stateRoot: string | null = null;
test.afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = null;
    if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
    stateRoot = null;
  }
});

const profile: RetargetProfile = {
  id: 'synthetic-bundled-u1',
  source: 'bundled',
  displayName: 'Synthetic U1',
  processName: 'Synthetic standard',
  machineName: 'Snapmaker U1',
  compatibleFilaments: ['PLA'],
  layerHeight: 0.2,
  category: null,
  bundleCommit: 'a'.repeat(40),
  settingCount: 1,
  settingsSummary: {},
  importedAt: null,
  fingerprint: 'b'.repeat(64),
};
const imported: RetargetProfile = {
  ...profile,
  id: 'synthetic-imported-u1',
  source: 'imported',
  importedAt: 1,
};
const failure = (
  message: string,
  code:
    | 'saveDestinationExists'
    | 'sidecarUnavailable'
    | 'saveFailed' = 'sidecarUnavailable',
) => ({
  domain: 'electron' as const,
  code,
  message,
  action: 'Retry the synthetic request.',
  part: null,
  setting: null,
});
const issue = {
  code: 'sourceChanged' as const,
  severity: 'blocker' as const,
  title: 'Source changed',
  message: 'Synthetic source changed after selection.',
  action: 'Reselect the source.',
  part: null,
  setting: null,
};
const preflight: Extract<RetargetPreflightResponse, { status: 'ok' }> = {
  status: 'ok',
  value: {
    token: 'a'.repeat(43),
    report: {
      accepted: true,
      source: {
        fileName: syntheticModelName,
        byteSize: 1024,
        sha256: 'f'.repeat(64),
        producer: 'OrcaSlicer',
        machineId: null,
        processId: null,
        layerHeight: 0.2,
        objectCount: 1,
        buildItemCount: 1,
        plateCount: 1,
        materials: ['PLA'],
        colors: [],
      },
      recommendation: null,
      blockers: [],
      warnings: [
        {
          ...issue,
          code: 'staleSliceArtifactsRemoved',
          severity: 'warning',
          title: 'Stale slices',
          message: 'Synthetic stale slices will be removed.',
        },
      ],
      proposedChanges: {
        process: [
          {
            code: 'settingClamped',
            message: 'Synthetic speed will be clamped.',
            setting: 'speed',
            before: '999',
            after: '100',
          },
        ],
      },
    },
  },
};
const built: RetargetBuildResponse = {
  status: 'ok',
  value: {
    sourceSha256: 'f'.repeat(64),
    outputSha256: 'b'.repeat(64),
    outputFileName: 'synthetic-u1.3mf',
    targetProfileId: profile.id,
    removedPartCount: 1,
    preservedPartCount: 4,
    appliedChanges: {},
    warnings: [],
    validation: {
      valid: true,
      sourceSha256: 'f'.repeat(64),
      outputSha256: 'b'.repeat(64),
      sourcePreserved: true,
      sceneCompatibility: { compatible: true, differences: [] },
      invariants: {},
      warnings: [],
      errors: [],
    },
  },
};

async function open(replies: IpcReplies = {}): Promise<Page> {
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  await applyCalibrationScenario(app, launched.page, {});
  await installIpcReplies(app, {
    ...syntheticModelReplies(),
    'retarget:listProfiles': [
      {
        value: {
          status: 'ok',
          value: { profiles: [profile, imported], warnings: [] },
        },
      },
    ],
    'retarget:preflight': [{ value: preflight }],
    'retarget:build': [{ value: built }],
    'retarget:loadScene': [
      { value: { status: 'ok', value: syntheticScene() } },
    ],
    'retarget:saveAs': [{ value: { status: 'canceled' } }],
    'retarget:importProfile': [{ value: { status: 'canceled' } }],
    'retarget:dispose': [{ value: { disposed: true } }],
    ...replies,
  });
  const page = launched.page;
  await page.reload();
  await applyPinnedRenderingProfile(page);
  const later = page.getByRole('button', { name: 'Maybe later' });
  if (await later.isVisible()) await later.click();
  await page
    .getByRole('button', { name: `Select ${syntheticModelName}` })
    .click();
  await page.getByRole('button', { name: 'Prepare for Snapmaker U1' }).click();
  return page;
}

async function capture(page: Page, state: string, testInfo: TestInfo) {
  const dialog = page.getByRole('dialog', { name: 'Prepare for Snapmaker U1' });
  await scanSurface(page, {
    name: `synthetic retarget ${state}`,
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, `retarget.states.${state}`, testInfo);
}

test('synthetic retarget loading, catalog error and retry preserve explicit selection', async () => {
  const info = test.info();
  const page = await open({
    'retarget:listProfiles': [
      { pending: true },
      {
        value: {
          status: 'error',
          error: failure('Synthetic catalog unavailable.'),
        },
      },
      {
        value: {
          status: 'ok',
          value: {
            profiles: [profile, imported],
            warnings: [failure('Synthetic catalog warning.')],
          },
        },
      },
    ],
  });
  await expect(
    page.getByRole('status').filter({ hasText: 'Working…' }),
  ).toBeVisible();
  await capture(page, 'catalog-loading', info);
  await releaseIpcReply(app!, 'retarget:listProfiles');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic catalog unavailable.',
  );
  await capture(page, 'catalog-error', info);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(
    page.locator('.retarget-dialog input[type=radio]:checked'),
  ).toHaveCount(0);
  await expect(
    page.getByRole('status').filter({ hasText: 'Synthetic catalog warning.' }),
  ).toBeVisible();
  await capture(page, 'catalog-retry-warning', info);
});

test('synthetic retarget preflight blocks, errors, retries and shows proposed changes', async () => {
  const info = test.info();
  const page = await open({
    'retarget:preflight': [
      { pending: true },
      {
        value: {
          status: 'blocked',
          blockers: [issue],
          warnings: [],
          value: {
            ...preflight.value,
            report: {
              ...preflight.value.report,
              accepted: false,
              blockers: [issue],
            },
          },
        },
      },
      {
        value: {
          status: 'error',
          error: failure('Synthetic preflight error.'),
        },
      },
      { value: preflight },
    ],
  });
  await page.getByRole('radio', { name: 'Synthetic U1 (bundled)' }).click();
  await capture(page, 'preflight-loading', info);
  await releaseIpcReply(app!, 'retarget:preflight');
  await expect(
    page.getByRole('button', { name: 'Build review copy' }),
  ).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic source changed',
  );
  await capture(page, 'preflight-blocked', info);
  await page
    .getByRole('checkbox', { name: 'Exclude objects by plate' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic preflight error.',
  );
  await capture(page, 'preflight-error', info);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Proposed changes' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Build review copy' }),
  ).toBeEnabled();
  await capture(page, 'preflight-warning-changes', info);
});

test('synthetic retarget build, scene retry, saving, cancel, collision and save retry', async () => {
  const info = test.info();
  const page = await open({
    'retarget:build': [{ pending: true }, { value: built }],
    'retarget:loadScene': [
      { pending: true },
      {
        value: {
          status: 'error',
          error: failure('Synthetic scene unavailable.'),
        },
      },
      { value: { status: 'ok', value: syntheticScene() } },
    ],
    'retarget:saveAs': [
      { pending: true },
      { value: { status: 'canceled' } },
      {
        value: {
          status: 'error',
          error: failure(
            'Synthetic destination exists.',
            'saveDestinationExists',
          ),
        },
      },
      {
        value: {
          status: 'error',
          error: failure('Synthetic save failed.', 'saveFailed'),
        },
      },
      {
        value: {
          status: 'ok',
          fileName: 'synthetic-u1.3mf',
          refreshWarning: failure('Synthetic catalog refresh warning.'),
        },
      },
    ],
  });
  await page.getByRole('radio', { name: 'Synthetic U1 (bundled)' }).click();
  await page.getByRole('button', { name: 'Build review copy' }).click();
  await expect(
    page.getByRole('button', { name: 'Close', exact: true }),
  ).toBeDisabled();
  await capture(page, 'building', info);
  await releaseIpcReply(app!, 'retarget:build');
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading comparison scene…' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save As…' })).toBeDisabled();
  await capture(page, 'scene-loading', info);
  await releaseIpcReply(app!, 'retarget:loadScene');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic scene unavailable.',
  );
  await capture(page, 'scene-error', info);
  await page.getByRole('button', { name: 'Retry scene' }).click();
  await expect(page.locator('.retarget-dialog canvas')).toHaveCount(1);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Source', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.retarget-dialog canvas')).toHaveCount(1);
  await capture(page, 'scene-retry-source', info);
  await page.getByRole('button', { name: 'Save As…' }).click();
  await expect(
    page.getByRole('button', { name: 'Close', exact: true }),
  ).toBeDisabled();
  await capture(page, 'saving', info);
  await releaseIpcReply(app!, 'retarget:saveAs');
  await expect(
    page.getByRole('heading', { name: 'Review changes' }),
  ).toBeVisible();
  await capture(page, 'save-canceled-review-retained', info);
  for (const [state, message] of [
    ['save-collision', 'Synthetic destination exists.'],
    ['save-error', 'Synthetic save failed.'],
  ]) {
    await page.getByRole('button', { name: 'Save As…' }).click();
    await expect(page.getByRole('alert')).toContainText(message!);
    await expect(page.getByRole('button', { name: 'Save As…' })).toBeEnabled();
    await capture(page, state!, info);
  }
  await page.getByRole('button', { name: 'Save As…' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Saved synthetic-u1.3mf' }),
  ).toContainText('Synthetic catalog refresh warning.');
  await capture(page, 'saved-refresh-warning', info);
});

test('synthetic retarget import cancel and error retain catalog without selection', async () => {
  const info = test.info();
  const page = await open({
    'retarget:importProfile': [
      { value: { status: 'canceled' } },
      {
        value: {
          status: 'error',
          error: failure('Synthetic reference import failed.'),
        },
      },
    ],
  });
  await page.getByRole('button', { name: 'Import U1 reference' }).click();
  await expect(
    page.locator('.retarget-dialog input[type=radio]:checked'),
  ).toHaveCount(0);
  await capture(page, 'import-canceled', info);
  await page.getByRole('button', { name: 'Import U1 reference' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic reference import failed.',
  );
  await capture(page, 'import-error', info);
});

test('synthetic retarget thrown catalog and preflight failures recover explicitly', async () => {
  const info = test.info();
  const page = await open({
    'retarget:listProfiles': [
      { error: 'Synthetic catalog transport rejected.' },
      { value: { status: 'ok', value: { profiles: [profile], warnings: [] } } },
    ],
    'retarget:preflight': [
      { error: 'Synthetic preflight transport rejected.' },
      { value: preflight },
    ],
  });
  await expect(page.getByRole('alert')).toContainText(
    'Profiles are unavailable.',
  );
  await capture(page, 'catalog-thrown', info);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('radio', { name: 'Synthetic U1 (bundled)' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Preflight could not be completed.',
  );
  await capture(page, 'preflight-thrown', info);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Build review copy' }),
  ).toBeEnabled();
});

test('synthetic retarget build refusals and thrown scene/save failures remain recoverable', async () => {
  const info = test.info();
  const page = await open({
    'retarget:build': [
      {
        value: {
          status: 'blocked',
          blockers: [issue],
          warnings: [],
          value: null,
        },
      },
      { value: { status: 'error', error: failure('Synthetic build error.') } },
      { error: 'Synthetic build transport rejected.' },
      { value: built },
    ],
    'retarget:loadScene': [
      { error: 'Synthetic scene transport rejected.' },
      { value: { status: 'ok', value: syntheticScene() } },
    ],
    'retarget:saveAs': [{ error: 'Synthetic save transport rejected.' }],
  });
  await page.getByRole('radio', { name: 'Synthetic U1 (bundled)' }).click();
  await page.getByRole('button', { name: 'Build review copy' }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Resolve the listed blockers' }),
  ).toContainText(issue.message);
  await expect(
    page.getByRole('button', { name: 'Build review copy' }),
  ).toBeDisabled();
  await capture(page, 'build-blocked', info);
  await page.getByRole('radio', { name: 'Synthetic U1 (imported)' }).click();
  await page.getByRole('button', { name: 'Build review copy' }).click();
  await expect(page.getByRole('alert')).toContainText('Synthetic build error.');
  await capture(page, 'build-error', info);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Build review copy' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The review copy could not be built.',
  );
  await capture(page, 'build-thrown', info);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.getByRole('button', { name: 'Build review copy' }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'The comparison scene could not be loaded.' }),
  ).toBeVisible();
  await capture(page, 'scene-thrown', info);
  await page.getByRole('button', { name: 'Retry scene' }).click();
  await expect(page.locator('.retarget-dialog canvas')).toHaveCount(1);
  await page.getByRole('button', { name: 'Source', exact: true }).click();
  await expect(page.locator('.retarget-dialog canvas')).toHaveCount(1);
  await page
    .getByRole('button', { name: 'Snapmaker U1 output', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Snapmaker U1 output', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.retarget-dialog canvas')).toHaveCount(1);
  await capture(page, 'scene-output-return', info);
  await page.getByRole('button', { name: 'Save As…' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'The project could not be saved.',
  );
  await expect(
    page.getByRole('heading', { name: 'Review changes' }),
  ).toBeVisible();
  await capture(page, 'save-thrown', info);
});

test('synthetic retarget import success selects explicitly and catalog refresh failures preserve old choices', async () => {
  const info = test.info();
  const page = await open({
    'retarget:importProfile': [
      { error: 'Synthetic import transport rejected.' },
      { value: { status: 'ok', profile: imported, duplicate: false } },
    ],
    'retarget:listProfiles': [
      { value: { status: 'ok', value: { profiles: [profile], warnings: [] } } },
      { error: 'Synthetic refresh transport rejected.' },
      {
        value: {
          status: 'error',
          error: failure('Synthetic refreshed catalog unavailable.'),
        },
      },
      {
        value: {
          status: 'ok',
          value: { profiles: [profile, imported], warnings: [] },
        },
      },
    ],
  });
  for (const [state, message] of [
    ['import-thrown', 'The U1 reference could not be imported.'],
    ['import-refresh-thrown', 'The U1 profile catalog could not be refreshed.'],
    ['import-refresh-error', 'Synthetic refreshed catalog unavailable.'],
  ]) {
    await page.getByRole('button', { name: 'Import U1 reference' }).click();
    await expect(page.getByRole('alert')).toContainText(message!);
    await expect(
      page.locator('.retarget-dialog input[type=radio]:checked'),
    ).toHaveCount(0);
    await capture(page, state!, info);
  }
  await page.getByRole('button', { name: 'Import U1 reference' }).click();
  await expect(
    page.getByRole('radio', { name: 'Synthetic U1 (imported)' }),
  ).toBeChecked();
  await expect(
    page.getByRole('button', { name: 'Build review copy' }),
  ).toBeEnabled();
  await capture(page, 'import-success-selected', info);
});
