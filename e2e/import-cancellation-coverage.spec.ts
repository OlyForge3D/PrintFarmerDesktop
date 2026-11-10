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

test('keeps Source folders available when the synthetic folder picker is canceled', async ({
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

  await page.getByRole('button', { name: /^Settings/ }).click();
  const sources = page.getByRole('region', {
    name: 'Source folders',
    exact: true,
  });
  await expect(sources).toBeVisible();
  await sources.getByRole('button', { name: 'Add source folder' }).click();
  await expect(sources).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Organize models before importing' }),
  ).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await scanSurface(page, {
    name: 'folder picker canceled before import review',
    present: sources,
    testInfo,
  });
  await captureVisualScenario(page, 'sources.picker-cancel', testInfo);
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

  await page.getByRole('button', { name: /^Settings/ }).click();
  const sources = page.getByRole('region', {
    name: 'Source folders',
    exact: true,
  });
  await expect(sources).toBeVisible();
  await sources.getByRole('button', { name: 'Add source folder' }).click();
  const importReview = page.getByRole('dialog', {
    name: 'Organize models before importing',
  });
  await expect(importReview).toBeVisible();
  await expect(
    importReview.getByRole('button', { name: 'Import', exact: true }),
  ).toBeEnabled();
  await importReview.getByRole('button', { name: 'Cancel import' }).click();
  await expect(importReview).toHaveCount(0);
  await expect(sources).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await scanSurface(page, {
    name: 'import review canceled without import',
    present: sources,
    testInfo,
  });
  await captureVisualScenario(page, 'import.review-cancel', testInfo);
});
