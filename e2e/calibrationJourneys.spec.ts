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
 * returns no printers, the wizard's printer `<select>` is entirely absent
 * AND the "No PrintFarmer printers are available" copy renders — proving
 * the positive test's `printers.count > 0` assertion is not vacuous. Post-
 * #773 the picker is a `<select>` with an always-present empty-value
 * placeholder option, so counting `<option>` elements is not enough on its
 * own — the discriminator is the presence/absence of the combobox itself.
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
  // `calibration:listPrinters`; asserting on the printer picker inside it
  // proves the shipped route serves the shape the desktop expects. Post-
  // #773 the picker is a `<select>` with an "Online"/"Offline" `<optgroup>`
  // instead of a radio group, so count the real `<option>` elements — those
  // whose `value` is non-empty, since `value=""` is the always-rendered
  // "Select a printer" placeholder and would otherwise make the populated
  // and empty cases indistinguishable.
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  await expect(step1).toBeVisible();

  const printerSelect = step1.getByRole('combobox', { name: 'Printer' });
  await expect(printerSelect).toBeVisible();
  const printerOptions = printerSelect.locator('option:not([value=""])');
  const count = await printerOptions.count();
  // Failure message names what was actually observed, not one guessed
  // cause. The previous wording ("the /api/printers response is not
  // reaching the wizard") assumed a specific mechanism and misattributed
  // the very failure that made this file fail on trunk: the DOM had
  // migrated to a `<select>` and the assertion's radio-shaped locator no
  // longer matched anything. `printerSelect.toBeVisible()` above already
  // proves the combobox itself mounted, so if the count is 0 here the two
  // remaining causes are the ones enumerated.
  expect(
    count,
    "the Printer combobox mounted but contains no non-placeholder <option> — either the /api/printers response never reached the wizard, or the picker's <option> shape drifted from what this selector matches",
  ).toBeGreaterThan(0);
});

test('Filament Calibration wizard shows the empty-list hint when no printers are returned (control)', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  // Discriminator for the populated-list assertion above.
  //
  // The previous version of this control asserted `radioCount == 0` on a
  // selector (`input[name="filament-cal-printer"][type="radio"]`) that
  // #773 had already removed. That assertion PASSED in the CI run that
  // caught the picker regression (workflow run 32921712975): the DOM had
  // no radios in EITHER the populated or empty scenarios, so the control
  // reported success while the contract it was meant to protect was
  // broken. Any new discriminator here has to be robust against the same
  // failure mode — a locator that vacuously reports the "expected"
  // result on both scenarios is worse than no control at all.
  //
  // In the shipped wizard the entire `<label>Printer<select>…</select>
  // </label>` is conditional on `printers.length > 0` (see
  // `FilamentCalibrationWizard.tsx` `SelectStep`) — so with an empty
  // fixture the combobox is not rendered at all, and only the "no
  // printers" hint appears in its place. Asserting BOTH is the
  // discriminator:
  //
  //   - If the populated case's DOM leaked into the empty scenario, the
  //     combobox count would be > 0 and this test would fail.
  //   - If the wizard failed to render Step 1 altogether, the hint text
  //     would be absent and this test would fail.
  //
  // Counting non-placeholder `<option>` elements alone would not work
  // here: when the combobox is absent, that count is 0, and it is ALSO 0
  // in a broken populated-case render where the select mounted with only
  // the "Select a printer" placeholder. The presence/absence of the
  // combobox itself is what discriminates.
  await applyCalibrationScenario(app, page, { printerList: 'empty' });
  await openFilamentCalibrationWizard(page);

  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  await expect(step1).toBeVisible();

  const printerSelect = step1.getByRole('combobox', { name: 'Printer' });
  await expect(printerSelect).toHaveCount(0);
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
