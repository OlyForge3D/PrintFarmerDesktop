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

test('renders and dismisses a mocked update notice', async ({
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
    availableReleaseFixture: 'beta',
  });

  const notice = page.locator('.status-item--update');
  const link = notice.getByRole('link', {
    name: 'Beta 0.1.0-beta.9 available',
  });
  await expect(link).toHaveAttribute(
    'href',
    'https://example.invalid/releases/v0.1.0-beta.9',
  );
  await scanSurface(page, {
    name: 'update notice',
    present: notice,
    include: '.status-item--update',
    testInfo,
  });
  await captureVisualScenario(page, 'shell.status-bar.update-notice', testInfo);

  await notice
    .getByRole('button', { name: 'Dismiss 0.1.0-beta.9 update notice' })
    .click();
  await expect(notice).toHaveCount(0);
});
