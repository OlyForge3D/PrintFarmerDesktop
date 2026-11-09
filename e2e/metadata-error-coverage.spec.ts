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

test('announces selected-model vendor and collection metadata failures', async ({
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
    inspectorErrorFixture: true,
  });

  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  const modelCard = page.getByRole('button', {
    name: 'Select metadata-error.3mf',
  });
  await expect(modelCard).toBeVisible();
  await modelCard.click();

  const inspector = page.getByRole('complementary', {
    name: 'Model properties',
  });
  await expect(
    inspector
      .getByRole('alert')
      .filter({ hasText: 'Synthetic slicer metadata failure.' }),
  ).toBeVisible();
  await expect(
    inspector
      .getByRole('alert')
      .filter({ hasText: 'Synthetic model collection metadata failure.' }),
  ).toBeVisible();
  await scanSurface(page, {
    name: 'selected model metadata error states',
    present: inspector,
    include: '.properties-inspector',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'library.inspector.metadata-errors',
    testInfo,
  );
});
