/**
 * Printer Calibration end-to-end user journeys (issue #156).
 *
 * These run in the packaged Electron app under the `Release package` job, which
 * executes `playwright test --grep-invert "@gpu|@a11y"`. Registration therefore
 * needs no workflow change and no branch-protection change: the tests gate
 * merges the moment they land, with no window in which they run but do not
 * block. That is the same reasoning #153 used to register its suite by import.
 *
 * The failure class these are built against is *the assertion that passes
 * because nothing resolved*. `expect(locator).toHaveCount(0)` succeeds when the
 * affordance is correctly gated, and it succeeds identically when the
 * accessible name is misspelled, when the panel never rendered, and when the
 * scenario was never applied. An offline suite written without controls is a
 * suite that cannot fail in the direction it exists to detect.
 *
 * So every absence assertion here is paired with one of two controls:
 *
 *   - a *positive control* — the same locator, same name, in the scenario where
 *     the affordance is legitimately offered. If the offline case says "absent"
 *     and the online case also says "absent", the name is wrong, not the gate.
 *   - an *injected counterfactual* — a matching element is inserted into the
 *     live surface, the query is required to find it, and it is removed again
 *     before the real assertion runs. This proves the query can return a
 *     positive against this DOM on this run, which a positive control taken in
 *     a different scenario does not.
 *
 * The counterfactual is Dallas's `scanSurface` instrument from #153 turned
 * around: his injects a violation and requires the detector to fire before he
 * believes a clean scan; this injects a match and requires the locator to fire
 * before believing an empty one.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import { rmSync } from 'node:fs';
import {
  applyCalibrationScenario,
  launchCalibrationApp,
  openCalibrationWorkspace,
  openTemperatureStage,
} from './helpers/calibrationA11yFixture';

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
 * Proves `locator` is capable of matching in the *current* DOM, then asserts it
 * matches nothing.
 *
 * `build` receives the page and must insert an element the locator would match.
 * It returns a teardown that removes it. If the injected element is not found,
 * the locator is broken — a misspelled name, a role that never renders, a
 * surface that failed to mount — and the subsequent absence assertion would
 * have passed for a reason unrelated to the gate under test.
 */
async function expectAbsentWithCounterfactual(options: {
  readonly what: string;
  readonly locator: Locator;
  readonly page: Page;
  readonly inject: (page: Page) => Promise<void>;
  readonly remove: (page: Page) => Promise<void>;
}): Promise<void> {
  const { what, locator, page, inject, remove } = options;

  await inject(page);
  try {
    await expect(
      locator,
      `counterfactual for "${what}" did not resolve: the locator cannot match ` +
        `anything in this DOM, so asserting its absence would prove nothing ` +
        `about whether the affordance is gated`,
    ).toHaveCount(1, { timeout: 15_000 });
  } finally {
    await remove(page);
  }

  await expect(
    locator,
    `counterfactual teardown failed for "${what}": the injected element is ` +
      `still present, so the real assertion below cannot be trusted`,
  ).toHaveCount(0, { timeout: 15_000 });
}

/** Inserts a button carrying `name` as its accessible name, and removes it. */
const COUNTERFACTUAL_ID = 'hicks-156-counterfactual';

async function injectButton(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ id, label }) => {
      const existing = document.getElementById(id);
      existing?.remove();
      const button = document.createElement('button');
      button.id = id;
      button.type = 'button';
      button.textContent = label;
      document.body.append(button);
    },
    { id: COUNTERFACTUAL_ID, label: name },
  );
}

async function removeInjectedButton(page: Page): Promise<void> {
  await page.evaluate((id) => {
    document.getElementById(id)?.remove();
  }, COUNTERFACTUAL_ID);
}

// ---------------------------------------------------------------------------
// Offline gating, end to end, with paired positive controls
// ---------------------------------------------------------------------------

/**
 * Write affordances and the surface each is offered on. The names are ones
 * #153 already asserts, so they are known to exist rather than transcribed
 * from a description — but *existing* and *being on the surface you opened*
 * are different claims, and conflating them is what the first run of this
 * spec got wrong: `Generate calibration model` is a temperature-stage
 * control, and asserting it from the dashboard found nothing.
 */
const OFFLINE_GATED_CONTROLS = [
  {
    name: 'New calibration project',
    surface: 'calibration dashboard',
    open: openCalibrationWorkspace,
  },
  {
    name: 'Generate calibration model',
    surface: 'temperature stage',
    open: openTemperatureStage,
  },
] as const;

test('calibration write affordances are offered online on their own surfaces', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      verified: true,
    });

    for (const control of OFFLINE_GATED_CONTROLS) {
      await control.open(page);
      await expect(
        page.getByRole('button', { name: control.name }),
        `"${control.name}" is not enabled on the ${control.surface} while ` +
          `online, so any later assertion that it is unavailable offline ` +
          `would prove nothing about gating`,
      ).toBeEnabled({ timeout: 15_000 });
    }
  });
});

test('calibration write affordances are gated while offline', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await withCalibrationApp(async ({ app, page }) => {
    // Scoped deliberately to the dashboard. #153 establishes that the
    // dashboard renders while the availability probe is rejecting; nothing
    // establishes that the temperature stage is reachable offline, and a
    // navigation that fails there would report as a gating failure rather
    // than as the unknown it is. The online control above covers the stage
    // selector; the offline behaviour of the stage-level generate control is
    // *not* covered here, and is called out in the PR rather than papered
    // over with an assertion that passes either way.
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      verified: true,
      offline: true,
    });
    await openCalibrationWorkspace(page);

    await expect(
      page.getByRole('button', { name: 'New calibration project' }),
      '"New calibration project" is still actionable while offline',
    ).toBeDisabled({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Unknown dispatch outcome: "Starting" stays "Starting"
// ---------------------------------------------------------------------------

test('an unknown dispatch outcome offers reconciliation guidance and no retry', async ({
  browserName,
}) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(300_000);

  await withCalibrationApp(async ({ app, page }) => {
    await applyCalibrationScenario(app, page, {
      withAttempt: true,
      queue: 'unknownOutcome',
    });
    await openTemperatureStage(page);

    // Render precondition. The panel element carries `aria-label="Queue and
    // dispatch status"` on a `<div>` with no role, so it is *not* exposed as a
    // named region and cannot be located by role and name. Its heading can be,
    // so the heading is the precondition here and the missing region name is
    // raised as a #153-class gap rather than worked around with a test id.
    const panelHeading = page.getByRole('heading', { name: 'Queue State' });
    await expect(
      panelHeading,
      'the queue and dispatch panel never rendered, so nothing below is a ' +
        'statement about the unknown-outcome behaviour',
    ).toBeVisible({ timeout: 15_000 });

    // The guidance must be announced and must tell the operator what to do
    // instead of retrying. Asserting only that a retry button is absent would
    // be satisfied by a panel that says nothing at all.
    const guidance = page.getByRole('status').filter({
      hasText: /has not yet confirmed whether the print started/i,
    });
    await expect(
      guidance,
      'the unknown outcome produced no announced reconciliation guidance',
    ).toBeVisible({ timeout: 15_000 });
    await expect(guidance).toContainText(/Do not retry/i);
    await expect(guidance).toContainText(/check the printer/i);

    // And the affordance must genuinely be absent — proven against a locator
    // shown to work on this DOM, this run.
    const retry = page.getByRole('button', { name: 'Retry' });
    await expectAbsentWithCounterfactual({
      what: 'a blind retry control beside an unknown dispatch outcome',
      locator: retry,
      page,
      inject: (target) => injectButton(target, 'Retry'),
      remove: removeInjectedButton,
    });
    await expect(
      retry,
      'a control named "Retry" is offered while the dispatch outcome is ' +
        'Unknown, which is exactly the duplicate print the guidance warns about',
    ).toHaveCount(0, { timeout: 15_000 });
  });
});
