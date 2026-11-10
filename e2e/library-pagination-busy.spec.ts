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

test('library pagination controls disable while a delayed query is pending', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  const page = launched.page;
  await applyPinnedRenderingProfile(page);
  await applyCalibrationScenario(app, page, { libraryQueryDelayMs: 1800 });

  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  const pagination = page.getByRole('navigation', { name: 'Library pages' });
  const pageSize = pagination.getByRole('combobox', {
    name: 'Items per page',
  });
  await expect(pageSize).toBeEnabled();

  const search = page.getByRole('searchbox', { name: 'Search models' });
  await search.fill('synthetic-busy-query');
  await expect(pageSize).toBeDisabled();
  const library = page.getByRole('main', { name: 'Model library' });
  await expect(library.locator('.library-content')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await scanSurface(page, {
    name: 'library workspace loading state',
    present: library,
    testInfo,
  });
  await captureVisualScenario(page, 'library.home.loading', testInfo);
  await scanSurface(page, {
    name: 'library pagination busy state',
    present: pagination,
    testInfo,
  });
  await captureVisualScenario(page, 'library.pagination.busy-query', testInfo);
  await expect(pageSize).toBeEnabled();
  await expect(pagination.getByRole('status')).toHaveText('0-0 of 0 matches');
  await expect(page.locator('.model-card')).toHaveCount(0);
});

test('library initial query failure announces and recovers on retry', async ({
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
    libraryErrorOnce: 'Synthetic initial catalog failure.',
  });

  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  const error = page
    .getByRole('alert')
    .filter({ hasText: 'Synthetic initial catalog failure.' });
  await expect(error).toBeVisible();
  await expect(
    error.getByRole('button', { name: 'Reload catalog' }),
  ).toBeVisible();
  await expect(
    error.getByRole('button', { name: 'Dismiss library error' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'library initial query error state',
    present: error,
    testInfo,
  });
  await captureVisualScenario(page, 'library.home.page-load-error', testInfo);
  await error.getByRole('button', { name: 'Reload catalog' }).click();
  await expect(error).toHaveCount(0);
  await expect(
    page.getByRole('navigation', { name: 'Library pages' }).getByRole('status'),
  ).toHaveText('0-0 of 0 matches');
  await expect(page.locator('.library-content')).toHaveAttribute(
    'aria-busy',
    'false',
  );
});
