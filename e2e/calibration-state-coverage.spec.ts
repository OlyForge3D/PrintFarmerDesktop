import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { rmSync } from 'node:fs';
import {
  FILAMENT_METHOD_META,
  scalarSpecFor,
} from '../src/renderer/calibration/filamentWizardState';
import type {
  CalibrationApiError,
  CalibrationSliceJobSnapshot,
  CalibrationSliceMethod,
  CalibrationMethodProgressRecord,
  FilamentWizardStateRecord,
  FilamentWizardStatePhase,
  CalibrationSlicerProfileRef,
  CalibrationConflict,
} from '../src/shared/ipc';
import {
  CAL,
  applyCalibrationScenario,
  launchCalibrationApp,
  openFilamentCalibrationWizard,
  openCalibrationWorkspace,
  scanSurface,
  type CalibrationScenario,
} from './helpers/calibrationA11yFixture';
import {
  installIpcReplies,
  ipcRequests,
  releaseIpcReply,
  type IpcReplies,
} from './helpers/syntheticIpc';
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
async function open(
  scenario: CalibrationScenario = {},
  replies: IpcReplies = {},
  wizard = true,
) {
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  await applyCalibrationScenario(app, launched.page, {
    profileCatalog: true,
    ...scenario,
  });
  await installIpcReplies(app, replies);
  await applyPinnedRenderingProfile(launched.page);
  if (wizard) await openFilamentCalibrationWizard(launched.page);
  else await openCalibrationWorkspace(launched.page);
  return launched.page;
}
async function capture(page: Page, state: string, info: TestInfo) {
  await captureVisualScenario(page, `calibration.states.${state}`, info);
  await scanSurface(page, {
    name: `calibration ${state}`,
    present: page.locator('#root'),
    testInfo: info,
    soft: true,
  });
}
const machine: CalibrationSlicerProfileRef = {
  name: 'K1 Max 0.4',
  guid: '22222222-2222-4222-8222-222222222201',
  source: 'system',
  displayLabel: 'Synthetic machine',
  contentSha256: null,
};
const processProfile: CalibrationSlicerProfileRef = {
  ...machine,
  name: '0.20mm Standard',
  guid: '22222222-2222-4222-8222-222222222202',
};
const filament: CalibrationSlicerProfileRef = {
  ...machine,
  name: 'Generic PLA',
  guid: '22222222-2222-4222-8222-222222222203',
};
const catalog = {
  status: 'ok' as const,
  machineProfiles: [machine],
  processProfiles: [processProfile],
  filamentProfiles: [filament],
  profilesTruncated: false,
  fetchedAt: CAL.now,
};
const printers = {
  printers: [
    {
      printerId: CAL.printerId,
      displayName: CAL.displayName,
      printerModel: 'Synthetic printer',
      printerModelId: CAL.printerModelId,
      isOnline: true,
    },
    {
      printerId: CAL.altPrinterId,
      displayName: CAL.altDisplayName,
      printerModel: null,
      printerModelId: null,
      isOnline: false,
    },
  ],
  printersTruncated: false,
  printersUnreadable: 0,
  fetchedAt: CAL.now,
};
function apiError(
  message: string,
  code: CalibrationApiError['code'] = 'serverError',
): CalibrationApiError {
  return {
    code,
    message,
    retryable: true,
    retryAfterSeconds: null,
    reference: null,
  };
}
async function pickPrinter(page: Page, id: string = CAL.printerId) {
  await page
    .getByRole('combobox', { name: 'Printer', exact: true })
    .selectOption(id);
}
async function toClone(page: Page) {
  await pickPrinter(page);
  await page
    .getByRole('combobox', { name: 'Machine profile', exact: true })
    .selectOption({ index: 1 });
  await page
    .getByRole('combobox', { name: 'Process profile', exact: true })
    .selectOption({ index: 1 });
  await page
    .getByRole('combobox', { name: 'Filament profile', exact: true })
    .selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Next — name the clone' }).click();
}
function restored(
  phase: FilamentWizardStatePhase,
  method: CalibrationSliceMethod = 'temperature_tower',
): FilamentWizardStateRecord {
  return {
    schemaVersion: 1,
    printerId: CAL.printerId,
    printerModelId: CAL.printerModelId,
    machineName: machine.name,
    processName: processProfile.name,
    baseFilamentName: filament.name,
    baseFilamentGuid: filament.guid!,
    cloneId: CAL.cloneId,
    cloneName: 'Synthetic calibration clone',
    calibrationProjectId: CAL.calibrationProjectId,
    completedMethods: [],
    currentMethod: phase === 'methodPicker' ? null : method,
    inFlightJob:
      phase === 'pollingSlice' || phase === 'sliceReady'
        ? {
            jobId: CAL.sliceJobId,
            method,
            submittedAt: CAL.now,
            pollAttempt: 2,
            lastStatus: phase === 'sliceReady' ? 'Completed' : 'Processing',
          }
        : null,
    draftObservationFailures: [],
    phase,
    updatedAt: CAL.now,
  };
}
function progress(
  method: CalibrationSliceMethod,
  disposition: CalibrationMethodProgressRecord['disposition'],
  revision = 1,
): CalibrationMethodProgressRecord {
  return {
    id: CAL.cloneId,
    projectId: CAL.calibrationProjectId,
    method,
    disposition,
    currentStepId: null,
    revision,
    createdAtUtc: CAL.now,
    updatedAtUtc: CAL.now,
  };
}
function snapshot(
  overrides: Partial<CalibrationSliceJobSnapshot> = {},
): CalibrationSliceJobSnapshot {
  return {
    id: CAL.sliceJobId,
    status: 'Processing',
    progressPercent: 42,
    progressMessage: 'Synthetic worker slicing',
    queuedAt: CAL.now,
    startedAt: CAL.now,
    completedAt: null,
    errorMessage: null,
    errorDetail: null,
    layoutDegradation: null,
    failureReason: null,
    failureHint: null,
    estimatedPrintTimeSeconds: null,
    filamentUsedGrams: null,
    workerId: 'synthetic-worker',
    modelFileName: 'synthetic-calibration.3mf',
    slicerEngine: 'OrcaSlicer',
    artifactsRoute: null,
    ...overrides,
  };
}

test('synthetic calibration printer loading/error/retry and selectable offline group', async () => {
  const info = test.info();
  const page = await open(
    {},
    {
      'calibration:listPrinters': [
        { pending: true },
        { error: 'Synthetic printer list unavailable.' },
        { value: printers },
      ],
    },
  );
  await expect(
    page.getByRole('status').filter({ hasText: 'Loading printers.' }),
  ).toBeVisible();
  await capture(page, 'printers-loading', info);
  await releaseIpcReply(app!, 'calibration:listPrinters');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic printer list unavailable.',
  );
  await capture(page, 'printers-error', info);
  await page.getByRole('button', { name: 'Retry loading printers' }).click();
  const picker = page.getByRole('combobox', { name: 'Printer', exact: true });
  await expect(picker.locator('optgroup')).toHaveCount(2);
  await pickPrinter(page, CAL.altPrinterId);
  await expect(picker).toHaveValue(CAL.altPrinterId);
  await capture(page, 'printers-offline-selectable', info);
});

test('synthetic calibration catalog loading/error/retry and dependent profile requests', async () => {
  const info = test.info();
  const page = await open(
    {},
    {
      'calibration:listExtendedProfiles': [
        { pending: true },
        { error: 'Synthetic profile catalog failed.' },
        { value: catalog },
      ],
      'calibration:listProcessProfilesForMachines': [
        { pending: true },
        { error: 'Synthetic process lookup failed.' },
        {
          value: {
            status: 'ok',
            profiles: [processProfile],
            profilesTruncated: false,
            fetchedAt: CAL.now,
          },
        },
      ],
    },
  );
  await pickPrinter(page);
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Loading calibration profile catalog' }),
  ).toBeVisible();
  await capture(page, 'catalog-loading', info);
  await releaseIpcReply(app!, 'calibration:listExtendedProfiles');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic profile catalog failed.',
  );
  await capture(page, 'catalog-error', info);
  await page.getByRole('button', { name: 'Retry loading the catalog' }).click();
  await page
    .getByRole('combobox', { name: 'Machine profile', exact: true })
    .selectOption({ index: 1 });
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Loading process and filament profiles' }),
  ).toBeVisible();
  await capture(page, 'dependencies-loading', info);
  await releaseIpcReply(app!, 'calibration:listProcessProfilesForMachines');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic process lookup failed.',
  );
  await capture(page, 'dependencies-error', info);
});

test('synthetic calibration no model alias and system/custom dependent options', async () => {
  const info = test.info();
  const page = await open(
    {},
    {
      'calibration:listMachineProfilesForModel': [
        {
          value: {
            status: 'ok',
            profiles: [],
            noModelAlias: true,
            profilesTruncated: false,
            fetchedAt: CAL.now,
          },
        },
      ],
      'calibration:listCustomProfiles': [
        {
          value: {
            status: 'ok',
            fetchedAt: CAL.now,
            profiles: [
              {
                id: CAL.cloneId,
                name: 'Synthetic custom machine',
                profileType: 'machine',
                printerModelId: CAL.printerModelId,
                compatiblePrinters: null,
                createdAt: CAL.now,
              },
              {
                id: CAL.altProfileId,
                name: 'Synthetic custom process',
                profileType: 'process',
                printerModelId: CAL.printerModelId,
                compatiblePrinters: [machine.name],
                createdAt: CAL.now,
              },
              {
                id: CAL.draftProfileId,
                name: 'Synthetic custom filament',
                profileType: 'filament',
                printerModelId: CAL.printerModelId,
                compatiblePrinters: [machine.name],
                createdAt: CAL.now,
              },
            ],
          },
        },
      ],
    },
  );
  await pickPrinter(page);
  await expect(
    page.getByRole('status').filter({ hasText: 'catalog has no alias' }),
  ).toBeVisible();
  await expect(
    page
      .getByRole('combobox', { name: 'Machine profile', exact: true })
      .locator('optgroup'),
  ).toHaveCount(2);
  await page
    .getByRole('combobox', { name: 'Machine profile', exact: true })
    .selectOption({ index: 1 });
  await expect(
    page
      .getByRole('combobox', { name: 'Process profile', exact: true })
      .locator('optgroup'),
  ).toHaveCount(2);
  await page
    .getByRole('combobox', { name: 'Process profile', exact: true })
    .selectOption({ index: 1 });
  await expect(
    page
      .getByRole('combobox', { name: 'Filament profile', exact: true })
      .locator('optgroup'),
  ).toHaveCount(2);
  await capture(page, 'alias-system-custom-options', info);
});

for (const missing of ['machine', 'process', 'filament'] as const) {
  test(`synthetic calibration missing ${missing} profiles remains explicit`, async () => {
    const info = test.info();
    const page = await open(
      {},
      missing === 'machine'
        ? {
            'calibration:listMachineProfilesForModel': [
              {
                value: {
                  status: 'ok',
                  profiles: [],
                  noModelAlias: false,
                  profilesTruncated: false,
                  fetchedAt: CAL.now,
                },
              },
            ],
          }
        : missing === 'process'
          ? {
              'calibration:listProcessProfilesForMachines': [
                {
                  value: {
                    status: 'ok',
                    profiles: [],
                    profilesTruncated: false,
                    fetchedAt: CAL.now,
                  },
                },
              ],
            }
          : {
              'calibration:listFilamentProfilesForMachines': [
                {
                  value: {
                    status: 'ok',
                    profiles: [],
                    profilesTruncated: false,
                    fetchedAt: CAL.now,
                  },
                },
              ],
            },
    );
    await pickPrinter(page);
    if (missing !== 'machine')
      await page
        .getByRole('combobox', { name: 'Machine profile', exact: true })
        .selectOption({ index: 1 });
    if (missing === 'filament') {
      await page
        .getByRole('combobox', { name: 'Process profile', exact: true })
        .selectOption({ index: 1 });
    }
    await expect(
      page.getByText(new RegExp(`No ${missing} profiles are available`)),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Next — name the clone' }),
    ).toBeDisabled();
    await capture(page, `missing-${missing}`, info);
  });
}

test('synthetic calibration spool loading/error and clone-name bounds with clone retry', async () => {
  const info = test.info();
  const page = await open(
    { sliceSubmissionPending: true },
    {
      'calibration:listSpoolmanSpools': [
        { pending: true },
        { error: 'Synthetic Spoolman unavailable.' },
      ],
      'calibration:cloneFilamentProfile': [
        { error: 'Synthetic clone failed.' },
        {
          value: {
            status: 'ok',
            clone: {
              id: CAL.cloneId,
              name: 'Synthetic clone',
              profileType: 'filament',
              isSystem: false,
            },
          },
        },
      ],
    },
  );
  await toClone(page);
  await expect(page.getByText('Loading Spoolman spools…')).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Clone this filament profile' }),
  ).toBeDisabled();
  await capture(page, 'spool-loading', info);
  await releaseIpcReply(app!, 'calibration:listSpoolmanSpools');
  await expect(
    page.getByText(/Spoolman spools could not be loaded/),
  ).toBeVisible();
  const name = page.getByRole('textbox', { name: 'Clone name' });
  await name.fill('   ');
  await expect(
    page.getByRole('button', { name: 'Clone this filament profile' }),
  ).toBeDisabled();
  await capture(page, 'spool-error-empty-clone-name', info);
  await name.fill('N'.repeat(513));
  await expect(name).toHaveValue('N'.repeat(512));
  await capture(page, 'clone-name-max', info);
  await name.fill('Synthetic clone');
  await page
    .getByRole('button', { name: 'Clone this filament profile' })
    .click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic clone failed.',
  );
  await capture(page, 'clone-error', info);
  await page
    .getByRole('button', { name: 'Clone this filament profile' })
    .click();
  await expect(
    page.getByRole('group', { name: 'Step 3 — calibration method' }),
  ).toBeVisible();
  await capture(page, 'clone-retry-success', info);
});

test('synthetic calibration populated spool and explicit no-spool choice', async () => {
  const info = test.info();
  const spoolId = 'f8888888-8888-4888-8888-888888888888';
  const page = await open(
    {},
    {
      'calibration:listSpoolmanSpools': [
        {
          value: {
            status: 'ok',
            fetchedAt: CAL.now,
            spools: [
              {
                spoolmanSpoolId: spoolId,
                spoolmanFilamentId: CAL.cloneId,
                displayName: 'Synthetic PLA spool',
                material: 'PLA',
                color: '#ffffff',
                vendor: 'Synthetic',
                remainingWeightGrams: 500,
              },
            ],
          },
        },
      ],
    },
  );
  await toClone(page);
  const picker = page.getByRole('combobox', { name: 'Spoolman spool' });
  await expect(picker).toHaveValue('');
  await picker.selectOption(spoolId);
  await expect(picker).toHaveValue(spoolId);
  await capture(page, 'spool-populated-selected', info);
  await picker.selectOption('');
  await expect(picker).toHaveValue('');
  await capture(page, 'spool-explicit-none', info);
});

test('synthetic calibration dispositions show completed/skipped/pending, locked/next and skip recovery', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'methodPicker' },
    {
      'calibration:getMethodProgress': [
        {
          value: {
            status: 'ok',
            progress: [
              progress('temperature_tower', 'Completed'),
              progress('max_volumetric_speed', 'Skipped'),
            ],
          },
        },
      ],
      'calibration:setMethodDisposition': [
        { pending: true },
        { error: 'Synthetic skip conflict.' },
        {
          value: {
            status: 'ok',
            progress: progress('max_volumetric_speed', 'Pending', 2),
          },
        },
        {
          value: {
            status: 'ok',
            progress: progress('max_volumetric_speed', 'Skipped', 3),
          },
        },
      ],
    },
  );
  const methods = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  await expect(
    methods.getByRole('button', {
      name: /^Start Temperature tower \(completed once\)/,
    }),
  ).toBeVisible();
  await expect(
    methods.getByRole('button', {
      name: /^Start Pressure advance.*recommended next/,
    }),
  ).toBeEnabled();
  await expect(
    methods.getByRole('button', { name: /^Start Retraction.*locked/ }),
  ).toBeDisabled();
  await expect(methods.getByText('Skipped', { exact: true })).toBeVisible();
  await capture(page, 'method-dispositions-guided', info);
  await methods
    .getByRole('button', { name: 'Un-skip Max volumetric speed', exact: true })
    .click();
  await expect(
    methods.getByRole('button', {
      name: 'Un-skip Max volumetric speed',
      exact: true,
    }),
  ).toBeDisabled();
  await capture(page, 'method-disposition-pending', info);
  await releaseIpcReply(app!, 'calibration:setMethodDisposition');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic skip conflict.',
  );
  await capture(page, 'method-disposition-error', info);
  await methods
    .getByRole('button', { name: 'Un-skip Max volumetric speed', exact: true })
    .click();
  await expect(
    methods.getByRole('button', {
      name: /^Start Max volumetric speed.*recommended next/,
    }),
  ).toBeEnabled();
  await capture(page, 'method-unskipped-next', info);
  await methods
    .getByRole('button', { name: 'Skip Max volumetric speed', exact: true })
    .click();
  await expect(
    methods.getByRole('button', {
      name: 'Un-skip Max volumetric speed',
      exact: true,
    }),
  ).toBeEnabled();
  await capture(page, 'method-reskipped', info);
});

test('synthetic calibration declared input bounds and no-input submission have distinct request shapes', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'methodPicker', methodVariants: true },
    {
      'calibration:getMethodGuidanceCatalog': [
        {
          value: {
            status: 'ok',
            catalog: [
              {
                method: 'temperature_tower',
                title: 'Temperature tower',
                purpose: 'Synthetic bounded inputs.',
                wikiUrl:
                  'https://github.com/SoftFever/OrcaSlicer/wiki/Calibration',
                setupInputs: [
                  {
                    key: 'nozzleTemperature',
                    label: 'Nozzle temperature',
                    unit: 'C',
                    minimum: 180,
                    maximum: 300,
                  },
                ],
                measureQuantity: null,
                steps: ['setup'],
              },
              {
                method: 'max_volumetric_speed',
                title: 'Max volumetric speed',
                purpose: 'Synthetic no-input method.',
                wikiUrl: '',
                setupInputs: [],
                measureQuantity: null,
                steps: ['setup'],
              },
            ],
          },
        },
      ],
      'calibration:submitCalibrationSlice': [
        { error: 'Synthetic slice submission refused.' },
      ],
    },
  );
  await page.getByRole('button', { name: /^Start Temperature tower/ }).click();
  const purpose = page.getByRole('group', { name: 'Step 3a — purpose' });
  await expect(
    purpose.getByRole('link', { name: 'OrcaSlicer wiki reference' }),
  ).toHaveAttribute(
    'href',
    'https://github.com/SoftFever/OrcaSlicer/wiki/Calibration',
  );
  await capture(page, 'method-purpose-reference', info);
  await purpose.getByRole('button', { name: 'Continue to inputs' }).click();
  const inputs = page.getByRole('group', { name: 'Step 3b — inputs' });
  for (const [state, value] of [
    ['inputs-empty', ''],
    ['inputs-below-minimum', '179'],
    ['inputs-above-maximum', '301'],
  ]) {
    await inputs.getByRole('spinbutton').fill(value!);
    await inputs.getByRole('button', { name: 'Start slicing' }).click();
    await expect(inputs.getByRole('alert')).toContainText(
      'between 180 and 300',
    );
    expect(
      await ipcRequests(app!, 'calibration:submitCalibrationSlice'),
    ).toHaveLength(0);
    await capture(page, state!, info);
  }
  await inputs.getByRole('spinbutton').fill('180');
  await inputs.getByRole('button', { name: 'Start slicing' }).click();
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic slice submission refused.',
  );
  expect(
    await ipcRequests(app!, 'calibration:submitCalibrationSlice'),
  ).toHaveLength(1);
  expect(
    (await ipcRequests(app!, 'calibration:submitCalibrationSlice'))[0],
  ).toMatchObject({ params: { nozzleTemperature: 180 } });
  await capture(page, 'slice-submit-error', info);
  await page
    .getByRole('button', { name: /^Start Max volumetric speed/ })
    .click();
  await page.getByRole('button', { name: 'Continue to inputs' }).click();
  await expect(
    inputs.getByText('No additional inputs are required for this step.'),
  ).toBeVisible();
  await capture(page, 'inputs-none', info);
  await inputs.getByRole('button', { name: 'Start slicing' }).click();
  await expect(
    page.getByRole('group', { name: 'Step 3 — calibration method' }),
  ).toBeVisible();
  const calls = await ipcRequests(app!, 'calibration:submitCalibrationSlice');
  expect(calls).toHaveLength(2);
  expect(calls[1]).not.toHaveProperty('params');
});

test('synthetic calibration handoff continue/wait and discard pending/error/retry are explicit', async () => {
  const info = test.info();
  const draft = (stepId: string, deviceLabel: string) => ({
    stepId,
    deviceLabel,
    updatedAtUtc: CAL.now,
  });
  const page = await open(
    { restoreWizardPhase: 'methodPicker' },
    {
      'calibration:getInFlightState': [
        {
          value: {
            status: 'ok',
            projectId: CAL.calibrationProjectId,
            orchestration: null,
            drafts: [
              draft('temperature_tower', 'Synthetic device A'),
              draft('max_volumetric_speed', 'Synthetic device B'),
              draft('retraction', 'Synthetic device C'),
            ],
          },
        },
        {
          value: {
            status: 'ok',
            projectId: CAL.calibrationProjectId,
            orchestration: null,
            drafts: [],
          },
        },
      ],
      'calibration:discardDeviceDraft': [
        { pending: true },
        { error: 'Synthetic discard unavailable.' },
        { value: { status: 'ok', discarded: true } },
      ],
    },
  );
  await expect(
    page.getByRole('button', { name: 'Continue here', exact: true }),
  ).toHaveCount(3);
  await capture(page, 'handoff-three-choices', info);
  await page
    .getByRole('button', { name: 'Continue here', exact: true })
    .first()
    .click();
  await expect(
    page.getByRole('button', { name: 'Continue here', exact: true }),
  ).toHaveCount(2);
  expect(
    await ipcRequests(app!, 'calibration:discardDeviceDraft'),
  ).toHaveLength(0);
  await capture(page, 'handoff-continue', info);
  await page.getByRole('button', { name: 'Wait', exact: true }).first().click();
  await expect(
    page.getByRole('button', { name: 'Continue here', exact: true }),
  ).toHaveCount(1);
  expect(
    await ipcRequests(app!, 'calibration:discardDeviceDraft'),
  ).toHaveLength(0);
  await capture(page, 'handoff-wait', info);
  await page
    .getByRole('button', { name: 'Discard their draft', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Discarding…', exact: true }),
  ).toBeDisabled();
  await capture(page, 'handoff-discard-pending', info);
  await releaseIpcReply(app!, 'calibration:discardDeviceDraft');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic discard unavailable.',
  );
  await capture(page, 'handoff-discard-error', info);
  await page
    .getByRole('button', { name: 'Discard their draft', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Continue here', exact: true }),
  ).toHaveCount(0);
  await capture(page, 'handoff-discard-retry-success', info);
});

test('synthetic calibration in-flight loading and running print gate all method starts', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'methodPicker' },
    {
      'calibration:getInFlightState': [
        { pending: true },
        {
          value: {
            status: 'ok',
            projectId: CAL.calibrationProjectId,
            drafts: [],
            orchestration: {
              id: CAL.cloneId,
              projectId: CAL.calibrationProjectId,
              attemptId: CAL.altProfileId,
              currentStep: 'awaiting-print',
              status: 'Running',
              sliceJobId: CAL.sliceJobId,
              gcodeFileId: null,
              printJobId: null,
              revision: 1,
              updatedAtUtc: CAL.now,
            },
          },
        },
      ],
    },
  );
  const methods = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  await expect(methods.getByRole('status')).toContainText(
    'Checking whether another machine',
  );
  await expect(
    methods.getByRole('button', { name: /^Start / }).first(),
  ).toBeDisabled();
  await capture(page, 'handoff-check-pending', info);
  await releaseIpcReply(app!, 'calibration:getInFlightState');
  await expect(methods.getByRole('alert')).toContainText(
    'A calibration print is already running elsewhere.',
  );
  const starts = methods.getByRole('button', { name: /^Start / });
  for (const button of await starts.all()) await expect(button).toBeDisabled();
  await capture(page, 'handoff-print-running', info);
});

test('synthetic calibration in-flight check failure is visible without inventing a lock', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'methodPicker' },
    {
      'calibration:getInFlightState': [
        { error: 'Synthetic handoff check unavailable.' },
      ],
    },
  );
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: "Couldn't check whether another machine" }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Start Temperature tower/ }),
  ).toBeEnabled();
  await capture(page, 'handoff-check-error', info);
});

test('synthetic calibration slice progress advances to ready with reported estimates', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'pollingSlice' },
    {
      'calibration:getSliceJobStatus': [
        {
          value: {
            status: 'ok',
            snapshot: snapshot(),
            terminal: null,
            nextPollDelayMs: 1,
            cappedOut: false,
          },
        },
        { pending: true },
        {
          value: {
            status: 'ok',
            snapshot: snapshot({
              status: 'Completed',
              progressPercent: 100,
              estimatedPrintTimeSeconds: 600,
              filamentUsedGrams: 12.5,
            }),
            terminal: 'completed',
            nextPollDelayMs: null,
            cappedOut: false,
          },
        },
      ],
    },
  );
  await expect(
    page.getByRole('progressbar', { name: 'Slice progress' }),
  ).toHaveAttribute('value', '42');
  await expect(page.getByTestId('slice-progress-message')).toContainText(
    '42% — Processing — Synthetic worker slicing',
  );
  await capture(page, 'slice-processing-percent', info);
  await expect
    .poll(
      async () =>
        (await ipcRequests(app!, 'calibration:getSliceJobStatus')).length,
    )
    .toBe(2);
  await releaseIpcReply(app!, 'calibration:getSliceJobStatus');
  const send = page.getByRole('group', { name: 'Step 5 — send to printer' });
  await expect(send).toContainText('10 min, using approximately 12.5 g');
  expect(await ipcRequests(app!, 'calibration:getSliceJobStatus')).toEqual([
    { profileId: CAL.profileId, jobId: CAL.sliceJobId, pollAttempt: 2 },
    { profileId: CAL.profileId, jobId: CAL.sliceJobId, pollAttempt: 3 },
  ]);
  await capture(page, 'slice-ready-estimates', info);
});

for (const state of [
  'slice-failed',
  'slice-capped',
  'slice-api-error',
  'slice-poll-thrown',
] as const) {
  test(`synthetic calibration ${state} stays visible and preserves retry context`, async () => {
    const info = test.info();
    const reply: IpcReplies =
      state === 'slice-poll-thrown'
        ? {
            'calibration:getSliceJobStatus': [
              { error: 'Synthetic poll transport failed.' },
            ],
          }
        : state === 'slice-api-error'
          ? {
              'calibration:getSliceJobStatus': [
                {
                  value: {
                    status: 'error',
                    error: apiError(
                      'Synthetic slice job timeout.',
                      'sliceJobTimeout',
                    ),
                  },
                },
              ],
            }
          : {
              'calibration:getSliceJobStatus': [
                {
                  value: {
                    status: 'ok',
                    snapshot: snapshot(
                      state === 'slice-failed'
                        ? {
                            status: 'Failed',
                            errorMessage: 'Synthetic worker could not slice.',
                          }
                        : {},
                    ),
                    terminal: state === 'slice-failed' ? 'failed' : null,
                    nextPollDelayMs: null,
                    cappedOut: state === 'slice-capped',
                  },
                },
              ],
            };
    const page = await open({ restoreWizardPhase: 'pollingSlice' }, reply);
    if (state === 'slice-capped') {
      await expect(
        page.getByText(
          'Automatic polling paused after the wall-clock cap. Retry from the method picker to submit a fresh job.',
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('progressbar', { name: 'Slice progress' }),
      ).toHaveAttribute('value', '42');
    } else {
      await expect(page.getByRole('alert')).toBeVisible();
      if (state !== 'slice-poll-thrown')
        await expect(
          page.getByRole('group', { name: 'Step 3 — calibration method' }),
        ).toBeVisible();
    }
    await capture(page, state, info);
  });
}

test('synthetic calibration typed START sends only to local mock, reachability refusal permits upload-only retry', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'sliceReady' },
    {
      'calibration:sendSliceToPrinter': [
        { pending: true },
        {
          value: {
            status: 'error',
            error: apiError(
              'Synthetic printer is unreachable.',
              'printerContextStale',
            ),
          },
        },
        {
          value: {
            status: 'ok',
            result: {
              jobId: CAL.sliceJobId,
              printerId: CAL.printerId,
              fileName: 'synthetic.gcode',
              printStarted: false,
              message: 'Synthetic upload only; no printer contacted.',
            },
          },
        },
      ],
    },
  );
  const start = page.getByRole('button', {
    name: 'Start the calibration print now',
  });
  await page.getByRole('textbox', { name: 'Confirm start' }).fill('STAR');
  await expect(start).toBeDisabled();
  await capture(page, 'send-start-incomplete', info);
  await page.getByRole('textbox', { name: 'Confirm start' }).fill('START');
  await expect(start).toBeEnabled();
  await capture(page, 'send-start-confirmed', info);
  await start.click();
  await expect(
    page.getByTestId('filament-calibration-wizard').getByRole('status'),
  ).toContainText('Working…');
  expect(
    (await ipcRequests(app!, 'calibration:sendSliceToPrinter'))[0],
  ).toMatchObject({
    startPrint: true,
    operatorAcknowledgement: expect.stringMatching(/^filament-cal:/),
  });
  await capture(page, 'send-start-pending', info);
  await releaseIpcReply(app!, 'calibration:sendSliceToPrinter');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic printer is unreachable.',
  );
  await expect(
    page.getByRole('textbox', { name: 'Confirm start' }),
  ).toHaveValue('');
  await expect(start).toBeDisabled();
  await capture(page, 'send-unreachable-refusal', info);
  await page
    .getByRole('button', { name: 'Upload gcode only (do not start)' })
    .click();
  await expect(
    page.getByRole('group', { name: 'Step 6 — measurement' }),
  ).toBeVisible();
  await expect(
    page.getByTestId('filament-calibration-wizard').getByRole('status'),
  ).toContainText('Gcode uploaded to the printer.');
  expect(
    (await ipcRequests(app!, 'calibration:sendSliceToPrinter'))[1],
  ).toMatchObject({ startPrint: false, operatorAcknowledgement: null });
  await capture(page, 'send-upload-only-retry', info);
});

test('synthetic calibration operator-recovery refusal names deliberate server-side recovery', async () => {
  const page = await open(
    { restoreWizardPhase: 'sliceReady' },
    {
      'calibration:sendSliceToPrinter': [
        {
          value: {
            status: 'error',
            error: {
              ...apiError('Synthetic dispatch remains blocked.'),
              blockedReasonCode: 'OperatorRecoveryRequired',
              reference: '88888888-8888-4888-8888-888888888801',
            },
          },
        },
      ],
    },
  );
  await page.getByRole('textbox', { name: 'Confirm start' }).fill('START');
  await page
    .getByRole('button', { name: 'Start the calibration print now' })
    .click();
  const alert = page.getByRole('alert');
  await expect(alert).toContainText(
    'PrintFarmer blocked this job after an operator released an indeterminate pre-start dispatch claim. The job cannot be dispatched until an operator deliberately clears the block in PrintFarmer or cancels the job.',
  );
  await expect(alert).toContainText('Synthetic dispatch remains blocked.');
  await expect(alert).toContainText(
    'Reference: 88888888-8888-4888-8888-888888888801',
  );
  await expect(alert).not.toContainText('unrecognised reason code');
  await expect(alert.getByText('Retry.', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Confirm start' }),
  ).toHaveValue('');
  expect(
    await ipcRequests(app!, 'calibration:sendSliceToPrinter'),
  ).toHaveLength(1);
  await test.info().attach('operator-recovery-refusal', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
  await scanSurface(page, {
    name: 'calibration operator recovery refusal',
    present: page.locator('#root'),
    testInfo: test.info(),
  });
});

test('synthetic calibration temperature validation, write-back error/retry and draft-sync states', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'awaitingMeasurement' },
    {
      'calibration:updateFilamentProfileMeasurement': [
        { pending: true },
        { error: 'Synthetic profile update rejected.' },
        {
          value: {
            status: 'ok',
            updated: {
              id: CAL.cloneId,
              name: 'Synthetic clone',
              profileType: 'filament',
              isSystem: false,
            },
          },
        },
      ],
      'calibration:submitCalibrationObservation': [
        { pending: true },
        { error: 'Synthetic draft sync rejected.' },
      ],
    },
  );
  const measure = page.getByRole('group', { name: 'Step 6 — measurement' });
  const save = measure.getByRole('button', {
    name: 'Save measurement and continue',
  });
  await save.click();
  await expect(measure.getByRole('alert')).toContainText('between 150 and 320');
  expect(
    await ipcRequests(app!, 'calibration:updateFilamentProfileMeasurement'),
  ).toHaveLength(0);
  await capture(page, 'measurement-temperature-empty', info);
  await measure
    .getByRole('spinbutton', { name: 'Nozzle temperature', exact: true })
    .fill('321');
  await measure
    .getByRole('spinbutton', {
      name: 'Initial layer nozzle temperature',
      exact: true,
    })
    .fill('149');
  await save.click();
  await expect(measure.getByRole('alert')).toContainText('between 150 and 320');
  await capture(page, 'measurement-temperature-out-of-range', info);
  for (const [label, value] of [
    ['Nozzle temperature', '220'],
    ['Initial layer nozzle temperature', '225'],
  ]) {
    await measure
      .getByRole('spinbutton', { name: label!, exact: true })
      .fill(value!);
  }
  await save.click();
  await expect(
    page.getByTestId('filament-calibration-wizard').getByRole('status'),
  ).toContainText('Working…');
  await capture(page, 'measurement-writing-pending', info);
  await releaseIpcReply(app!, 'calibration:updateFilamentProfileMeasurement');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic profile update rejected.',
  );
  await capture(page, 'measurement-write-error', info);
  for (const [label, value] of [
    ['Nozzle temperature', '150'],
    ['Initial layer nozzle temperature', '320'],
  ]) {
    await measure
      .getByRole('spinbutton', { name: label!, exact: true })
      .fill(value!);
  }
  await save.click();
  await expect(
    page.getByTestId('filament-calibration-wizard').getByRole('status'),
  ).toContainText('measurement saved.');
  await expect(
    page.getByRole('button', { name: 'Finish calibration' }),
  ).toBeDisabled();
  await expect(page.getByText(/Still syncing 1 step/)).toBeVisible();
  await capture(page, 'measurement-saved-draft-pending', info);
  await releaseIpcReply(app!, 'calibration:submitCalibrationObservation');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic draft sync rejected.',
  );
  await expect(page.getByText(/1 step\(s\) failed to sync/)).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Finish calibration' }),
  ).toBeDisabled();
  await capture(page, 'measurement-draft-sync-error', info);
});

for (const method of [
  'max_volumetric_speed',
  'pressure_advance_tower',
  'flow_rate_yolo_recommended',
  'flow_rate_yolo_perfectionist',
  'flow_rate_pass_1',
  'flow_rate_pass_2',
  'retraction',
] satisfies CalibrationSliceMethod[]) {
  test(`synthetic calibration scalar measurement ${method}`, async () => {
    const info = test.info();
    const spec = scalarSpecFor(FILAMENT_METHOD_META[method].measurementSchema);
    if (!spec) throw new Error('Scalar fixture requires a scalar method.');
    const page = await open(
      { restoreWizardPhase: 'awaitingMeasurement' },
      {
        'calibration:getFilamentWizardState': [
          { value: restored('awaitingMeasurement', method) },
        ],
        'calibration:updateFilamentProfileMeasurement': [
          {
            value: {
              status: 'ok',
              updated: {
                id: CAL.cloneId,
                name: 'Synthetic clone',
                profileType: 'filament',
                isSystem: false,
              },
            },
          },
        ],
        'calibration:submitCalibrationObservation': [
          {
            value: {
              status: 'ok',
              attemptId: CAL.altProfileId,
              observationId: CAL.cloneId,
            },
          },
        ],
      },
    );
    const measure = page.getByRole('group', { name: 'Step 6 — measurement' });
    await expect(measure.getByRole('spinbutton')).toHaveCount(1);
    const input = measure.getByRole('spinbutton', {
      name: spec.ariaLabel,
      exact: true,
    });
    await measure
      .getByRole('button', { name: 'Save measurement and continue' })
      .click();
    await expect(measure.getByRole('alert')).toContainText(spec.rangeMessage);
    await input.fill('-1');
    await measure
      .getByRole('button', { name: 'Save measurement and continue' })
      .click();
    await expect(measure.getByRole('alert')).toContainText(spec.rangeMessage);
    expect(
      await ipcRequests(app!, 'calibration:updateFilamentProfileMeasurement'),
    ).toHaveLength(0);
    await capture(page, `scalar-invalid-${method.replaceAll('_', '-')}`, info);
    await input.fill('1');
    await measure
      .getByRole('button', { name: 'Save measurement and continue' })
      .click();
    await expect(
      page.getByTestId('filament-calibration-wizard').getByRole('status'),
    ).toContainText('measurement saved.');
    expect(
      (
        await ipcRequests(app!, 'calibration:updateFilamentProfileMeasurement')
      )[0],
    ).toMatchObject({ measurement: { method, [spec.field]: 1 } });
    await capture(page, `scalar-saved-${method.replaceAll('_', '-')}`, info);
  });
}

test('synthetic calibration start over clears the bookmark before deleting the clone and remounts clean', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'methodPicker', methodVariants: true },
    {
      'calibration:getFilamentWizardState': [
        { value: restored('methodPicker') },
        { value: null },
      ],
      'calibration:clearFilamentWizardState': [
        { pending: true },
        { value: { cleared: true } },
      ],
      'calibration:deleteWorkingCloneProfile': [
        { value: { status: 'ok', alreadyDeleted: false } },
      ],
    },
  );
  await expect(
    page.getByRole('group', { name: 'Step 3 — calibration method' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Start over' }).click();
  const step = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  await expect(step).toBeVisible();
  expect(
    await ipcRequests(app!, 'calibration:deleteWorkingCloneProfile'),
  ).toHaveLength(0);
  await capture(page, 'restart-bookmark-clear-pending', info);
  await releaseIpcReply(app!, 'calibration:clearFilamentWizardState');
  await expect
    .poll(
      async () =>
        (await ipcRequests(app!, 'calibration:deleteWorkingCloneProfile'))
          .length,
    )
    .toBe(1);
  await page.getByRole('button', { name: 'Back to dashboard' }).click();
  await page
    .getByRole('button', { name: 'Calibrate a filament spool' })
    .click();
  await expect(step).toBeVisible();
  await expect(
    page.getByRole('combobox', { name: 'Printer', exact: true }),
  ).toHaveValue('');
  await capture(page, 'restart-remounted-clean', info);
});

test('synthetic calibration compact breakpoint stacks dashboard and wizard headers', async () => {
  const info = test.info();
  const page = await open({}, {}, false);
  await applyPinnedRenderingProfile(
    page,
    'desktop-dark-680x450-dsf1-en-US-UTC-reduced-motion-v1',
  );
  await expect(page.locator('.cal-view-heading')).toHaveCSS(
    'flex-direction',
    'column',
  );
  await capture(page, 'dashboard-680-stacked', info);
  await page
    .getByRole('button', { name: 'Calibrate a filament spool' })
    .click();
  await expect(page.locator('.cal-view-heading')).toHaveCSS(
    'flex-direction',
    'column',
  );
  await expect(
    page.getByRole('group', {
      name: 'Step 1 — machine, process, and base filament',
    }),
  ).toBeVisible();
  await capture(page, 'wizard-680-stacked', info);
});

test('synthetic calibration completion pending/error, unconfirmed promotion and confirmed retry', async () => {
  const info = test.info();
  const page = await open(
    { restoreWizardPhase: 'methodPicker', methodVariants: true },
    {
      'calibration:completeCalibrationProject': [
        { pending: true },
        { error: 'Synthetic completion rejected.' },
        {
          value: {
            status: 'ok',
            lifecycleStatus: 'Completed',
            promotedProfileId: null,
          },
        },
        {
          value: {
            status: 'ok',
            lifecycleStatus: 'Completed',
            promotedProfileId: CAL.draftProfileId,
          },
        },
      ],
      'calibration:clearFilamentWizardState': [{ value: { cleared: true } }],
      'calibration:deleteWorkingCloneProfile': [
        { value: { status: 'ok', alreadyDeleted: false } },
      ],
    },
  );
  const finish = page.getByRole('button', { name: 'Finish calibration' });
  await finish.click();
  await expect(finish).toBeDisabled();
  await capture(page, 'completion-pending', info);
  await releaseIpcReply(app!, 'calibration:completeCalibrationProject');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic completion rejected.',
  );
  await expect(finish).toBeEnabled();
  await capture(page, 'completion-error', info);
  await finish.click();
  await expect(
    page.getByTestId('filament-calibration-wizard').getByRole('status'),
  ).toContainText('promotion could not be confirmed yet');
  await expect(finish).toBeEnabled();
  expect(
    await ipcRequests(app!, 'calibration:deleteWorkingCloneProfile'),
  ).toHaveLength(0);
  await capture(page, 'completion-promotion-unconfirmed', info);
  await finish.click();
  await expect(
    page
      .getByTestId('filament-calibration-wizard')
      .getByRole('status')
      .filter({ hasText: 'Calibration completed.' }),
  ).toContainText('promoted to a new custom filament profile');
  await expect(
    page.getByRole('group', {
      name: 'Step 1 — machine, process, and base filament',
    }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await ipcRequests(app!, 'calibration:deleteWorkingCloneProfile'))
          .length,
    )
    .toBe(1);
  await capture(page, 'completion-promotion-confirmed', info);
});

test('synthetic calibration provider loading/error/retry and subnav return announce state', async () => {
  const info = test.info();
  const page = await open(
    {},
    {
      'calibration:listWorkspaceStates': [
        { pending: true },
        { error: 'Synthetic local workspace load failed.' },
        { value: { states: [], unhydratedProjects: [] } },
      ],
    },
    false,
  );
  await expect(
    page
      .getByRole('status')
      .filter({ hasText: 'Confirming calibration availability.' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Calibrate a filament spool' }),
  ).toBeDisabled();
  await capture(page, 'provider-loading', info);
  await releaseIpcReply(app!, 'calibration:listWorkspaceStates');
  await expect(
    page
      .getByRole('main', { name: 'Filament calibration workspace' })
      .getByRole('alert')
      .filter({ hasText: 'Synthetic local workspace load failed.' }),
  ).toBeVisible();
  await capture(page, 'provider-error', info);
  await page
    .getByRole('button', { name: 'Retry loading', exact: true })
    .click();
  await expect(
    page.getByRole('status').filter({
      hasText: 'Calibration workspace loaded. 0 projects available.',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Calibrate a filament spool' }),
  ).toBeEnabled();
  await capture(page, 'provider-retry-live', info);
  await page
    .getByRole('button', { name: 'Calibrate a filament spool' })
    .click();
  const dashboard = page
    .getByRole('navigation', { name: 'Calibration views' })
    .getByRole('button', { name: 'Dashboard', exact: true });
  await dashboard.click();
  await expect(dashboard).toHaveAttribute('aria-current', 'page');
  await capture(page, 'subnav-dashboard-return', info);
});

function conflict(local: unknown): CalibrationConflict {
  return {
    conflictId: CAL.cloneId,
    profileId: CAL.profileId,
    projectId: CAL.calibrationProjectId,
    kind: 'stepDraft',
    entityId: CAL.altProfileId,
    localPayloadSummary: JSON.stringify(local),
    serverPayloadSummary: '{}',
    serverRevision: 1,
    availableResolutions: ['manualFieldMerge'],
    resolvedAt: null,
    resolution: null,
    createdAt: CAL.now,
  };
}
test('synthetic calibration conflict merge key and editable value limits stay within IPC bounds', async () => {
  const info = test.info();
  const key = 'k'.repeat(200);
  const page = await open(
    {},
    {
      'calibration:listConflicts': [
        {
          value: {
            conflicts: [
              conflict({
                [key]: 'Synthetic value',
                ['z'.repeat(201)]: 'Dropped key',
                numeric: 3,
                boolean: true,
                empty: null,
              }),
            ],
          },
        },
      ],
      'calibration:resolveConflict': [
        { error: 'Synthetic boundary resolution refused.' },
      ],
    },
    false,
  );
  await page
    .getByRole('button', { name: 'Review conflicts', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Review calibration conflicts',
    exact: true,
  });
  await dialog.getByRole('radio', { name: 'Merge fields manually' }).click();
  await expect(dialog.getByRole('textbox')).toHaveCount(4);
  const field = dialog.getByRole('textbox', { name: key, exact: true });
  await expect(field).toHaveAttribute('maxlength', '4096');
  await field.fill('V'.repeat(4097));
  await expect(field).toHaveValue('V'.repeat(4096));
  await expect(
    dialog.getByRole('button', { name: 'Resolve conflict', exact: true }),
  ).toBeEnabled();
  await expect(
    dialog.getByRole('textbox', { name: 'numeric', exact: true }),
  ).toHaveValue('3');
  await expect(
    dialog.getByRole('textbox', { name: 'boolean', exact: true }),
  ).toHaveValue('true');
  await expect(
    dialog.getByRole('textbox', { name: 'empty', exact: true }),
  ).toHaveValue('');
  await capture(page, 'conflict-merge-key-value-limits', info);
  await dialog
    .getByRole('button', { name: 'Resolve conflict', exact: true })
    .click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic boundary resolution refused.',
  );
  expect(
    (await ipcRequests(app!, 'calibration:resolveConflict'))[0],
  ).toMatchObject({
    mergedFields: {
      [key]: 'V'.repeat(4096),
      numeric: '3',
      boolean: 'true',
      empty: '',
    },
  });
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Review conflicts', exact: true }),
  ).toBeFocused();
});
for (const [state, local] of [
  ['nested', { nested: { value: 1 }, displayName: 'Local' }],
  ['array', { list: [1, 2] }],
  ['root-array', [1, 2]],
] as const) {
  test(`synthetic calibration conflict rejects ${state} summaries without partial merge`, async () => {
    const info = test.info();
    const page = await open(
      {},
      {
        'calibration:listConflicts': [
          { value: { conflicts: [conflict(local)] } },
        ],
      },
      false,
    );
    await page
      .getByRole('button', { name: 'Review conflicts', exact: true })
      .click();
    const dialog = page.getByRole('dialog', {
      name: 'Review calibration conflicts',
      exact: true,
    });
    await dialog.getByRole('radio', { name: 'Merge fields manually' }).click();
    await expect(dialog.getByRole('alert')).toContainText(
      'not a JSON object with top-level scalar fields',
    );
    await expect(dialog.getByRole('textbox')).toHaveCount(0);
    await expect(
      dialog.getByRole('button', { name: 'Resolve conflict', exact: true }),
    ).toBeDisabled();
    await capture(page, `conflict-merge-${state}-blocked`, info);
  });
}
