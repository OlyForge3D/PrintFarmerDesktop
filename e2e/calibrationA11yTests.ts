/**
 * Filament calibration accessibility Playwright E2E tests (@a11y).
 *
 * Post-#756 the printer-calibration saga is gone, along with the dashboard's
 * saved-projects list, generation status alert, bed-clear dialog, temperature
 * stage workflow, calibration report, and OrcaSlicer profile install/restore
 * flow. Every axe scan, focus trap, and recovery-state assertion that took
 * one of those as its subject was deleted with #756 — a rename does not
 * revive a UI that no longer exists.
 *
 * What survives is the shipped page the operator will actually run: the
 * Filament Calibration dashboard and the filament calibration wizard. This
 * spec asserts the a11y invariants that continue to hold on those surfaces:
 *
 *   1. Axe scans of the dashboard and the wizard's Step 1 report no
 *      material WCAG A/AA violations.
 *   2. Keyboard traversal reaches the primary "Calibrate a filament spool"
 *      CTA and, in the wizard, reaches the printer picker inside Step 1.
 *   3. Dashboard recovery states (offline, missing scopes, missing
 *      capability flags) each disable the primary CTA and announce the
 *      recovery message — with a positive control (`availability: 'ok'`)
 *      that must NOT show any recovery message on the same fixtures.
 *   4. Reduced motion, dark theme, and 200% zoom on the dashboard and
 *      the wizard's Step 1 hold up without axe regressions.
 *
 * Tests deleted (subject no longer exists):
 *
 *   - Legacy backup import dialog focus trap (dialog reaped)
 *   - Bed-clear dialog focus trap (dialog reaped)
 *   - Project overview / temperature stage / generation status axe scans
 *     (all saga surfaces)
 *   - Calibration report print media (report reaped)
 *   - OrcaSlicer profile install rollback (channels reaped, see #756 PR body)
 *   - Project recovery states — stale context, conflict, generation
 *     failure, uncertain dispatch (saga workspace state gone)
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Locator,
  type Page,
} from '@playwright/test';
import { rmSync } from 'node:fs';
import type { UploadJob } from '@shared/ipc';

import {
  applyCalibrationScenario,
  expectTabReaches,
  getCalibrationFixtureCallCount,
  launchCalibrationApp,
  openCalibrationWorkspace,
  openFilamentCalibrationWizard,
  scanSurface,
  WCAG_TAGS,
  type CalibrationScenario,
} from './helpers/calibrationA11yFixture.js';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage.js';
import AxeBuilder from '@axe-core/playwright';

let app: ElectronApplication;
let page: Page;
let stateRoot: string | null = null;
const blockedCalibrationSideEffectChannels = [
  'calibration:sendSliceToPrinter',
  'calibration:updateFilamentProfileMeasurement',
  'calibration:submitCalibrationObservation',
  'calibration:completeCalibrationProject',
  'calibration:deleteWorkingCloneProfile',
] as const;

async function expectNoCalibrationSideEffectCalls(): Promise<void> {
  for (const channel of blockedCalibrationSideEffectChannels) {
    expect(await getCalibrationFixtureCallCount(app, channel), channel).toBe(0);
  }
}

test.beforeAll(async () => {
  const launched = await launchCalibrationApp();
  app = launched.app;
  page = launched.page;
  await applyPinnedRenderingProfile(page);
  stateRoot = launched.stateRoot;
});

test.afterAll(async () => {
  try {
    await app.close();
  } catch {
    // best-effort — the after-each cleanup already ran
  }
  if (stateRoot !== null) {
    try {
      rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      // Windows may still hold the SQLite handle; the OS reclaims the
      // tmpdir on next boot even if this call fails.
    }
  }
});

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// 1. Axe scans
// ---------------------------------------------------------------------------

test('@a11y filament calibration dashboard has no material WCAG A/AA violations', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);
  await scanSurface(page, {
    name: 'filament calibration dashboard',
    present: page.getByRole('heading', {
      name: 'Filament Calibration',
      level: 1,
    }),
    testInfo,
  });
  await captureVisualScenario(page, 'calibration.dashboard.ready', testInfo);
});

test('@a11y calibration conflicts dialog renders a synthetic list and supports keyboard selection', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, { conflictList: 'populated' });
  await openCalibrationWorkspace(page);
  await page.getByRole('button', { name: 'Review conflicts' }).click();

  const dialog = page.getByRole('dialog', {
    name: 'Review calibration conflicts',
  });
  await expect(dialog).toBeVisible();
  const listbox = dialog.getByRole('listbox', {
    name: 'Unresolved calibration conflicts for A11y Test Server',
  });
  const options = listbox.getByRole('option');
  await expect(options).toHaveCount(2);
  await options.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(dialog.getByText('Local payload summary')).toBeVisible();
  await expect(dialog.getByText(/Local cooling notes/)).toBeVisible();
  await expect(
    dialog.getByRole('radio', { name: 'Merge fields manually' }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Resolve conflict' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'calibration conflicts list and details dialog',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.conflicts.list-details',
    testInfo,
  );
  await dialog
    .getByRole('button', { name: 'Close calibration conflicts dialog' })
    .click();
  await expect(dialog).toHaveCount(0);
});

test('@a11y calibration conflicts dialog exposes loading, empty, and load-error states', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  const cases = [
    {
      name: 'loading',
      scenario: { conflictList: 'loading' as const },
      expected: 'Loading conflicts…',
      scenarioId: 'calibration.conflicts.loading',
    },
    {
      name: 'empty',
      scenario: { conflictList: 'empty' as const },
      expected: 'No calibration conflicts',
      scenarioId: 'calibration.conflicts.empty',
    },
    {
      name: 'load error',
      scenario: { conflictList: 'error' as const },
      expected: 'Synthetic conflict service unavailable.',
      scenarioId: 'calibration.conflicts.load-error',
    },
  ];

  for (const item of cases) {
    await applyCalibrationScenario(app, page, item.scenario);
    await openCalibrationWorkspace(page);
    await page.getByRole('button', { name: 'Review conflicts' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Review calibration conflicts',
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByText(item.expected, { exact: false }),
    ).toBeVisible();
    if (item.name === 'loading') {
      await expect(dialog).toHaveAttribute('aria-busy', 'true');
    } else {
      await expect(dialog).toHaveAttribute('aria-busy', 'false');
    }
    if (item.name === 'load error') {
      await expect(
        dialog.getByRole('button', { name: 'Try again' }),
      ).toBeEnabled();
    }
    await scanSurface(page, {
      name: `calibration conflicts ${item.name} state`,
      present: dialog,
      testInfo,
    });
    await captureVisualScenario(page, item.scenarioId, testInfo);
    await dialog
      .getByRole('button', { name: 'Close calibration conflicts dialog' })
      .click();
    await expect(dialog).toHaveCount(0);
  }
});

test('@a11y calibration conflicts dialog shows a local-only manual merge draft', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, { conflictList: 'populated' });
  await openCalibrationWorkspace(page);
  await page.getByRole('button', { name: 'Review conflicts' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Review calibration conflicts',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Merge fields manually' }).check();
  const displayName = dialog.getByRole('textbox', { name: 'displayName' });
  await expect(displayName).toHaveValue('Local temperature notes');
  await expect(
    dialog.getByRole('textbox', { name: 'targetTemperature' }),
  ).toHaveValue('220');
  await displayName.fill('Synthetic merged notes');
  await expect(
    dialog.getByRole('button', { name: 'Resolve conflict' }),
  ).toBeEnabled();
  await expect(dialog).toHaveAttribute('aria-busy', 'false');
  await scanSurface(page, {
    name: 'calibration conflicts manual merge draft',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.conflicts.manual-merge-draft',
    testInfo,
  );
  await dialog
    .getByRole('button', { name: 'Close calibration conflicts dialog' })
    .click();
  await expect(dialog).toHaveCount(0);
});

test('@a11y calibration conflicts dialog blocks a malformed manual merge', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    conflictList: 'populated',
    conflictPayload: 'malformed',
  });
  await openCalibrationWorkspace(page);
  await page.getByRole('button', { name: 'Review conflicts' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Review calibration conflicts',
  });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Merge fields manually' }).check();
  await expect(
    dialog.getByRole('alert').filter({
      hasText: 'Manual merge is blocked because one or both payload summaries',
    }),
  ).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Resolve conflict' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'calibration conflicts malformed merge blocked',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.conflicts.manual-merge-blocked',
    testInfo,
  );
  await dialog
    .getByRole('button', { name: 'Close calibration conflicts dialog' })
    .click();
  await expect(dialog).toHaveCount(0);
});

test('@a11y calibration conflicts dialog blocks over-limit merges and unavailable strategies', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  const cases = [
    {
      payload: 'tooManyFields' as const,
      scenarioId: 'calibration.conflicts.manual-merge-over-limit',
    },
    {
      payload: 'noResolutions' as const,
      scenarioId: 'calibration.conflicts.no-safe-resolution',
    },
  ];

  for (const item of cases) {
    await applyCalibrationScenario(app, page, {
      conflictList: 'populated',
      conflictPayload: item.payload,
    });
    await openCalibrationWorkspace(page);
    await page.getByRole('button', { name: 'Review conflicts' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Review calibration conflicts',
    });
    await expect(dialog).toBeVisible();

    if (item.payload === 'tooManyFields') {
      await dialog
        .getByRole('radio', { name: 'Merge fields manually' })
        .check();
      await expect(
        dialog.getByRole('alert').filter({
          hasText: '21 fields exceed the 20-field IPC limit',
        }),
      ).toBeVisible();
    } else {
      await expect(dialog.getByRole('radio')).toHaveCount(0);
      await expect(
        dialog.getByText(
          'PrintFarmer did not advertise a safe resolution for this conflict.',
        ),
      ).toBeVisible();
    }

    await expect(
      dialog.getByRole('button', { name: 'Resolve conflict' }),
    ).toBeDisabled();
    await scanSurface(page, {
      name: `calibration conflicts ${item.payload} resolution refusal`,
      present: dialog,
      testInfo,
    });
    await captureVisualScenario(page, item.scenarioId, testInfo);
    await dialog
      .getByRole('button', { name: 'Close calibration conflicts dialog' })
      .click();
    await expect(dialog).toHaveCount(0);
  }
});

test('@a11y calibration conflicts dialog exposes mocked pending, error, and result resolution states', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  const cases = [
    {
      name: 'pending',
      scenario: { conflictResolution: 'pending' as const },
      scenarioId: 'calibration.conflicts.resolution-pending',
    },
    {
      name: 'error',
      scenario: { conflictResolution: 'error' as const },
      scenarioId: 'calibration.conflicts.resolution-error',
    },
    {
      name: 'resolved',
      scenario: { conflictResolution: 'resolved' as const },
      scenarioId: 'calibration.conflicts.resolution-result',
    },
  ];

  for (const item of cases) {
    await applyCalibrationScenario(app, page, {
      conflictList: 'populated',
      ...item.scenario,
    });
    await openCalibrationWorkspace(page);
    await page.getByRole('button', { name: 'Review conflicts' }).click();
    const dialog = page.getByRole('dialog', {
      name: 'Review calibration conflicts',
    });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('radio', { name: 'Accept server version' }).check();
    await dialog.getByRole('button', { name: 'Resolve conflict' }).click();

    if (item.name === 'pending') {
      await expect(
        dialog.getByRole('button', { name: 'Resolving…' }),
      ).toBeDisabled();
      await expect(
        dialog.getByRole('radio', { name: 'Accept server version' }),
      ).toBeDisabled();
    } else if (item.name === 'error') {
      await expect(
        dialog.getByRole('alert').filter({
          hasText: /Resolution failed.*Synthetic stale-revision conflict\./,
        }),
      ).toBeVisible();
      await expect(dialog.getByText('2 unresolved')).toBeVisible();
    } else {
      await expect(
        dialog.getByRole('region', { name: 'Resolution result' }),
      ).toContainText('1 recorded observation superseded');
      await expect(
        dialog.getByText(/These observations were not invalidated/),
      ).toBeVisible();
    }

    await scanSurface(page, {
      name: `calibration conflicts ${item.name} resolution state`,
      present: dialog,
      testInfo,
    });
    await captureVisualScenario(page, item.scenarioId, testInfo);
    await dialog
      .getByRole('button', { name: 'Close calibration conflicts dialog' })
      .click();
    await expect(dialog).toHaveCount(0);
  }
});

test('@a11y filament calibration wizard Step 1 has no material WCAG A/AA violations', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {});
  await openFilamentCalibrationWizard(page);
  await scanSurface(page, {
    name: 'filament calibration wizard Step 1',
    present: page.getByRole('group', {
      name: 'Step 1 — machine, process, and base filament',
    }),
    testInfo,
  });
  await captureVisualScenario(page, 'calibration.wizard.step-1', testInfo);
});

test('@a11y filament calibration wizard explains an empty printer list', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, { printerList: 'empty' });
  await openFilamentCalibrationWizard(page);
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  await expect(step1.getByRole('combobox', { name: 'Printer' })).toHaveCount(0);
  const emptyHint = step1.getByText(
    /No PrintFarmer printers are available\. Add one on the server/,
  );
  await expect(emptyHint).toBeVisible();
  await scanSurface(page, {
    name: 'calibration wizard empty printer list',
    present: step1,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.empty-printer-list',
    testInfo,
  );
});

test('@a11y filament calibration wizard names a clone from deterministic profile selections', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, { profileCatalog: true });
  await openFilamentCalibrationWizard(page);

  await page
    .getByRole('combobox', { name: 'Printer' })
    .selectOption({ label: 'A11y Fixture Printer — A11y Reference Klipper' });

  const machine = page.getByRole('combobox', { name: 'Machine profile' });
  await expect(machine.locator('option')).toHaveCount(2);
  await machine.selectOption({ index: 1 });
  const process = page.getByRole('combobox', { name: 'Process profile' });
  await expect(process.locator('option')).toHaveCount(2);
  await process.selectOption({ index: 1 });
  const filament = page.getByRole('combobox', { name: 'Filament profile' });
  await expect(filament.locator('option')).toHaveCount(2);
  await filament.selectOption({ index: 1 });

  await page.getByRole('button', { name: 'Next — name the clone' }).click();
  const cloneStep = page.getByRole('group', {
    name: 'Step 2 — name the clone',
  });
  await expect(
    cloneStep.getByRole('textbox', { name: 'Clone name' }),
  ).toHaveValue('Generic PLA (calibration)');
  await expect(
    cloneStep.getByRole('combobox', { name: 'Spoolman spool' }),
  ).toHaveValue('');
  await expect(
    cloneStep.getByRole('button', { name: 'Clone this filament profile' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'calibration wizard clone-name step',
    present: cloneStep,
    testInfo,
  });
  await captureVisualScenario(page, 'calibration.wizard.clone-name', testInfo);
});

test('@a11y filament calibration wizard restores the method picker without starting physical work', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    restoreWizardPhase: 'methodPicker',
  });
  await openFilamentCalibrationWizard(page);
  const methodPicker = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  await expect(methodPicker).toBeVisible();
  await expect(
    methodPicker.getByRole('button', { name: /^Start / }),
  ).toHaveCount(8);
  await expect(
    methodPicker.getByRole('button', { name: 'Finish calibration' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'calibration wizard method picker',
    present: methodPicker,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.method-picker',
    testInfo,
  );
});

test('@a11y filament calibration wizard explains purpose and setup inputs before slicing', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    restoreWizardPhase: 'methodPicker',
  });
  await openFilamentCalibrationWizard(page);
  const methodPicker = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  await methodPicker
    .getByRole('button', { name: /^Start Temperature tower/ })
    .click();

  const purpose = page.getByRole('group', { name: 'Step 3a — purpose' });
  await expect(
    purpose.getByText(/Compare the synthetic tower bands/),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'calibration wizard method purpose',
    present: purpose,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.method-purpose',
    testInfo,
  );

  await purpose.getByRole('button', { name: 'Continue to inputs' }).click();
  const inputs = page.getByRole('group', { name: 'Step 3b — inputs' });
  await expect(
    inputs.getByRole('spinbutton', { name: /Nozzle temperature/ }),
  ).toBeVisible();
  await expect(
    inputs.getByRole('button', { name: 'Start slicing' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'calibration wizard setup inputs',
    present: inputs,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.method-inputs',
    testInfo,
  );
});

test('@a11y filament calibration wizard scans purpose and input screens for the other seven methods', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(360_000);

  const methods = [
    { id: 'max-volumetric-speed', title: 'Max volumetric speed' },
    { id: 'pressure-advance-tower', title: 'Pressure advance — tower' },
    { id: 'flow-yolo-recommended', title: 'Flow rate — YOLO (Recommended)' },
    {
      id: 'flow-yolo-perfectionist',
      title: 'Flow rate — YOLO (Perfectionist)',
    },
    { id: 'flow-pass-1', title: 'Flow rate — pass 1' },
    { id: 'flow-pass-2', title: 'Flow rate — pass 2' },
    { id: 'retraction', title: 'Retraction' },
  ];
  const escapeRegExp = (value: string): string =>
    value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  await applyCalibrationScenario(app, page, {
    restoreWizardPhase: 'methodPicker',
    methodVariants: true,
  });
  await openFilamentCalibrationWizard(page);
  const methodPicker = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });

  for (const method of methods) {
    await methodPicker
      .getByRole('button', {
        name: new RegExp(`^Start ${escapeRegExp(method.title)}`),
      })
      .click();
    const purpose = page.getByRole('group', { name: 'Step 3a — purpose' });
    await expect(
      purpose.getByText(`Synthetic method purpose for ${method.title}.`, {
        exact: true,
      }),
    ).toBeVisible();
    await scanSurface(page, {
      name: `${method.title} purpose screen`,
      present: purpose,
      testInfo,
    });
    await captureVisualScenario(
      page,
      `calibration.wizard.method-purpose.${method.id}`,
      testInfo,
    );

    await purpose.getByRole('button', { name: 'Continue to inputs' }).click();
    const inputs = page.getByRole('group', { name: 'Step 3b — inputs' });
    await expect(
      inputs.getByRole('spinbutton', { name: /Synthetic setup input/ }),
    ).toBeVisible();
    await scanSurface(page, {
      name: `${method.title} setup inputs`,
      present: inputs,
      testInfo,
    });
    await captureVisualScenario(
      page,
      `calibration.wizard.method-inputs.${method.id}`,
      testInfo,
    );

    await inputs.getByRole('button', { name: 'Back' }).click();
    await purpose.getByRole('button', { name: 'Back' }).click();
    await expect(methodPicker).toBeVisible();
  }
});

test('@a11y filament calibration wizard announces a pending mocked slice submission', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    profileCatalog: true,
    sliceSubmissionPending: true,
  });
  await openFilamentCalibrationWizard(page);
  await page
    .getByRole('combobox', { name: 'Printer' })
    .selectOption({ label: 'A11y Fixture Printer — A11y Reference Klipper' });
  const machine = page.getByRole('combobox', { name: 'Machine profile' });
  await machine.selectOption({ index: 1 });
  const process = page.getByRole('combobox', { name: 'Process profile' });
  await process.selectOption({ index: 1 });
  const filament = page.getByRole('combobox', { name: 'Filament profile' });
  await filament.selectOption({ index: 1 });
  await page.getByRole('button', { name: 'Next — name the clone' }).click();
  await page
    .getByRole('button', { name: 'Clone this filament profile' })
    .click();

  const methodPicker = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  await expect(methodPicker).toBeVisible();
  await methodPicker
    .getByRole('button', { name: /^Start Temperature tower/ })
    .click();
  await page
    .getByRole('group', { name: 'Step 3a — purpose' })
    .getByRole('button', { name: 'Continue to inputs' })
    .click();
  const inputs = page.getByRole('group', { name: 'Step 3b — inputs' });
  await inputs
    .getByRole('spinbutton', { name: /Nozzle temperature/ })
    .fill('220');
  await inputs.getByRole('button', { name: 'Start slicing' }).click();

  const wizard = page.getByTestId('filament-calibration-wizard');
  await expect(wizard.getByRole('status')).toHaveText(
    'Submitting the calibration slice request. Progress will appear when the job is accepted.',
  );
  expect(
    await getCalibrationFixtureCallCount(app, 'calibration:createProject'),
  ).toBe(1);
  expect(
    await getCalibrationFixtureCallCount(
      app,
      'calibration:cloneFilamentProfile',
    ),
  ).toBe(1);
  expect(
    await getCalibrationFixtureCallCount(
      app,
      'calibration:submitCalibrationSlice',
    ),
  ).toBe(1);
  await expectNoCalibrationSideEffectCalls();
  await scanSurface(page, {
    name: 'calibration wizard pending slice submission',
    present: wizard,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.slice-submitting',
    testInfo,
  );
});

test('@a11y filament calibration wizard presents a pending slice job accessibly', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    restoreWizardPhase: 'pollingSlice',
  });
  await openFilamentCalibrationWizard(page);
  const slicing = page.getByRole('group', { name: 'Step 4 — slicing' });
  await expect(
    slicing.getByRole('progressbar', { name: 'Slice progress' }),
  ).toBeVisible();
  await expect(slicing.getByRole('status')).toHaveText(
    'Waiting for the first status report.',
  );
  await scanSurface(page, {
    name: 'calibration wizard pending slice job',
    present: slicing,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.slice-progress',
    testInfo,
  );
});

test('@a11y filament calibration wizard keeps print dispatch explicitly gated', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    restoreWizardPhase: 'sliceReady',
  });
  await openFilamentCalibrationWizard(page);
  const sendStep = page.getByRole('group', {
    name: 'Step 5 — send to printer',
  });
  await expect(
    sendStep.getByText(/Starting a print moves the machine/),
  ).toBeVisible();
  await expect(
    sendStep.getByRole('button', { name: 'Upload gcode only (do not start)' }),
  ).toBeVisible();
  await expect(
    sendStep.getByRole('button', { name: 'Start the calibration print now' }),
  ).toBeDisabled();
  await expectNoCalibrationSideEffectCalls();
  await scanSurface(page, {
    name: 'calibration wizard print confirmation step',
    present: sendStep,
    testInfo,
  });
  await captureVisualScenario(page, 'calibration.wizard.slice-ready', testInfo);
});

test('@a11y filament calibration wizard collects measurements without writing them back', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    restoreWizardPhase: 'awaitingMeasurement',
  });
  await openFilamentCalibrationWizard(page);
  const measurement = page.getByRole('group', {
    name: 'Step 6 — measurement',
  });
  await expect(
    measurement.getByRole('spinbutton', {
      name: 'Nozzle temperature',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    measurement.getByRole('spinbutton', {
      name: 'Initial layer nozzle temperature',
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    measurement.getByRole('button', {
      name: 'Save measurement and continue',
    }),
  ).toBeVisible();
  await expectNoCalibrationSideEffectCalls();
  await scanSurface(page, {
    name: 'calibration wizard measurement step',
    present: measurement,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.awaiting-measurement',
    testInfo,
  );
});

// ---------------------------------------------------------------------------
// 2. Keyboard traversal
// ---------------------------------------------------------------------------

test('@a11y filament calibration dashboard is reachable by keyboard traversal', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);
  // Traversal starts from the app root (Escape returns focus to <body>
  // predictably in the packaged bundle).
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  const primary = page.getByRole('button', {
    name: 'Calibrate a filament spool',
  });
  const workspace = page.getByRole('main', {
    name: 'Filament calibration workspace',
  });
  await expectTabReaches(
    page,
    primary,
    'the "Calibrate a filament spool" primary CTA',
    80,
    workspace,
  );
});

test('@a11y filament calibration wizard printer picker is reachable by keyboard traversal', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, { printerList: 'populated' });
  await openFilamentCalibrationWizard(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  // Post-#773 the picker is a `<select aria-label="Printer">` with
  // `<optgroup>`-grouped options, not a radio group. The invariant this
  // test guards is unchanged: the picker must be reachable by keyboard
  // traversal from the CTA — proven here by tabbing to the combobox.
  const printerSelect = step1.getByRole('combobox', { name: 'Printer' });
  await expectTabReaches(
    page,
    printerSelect,
    'the printer picker combobox in the wizard Step 1',
    80,
    step1,
  );
});

// ---------------------------------------------------------------------------
// 3. Recovery states (dashboard)
// ---------------------------------------------------------------------------
//
// The three recovery states surviving under Path D each disable the primary
// CTA and announce a recovery message. This block asserts one positive arm
// per state PLUS a positive control (`availability: 'ok'`, online) where
// NONE of the recovery messages appear — without that discriminator, a
// fixture that always shows every message would pass every arm.

const RECOVERY_STATES: ReadonlyArray<{
  readonly label: string;
  readonly scenarioId: string;
  readonly scenario: Parameters<typeof applyCalibrationScenario>[2];
  readonly messagePattern: RegExp;
}> = [
  {
    label: 'offline',
    scenarioId: 'calibration.dashboard.offline',
    scenario: { offline: true },
    messagePattern:
      /Offline: filament calibration requires a live PrintFarmer connection/,
  },
  {
    label: 'missing scopes',
    scenarioId: 'calibration.dashboard.missing-scopes',
    scenario: { availability: 'missingScopes' },
    messagePattern: /Permission denied: calibration read, write, generation/,
  },
  {
    label: 'missing capability flags',
    scenarioId: 'calibration.dashboard.missing-capabilities',
    scenario: { availability: 'missingCapabilityFlags' },
    messagePattern: /Filament calibration is unavailable on this PrintFarmer/,
  },
];

for (const { label, scenarioId, scenario, messagePattern } of RECOVERY_STATES) {
  test(`@a11y filament calibration dashboard announces the ${label} recovery state and disables the primary CTA`, async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe('chromium');
    test.setTimeout(180_000);

    await applyCalibrationScenario(app, page, scenario);
    await openCalibrationWorkspace(page);

    const primary = page.getByRole('button', {
      name: 'Calibrate a filament spool',
    });
    await expect(primary).toBeVisible();
    await expect(primary).toBeDisabled();

    const alert = page.getByRole('alert').filter({ hasText: messagePattern });
    await expect(alert).toBeVisible();
    await scanSurface(page, {
      name: `filament calibration ${label} recovery alert`,
      present: alert,
      testInfo,
    });
    await captureVisualScenario(page, scenarioId, testInfo);
  });
}

test('@a11y filament calibration dashboard control: online + ok availability shows no recovery message and enables the primary CTA', async ({
  browserName,
}) => {
  // Positive control for the three recovery-state tests above. Without this
  // arm, a fixture that unconditionally returned "offline" would still pass
  // every "recovery message visible" assertion — the presence of the state
  // is only meaningful if we can also prove its ABSENCE.
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);

  const primary = page.getByRole('button', {
    name: 'Calibrate a filament spool',
  });
  await expect(primary).toBeVisible();
  await expect(primary).toBeEnabled();

  for (const { messagePattern } of RECOVERY_STATES) {
    await expect(
      page.getByRole('alert').filter({ hasText: messagePattern }),
    ).toHaveCount(0);
  }
});

const OTHER_DASHBOARD_REFUSALS: ReadonlyArray<{
  readonly label: string;
  readonly scenario: CalibrationScenario;
  readonly expectedCopy: string;
}> = [
  {
    label: 'no selected profile',
    scenario: { noProfile: true },
    expectedCopy: 'Select or create a PrintFarmer profile.',
  },
  {
    label: 'expired session',
    scenario: { availability: 'sessionExpired' },
    expectedCopy: 'Your PrintFarmer session expired or was revoked.',
  },
  {
    label: 'legacy server',
    scenario: { availability: 'legacyServer' },
    expectedCopy:
      'This profile points to a server without the calibration API.',
  },
  {
    label: 'server version',
    scenario: { availability: 'serverVersionTooLow' },
    expectedCopy: 'Update the selected PrintFarmer server before calibrating',
  },
  {
    label: 'unsupported firmware',
    scenario: { availability: 'unsupportedFirmware' },
    expectedCopy: 'PrintFarmer did not confirm compatible Klipper firmware',
  },
  {
    label: 'unsupported slicer',
    scenario: { availability: 'unsupportedSlicer' },
    expectedCopy: 'Upstream OrcaSlicer capability was not confirmed.',
  },
  {
    label: 'operator disabled',
    scenario: { availability: 'operatorDisabled' },
    expectedCopy: 'Filament calibration was disabled by the server operator.',
  },
];

test('@a11y filament calibration dashboard renders and scans remaining refusal states', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  const workspace = page.getByRole('main', {
    name: 'Filament calibration workspace',
  });
  for (const { label, scenario, expectedCopy } of OTHER_DASHBOARD_REFUSALS) {
    await applyCalibrationScenario(app, page, scenario);
    await openCalibrationWorkspace(page);
    await expect(
      page.getByRole('button', { name: 'Calibrate a filament spool' }),
    ).toBeDisabled();
    if (scenario.noProfile === true) {
      await expect(page.getByText(expectedCopy).first()).toBeVisible();
    } else {
      await expect(
        page.getByRole('alert').filter({ hasText: expectedCopy }),
      ).toBeVisible();
    }
    await scanSurface(page, {
      name: `calibration dashboard ${label} refusal`,
      present: workspace,
      testInfo,
    });
  }
  await captureVisualScenario(
    page,
    'calibration.dashboard.other-refusals',
    testInfo,
  );
});

test('@a11y server profile management dialog renders a synthetic profile', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);
  await page
    .getByRole('button', { name: 'Manage PrintFarmer profiles' })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Manage PrintFarmer connection',
  });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('A11y Test Server')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Test', exact: true }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'server profile management dialog',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.dialog-axe', testInfo);
  await dialog.getByRole('button', { name: 'Close server profiles' }).click();
  await expect(dialog).toHaveCount(0);
});

test('@a11y server profile dialog covers synthetic credential and recovery states', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  const openDialog = async () => {
    await openCalibrationWorkspace(page);
    await page
      .getByRole('button', { name: 'Manage PrintFarmer profiles' })
      .click();
  };
  const fillApiKeyDraft = async (dialog: Locator) => {
    await dialog.getByLabel('Profile name').fill('Synthetic Draft Server');
    await dialog
      .getByLabel('Server URL')
      .fill('https://synthetic.example.test');
    await dialog
      .getByRole('textbox', { name: 'Desktop API key' })
      .fill('synthetic-ui-fixture-only');
  };

  await applyCalibrationScenario(app, page, { serverProfileCount: 0 });
  await openDialog();
  let dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await expect(dialog.getByText('No server profiles saved yet.')).toBeVisible();
  await scanSurface(page, {
    name: 'empty server profile list',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.empty-list', testInfo);
  await dialog.getByRole('button', { name: 'Close server profiles' }).click();

  await applyCalibrationScenario(app, page, {
    serverProfileCount: 0,
    serverProfileActionFailure: 'list',
  });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await expect(page.locator('.statusbar-error')).toContainText(
    'Synthetic server profile list failure.',
  );
  await scanSurface(page, {
    name: 'server profile list error',
    present: page.locator('body'),
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.list-error', testInfo);
  await dialog.getByRole('button', { name: 'Close server profiles' }).click();

  await applyCalibrationScenario(app, page, {
    serverProfileCount: 0,
    serverProfileActionDelayMs: 6_000,
  });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await fillApiKeyDraft(dialog);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Checking...' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'pending synthetic server profile test',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.test-pending', testInfo);
  await expect(dialog.getByText('Connection successful')).toBeVisible();
  await scanSurface(page, {
    name: 'successful synthetic server profile test',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.test-success', testInfo);
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  dialog = page.getByRole('dialog', { name: 'Manage PrintFarmer connection' });
  await expect(dialog.getByText('Synthetic Draft Server')).toBeVisible();
  await scanSurface(page, {
    name: 'saved synthetic API-key profile',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.api-key-saved', testInfo);

  await applyCalibrationScenario(app, page, { serverProfileCount: 0 });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await dialog.getByLabel('Profile name').fill('Synthetic Password Server');
  await dialog.getByLabel('Server URL').fill('https://synthetic.example.test');
  await dialog.getByLabel('Authentication').selectOption('password');
  await dialog
    .getByRole('textbox', { name: 'Username or email' })
    .fill('fixture-user');
  await dialog
    .getByRole('textbox', { name: 'Password' })
    .fill('synthetic-ui-fixture-only');
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('Connection successful')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save profile' }).click();
  dialog = page.getByRole('dialog', { name: 'Manage PrintFarmer connection' });
  await expect(dialog.getByText('Synthetic Draft Server')).toBeVisible();
  await scanSurface(page, {
    name: 'saved synthetic username-password profile',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'server-profiles.password-draft-saved',
    testInfo,
  );

  await applyCalibrationScenario(app, page, {
    serverProfileCount: 0,
    serverProfileTestResult: 'legacy',
  });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await fillApiKeyDraft(dialog);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByText('Legacy server detected')).toBeVisible();
  const saveButton = dialog.getByRole('button', { name: 'Save profile' });
  await expect(saveButton).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Save in legacy mode/ }).check();
  await expect(saveButton).toBeEnabled();
  await scanSurface(page, {
    name: 'explicit legacy profile consent',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.legacy-consent', testInfo);
  await saveButton.click();
  dialog = page.getByRole('dialog', { name: 'Manage PrintFarmer connection' });
  await expect(dialog.getByText('Synthetic Draft Server')).toBeVisible();

  await applyCalibrationScenario(app, page, {
    serverProfileCount: 0,
    serverProfileActionFailure: 'test',
  });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await fillApiKeyDraft(dialog);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic server profile test failure.',
  );
  await scanSurface(page, {
    name: 'synthetic server profile connection test error',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.test-error', testInfo);

  await applyCalibrationScenario(app, page, {
    serverProfileCount: 1,
    serverProfileActionFailure: 'test',
  });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Manage PrintFarmer connection' });
  await dialog.getByRole('button', { name: 'Test', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic server profile test failure.',
  );
  await scanSurface(page, {
    name: 'saved server profile retest error',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'server-profiles.saved-retest-error',
    testInfo,
  );

  await applyCalibrationScenario(app, page, { serverProfileCount: 2 });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Manage PrintFarmer connection' });
  const backupCard = dialog
    .locator('.profile-card')
    .filter({ hasText: 'A11y Backup Server' });
  await backupCard.getByRole('button', { name: 'Select' }).click();
  await expect(backupCard).toHaveClass(/selected/);
  await scanSurface(page, {
    name: 'selected synthetic server profile',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.select', testInfo);
  await backupCard
    .getByRole('button', { name: 'Remove A11y Backup Server' })
    .click();
  await expect(backupCard).toHaveCount(0);
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await expect(dialog.getByText('A11y Test Server')).toBeVisible();
  await scanSurface(page, {
    name: 'removed synthetic server profile',
    present: dialog,
    testInfo,
  });
  await captureVisualScenario(page, 'server-profiles.remove', testInfo);

  await applyCalibrationScenario(app, page, {
    serverProfileCount: 0,
    serverProfileActionDelayMs: 1_000,
  });
  await openDialog();
  dialog = page.getByRole('dialog', { name: 'Connect to PrintFarmer' });
  await fillApiKeyDraft(dialog);
  await dialog.getByRole('button', { name: 'Test connection' }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.waitForTimeout(1_200);
  await expect(page.getByText('Connection successful')).toHaveCount(0);
  await scanSurface(page, {
    name: 'closed server profile dialog ignores stale test completion',
    present: page.locator('body'),
    testInfo,
  });
  await captureVisualScenario(
    page,
    'server-profiles.stale-close-completion',
    testInfo,
  );
});

test('@a11y authority bar reports connection modes and insecure transport', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  const authorityBar = page.getByRole('region', {
    name: 'PrintFarmer server',
  });
  const modes = [
    {
      label: 'modern connected',
      scenario: { serverProfileMode: 'modern' as const },
      expected: /Manage connection: A11y Test Server, 2\.0, Status: Connected/,
    },
    {
      label: 'legacy',
      scenario: { serverProfileMode: 'legacy' as const },
      expected:
        /Manage connection: A11y Test Server, Legacy server, Status: Legacy fallback/,
    },
    {
      label: 'connection error',
      scenario: { serverProfileMode: 'error' as const },
      expected:
        /Manage connection: A11y Test Server, 2\.0, Status: Connection error/,
    },
    {
      label: 'insecure HTTP',
      scenario: { serverProfileMode: 'insecureHttp' as const },
      expected: /Manage connection: A11y Test Server, 2\.0, Status: Connected/,
    },
    {
      label: 'no selected server',
      scenario: { noProfile: true },
      expected:
        /Connect to PrintFarmer: No server selected yet, Status: Disconnected/,
    },
  ];

  for (const mode of modes) {
    await applyCalibrationScenario(app, page, mode.scenario);
    await expect(authorityBar).toBeVisible();
    await expect(authorityBar.getByRole('button')).toHaveAccessibleName(
      mode.expected,
    );
    if (mode.label === 'insecure HTTP') {
      await expect(authorityBar).toContainText(
        'HTTP connection is not encrypted',
      );
    }
    await scanSurface(page, {
      name: `authority bar ${mode.label}`,
      present: authorityBar,
      testInfo,
    });
  }

  await captureVisualScenario(
    page,
    'shell.authority-bar.profile-connectivity-modes',
    testInfo,
  );
});

test('@a11y workspace rail and status bar announce synthetic queue and source state', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, {
    uploadJobs: [queuedUploadJob()],
  });
  const rail = page.locator('nav.workspace-rail');
  const uploads = rail
    .locator('button.rail-item')
    .filter({ hasText: 'Uploads' });
  const sources = rail
    .locator('button.rail-item')
    .filter({ hasText: 'Sources' });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await expect(uploads).toHaveAttribute('aria-current', 'page');
  await expect(uploads).toContainText('1 upload remaining');
  await expect(sources).toContainText('1 source needs attention');

  const statusBar = page.getByRole('contentinfo', {
    name: 'Application status',
  });
  await expect(statusBar).toContainText('1 upload remaining');
  await expect(statusBar).toContainText('1 source needs attention');
  await expect(statusBar).toContainText('A11y Test Server');
  await expect(statusBar).toContainText(/v\d/);
  await scanSurface(page, {
    name: 'application status bar with synthetic upload and offline source',
    present: statusBar,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'shell.status-bar.activity-transfer-source-server-build',
    testInfo,
  );

  await page
    .getByRole('region', { name: 'PrintFarmer server' })
    .getByRole('button')
    .click();
  const profileDialog = page.getByRole('dialog', {
    name: 'Manage PrintFarmer connection',
  });
  await expect(profileDialog).toBeVisible();
  await expect(uploads).toBeDisabled();
  await expect(sources).toBeDisabled();
  await expect(uploads).toHaveAttribute('aria-current', 'page');
  await expect(uploads).toHaveAttribute(
    'aria-describedby',
    'workspace-switch-explanation',
  );
  await expect(uploads).toContainText('1 upload remaining');
  await scanSurface(page, {
    name: 'workspace rail with disabled routes and count badges',
    present: profileDialog,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'shell.workspace-rail.active-disabled-count-badges',
    testInfo,
  );
});

test('@a11y uploads workspace renders empty and duplicate-risk queue states', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  const uploadQueue = page.getByRole('main', { name: 'Upload queue' });
  await applyCalibrationScenario(app, page, { uploadJobs: [] });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await expect(uploadQueue).toBeVisible();
  await expect(uploadQueue.getByText('Nothing queued')).toBeVisible();
  await scanSurface(page, {
    name: 'empty upload queue',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.empty-queue', testInfo);

  await applyCalibrationScenario(app, page, {
    uploadJobs: [duplicateRiskUploadJob()],
  });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await expect(uploadQueue).toBeVisible();
  await expect(uploadQueue).toContainText(
    'Legacy server: thumbnails are generated by the server.',
  );
  await expect(uploadQueue).toContainText('1 uncertain');
  await expect(
    uploadQueue.getByRole('button', {
      name: 'Confirm duplicate risk and upload',
    }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'legacy upload duplicate-risk queue',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.duplicate-risk', testInfo);
});

test('@a11y uploads workspace renders lifecycle and mocked recovery transitions', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  const uploadQueue = page.getByRole('main', { name: 'Upload queue' });
  await applyCalibrationScenario(app, page, {
    uploadJobs: [uploadLifecycleMatrixJob()],
    uploadActionDelayMs: 5_000,
    uploadActionDelayAction: 'pause',
  });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await expect(uploadQueue).toBeVisible();
  for (const label of [
    'queued',
    'uploading',
    'succeeded',
    'failed',
    'cancelled',
    'already uploaded',
  ]) {
    await expect(uploadQueue.getByText(label, { exact: true })).toHaveCount(1);
  }
  await expect(uploadQueue.getByText('uncertain', { exact: true })).toHaveCount(
    2,
  );
  await scanSurface(page, {
    name: 'upload queue lifecycle matrix',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.lifecycle-matrix', testInfo);

  await uploadQueue.getByRole('button', { name: 'Pause' }).click();
  await expect(uploadQueue.getByRole('status')).toHaveText(
    'Updating upload queue.',
  );
  await expect(
    uploadQueue.getByRole('button', { name: 'Pause' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'upload queue action pending',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.action-pending', testInfo);
  await expect(
    uploadQueue.getByRole('button', { name: 'Resume' }),
  ).toBeVisible();
  await expect(uploadQueue.getByRole('status')).toHaveText(
    '2 paused; 2 succeeded, 1 failed, 2 uncertain, 1 cancelled.',
  );
  await scanSurface(page, {
    name: 'paused upload queue',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.paused-state', testInfo);

  await uploadQueue.getByRole('button', { name: 'Resume' }).click();
  await expect(
    uploadQueue.getByRole('button', { name: 'Pause' }),
  ).toBeVisible();
  await uploadQueue.getByRole('button', { name: 'Cancel remaining' }).click();
  await expect(uploadQueue.getByRole('status')).toHaveText(
    '2 succeeded, 1 failed, 2 uncertain, 3 cancelled.',
  );
  await scanSurface(page, {
    name: 'cancelled upload remainder',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.cancelled-remainder', testInfo);

  await uploadQueue.getByRole('button', { name: 'Retry incomplete' }).click();
  await expect(uploadQueue.getByRole('status')).toHaveText(
    '5 queued; 2 succeeded, 1 uncertain.',
  );
  await scanSurface(page, {
    name: 'upload retry recovery',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.retry-recovery', testInfo);

  await applyCalibrationScenario(app, page, {
    uploadJobs: [duplicateRiskUploadJob()],
  });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await uploadQueue
    .getByRole('button', { name: 'Confirm duplicate risk and upload' })
    .click();
  await expect(uploadQueue.getByRole('status')).toHaveText('1 queued.');
  await expect(
    uploadQueue.getByRole('button', {
      name: 'Confirm duplicate risk and upload',
    }),
  ).toHaveCount(0);
  await scanSurface(page, {
    name: 'confirmed synthetic legacy retry',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.legacy-retry-confirmed', testInfo);

  await applyCalibrationScenario(app, page, {
    uploadJobs: [completedUploadJob()],
  });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await uploadQueue.getByRole('button', { name: 'Remove' }).click();
  await expect(uploadQueue.getByText('Nothing queued')).toBeVisible();
  await scanSurface(page, {
    name: 'removed completed synthetic upload',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.completed-removed', testInfo);

  await applyCalibrationScenario(app, page, {
    uploadJobs: [retryableUploadJob()],
    uploadActionFailure: 'retry',
  });
  await page.getByRole('button', { name: /^Uploads/ }).click();
  await uploadQueue.getByRole('button', { name: 'Retry incomplete' }).click();
  await expect(uploadQueue.getByRole('alert')).toContainText(
    'Synthetic upload retry failure.',
  );
  await scanSurface(page, {
    name: 'upload retry failure and backup recovery action',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.retry-error', testInfo);
  await uploadQueue
    .getByRole('button', { name: 'Reset queue (keep backup)' })
    .click();
  await expect(uploadQueue.getByText('Nothing queued')).toBeVisible();
  await scanSurface(page, {
    name: 'upload queue reset after synthetic error',
    present: uploadQueue,
    testInfo,
  });
  await captureVisualScenario(page, 'uploads.reset-recovery', testInfo);
});

test('@a11y library short and expanded errors retain retry and dismiss actions', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {
    libraryError: 'Synthetic catalog read failed.',
  });
  const shortError = page
    .getByRole('alert')
    .filter({ hasText: 'Synthetic catalog read failed.' });
  await expect(shortError).toBeVisible();
  await expect(shortError.getByText('Error details')).toHaveCount(0);
  await expect(shortError.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(
    shortError.getByRole('button', { name: 'Dismiss library error' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'short library error',
    present: shortError,
    testInfo,
  });

  const longErrorMessage = `Synthetic catalog failure: ${'fixture detail '.repeat(24)}`;
  await applyCalibrationScenario(app, page, { libraryError: longErrorMessage });
  const longError = page
    .getByRole('alert')
    .filter({ hasText: 'Synthetic catalog failure:' });
  await expect(longError).toBeVisible();
  await longError.getByText('Error details', { exact: true }).click();
  await expect(longError.locator('pre')).toContainText(longErrorMessage);
  await expect(longError.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(
    longError.getByRole('button', { name: 'Dismiss library error' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'expanded long library error',
    present: longError,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'library.error-details.compact-long-retry-dismiss',
    testInfo,
  );
});

// ---------------------------------------------------------------------------
// 4. Reduced motion, dark theme, 200% zoom
// ---------------------------------------------------------------------------

/*
 * The dark-theme half asserts what the pre-#756 version asserted, and for the
 * same reason: there are no `prefers-color-scheme` rules in this codebase, so
 * emulating `colorScheme: 'dark'` does not select a dark theme (there is no
 * dark theme to select). What it does assert is narrower and still worth
 * having: an axe contrast regression guard that runs with the dark preference
 * set, so if a dark theme is added later, contrast failures surface here
 * rather than at a user.
 */

test('@a11y filament calibration wizard Step 1 holds up under reduced motion, dark theme, and 200% zoom', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await applyCalibrationScenario(app, page, {});
  await openFilamentCalibrationWizard(page);
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(
    step1,
    'the wizard Step 1 did not render under reduced motion',
  ).toBeVisible();
  const animated = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.calibration-workspace *'))
        .map((node) => {
          const style = getComputedStyle(node);
          return {
            animation: style.animationDuration,
            transition: style.transitionDuration,
          };
        })
        .filter(
          (durations) =>
            parseFloat(durations.animation) > 0.05 ||
            parseFloat(durations.transition) > 0.05,
        ).length,
  );
  expect(
    animated,
    'elements still animate for longer than 50ms under prefers-reduced-motion: reduce',
  ).toBe(0);

  await scanSurface(page, {
    name: 'filament calibration wizard Step 1 with reduced motion',
    present: step1,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'layout.theme.reduced-motion-selected',
    testInfo,
  );

  const darkCanvas = await page
    .locator('.app-root')
    .evaluate((element) =>
      getComputedStyle(element).getPropertyValue('--canvas').trim(),
    );
  expect(darkCanvas).toBe('#11151a');
  await captureVisualScenario(
    page,
    'layout.theme.dark-theme-profile',
    testInfo,
  );

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await scanSurface(page, {
    name: 'filament calibration wizard Step 1 in dark theme',
    present: step1,
    testInfo,
  });

  await page.emulateMedia({ colorScheme: 'light' });
  const viewport = page.viewportSize();
  if (viewport !== null) {
    // Emulate 200% zoom by halving the viewport in CSS pixels — Playwright
    // does not expose a browser-native zoom, but the axe scan runs against
    // the produced layout, which is what WCAG 1.4.10 (Reflow) is about.
    await page.setViewportSize({
      width: Math.floor(viewport.width / 2),
      height: Math.floor(viewport.height / 2),
    });
    try {
      await expect(
        step1,
        'the wizard Step 1 did not render at 200% zoom',
      ).toBeVisible();
      const zoomBuilder = new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(WCAG_TAGS);
      const zoomResults = await zoomBuilder.analyze();
      const materialZoomViolations = zoomResults.violations.filter(
        (violation) =>
          typeof violation.impact === 'string' &&
          ['moderate', 'serious', 'critical'].includes(violation.impact),
      );
      if (materialZoomViolations.length > 0) {
        await testInfo.attach('axe-filament-wizard-zoom.json', {
          body: Buffer.from(JSON.stringify(materialZoomViolations, null, 2)),
          contentType: 'application/json',
        });
      }
      expect(
        materialZoomViolations,
        'filament wizard Step 1 has material WCAG A/AA violations at 200% zoom',
      ).toEqual([]);
      await applyPinnedRenderingProfile(
        page,
        'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1',
      );
      await scanSurface(page, {
        name: 'filament calibration wizard Step 1 at the 200% viewport proxy',
        present: step1,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'layout.theme.200-percent-viewport-proxy',
        testInfo,
      );
    } finally {
      await page.setViewportSize(viewport);
    }
  }
});

function duplicateRiskUploadJob(): UploadJob {
  const timestamp = '2026-07-29T10:00:00.000Z';
  return {
    id: 'b2222222-2222-4222-8222-222222222222',
    profileId: 'f1111111-1111-4111-8111-111111111111',
    profileName: 'A11y Test Server',
    profileRevision: 'synthetic-revision',
    serverBinding: 'synthetic-binding',
    mode: 'legacyModelOnly',
    state: 'attention',
    paused: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    items: [
      {
        id: 'b3333333-3333-4333-8333-333333333333',
        hash: 'a'.repeat(64),
        clientUploadId: 'b4444444-4444-4444-8444-444444444444',
        displayName: 'synthetic-model.stl',
        size: 100,
        state: 'uncertain',
        bytesSent: 42,
        attempts: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        remote: null,
        error: {
          code: 'LEGACY_UPLOAD_UNCERTAIN',
          message: 'A previous transfer may have reached the server.',
          retryable: false,
          retryAfterSeconds: null,
          duplicateRisk: true,
        },
      },
    ],
    totalBytes: 100,
    bytesSent: 42,
    summary: {
      queued: 0,
      uploading: 0,
      succeeded: 0,
      failed: 0,
      cancelled: 0,
      uncertain: 1,
    },
  };
}

function queuedUploadJob(): UploadJob {
  const job = duplicateRiskUploadJob();
  return {
    ...job,
    state: 'running',
    bytesSent: 30,
    items: job.items.map((item) => ({
      ...item,
      state: 'uploading',
      bytesSent: 30,
      error: null,
    })),
    summary: {
      ...job.summary,
      queued: 0,
      uploading: job.items.length,
      uncertain: 0,
    },
  };
}

function uploadLifecycleMatrixJob(): UploadJob {
  const timestamp = '2026-07-29T10:00:00.000Z';
  const definitions: Array<{
    state: UploadJob['items'][number]['state'];
    name: string;
    retryable?: boolean;
    duplicateRisk?: boolean;
    alreadyUploaded?: boolean;
  }> = [
    { state: 'queued', name: 'queued-model.stl' },
    { state: 'uploading', name: 'uploading-model.stl' },
    { state: 'succeeded', name: 'succeeded-model.stl' },
    {
      state: 'failed',
      name: 'failed-model.stl',
      retryable: true,
    },
    {
      state: 'cancelled',
      name: 'cancelled-model.stl',
      retryable: true,
    },
    {
      state: 'uncertain',
      name: 'uncertain-model.stl',
      retryable: true,
    },
    {
      state: 'succeeded',
      name: 'already-uploaded-model.stl',
      alreadyUploaded: true,
    },
    {
      state: 'uncertain',
      name: 'legacy-risk-model.stl',
      duplicateRisk: true,
    },
  ];
  const items = definitions.map((definition, index) => {
    const suffix = String(index + 1).padStart(12, '0');
    const clientUploadId = `d4444444-4444-4444-8444-${suffix}`;
    const completed = definition.state === 'succeeded';
    return {
      id: `d3333333-3333-4333-8333-${suffix}`,
      hash: (index + 1).toString(16).padStart(64, '0'),
      clientUploadId,
      displayName: definition.name,
      size: 100,
      state: definition.state,
      bytesSent:
        definition.state === 'queued'
          ? 0
          : definition.state === 'uploading'
            ? 40
            : completed
              ? 100
              : 25,
      attempts: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      remote:
        completed && !definition.alreadyUploaded
          ? {
              id: `synthetic-remote-${index + 1}`,
              name: definition.name,
              fileName: definition.name,
              fileSize: 100,
              fileType: 'model/stl',
              uploadedAt: timestamp,
              url: '',
              thumbnailUrl: null,
              wasExisting: false,
              clientUploadId,
              etag: null,
            }
          : null,
      error:
        definition.retryable || definition.duplicateRisk
          ? {
              code: definition.duplicateRisk
                ? 'LEGACY_UPLOAD_UNCERTAIN'
                : 'SYNTHETIC_RETRYABLE_FAILURE',
              message: definition.duplicateRisk
                ? 'A previous transfer may have reached the server.'
                : 'Synthetic transfer stopped before completion.',
              retryable: definition.retryable ?? false,
              retryAfterSeconds: null,
              duplicateRisk: definition.duplicateRisk ?? false,
            }
          : null,
    };
  });
  const summary = {
    queued: 0,
    uploading: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
    uncertain: 0,
  };
  for (const item of items) summary[item.state] += 1;
  return {
    id: 'b2222222-2222-4222-8222-222222222222',
    profileId: 'f1111111-1111-4111-8111-111111111111',
    profileName: 'A11y Test Server',
    profileRevision: 'synthetic-revision',
    serverBinding: 'synthetic-binding',
    mode: 'modern',
    state: 'attention',
    paused: false,
    createdAt: timestamp,
    updatedAt: timestamp,
    items,
    totalBytes: items.reduce((total, item) => total + item.size, 0),
    bytesSent: items.reduce((total, item) => total + item.bytesSent, 0),
    summary,
  };
}

function completedUploadJob(): UploadJob {
  const job = uploadLifecycleMatrixJob();
  job.items = [job.items.find((item) => item.state === 'succeeded')!];
  job.summary = {
    queued: 0,
    uploading: 0,
    succeeded: 1,
    failed: 0,
    cancelled: 0,
    uncertain: 0,
  };
  job.state = 'completed';
  job.totalBytes = 100;
  job.bytesSent = 100;
  return job;
}

function retryableUploadJob(): UploadJob {
  const job = uploadLifecycleMatrixJob();
  job.items = [job.items.find((item) => item.state === 'failed')!];
  job.summary = {
    queued: 0,
    uploading: 0,
    succeeded: 0,
    failed: 1,
    cancelled: 0,
    uncertain: 0,
  };
  job.state = 'partialFailure';
  job.totalBytes = 100;
  job.bytesSent = 25;
  return job;
}
