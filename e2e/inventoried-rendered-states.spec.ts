import { expect, test, type ElectronApplication } from '@playwright/test';
import { rmSync } from 'node:fs';
import {
  applyCalibrationScenario,
  getCalibrationFixtureCallCount,
  launchCalibrationApp,
  openFilamentCalibrationWizard,
  scanSurface,
} from './helpers/calibrationA11yFixture';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage.js';

let app: ElectronApplication | null = null;
let stateRoot: string | null = null;

test.afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = null;
    if (stateRoot !== null) {
      rmSync(stateRoot, { recursive: true, force: true });
      stateRoot = null;
    }
  }
});

async function launchScenario(
  browserName: string,
  scenario: Parameters<typeof applyCalibrationScenario>[2],
) {
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  await applyPinnedRenderingProfile(launched.page);
  await applyCalibrationScenario(app, launched.page, scenario);
  const maybeLater = launched.page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  return launched.page;
}

test('active source scan remains announced in Settings and Library', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    sourceScanDelayMs: 8_000,
  });
  await page.getByRole('button', { name: /^Settings/ }).click();
  const sources = page.getByRole('region', {
    name: 'Source folders',
    exact: true,
  });
  const root = page.getByRole('list', { name: 'Source folders' }).locator('li');
  await expect(root).toContainText('a11y-models');
  await root.getByRole('button', { name: 'Reconnect' }).click();
  await expect(sources).toHaveAttribute('aria-busy', 'true');
  const sourceProgress = sources
    .getByRole('status')
    .filter({ hasText: 'Scanning source' });
  await expect(sourceProgress).toContainText(
    'Reconnecting /fixtures/a11y-models',
  );
  await scanSurface(page, {
    name: 'Settings active source scan',
    present: sourceProgress,
    testInfo,
  });
  await captureVisualScenario(page, 'sources.active-scanning', testInfo);

  await page.getByRole('button', { name: 'Library', exact: true }).click();
  const library = page.getByRole('main', { name: 'Model library' });
  const liveStatus = library.locator('.library-live-status');
  await expect(liveStatus).toHaveAttribute('aria-busy', 'true');
  await expect(liveStatus).toContainText('Reconnecting /fixtures/a11y-models');
  await scanSurface(page, {
    name: 'Library active source scan',
    present: library,
    testInfo,
  });
  await captureVisualScenario(page, 'library.home.active-scanning', testInfo);
});

test('ambiguous import collection suggestions block until an identity is selected', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    importAmbiguityFixture: true,
  });
  await page.getByRole('button', { name: /^Settings/ }).click();
  await page
    .getByRole('region', { name: 'Source folders', exact: true })
    .getByRole('button', { name: 'Add source folder' })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Organize models before importing',
  });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Folder organization for Animals' })
    .selectOption('collection');
  const picker = dialog.getByRole('combobox', {
    name: 'Choose collection for Animals',
  });
  await expect(picker).toHaveValue('__unresolved__');
  await expect(picker).toHaveAttribute('aria-invalid', 'true');
  await expect(picker.locator('option')).toHaveCount(4);
  const importButton = dialog.getByRole('button', {
    name: 'Import 2 files',
  });
  await expect(importButton).toBeDisabled();
  await scanSurface(page, {
    name: 'ambiguous import collection target',
    present: dialog,
    include: '[role="dialog"]',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.import-review.ambiguous-collection-guard',
    testInfo,
  );
  await picker.selectOption('synthetic-animals-two');
  await expect(picker).toHaveValue('synthetic-animals-two');
  await expect(importButton).toBeEnabled();
  await expect(dialog.getByRole('alert')).toHaveCount(0);
});

test('cache settings loading and failure feedback remain visible and accessible', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    thumbnailCacheLoadPending: true,
  });
  await page.getByRole('button', { name: /^Settings/ }).click();
  const dialog = page.getByRole('region', {
    name: 'Thumbnail cache',
    exact: true,
  });
  await expect(dialog.getByText('Loading cache settings…')).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Clear cached thumbnails…' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'thumbnail cache settings loading',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.loading',
    testInfo,
  );
});

test('cache settings load failure is announced without enabling destructive actions', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    thumbnailCacheLoadFailure: true,
  });
  await page.getByRole('button', { name: /^Settings/ }).click();
  const dialog = page.getByRole('region', {
    name: 'Thumbnail cache',
    exact: true,
  });
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic cache settings load failure.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Clear cached thumbnails…' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'thumbnail cache settings load failure',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.load-error',
    testInfo,
  );
});

test('organization deletion review reports local and synced effects before confirmation', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    organizationReviewFixture: true,
  });
  await page.getByRole('button', { name: /^Tags & Collections/ }).click();
  const organization = page.getByRole('main', {
    name: 'Tags and collections',
  });
  await expect(organization).toBeVisible();
  await organization
    .getByRole('checkbox', { name: 'Select all shown collections' })
    .check();
  await organization.getByRole('button', { name: 'Review deletion…' }).click();
  const review = organization.getByRole('alert').filter({
    hasText: 'Delete 2 collections?',
  });
  await expect(review).toContainText(
    '5 model assignments will be removed. The models themselves stay in the library.',
  );
  await expect(review).toContainText(
    '1 synced collection will also be deleted on PrintFarmer at the next sync.',
  );
  await expect(review).toContainText('Local collection');
  await expect(review).toContainText('Synced collection');
  await scanSurface(page, {
    name: 'organization synced deletion review',
    present: review,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'organization.workspace.delete-review-synced-effects',
    testInfo,
  );
  await review.getByRole('button', { name: 'Keep collections' }).click();
  await expect(review).toHaveCount(0);
});

test('profile selection explains the administrator-only machine catalog gap', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    profileCatalog: true,
    profileCatalogAdminNotice: true,
  });
  await openFilamentCalibrationWizard(page);
  await page
    .getByRole('combobox', { name: 'Printer' })
    .selectOption({ label: 'A11y Fixture Printer — A11y Reference Klipper' });
  const selection = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  const notice = selection.getByRole('status').filter({
    hasText: 'No machine profiles are available for this printer.',
  });
  await expect(notice).toContainText(
    'Creating profiles requires slicer-admin permission',
  );
  await expect(
    notice.getByRole('button', { name: 'Reload profiles' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'administrator-only machine profile notice',
    present: selection,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.printer-profile-selection.admin-import-notice',
    testInfo,
  );
});

test('method progress sync failure is announced, blocks skip, and recovers on retry', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    methodProgressFailureOnce: true,
    restoreWizardPhase: 'methodPicker',
  });
  await openFilamentCalibrationWizard(page);
  const methodPicker = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  const error = methodPicker.getByRole('status').filter({
    hasText: "Couldn't read step status from the server.",
  });
  await expect(error).toBeVisible();
  const skip = methodPicker.getByRole('button', {
    name: 'Skip Temperature tower',
  });
  await expect(skip).toBeDisabled();
  await scanSurface(page, {
    name: 'method progress sync error',
    present: methodPicker,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.spool-methods.method-progress-sync-error',
    testInfo,
  );

  await error.getByRole('button', { name: 'Retry sync' }).click();
  await expect(error).toHaveCount(0);
  await expect(
    getCalibrationFixtureCallCount(app!, 'calibration:getMethodProgress'),
  ).resolves.toBeGreaterThanOrEqual(2);
  await expect(skip).toBeEnabled();
});

test('clone request exposes its pending state without creating a real profile', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    profileCatalog: true,
    sliceSubmissionPending: true,
    cloneRequestPending: true,
  });
  await openFilamentCalibrationWizard(page);
  await page
    .getByRole('combobox', { name: 'Printer' })
    .selectOption({ label: 'A11y Fixture Printer — A11y Reference Klipper' });
  await page.getByRole('combobox', { name: 'Machine profile' }).selectOption({
    index: 1,
  });
  await page.getByRole('combobox', { name: 'Process profile' }).selectOption({
    index: 1,
  });
  await page.getByRole('combobox', { name: 'Filament profile' }).selectOption({
    index: 1,
  });
  await page.getByRole('button', { name: 'Next — name the clone' }).click();
  const cloneStep = page.getByRole('group', {
    name: 'Step 2 — name the clone',
  });
  const clone = cloneStep.getByRole('button', {
    name: 'Clone this filament profile',
  });
  await clone.click();
  await expect(
    cloneStep.getByRole('button', { name: 'Cloning…' }),
  ).toBeDisabled();
  await expect(
    getCalibrationFixtureCallCount(app!, 'calibration:cloneFilamentProfile'),
  ).resolves.toBe(1);
  await scanSurface(page, {
    name: 'filament profile clone pending',
    present: cloneStep,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.clone-pending',
    testInfo,
  );
});

test('upload-only request exposes pending feedback through synthetic IPC', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    restoreWizardPhase: 'sliceReady',
    sendRequestPending: true,
  });
  await openFilamentCalibrationWizard(page);
  const sendStep = page.getByRole('group', {
    name: 'Step 5 — send to printer',
  });
  await sendStep
    .getByRole('button', { name: 'Upload gcode only (do not start)' })
    .click();
  const wizard = page.getByTestId('filament-calibration-wizard');
  await expect(wizard.getByRole('status')).toHaveText('Working…');
  await expect(
    getCalibrationFixtureCallCount(app!, 'calibration:sendSliceToPrinter'),
  ).resolves.toBe(1);
  await expect(sendStep).toHaveCount(0);
  await scanSurface(page, {
    name: 'upload-only request pending',
    present: wizard,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.send-pending',
    testInfo,
  );
});

test('measurement write-back exposes pending feedback through synthetic IPC', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    restoreWizardPhase: 'awaitingMeasurement',
    measurementWritePending: true,
  });
  await openFilamentCalibrationWizard(page);
  const measurement = page.getByRole('group', {
    name: 'Step 6 — measurement',
  });
  await measurement
    .getByRole('spinbutton', {
      name: 'Nozzle temperature',
      exact: true,
    })
    .fill('220');
  await measurement
    .getByRole('spinbutton', { name: 'Initial layer nozzle temperature' })
    .fill('220');
  await measurement
    .getByRole('button', { name: 'Save measurement and continue' })
    .click();
  const wizard = page.getByTestId('filament-calibration-wizard');
  await expect(wizard.getByRole('status')).toHaveText('Working…');
  await expect(
    getCalibrationFixtureCallCount(
      app!,
      'calibration:updateFilamentProfileMeasurement',
    ),
  ).resolves.toBe(1);
  await scanSurface(page, {
    name: 'measurement write-back pending',
    present: wizard,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.writeback-pending',
    testInfo,
  );
});

test('completion failure keeps the synthetic wizard available for retry', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const page = await launchScenario(browserName, {
    completionFailure: true,
    methodVariants: true,
    restoreWizardPhase: 'methodPicker',
  });
  await openFilamentCalibrationWizard(page);
  const methodPicker = page.getByRole('group', {
    name: 'Step 3 — calibration method',
  });
  const finish = methodPicker.getByRole('button', {
    name: 'Finish calibration',
  });
  await expect(finish).toBeEnabled();
  await finish.click();
  const error = page.getByRole('alert').filter({
    hasText: 'The calibration could not be marked complete.',
  });
  await expect(error).toContainText('Synthetic project completion failure.');
  await expect(finish).toBeEnabled();
  await expect(
    getCalibrationFixtureCallCount(
      app!,
      'calibration:completeCalibrationProject',
    ),
  ).resolves.toBe(1);
  await scanSurface(page, {
    name: 'calibration completion failure and retry',
    present: methodPicker,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'calibration.wizard.completion-retry',
    testInfo,
  );
});
