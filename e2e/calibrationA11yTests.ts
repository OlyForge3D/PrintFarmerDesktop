/**
 * Printer Calibration accessibility and recovery-state acceptance (issue #153).
 *
 * These tests exist to defeat one failure class: an assertion that cannot fail.
 * An axe scan of a container that never rendered reports zero violations. A
 * traversal test passes when focus never moved. A recovery assertion passes
 * when the state was never entered. So every scan here is preceded by a render
 * precondition, every traversal asserts focus reached a *named* element, and
 * every recovery state asserts a structural signal, a named announced message,
 * and that the message names the operator's next action — with a healthy
 * negative control proving a no-op fixture would fail.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import {
  CAL,
  applyCalibrationScenario,
  expectTabReaches,
  focusIsInside,
  focusedDescription,
  launchCalibrationApp,
  openCalibrationWorkspace,
  openFixtureProject,
  openProfileView,
  openReportView,
  openTemperatureStage,
  scanSurface,
  type CalibrationScenario,
} from './helpers/calibrationA11yFixture';

/** Verbs that make a message actionable rather than merely descriptive. */
const NEXT_ACTION =
  /\b(Ask|Select|Reconnect|Refresh|Resolve|Review|Update|Wait|Configure|Check|Restore|Generate|Re-?queue|Retry)\b/;

/** Absolute local paths and credentials that must never reach a printed page. */
const LEAKS: readonly (readonly [string, RegExp])[] = [
  ['a Windows absolute path', /[A-Za-z]:\\/],
  ['a macOS home path', /\/Users\//],
  ['a Linux home path', /\/home\//],
  ['a file:// URL', /file:\/\//i],
  ['a bearer token', /\bBearer\s+\S+/i],
  [
    'a token or secret field',
    /\b(access_token|refresh_token|api[_-]?key|secret)\b/i,
  ],
];

async function withCalibrationApp(
  run: (context: {
    readonly app: Awaited<ReturnType<typeof launchCalibrationApp>>['app'];
    readonly page: Page;
  }) => Promise<void>,
): Promise<void> {
  const { app, page, stateRoot } = await launchCalibrationApp();
  try {
    await run({ app, page });
  } finally {
    await app.close().catch(() => undefined);
    try {
      rmSync(stateRoot, { recursive: true, force: true });
    } catch {
      // A locked Electron state file must not mask the test's own result.
    }
  }
}

/**
 * Asserts an announced message exists, names the next action, and that the
 * state it reports was genuinely entered (`signal`).
 */
async function expectRecoveryState(options: {
  readonly state: string;
  readonly signal: Locator;
  readonly signalDescription: string;
  readonly message: Locator;
}): Promise<void> {
  const { state, signal, signalDescription, message } = options;
  await expect(
    signal,
    `${state} was never entered: ${signalDescription} is absent, so the message assertion would prove nothing`,
  ).toBeVisible({ timeout: 15_000 });
  await expect(message, `${state} produced no announced message`).toBeVisible({
    timeout: 15_000,
  });
  // The live region is frequently an ancestor of the text-bearing node rather
  // than the node itself: a region must be mounted before its content to be
  // announced at all (#242), so the persistent container and the element that
  // carries the words are usually different elements. Resolve the role the way
  // assistive technology does — nearest live-region ancestor, self included.
  const role = await message.evaluate((el) => {
    const owner = (el as Element).closest('[role="alert"],[role="status"]');
    return owner ? owner.getAttribute('role') : null;
  });
  expect(
    role,
    `${state} message is not inside a live region (nearest role=${String(role)})`,
  ).toMatch(/^(alert|status)$/);
  const text = (await message.innerText()).trim();
  expect(
    text,
    `${state} message does not name a next action: "${text}"`,
  ).toMatch(NEXT_ACTION);
}

async function applyAndOpenDashboard(
  app: Awaited<ReturnType<typeof launchCalibrationApp>>['app'],
  page: Page,
  scenario: CalibrationScenario,
): Promise<void> {
  await applyCalibrationScenario(app, page, scenario);
  await openCalibrationWorkspace(page);
}

// ---------------------------------------------------------------------------
// 1. Axe over every calibration surface, each with a render precondition
// ---------------------------------------------------------------------------

test('@a11y calibration surfaces meet material WCAG checks', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      verified: true,
      orchestration: 'succeeded',
      queue: 'assigned',
    });

    await openCalibrationWorkspace(page);
    await scanSurface(page, {
      name: 'calibration dashboard',
      present: page.getByRole('heading', {
        name: 'Printer Calibration',
        level: 1,
      }),
      testInfo,
    });

    const importTrigger = page.getByRole('button', {
      name: 'Import a legacy calibration backup file',
    });
    await importTrigger.click();
    const importDialog = page.getByRole('dialog', {
      name: 'Import Legacy Calibration Backup',
    });
    await scanSurface(page, {
      name: 'legacy import dialog',
      present: importDialog,
      testInfo,
    });
    await page.getByRole('button', { name: 'Close import dialog' }).click();
    await expect(importDialog).toHaveCount(0);

    await page.getByRole('button', { name: 'New calibration project' }).click();
    await scanSurface(page, {
      name: 'new calibration project',
      present: page.getByRole('region', { name: 'New calibration project' }),
      testInfo,
    });

    await openFixtureProject(page);
    await scanSurface(page, {
      name: 'calibration project overview',
      present: page.getByRole('heading', { name: CAL.displayName, level: 1 }),
      testInfo,
    });

    await openTemperatureStage(page);
    await scanSurface(page, {
      name: 'calibration step workflow',
      present: page.getByRole('heading', { name: 'Temperature', level: 1 }),
      testInfo,
    });

    await page
      .getByRole('button', { name: 'Generate calibration model' })
      .click();
    await scanSurface(page, {
      name: 'calibration generation progress',
      present: page.getByRole('status', {
        name: 'Calibration generation status',
      }),
      testInfo,
    });

    await page.getByRole('button', { name: 'Confirm bed clear' }).click();
    const bedClear = page.getByRole('dialog', { name: 'Confirm Bed Clear' });
    await scanSurface(page, {
      name: 'bed clear safety dialog',
      present: bedClear,
      testInfo,
    });
    await page.keyboard.press('Escape');
    await expect(bedClear).toHaveCount(0);

    await openReportView(page);
    await scanSurface(page, {
      name: 'calibration report card',
      present: page.getByRole('article', { name: CAL.displayName }),
      testInfo,
    });

    await openProfileView(page);
    await scanSurface(page, {
      name: 'OrcaSlicer profile preview',
      present: page.getByRole('heading', {
        name: 'OrcaSlicer profile patch preview',
        level: 1,
      }),
      testInfo,
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Keyboard traversal — focus must reach specific named elements
// ---------------------------------------------------------------------------

test('@a11y calibration surfaces are traversable to named controls', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      verified: true,
      queue: 'assigned',
    });

    await openCalibrationWorkspace(page);
    const workspace = page.getByRole('main', {
      name: 'Printer calibration workspace',
    });
    await page
      .getByRole('link', { name: 'Skip to printer calibration' })
      .focus();
    await expectTabReaches(
      page,
      page.getByRole('button', {
        name: 'Import a legacy calibration backup file',
      }),
      'button "Import a legacy calibration backup file" on the dashboard',
      60,
      workspace,
    );

    await page.getByRole('button', { name: 'New calibration project' }).click();
    await page
      .getByRole('navigation', { name: 'Calibration views' })
      .getByRole('button', { name: 'Dashboard' })
      .focus();
    // Step 1 is the printer choice, so the first thing a keyboard user reaches
    // in the wizard is the printer radio group — not a project-name field for a
    // machine they have not selected yet.
    await expectTabReaches(
      page,
      page
        .getByRole('radiogroup', { name: 'PrintFarmer printer' })
        .getByRole('radio')
        .first(),
      'the first printer in the "PrintFarmer printer" choice',
      60,
      workspace,
    );

    await openFixtureProject(page);
    await page
      .getByRole('navigation', { name: 'Calibration views' })
      .getByRole('button', { name: 'Dashboard' })
      .focus();
    await expectTabReaches(
      page,
      page.getByRole('button', { name: /Open Temperature,/i }),
      'the "Open Temperature" stage button on the project overview',
      60,
      workspace,
    );

    await openTemperatureStage(page);
    await page
      .getByRole('navigation', { name: 'Calibration views' })
      .getByRole('button', { name: 'Dashboard' })
      .focus();
    await expectTabReaches(
      page,
      page.getByRole('button', { name: 'Generate calibration model' }),
      'button "Generate calibration model" on the step workflow',
      120,
      workspace,
    );

    // The report is reachable by keyboard alone: focus its nav control and
    // activate it with Enter, then assert the report actually rendered.
    await openFixtureProject(page);
    const reportNav = page
      .getByRole('button', { name: 'Calibration card' })
      .first();
    await reportNav.focus();
    await expect(reportNav).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('article', { name: CAL.displayName }),
      'Enter on the focused "Calibration card" control did not open the report',
    ).toBeVisible({ timeout: 15_000 });

    const profileNav = page
      .getByRole('button', { name: 'Profile patch' })
      .first();
    await profileNav.focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('heading', {
        name: 'OrcaSlicer profile patch preview',
        level: 1,
      }),
      'Enter on the focused "Profile patch" control did not open the profile preview',
    ).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// 3. Focus trap and restore on both modal dialogs
// ---------------------------------------------------------------------------

async function expectDialogTrapsAndRestores(
  page: Page,
  options: {
    readonly trigger: Locator;
    readonly dialog: Locator;
    readonly label: string;
  },
): Promise<void> {
  const { trigger, dialog, label } = options;
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(dialog, `${label} did not open`).toBeVisible({
    timeout: 15_000,
  });

  expect(
    await focusIsInside(dialog),
    `${label} did not move initial focus inside itself (focus is ${await focusedDescription(page)})`,
  ).toBe(true);

  const visited = new Set<string>();
  for (let press = 0; press < 20; press += 1) {
    await page.keyboard.press('Tab');
    expect(
      await focusIsInside(dialog),
      `Tab escaped ${label} after ${String(press + 1)} presses (focus is ${await focusedDescription(page)})`,
    ).toBe(true);
    visited.add(await focusedDescription(page));
  }
  expect(
    visited.size,
    `${label} never moved focus while cycling; a trap that pins focus to one element proves nothing`,
  ).toBeGreaterThan(1);

  for (let press = 0; press < 20; press += 1) {
    await page.keyboard.press('Shift+Tab');
    expect(
      await focusIsInside(dialog),
      `Shift+Tab escaped ${label} after ${String(press + 1)} presses`,
    ).toBe(true);
  }

  await page.keyboard.press('Escape');
  await expect(dialog, `Escape did not close ${label}`).toHaveCount(0);
  await expect(
    trigger,
    `${label} did not restore focus to the control that opened it`,
  ).toBeFocused({ timeout: 10_000 });
}

test('@a11y calibration dialogs trap focus and restore it to their trigger', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      queue: 'assigned',
    });

    await openCalibrationWorkspace(page);
    await expectDialogTrapsAndRestores(page, {
      trigger: page.getByRole('button', {
        name: 'Import a legacy calibration backup file',
      }),
      dialog: page.getByRole('dialog', {
        name: 'Import Legacy Calibration Backup',
      }),
      label: 'the legacy import dialog',
    });

    await openTemperatureStage(page);
    await expectDialogTrapsAndRestores(page, {
      trigger: page.getByRole('button', { name: 'Confirm bed clear' }),
      dialog: page.getByRole('dialog', { name: 'Confirm Bed Clear' }),
      label: 'the bed-clear safety dialog',
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Recovery states — dashboard scope
// ---------------------------------------------------------------------------

test('@a11y calibration announces offline, permission and capability recovery states', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await withCalibrationApp(async ({ app, page }) => {
    const createProject = page.getByRole('button', {
      name: 'New calibration project',
    });
    const offlineMessage = page.getByText(
      /Offline: saved projects can be edited and queued locally/,
    );
    const permissionMessage = page.getByText(/^Permission denied:/);
    const capabilityMessage = page.getByText(
      /Calibration is unavailable on this PrintFarmer server\./,
    );

    await applyAndOpenDashboard(app, page, { offline: true });
    await expectRecoveryState({
      state: 'offline',
      signal: page
        .getByRole('button', { name: 'New calibration project' })
        .and(page.locator('[disabled]')),
      signalDescription: 'the disabled "New calibration project" control',
      message: offlineMessage,
    });

    await applyAndOpenDashboard(app, page, { availability: 'missingScopes' });
    await expectRecoveryState({
      state: 'permission denied',
      signal: page
        .getByRole('button', { name: 'New calibration project' })
        .and(page.locator('[disabled]')),
      signalDescription: 'the disabled "New calibration project" control',
      message: permissionMessage,
    });

    await applyAndOpenDashboard(app, page, {
      availability: 'missingCapabilityFlags',
    });
    await expectRecoveryState({
      state: 'capability unavailable',
      signal: page
        .getByRole('button', { name: 'New calibration project' })
        .and(page.locator('[disabled]')),
      signalDescription: 'the disabled "New calibration project" control',
      message: capabilityMessage,
    });

    // Negative control. A fixture that silently no-ops would make all three
    // assertions above pass here too.
    await applyAndOpenDashboard(app, page, {});
    await expect(createProject).toBeEnabled({ timeout: 15_000 });
    await expect(offlineMessage).toHaveCount(0);
    await expect(permissionMessage).toHaveCount(0);
    await expect(capabilityMessage).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Recovery states — project scope
// ---------------------------------------------------------------------------

test('@a11y calibration announces stale, conflict, generation and dispatch recovery states', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(360_000);

  await withCalibrationApp(async ({ app, page }) => {
    const staleMessage = page.getByText(
      /The bound printer snapshot is stale\./,
    );
    const conflictMessage = page.getByText(
      /This project has an unresolved conflict\./,
    );
    const uncertainMessage = page.getByText(
      /The server has not yet confirmed whether the print started\./,
    );

    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      staleContext: true,
    });
    await openCalibrationWorkspace(page);
    const staleBadge = page.getByText('Stale snapshot', { exact: true });
    await expect(
      staleBadge,
      'the stale scenario produced no "Stale snapshot" badge, so the alert assertion would prove nothing',
    ).toBeVisible({ timeout: 15_000 });
    await openFixtureProject(page);
    await expectRecoveryState({
      state: 'stale printer context',
      signal: page.getByRole('button', { name: /Open Temperature,/i }),
      signalDescription: 'the project overview',
      message: staleMessage,
    });

    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      hasConflicts: true,
    });
    await openCalibrationWorkspace(page);
    const conflictBadge = page.getByText('Conflict', { exact: true });
    await expect(
      conflictBadge,
      'the conflict scenario produced no "Conflict" badge, so the alert assertion would prove nothing',
    ).toBeVisible({ timeout: 15_000 });
    await openFixtureProject(page);
    await expectRecoveryState({
      state: 'unresolved conflict',
      signal: page.getByRole('button', { name: /Open Temperature,/i }),
      signalDescription: 'the project overview',
      message: conflictMessage,
    });

    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      orchestration: 'failed',
    });
    await openTemperatureStage(page);
    await page
      .getByRole('button', { name: 'Generate calibration model' })
      .click();
    const generationAlert = page.getByRole('alert', {
      name: 'Calibration generation status',
    });
    await expectRecoveryState({
      state: 'failed generation',
      signal: generationAlert.getByText('Failed', { exact: true }),
      signalDescription: 'a Failed orchestration status',
      message: generationAlert,
    });

    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      queue: 'unknownOutcome',
    });
    await openTemperatureStage(page);
    await expectRecoveryState({
      state: 'uncertain print start',
      signal: page.getByText('Starting…', { exact: true }).first(),
      signalDescription: 'a "Starting…" dispatch status',
      message: uncertainMessage,
    });
    // Criterion 9: an uncertain start must not offer a blind retry. After #225
    // the panel deliberately carries a control named "Retry loading status",
    // which names the fetch it retries and is the opposite of blind — so the
    // old /^Retry/ prefix would fail on the fix for the very hazard it guards.
    // What must never exist is a control that reads as retrying the print.
    //
    // issue #224: the two assertions below are absence assertions, and in this
    // scenario they hold against ZERO candidate elements — `unknownOutcome`'s
    // fetch succeeds, so `fetchError` is null, the panel's retry block never
    // mounts, and they cannot distinguish "no blind retry" from "no retry
    // region". They would keep passing if the rule were deleted. The
    // `unknownOutcomeRefetchFailure` pass below supplies the missing domain.
    await expect(
      page.getByRole('button', { name: /^retry$/i }),
      'an uncertain start offered an unqualified Retry, which reads as retrying the print',
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /retry.*(print|dispatch|job)/i }),
      'an uncertain start offered a control naming a print/dispatch retry, which risks a duplicate print',
    ).toHaveCount(0);

    // issue #224: the same rule, asserted where a retry affordance actually
    // renders. The three positive controls below are what make the two
    // absence assertions after them mean anything.
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      queue: 'unknownOutcomeRefetchFailure',
    });
    await openTemperatureStage(page);
    const dispatchPanel = page.getByRole('region', {
      name: 'Queue and dispatch status',
    });
    await expect(
      dispatchPanel.getByRole('button', { name: 'Retry loading status' }),
      'POSITIVE CONTROL: the failed-refetch co-render did not occur, so the absence assertions below would hold vacuously',
    ).toHaveCount(1);
    await expect(
      dispatchPanel.getByText('Network timeout'),
      'POSITIVE CONTROL: the fetch error is not rendered, so this is not the co-render state',
    ).toHaveCount(1);
    await expect(
      page.getByText(/Do not retry/).first(),
      'POSITIVE CONTROL: the unresolved-outcome guidance was cleared, so this is no longer a co-render',
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^retry$/i }),
      'a failed refetch beside an unresolved outcome offered an unqualified Retry',
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /retry.*(print|dispatch|job)/i }),
      'a failed refetch beside an unresolved outcome offered a print/dispatch retry',
    ).toHaveCount(0);

    // Negative control for all four.
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      queue: 'assigned',
    });
    await openCalibrationWorkspace(page);
    await expect(page.getByText('Stale snapshot', { exact: true })).toHaveCount(
      0,
    );
    await expect(page.getByText('Conflict', { exact: true })).toHaveCount(0);
    await openFixtureProject(page);
    await expect(staleMessage).toHaveCount(0);
    await expect(conflictMessage).toHaveCount(0);
    await openTemperatureStage(page);
    await expect(uncertainMessage).toHaveCount(0);
    await expect(
      page.getByRole('alert', { name: 'Calibration generation status' }),
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Install rollback
// ---------------------------------------------------------------------------

test('@a11y calibration announces an actionable profile install rollback', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      verified: true,
    });
    await openProfileView(page);

    await page
      .getByRole('button', { name: 'Generate OrcaSlicer profile' })
      .click();
    await expect(page.getByText(/^Fields patched:/)).toBeVisible({
      timeout: 15_000,
    });

    const install = page.getByRole('button', {
      name: 'Install transactionally',
    });
    if ((await install.count()) === 0) {
      // Documented platform behaviour: darwin/linux expose "Export profile…"
      // instead of a transactional install, so there is no rollback to prove.
      await expect(
        page.getByRole('button', { name: 'Export profile…' }),
        'neither a transactional install nor an export path is offered',
      ).toBeVisible();
      test.skip(true, 'Transactional install and rollback are Windows-only.');
      return;
    }

    await install.click();
    await expect(page.getByText(/^Installed\. Hash:/)).toBeVisible({
      timeout: 15_000,
    });

    const restore = page.getByRole('button', { name: 'Restore from backup' });
    await expect(
      restore,
      'a transactional install offered no rollback control',
    ).toBeVisible();

    // The install genuinely happened before the rollback: without this the
    // rollback assertions below would prove nothing.
    const installedHash = page.getByText(/^Installed\. Hash:/);
    await expect(installedHash).toBeVisible();

    await restore.click();

    const status = page
      .getByRole('status')
      .filter({ hasText: /Profile restored from backup\./ })
      .first();
    await expect(
      status,
      'the rollback produced no announced status message',
    ).toBeVisible({ timeout: 15_000 });
    const restoredText = (await status.innerText()).trim();
    expect(
      restoredText,
      `the rollback message does not name a next action: "${restoredText}"`,
    ).toMatch(NEXT_ACTION);

    // The rollback genuinely reverted: the install evidence is gone.
    await expect(
      installedHash,
      'the rollback announced success while the installed-profile hash remained',
    ).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------
// 7. Print media
// ---------------------------------------------------------------------------

test('@a11y calibration report prints without local paths or credentials', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(240_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      verified: true,
    });
    await openReportView(page);

    await page.emulateMedia({ media: 'print' });
    const report = page.getByRole('article', { name: CAL.displayName });
    await expect(
      report,
      'the report did not render under print media, so a leak scan of it would prove nothing',
    ).toBeVisible({ timeout: 15_000 });

    const printed = await report.innerText();
    expect(
      printed.trim().length,
      'the printed report is empty, so a leak scan of it would prove nothing',
    ).toBeGreaterThan(200);
    expect(
      printed,
      'the printed report lost its immutable identity section',
    ).toContain('Immutable identity');

    for (const [description, pattern] of LEAKS) {
      expect(printed, `the printed report contains ${description}`).not.toMatch(
        pattern,
      );
    }

    await page.emulateMedia({ media: 'screen' });
  });
});

// ---------------------------------------------------------------------------
// 8. Reduced motion, dark theme and 200% zoom
// ---------------------------------------------------------------------------

/*
 * What the dark-theme half of this test does NOT prove, stated here rather than
 * in a pull request body, because the PR body is not what the next author reads
 * and a test's *name* is a durable claim that outlives everyone who knew what it
 * meant.
 *
 * There are no `prefers-color-scheme` rules anywhere in this codebase. Emulating
 * `colorScheme: 'dark'` therefore does not select a dark theme, because there is
 * no dark theme to select. What this asserts is narrower and still worth having:
 * an axe contrast regression guard that runs with the dark preference set, so
 * that if a dark theme is ever added, contrast failures surface here rather than
 * at a user.
 *
 * Do not read "in dark theme" in the surface names below as evidence that a dark
 * theme exists. If one is added, this comment is the thing to delete.
 */

test('@a11y calibration holds up under reduced motion, dark theme and 200% zoom', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      queue: 'assigned',
    });
    await openTemperatureStage(page);
    const workflow = page.getByRole('heading', {
      name: 'Temperature',
      level: 1,
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(
      workflow,
      'the step workflow did not render under reduced motion',
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
      name: 'calibration step workflow in dark theme',
      present: workflow,
      testInfo,
    });

    await page.getByRole('button', { name: 'Confirm bed clear' }).click();
    const bedClear = page.getByRole('dialog', { name: 'Confirm Bed Clear' });
    await scanSurface(page, {
      name: 'bed clear safety dialog in dark theme',
      present: bedClear,
      testInfo,
    });
    await page.emulateMedia({ colorScheme: 'light' });

    // 200% zoom is emulated by halving the CSS viewport. WCAG 1.4.10 requires
    // reflow without two-dimensional scrolling at that magnification.
    const original = page.viewportSize() ?? { width: 1280, height: 1024 };
    await page.setViewportSize({
      width: Math.round(original.width / 2),
      height: Math.round(original.height / 2),
    });
    await expect(
      bedClear,
      'the bed-clear dialog did not survive 200% zoom',
    ).toBeVisible();
    await expect(
      bedClear.getByRole('region', { name: 'Job details' }),
      'the bed-clear dialog lost its job details at 200% zoom',
    ).toBeVisible();

    // WCAG 1.4.10 forbids two-dimensional scrolling at 200%. Checking only
    // documentElement would be an assertion that cannot fail here, because
    // `.cal-workspace-content` is `overflow: auto` and absorbs any overflow
    // into its own scroller. So every scroll container is inspected.
    const horizontalScrollers = await page.evaluate(() => {
      const offenders: string[] = [];
      const nodes: Element[] = [
        document.documentElement,
        ...Array.from(document.querySelectorAll('*')),
      ];
      for (const node of nodes) {
        if (node.scrollWidth <= node.clientWidth + 1) continue;
        // Visually hidden (sr-only) elements are clipped to 1px by design.
        if (node !== document.documentElement && node.clientWidth <= 1)
          continue;
        const overflowX = getComputedStyle(node).overflowX;
        if (node !== document.documentElement && overflowX === 'visible') {
          continue;
        }
        const id = node.id ? `#${node.id}` : '';
        const cls = node.className
          ? `.${String(node.className).trim().split(/\s+/).join('.')}`
          : '';
        offenders.push(
          `${node.tagName.toLowerCase()}${id}${cls} (${String(node.scrollWidth)}px in ${String(node.clientWidth)}px)`,
        );
      }
      return offenders;
    });
    expect(
      horizontalScrollers,
      `these containers scroll horizontally at 200% zoom: ${horizontalScrollers.join('; ')}`,
    ).toEqual([]);

    const dialogBox = await bedClear.boundingBox();
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    expect(
      dialogBox,
      'the bed-clear dialog has no layout box at 200% zoom',
    ).not.toBeNull();
    expect(
      (dialogBox?.x ?? 0) >= -1 &&
        (dialogBox?.x ?? 0) + (dialogBox?.width ?? 0) <= viewport.width + 1,
      `the bed-clear dialog is clipped horizontally at 200% zoom (x=${String(dialogBox?.x)}, width=${String(dialogBox?.width)}, viewport=${String(viewport.width)})`,
    ).toBe(true);

    await page.keyboard.press('Escape');
    await expect(bedClear).toHaveCount(0);
    await expect(
      workflow,
      'the step workflow heading was lost at 200% zoom',
    ).toBeVisible();
    await page.setViewportSize(original);
  });
});
