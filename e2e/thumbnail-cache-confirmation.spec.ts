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

async function openCacheSettings(
  browserName: string,
  thumbnailCacheSaveResult: 'success' | 'unwritable',
) {
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  const page = launched.page;
  await applyPinnedRenderingProfile(page);
  await applyCalibrationScenario(app, page, {
    thumbnailCacheEntryCount: 3,
    thumbnailCacheSaveResult,
  });
  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  await page.getByRole('button', { name: /^Settings/ }).click();
  return {
    page,
    dialog: page.getByRole('region', { name: 'Thumbnail cache', exact: true }),
  };
}

test('thumbnail cache clear confirmation is cancellable with synthetic usage', async ({
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
    thumbnailCacheEntryCount: 3,
  });

  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  await page.getByRole('button', { name: /^Settings/ }).click();
  const dialog = page.getByRole('region', {
    name: 'Thumbnail cache',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByText('C:\\SyntheticPrintFarmer\\thumbnail-cache'),
  ).toBeVisible();
  await expect(dialog.getByText('3.0 KiB used · 3 thumbnails')).toBeVisible();
  await expect(dialog.getByLabel('Maximum size (MiB)')).toHaveValue('128');
  await expect(
    dialog.getByLabel('Remove unused thumbnails after (days)'),
  ).toHaveValue('30');
  await scanSurface(page, {
    name: 'loaded thumbnail cache settings',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.loaded-settings',
    testInfo,
  );
  await dialog.getByLabel('Maximum size (MiB)').fill('8');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  const validation = dialog.getByRole('alert').filter({
    hasText: 'Enter a cache size of 16–16384 MiB and retention of 1–3650 days.',
  });
  await expect(validation).toBeVisible();
  await scanSurface(page, {
    name: 'invalid thumbnail cache settings',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.invalid-settings',
    testInfo,
  );
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('button', { name: /^Settings/ }).click();
  const reopenedDialog = page.getByRole('region', {
    name: 'Thumbnail cache',
    exact: true,
  });
  await expect(
    reopenedDialog.getByText('3.0 KiB used · 3 thumbnails'),
  ).toBeVisible();
  await expect(
    reopenedDialog.getByRole('button', { name: 'Clear cached thumbnails…' }),
  ).toBeEnabled();
  await reopenedDialog
    .getByRole('button', { name: 'Clear cached thumbnails…' })
    .click();
  const confirmation = reopenedDialog.getByRole('alert', {
    name: 'Confirm clearing thumbnails',
  });
  await expect(confirmation).toContainText(
    'Your original model files will not be affected.',
  );
  await scanSurface(page, {
    name: 'populated thumbnail cache clear confirmation',
    present: confirmation,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.populated-clear-confirmation',
    testInfo,
  );
  await confirmation.getByRole('button', { name: 'Keep cache' }).click();
  await expect(confirmation).toHaveCount(0);
  await expect(
    reopenedDialog.getByRole('button', { name: 'Clear cached thumbnails…' }),
  ).toBeEnabled();
});

test('saves valid thumbnail cache settings through synthetic IPC', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const { page, dialog } = await openCacheSettings(browserName, 'success');
  await expect(dialog.getByLabel('Maximum size (MiB)')).toHaveValue('128');
  await dialog.getByLabel('Maximum size (MiB)').fill('64');
  await dialog.getByLabel('Remove unused thumbnails after (days)').fill('14');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(dialog.getByLabel('Maximum size (MiB)')).toHaveValue('64');
  await expect(
    dialog.getByLabel('Remove unused thumbnails after (days)'),
  ).toHaveValue('14');
  await expect(dialog.getByRole('status')).toHaveText(
    'Thumbnail cache settings saved.',
  );
  await expect(dialog.getByRole('alert')).toHaveCount(0);
  await scanSurface(page, {
    name: 'saved thumbnail cache settings',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.saved-settings',
    testInfo,
  );
});

test('announces an unwritable thumbnail cache location after save', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  const { page, dialog } = await openCacheSettings(browserName, 'unwritable');
  await dialog.getByLabel('Maximum size (MiB)').fill('64');
  await dialog.getByLabel('Remove unused thumbnails after (days)').fill('14');
  await dialog.getByRole('button', { name: 'Save settings' }).click();
  await expect(
    dialog.getByRole('alert').filter({
      hasText: 'Thumbnail cache location is unavailable or not writable.',
    }),
  ).toBeVisible();
  await expect(dialog).toContainText(
    'Thumbnails will still render, but may not be cached until the location is writable.',
  );
  await expect(dialog.getByRole('status')).toHaveText(
    'Thumbnail cache settings saved.',
  );
  await scanSurface(page, {
    name: 'unwritable thumbnail cache warning',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.unwritable-warning',
    testInfo,
  );
});

test('captures Library and cache settings at the compact CSS viewport proxy', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  const page = launched.page;
  const profileId =
    'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1';
  await applyPinnedRenderingProfile(page, profileId);
  await applyCalibrationScenario(app, page, {
    thumbnailCacheEntryCount: 0,
  });

  const library = page.getByRole('main', { name: 'Model library' });
  const sidebar = page.getByRole('complementary', {
    name: 'Library navigation',
  });
  await expect(library).toBeVisible();
  await expect(sidebar).toBeVisible();
  const libraryBounds = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(libraryBounds.viewportWidth).toBe(720);
  expect(libraryBounds.documentWidth).toBeLessThanOrEqual(
    libraryBounds.viewportWidth,
  );
  await scanSurface(page, {
    name: 'compact Library sidebar and model grid',
    present: library,
    testInfo,
  });
  await captureVisualScenario(page, 'library.home.compact-layout', testInfo);

  await page.getByRole('button', { name: /^Settings/ }).click();
  const dialog = page.getByRole('region', {
    name: 'Thumbnail cache',
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await dialog.scrollIntoViewIfNeeded();
  const dialogBounds = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      viewportWidth: document.documentElement.clientWidth,
      viewportHeight: document.documentElement.clientHeight,
    };
  });
  expect(dialogBounds.left).toBeGreaterThanOrEqual(0);
  expect(dialogBounds.right).toBeLessThanOrEqual(dialogBounds.viewportWidth);
  const clearCache = dialog.getByRole('button', {
    name: 'Clear cached thumbnails…',
  });
  await clearCache.scrollIntoViewIfNeeded();
  await expect(clearCache).toBeInViewport();
  await scanSurface(page, {
    name: 'compact thumbnail cache settings section',
    present: dialog,
    include: '.settings-cache',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'dialogs.thumbnail-cache.compact-layout',
    testInfo,
  );
});
