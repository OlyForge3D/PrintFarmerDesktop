/**
 * Filament calibration end-to-end journeys against the packaged Electron bundle.
 *
 * Post-#756 (`OlyForge3D/PrintFarmerDesktop#756`) the printer-calibration saga
 * is gone. The prior version of this file drove that saga: a `New calibration
 * project` primary CTA online-vs-offline gating test, and an unknown-dispatch
 * outcome test that exercised the retired queue/orchestration/bed-clear
 * channels. All three subjects have been removed from the shipped app, so
 * those tests were deleted rather than weakened.
 *
 * The new journey is the one the operator will actually run: open the
 * calibration page, follow the single primary CTA into the filament wizard,
 * and confirm the printer list populates. This is the closest thing to a
 * runtime proof of the `/api/printers` fix from `#756` we can get under e2e —
 * an empty-list regression on this page is the exact failure the retired
 * candidate contract used to prevent.
 *
 * Discrimination: a negative-control test asserts that when the fixture
 * returns no printers, the wizard renders the "No PrintFarmer printers are
 * available" copy — proving the positive test's `printers.count > 0`
 * assertion is not vacuous.
 */
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { rmSync } from 'node:fs';

import {
  applyCalibrationScenario,
  launchCalibrationApp,
  openCalibrationWorkspace,
  openFilamentCalibrationWizard,
} from './helpers/calibrationA11yFixture.js';

// One long-lived Electron app per file — the saga-workspace equivalent was
// paying full-startup cost per test and the filament flow is small enough
// that there is no isolation win from launching per-test.
let app: ElectronApplication;
let page: Page;
let stateRoot: string | null = null;

test.beforeAll(async () => {
  const launched = await launchCalibrationApp();
  app = launched.app;
  page = launched.page;
  stateRoot = launched.stateRoot;
});

test.afterAll(async () => {
  try {
    await app.close();
  } catch {
    // best-effort — the after-each cleanup already ran
  }
  if (stateRoot !== null) {
    try {
      rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      // Windows may still hold the SQLite handle for a moment; the OS
      // will reclaim the tmpdir on next boot even if this call fails.
    }
  }
});

test.describe.configure({ mode: 'serial' });

test('Filament Calibration dashboard leads with the filament CTA and no route into the saga', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);

  // The primary heading is the filament page, not the saga.
  await expect(
    page.getByRole('heading', { name: 'Filament Calibration', level: 1 }),
  ).toBeVisible();

  // The single primary action leads into the wizard.
  const primary = page.getByRole('button', {
    name: 'Calibrate a filament spool',
  });
  await expect(primary).toBeVisible();
  await expect(primary).toBeEnabled();

  // The saga's primary and secondary CTAs are gone. These names were the
  // dashboard's entry points into `NewCalibrationProject.tsx`, deleted with
  // #756. If either name is present in the shipped dashboard the reap
  // regressed and the operator can be led back into the wrong feature.
  await expect(
    page.getByRole('button', { name: 'New calibration project' }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('button', {
      name: 'Import a legacy calibration backup file',
    }),
  ).toHaveCount(0);
});

test('Filament Calibration wizard opens and the printer list populates from /api/printers', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  await applyCalibrationScenario(app, page, { printerList: 'populated' });
  await openFilamentCalibrationWizard(page);

  // The wizard's Step 1 fieldset is what actually consumes
  // `calibration:listPrinters`; asserting on the printer radio group inside
  // it proves the shipped route serves the shape the desktop expects.
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  await expect(step1).toBeVisible();

  const printerRadios = step1.locator(
    'input[name="filament-cal-printer"][type="radio"]',
  );
  const count = await printerRadios.count();
  expect(
    count,
    'printer list rendered empty — the /api/printers response is not reaching the wizard',
  ).toBeGreaterThan(0);
});

test('Filament Calibration wizard shows the empty-list hint when no printers are returned (control)', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  // Discriminator for the populated-list assertion above: with an empty
  // response, the wizard must render its "no printers" hint rather than a
  // spinning loader or a silent void. If this test also passes on a
  // populated fixture, the previous test proves nothing.
  await applyCalibrationScenario(app, page, { printerList: 'empty' });
  await openFilamentCalibrationWizard(page);

  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  await expect(step1).toBeVisible();

  const printerRadios = step1.locator(
    'input[name="filament-cal-printer"][type="radio"]',
  );
  await expect(printerRadios).toHaveCount(0);
  await expect(
    step1.getByText(
      /No PrintFarmer printers are available\. Add one on the server/,
    ),
  ).toBeVisible();
});

test('Filament Calibration dashboard disables the primary CTA when offline', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  await applyCalibrationScenario(app, page, { offline: true });
  await openCalibrationWorkspace(page);

  const primary = page.getByRole('button', {
    name: 'Calibrate a filament spool',
  });
  await expect(primary).toBeVisible();
  await expect(primary).toBeDisabled();

  // The offline alert names the state and the recovery — the operator
  // should not be left guessing what "disabled" means.
  await expect(
    page.getByRole('alert').filter({
      hasText: /Offline: filament calibration requires a live PrintFarmer/,
    }),
  ).toBeVisible();
});
