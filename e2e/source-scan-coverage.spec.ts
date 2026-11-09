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

test('shows delayed source scan progress, then announces and recovers from root error', async ({
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
    sourceScanDelayMs: 1200,
    sourceScanFailureOnce: 'Synthetic source scan failure.',
  });
  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  await page.getByRole('button', { name: /^Sources/ }).click();
  const sources = page.getByRole('main', { name: 'Catalog sources' });
  const root = page.getByRole('list', { name: 'Source folders' }).locator('li');
  await expect(root).toContainText('a11y-models');

  await root.getByRole('button', { name: 'Reconnect' }).click();
  await expect(sources).toHaveAttribute('aria-busy', 'true');
  const progress = sources.getByRole('status').filter({
    hasText: 'Reconnecting /fixtures/a11y-models',
  });
  await expect(progress).toBeVisible();
  await expect(
    progress.getByRole('progressbar', { name: 'Scan progress' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'source root scan progress',
    present: sources,
    testInfo,
  });
  await captureVisualScenario(page, 'sources.scan-progress', testInfo);

  const error = sources.getByRole('alert').filter({
    hasText: 'Synthetic source scan failure.',
  });
  await expect(error).toBeVisible();
  await expect(sources).toHaveAttribute('aria-busy', 'false');
  await scanSurface(page, {
    name: 'source root scan error',
    present: sources,
    testInfo,
  });
  await captureVisualScenario(page, 'sources.scan-root-error', testInfo);

  await root.getByRole('button', { name: 'Reconnect' }).click();
  await expect(sources).toHaveAttribute('aria-busy', 'false');
  await expect(error).toHaveCount(0);
});
