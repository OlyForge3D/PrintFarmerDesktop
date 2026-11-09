import { expect, test, type ElectronApplication } from '@playwright/test';
import { rmSync } from 'node:fs';
import {
  applyCalibrationScenario,
  launchCalibrationApp,
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

test('keeps Library open when the synthetic folder picker is canceled', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  const page = launched.page;
  await applyPinnedRenderingProfile(page);
  await applyCalibrationScenario(app, page, {
    importCancellationFixture: 'picker-cancel',
  });

  const library = page.getByRole('main', { name: 'Model library' });
  await expect(library).toBeVisible();
  await page.getByRole('button', { name: 'Add folder', exact: true }).click();
  await expect(library).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Organize models before importing' }),
  ).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await scanSurface(page, {
    name: 'folder picker canceled before import review',
    present: library,
    include: 'main[aria-label="Model library"]',
    testInfo,
  });
  await captureVisualScenario(page, 'library.home.picker-cancel', testInfo);
});

test('cancels synthetic import review without importing files', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  const page = launched.page;
  await applyPinnedRenderingProfile(page);
  await applyCalibrationScenario(app, page, {
    importCancellationFixture: 'review-cancel',
  });

  const library = page.getByRole('main', { name: 'Model library' });
  await expect(library).toBeVisible();
  await page.getByRole('button', { name: 'Add folder', exact: true }).click();
  const importReview = page.getByRole('dialog', {
    name: 'Organize models before importing',
  });
  await expect(importReview).toBeVisible();
  await expect(
    importReview.getByRole('button', { name: 'Import 1 files' }),
  ).toBeEnabled();
  await importReview.getByRole('button', { name: 'Cancel import' }).click();

  await expect(importReview).toHaveCount(0);
  await expect(library).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await scanSurface(page, {
    name: 'import review canceled without import',
    present: library,
    include: 'main[aria-label="Model library"]',
    testInfo,
  });
  await captureVisualScenario(page, 'import.review-cancel', testInfo);
});
