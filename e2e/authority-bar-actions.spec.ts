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

test('opens the connection manager from the unconfigured authority bar', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  const page = launched.page;
  await applyPinnedRenderingProfile(page);
  await applyCalibrationScenario(app, page, { noProfile: true });

  const authorityBar = page.getByRole('region', {
    name: 'PrintFarmer server',
  });
  const connect = authorityBar.getByRole('button', {
    name: /Connect to PrintFarmer/,
  });
  await expect(connect).toBeEnabled();
  await connect.click();

  const dialog = page.getByRole('dialog', {
    name: 'Connect to PrintFarmer',
  });
  await expect(dialog.getByText('No server profiles saved yet.')).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Add a server' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'connect to PrintFarmer dialog',
    present: dialog,
    include: '[role="dialog"]',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'shell.authority-bar.connect-manage-actions',
    testInfo,
  );
});
