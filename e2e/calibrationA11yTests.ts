/**
 * Filament calibration accessibility Playwright E2E tests (@a11y).
 *
 * Post-#756 the printer-calibration saga is gone, along with the dashboard's
 * saved-projects list, generation status alert, bed-clear dialog, temperature
 * stage workflow, calibration report, and OrcaSlicer profile install/restore
 * flow. Every axe scan, focus trap, and recovery-state assertion that took
 * one of those as its subject was deleted with #756 — a rename does not
 * revive a UI that no longer exists.
 *
 * What survives is the shipped page the operator will actually run: the
 * Filament Calibration dashboard and the filament calibration wizard. This
 * spec asserts the a11y invariants that continue to hold on those surfaces:
 *
 *   1. Axe scans of the dashboard and the wizard's Step 1 report no
 *      material WCAG A/AA violations.
 *   2. Keyboard traversal reaches the primary "Calibrate a filament spool"
 *      CTA and, in the wizard, reaches the printer picker inside Step 1.
 *   3. Dashboard recovery states (offline, missing scopes, missing
 *      capability flags) each disable the primary CTA and announce the
 *      recovery message — with a positive control (`availability: 'ok'`)
 *      that must NOT show any recovery message on the same fixtures.
 *   4. Reduced motion, dark theme, and 200% zoom on the dashboard and
 *      the wizard's Step 1 hold up without axe regressions.
 *
 * Tests deleted (subject no longer exists):
 *
 *   - Legacy backup import dialog focus trap (dialog reaped)
 *   - Bed-clear dialog focus trap (dialog reaped)
 *   - Project overview / temperature stage / generation status axe scans
 *     (all saga surfaces)
 *   - Calibration report print media (report reaped)
 *   - OrcaSlicer profile install rollback (channels reaped, see #756 PR body)
 *   - Project recovery states — stale context, conflict, generation
 *     failure, uncertain dispatch (saga workspace state gone)
 */
import {
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { rmSync } from 'node:fs';

import {
  applyCalibrationScenario,
  expectTabReaches,
  launchCalibrationApp,
  openCalibrationWorkspace,
  openFilamentCalibrationWizard,
  scanSurface,
  WCAG_TAGS,
} from './helpers/calibrationA11yFixture.js';
import AxeBuilder from '@axe-core/playwright';

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
      // Windows may still hold the SQLite handle; the OS reclaims the
      // tmpdir on next boot even if this call fails.
    }
  }
});

test.describe.configure({ mode: 'serial' });

// ---------------------------------------------------------------------------
// 1. Axe scans
// ---------------------------------------------------------------------------

test('@a11y filament calibration dashboard has no material WCAG A/AA violations', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);
  await scanSurface(page, {
    name: 'filament calibration dashboard',
    present: page.getByRole('heading', {
      name: 'Filament Calibration',
      level: 1,
    }),
    testInfo,
  });
});

test('@a11y filament calibration wizard Step 1 has no material WCAG A/AA violations', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await applyCalibrationScenario(app, page, {});
  await openFilamentCalibrationWizard(page);
  await scanSurface(page, {
    name: 'filament calibration wizard Step 1',
    present: page.getByRole('group', {
      name: 'Step 1 — machine, process, and base filament',
    }),
    testInfo,
  });
});

// ---------------------------------------------------------------------------
// 2. Keyboard traversal
// ---------------------------------------------------------------------------

test('@a11y filament calibration dashboard is reachable by keyboard traversal', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);
  // Traversal starts from the app root (Escape returns focus to <body>
  // predictably in the packaged bundle).
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  const primary = page.getByRole('button', {
    name: 'Calibrate a filament spool',
  });
  const workspace = page.getByRole('main', {
    name: 'Filament calibration workspace',
  });
  await expectTabReaches(
    page,
    primary,
    'the "Calibrate a filament spool" primary CTA',
    80,
    workspace,
  );
});

test('@a11y filament calibration wizard printer picker is reachable by keyboard traversal', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, { printerList: 'populated' });
  await openFilamentCalibrationWizard(page);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });
  // Post-#773 the picker is a `<select aria-label="Printer">` with
  // `<optgroup>`-grouped options, not a radio group. The invariant this
  // test guards is unchanged: the picker must be reachable by keyboard
  // traversal from the CTA — proven here by tabbing to the combobox.
  const printerSelect = step1.getByRole('combobox', { name: 'Printer' });
  await expectTabReaches(
    page,
    printerSelect,
    'the printer picker combobox in the wizard Step 1',
    80,
    step1,
  );
});

// ---------------------------------------------------------------------------
// 3. Recovery states (dashboard)
// ---------------------------------------------------------------------------
//
// The three recovery states surviving under Path D each disable the primary
// CTA and announce a recovery message. This block asserts one positive arm
// per state PLUS a positive control (`availability: 'ok'`, online) where
// NONE of the recovery messages appear — without that discriminator, a
// fixture that always shows every message would pass every arm.

const RECOVERY_STATES: ReadonlyArray<{
  readonly label: string;
  readonly scenario: Parameters<typeof applyCalibrationScenario>[2];
  readonly messagePattern: RegExp;
}> = [
  {
    label: 'offline',
    scenario: { offline: true },
    messagePattern:
      /Offline: filament calibration requires a live PrintFarmer connection/,
  },
  {
    label: 'missing scopes',
    scenario: { availability: 'missingScopes' },
    messagePattern: /Permission denied: calibration read, write, generation/,
  },
  {
    label: 'missing capability flags',
    scenario: { availability: 'missingCapabilityFlags' },
    messagePattern: /Filament calibration is unavailable on this PrintFarmer/,
  },
];

for (const { label, scenario, messagePattern } of RECOVERY_STATES) {
  test(`@a11y filament calibration dashboard announces the ${label} recovery state and disables the primary CTA`, async ({
    browserName,
  }) => {
    expect(browserName).toBe('chromium');
    test.setTimeout(180_000);

    await applyCalibrationScenario(app, page, scenario);
    await openCalibrationWorkspace(page);

    const primary = page.getByRole('button', {
      name: 'Calibrate a filament spool',
    });
    await expect(primary).toBeVisible();
    await expect(primary).toBeDisabled();

    await expect(
      page.getByRole('alert').filter({ hasText: messagePattern }),
    ).toBeVisible();
  });
}

test('@a11y filament calibration dashboard control: online + ok availability shows no recovery message and enables the primary CTA', async ({
  browserName,
}) => {
  // Positive control for the three recovery-state tests above. Without this
  // arm, a fixture that unconditionally returned "offline" would still pass
  // every "recovery message visible" assertion — the presence of the state
  // is only meaningful if we can also prove its ABSENCE.
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);

  await applyCalibrationScenario(app, page, {});
  await openCalibrationWorkspace(page);

  const primary = page.getByRole('button', {
    name: 'Calibrate a filament spool',
  });
  await expect(primary).toBeVisible();
  await expect(primary).toBeEnabled();

  for (const { messagePattern } of RECOVERY_STATES) {
    await expect(
      page.getByRole('alert').filter({ hasText: messagePattern }),
    ).toHaveCount(0);
  }
});

// ---------------------------------------------------------------------------
// 4. Reduced motion, dark theme, 200% zoom
// ---------------------------------------------------------------------------

/*
 * The dark-theme half asserts what the pre-#756 version asserted, and for the
 * same reason: there are no `prefers-color-scheme` rules in this codebase, so
 * emulating `colorScheme: 'dark'` does not select a dark theme (there is no
 * dark theme to select). What it does assert is narrower and still worth
 * having: an axe contrast regression guard that runs with the dark preference
 * set, so if a dark theme is added later, contrast failures surface here
 * rather than at a user.
 */

test('@a11y filament calibration wizard Step 1 holds up under reduced motion, dark theme, and 200% zoom', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await applyCalibrationScenario(app, page, {});
  await openFilamentCalibrationWizard(page);
  const step1 = page.getByRole('group', {
    name: 'Step 1 — machine, process, and base filament',
  });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(
    step1,
    'the wizard Step 1 did not render under reduced motion',
  ).toBeVisible();
  const animated = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll('.calibration-workspace *'))
        .map((node) => {
          const style = getComputedStyle(node);
          return {
            animation: style.animationDuration,
            transition: style.transitionDuration,
          };
        })
        .filter(
          (durations) =>
            parseFloat(durations.animation) > 0.05 ||
            parseFloat(durations.transition) > 0.05,
        ).length,
  );
  expect(
    animated,
    'elements still animate for longer than 50ms under prefers-reduced-motion: reduce',
  ).toBe(0);

  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await scanSurface(page, {
    name: 'filament calibration wizard Step 1 in dark theme',
    present: step1,
    testInfo,
  });

  await page.emulateMedia({ colorScheme: 'light' });
  const viewport = page.viewportSize();
  if (viewport !== null) {
    // Emulate 200% zoom by halving the viewport in CSS pixels — Playwright
    // does not expose a browser-native zoom, but the axe scan runs against
    // the produced layout, which is what WCAG 1.4.10 (Reflow) is about.
    await page.setViewportSize({
      width: Math.floor(viewport.width / 2),
      height: Math.floor(viewport.height / 2),
    });
    try {
      await expect(
        step1,
        'the wizard Step 1 did not render at 200% zoom',
      ).toBeVisible();
      const zoomBuilder = new AxeBuilder({ page })
        .setLegacyMode()
        .withTags(WCAG_TAGS);
      const zoomResults = await zoomBuilder.analyze();
      const materialZoomViolations = zoomResults.violations.filter(
        (violation) =>
          typeof violation.impact === 'string' &&
          ['moderate', 'serious', 'critical'].includes(violation.impact),
      );
      if (materialZoomViolations.length > 0) {
        await testInfo.attach('axe-filament-wizard-zoom.json', {
          body: Buffer.from(JSON.stringify(materialZoomViolations, null, 2)),
          contentType: 'application/json',
        });
      }
      expect(
        materialZoomViolations,
        'filament wizard Step 1 has material WCAG A/AA violations at 200% zoom',
      ).toEqual([]);
    } finally {
      await page.setViewportSize(viewport);
    }
  }
});
