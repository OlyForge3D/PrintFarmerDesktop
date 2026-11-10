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

test('organization loading, list error/retry and mutation failure states render accessibly', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(150_000);
  expect(browserName).toBe('chromium');
  const launched = await launchCalibrationApp();
  app = launched.app;
  const page = launched.page;
  stateRoot = launched.stateRoot;
  await applyPinnedRenderingProfile(page);

  const organization = page.getByRole('main', {
    name: 'Tags and collections',
  });
  const openOrganization = async (): Promise<void> => {
    const maybeLater = page.getByRole('button', { name: 'Maybe later' });
    if (await maybeLater.isVisible()) await maybeLater.click();
    await page.getByRole('button', { name: /^Tags & Collections/ }).click();
    await expect(organization).toBeVisible();
  };

  await applyCalibrationScenario(app, page, {
    organizationListDelayMs: 1200,
  });
  await openOrganization();
  await expect(organization.getByRole('status')).toHaveText(
    'Loading collections…',
  );
  await expect(organization).toHaveAttribute('aria-busy', 'false');
  await scanSurface(page, {
    name: 'organization loading state',
    present: organization,
    testInfo,
  });
  await captureVisualScenario(page, 'organization.workspace.loading', testInfo);
  await expect(organization.getByText('No collections yet')).toBeVisible();

  await applyCalibrationScenario(app, page, {
    organizationListFailure: 'once',
  });
  await openOrganization();
  await expect(organization.getByRole('alert')).toContainText(
    'Could not load tags and collections: Error invoking remote method',
  );
  await expect(organization.getByRole('alert')).toContainText(
    'Synthetic organization list failure.',
  );
  await scanSurface(page, {
    name: 'organization list error state',
    present: organization,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'organization.workspace.list-error',
    testInfo,
  );
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(organization.getByText('No collections yet')).toBeVisible();
  await expect(organization.getByRole('alert')).toHaveCount(0);

  await applyCalibrationScenario(app, page, {
    organizationCreateFailure: true,
    organizationCreateDelayMs: 500,
  });
  await openOrganization();
  await expect(organization.getByText('No collections yet')).toBeVisible();
  await organization
    .getByRole('textbox', { name: 'New collection name' })
    .fill('Synthetic failure collection');
  await organization.getByRole('button', { name: 'Create collection' }).click();
  await expect(organization).toHaveAttribute('aria-busy', 'true');
  await scanSurface(page, {
    name: 'organization create pending state',
    present: organization,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'organization.workspace.create-pending',
    testInfo,
  );
  await expect(organization.getByRole('alert')).toContainText(
    'Synthetic organization create failure.',
  );
  await expect(organization).toHaveAttribute('aria-busy', 'false');
  await expect(
    organization.getByRole('textbox', { name: 'New collection name' }),
  ).toHaveValue('Synthetic failure collection');
  await scanSurface(page, {
    name: 'organization create failure state',
    present: organization,
    testInfo,
  });
  await captureVisualScenario(
    page,
    'organization.workspace.create-error',
    testInfo,
  );
});

test('organization review blocks oversized selection and incrementally reveals definitions', async ({
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
    organizationListFixture: 'large',
  });

  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  if (await maybeLater.isVisible()) await maybeLater.click();
  await page.getByRole('button', { name: /^Tags & Collections/ }).click();
  const organization = page.getByRole('main', {
    name: 'Tags and collections',
  });
  await expect(organization).toBeVisible();
  const sharedEntry = organization.getByRole('checkbox', {
    name: 'Select Farm shared',
  });
  await expect(sharedEntry).toBeDisabled();
  await expect(organization.getByRole('table').getByRole('row')).toHaveCount(
    201,
  );
  await scanSurface(page, {
    name: 'organization shared read-only and initial large-list state',
    present: organization,
    include: '#organization-main',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'organization.workspace.shared-readonly',
    testInfo,
  );

  await organization
    .getByRole('button', { name: 'Show 200 more of 302' })
    .click();
  await expect(organization.getByRole('table').getByRole('row')).toHaveCount(
    401,
  );
  await expect(
    organization.getByRole('button', { name: 'Show 102 more of 102' }),
  ).toBeVisible();
  await organization
    .getByRole('button', { name: 'Select all unused (501)' })
    .click();
  await expect(
    organization.getByText('501 selected', { exact: true }),
  ).toBeVisible();
  await expect(organization.getByRole('status')).toContainText(
    'Select at most 500 collections per deletion.',
  );
  await expect(
    organization.getByRole('button', { name: 'Review deletion…' }),
  ).toBeDisabled();
  await scanSurface(page, {
    name: 'organization oversized selection block',
    present: organization,
    include: '#organization-main',
    testInfo,
  });
  await captureVisualScenario(
    page,
    'organization.workspace.large-selection-blocked',
    testInfo,
  );
});
