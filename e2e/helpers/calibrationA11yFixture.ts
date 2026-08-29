/**
 * Deterministic filament-calibration fixtures for the packaged-bundle
 * accessibility and journey specs.
 *
 * The packaged binary ships with `RunAsNode: false` (see `forge.config.ts`), so
 * Playwright's Electron launcher cannot drive it and the CDP attach used by
 * `helpers/packagedApp.ts` exposes no main process. Without `ipcMain` there is
 * no way to make a recovery state genuinely enter, and a recovery assertion
 * that cannot enter its state is an assertion that cannot fail. These helpers
 * therefore drive the production `.vite` bundles — the same renderer bundle
 * that is packaged — with fixture handlers installed in the main process, the
 * pattern already proven in `e2e/calibration.spec.ts`.
 *
 * Every scenario is applied to a single long-lived Electron app by replacing
 * the handlers and reloading the renderer, so the workspace store remounts and
 * observes the scenario from startup.
 *
 * **Post-#756 scope.** The printer-calibration saga was reaped in #756. Under
 * Path D the calibration workspace is a filament-spool wizard behind a
 * dashboard with a single primary CTA. The helpers below stub only the IPC
 * channels the filament dashboard + wizard actually consume:
 * `serverProfiles:list`, `catalog:listModels`, `calibration:getAvailability`,
 * `calibration:listPrinters`, and the wizard state read (empty). Saga
 * workspace-state, printer-context, orca-profile-list, workspace-save,
 * and generation/queue/orchestration/bed-clear stubs were removed with the
 * subjects they targeted.
 */
import AxeBuilder from '@axe-core/playwright';
import type { Result } from 'axe-core';
import {
  expect,
  _electron as electron,
  type ElectronApplication,
  type Locator,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IpcSchemas } from '@shared/ipc';
import type { z } from 'zod';

/**
 * Channels this fixture is allowed to stub, and the response each one owes.
 *
 * Derived from the live `ipcSchemas` registry rather than restated here, so a
 * channel whose contract changes cannot leave a stub behind that still
 * compiles. The previous signature took `channel: string` and returned
 * `unknown`, which meant the compiler checked no response shape at all: a stub
 * could return `{}` for every channel and typecheck stayed green while every
 * surface under test rendered its error state. That is the failure this
 * annotation exists to make impossible, and it is not hypothetical -- it is
 * how a fixture regression reached trunk.
 */
type StubbedChannel = keyof IpcSchemas;
type StubResponse<C extends StubbedChannel> = z.infer<
  IpcSchemas[C]['response']
>;

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);

const requiredArtifacts = [
  path.join(repoRoot, '.vite', 'build', 'main.js'),
  path.join(repoRoot, '.vite', 'build', 'preload.js'),
  path.join(repoRoot, '.vite', 'renderer', 'main_window', 'index.html'),
];

export const WCAG_TAGS = [
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
];
const MATERIAL_IMPACTS = new Set(['moderate', 'serious', 'critical']);

export const CAL = {
  now: '2026-07-29T10:00:00.000Z',
  profileId: 'f1111111-f111-4111-8111-111111111111',
  printerId: 'f3333333-f333-4333-8333-333333333333',
  altPrinterId: 'f3333333-f333-4333-8333-333333333334',
  printerModelId: 'a2222222-a222-4222-8222-222222222222',
  displayName: 'A11y Fixture Printer',
  altDisplayName: 'A11y Fixture Printer B',
} as const;

export type AvailabilityScenario =
  'ok' | 'missingScopes' | 'missingCapabilityFlags' | 'operatorDisabled';

export type PrinterListScenario = 'populated' | 'empty';

export interface CalibrationScenario {
  /** Availability request rejects, which is the store's offline signal. */
  readonly offline?: boolean;
  readonly availability?: AvailabilityScenario;
  /**
   * `populated` seeds two printers so the wizard's Step 1 picker renders
   * options and the ProfileSelectionSection can mount. `empty` returns no
   * printers so the "No PrintFarmer printers are available" hint renders —
   * this is the negative discriminator for the printer-list contract that
   * used to be enforced by the retired candidate endpoint.
   */
  readonly printerList?: PrinterListScenario;
}

interface FixtureArgs {
  readonly scenario: CalibrationScenario;
  readonly ids: typeof CAL;
}

export async function launchCalibrationApp(): Promise<{
  app: ElectronApplication;
  page: Page;
  stateRoot: string;
}> {
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run test:e2e` (which builds first) before the accessibility suite.',
      );
    }
  }
  // Kept out of the repository tree: a locked SQLite handle on Windows can
  // defeat cleanup, and a stray state directory must never look like a change.
  const stateRoot = mkdtempSync(path.join(tmpdir(), 'pf-cal-a11y-'));
  const userDataPath = path.join(stateRoot, 'user-data');
  mkdirSync(userDataPath, { recursive: true });
  const app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: {
      ...process.env,
      PRINTFARMER_CATALOG_DB: path.join(stateRoot, 'catalog.sqlite3'),
      PRINTFARMER_USER_DATA_PATH: userDataPath,
    },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, stateRoot };
}

/**
 * Installs the fixture handlers for one scenario and reloads the renderer so
 * the calibration store observes the scenario from its first request.
 */
export async function applyCalibrationScenario(
  app: ElectronApplication,
  page: Page,
  scenario: CalibrationScenario,
): Promise<void> {
  const args: FixtureArgs = { scenario, ids: CAL };

  await app.evaluate(({ ipcMain }, { scenario, ids }) => {
    const handle = <C extends StubbedChannel>(
      channel: C,
      handler: (...a: never[]) => StubResponse<C> | Promise<StubResponse<C>>,
    ) => {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, handler as never);
    };

    handle('serverProfiles:list', () => ({
      profiles: [
        {
          id: ids.profileId,
          displayName: 'A11y Test Server',
          baseUrl: 'http://localhost:8000',
          authMode: 'apiKey',
          version: {
            service: 'PrintFarmer',
            version: '2.0',
            commit: null,
            environment: 'test',
            runtime: 'node',
            timestamp: ids.now,
          },
          capabilities: {
            architecture: 'test',
            slicingEnabled: true,
            modelFilesEnabled: true,
            thumbnailGenerationEnabled: false,
            gcodeUploadEnabled: true,
            clientThumbnailUploadEnabled: false,
            idempotentModelUploadEnabled: true,
            modelThumbnailReplacementEnabled: false,
            platformNote: null,
          },
          availability: {
            modelUpload: { mode: 'modern', available: true, reason: null },
            librarySync: { mode: 'modern', available: true, reason: null },
            clientThumbnailUpload: {
              mode: 'unavailable',
              available: false,
              reason: null,
            },
            serverThumbnailFallback: {
              mode: 'unavailable',
              available: false,
              reason: 'Not required',
            },
          },
          status: 'connected',
          lastCheckedAt: ids.now,
          warnings: [],
        },
      ],
      selectedProfileId: ids.profileId,
    }));

    handle('catalog:listModels', () => []);

    const availabilityKind = scenario.availability ?? 'ok';
    handle('calibration:getAvailability', () => {
      if (scenario.offline === true) {
        // The store treats a rejected availability request as offline.
        throw new Error('PrintFarmer is unreachable from this workstation.');
      }
      const available = availabilityKind === 'ok';
      return {
        available,
        unavailableReason: available ? null : availabilityKind,
        unavailableDetail: null,
        negotiatedApiVersion: '2',
        negotiatedSchemaVersion: '2.0',
        capabilityFlags: {
          calibrationApiEnabled: true,
          calibrationChangeFeedEnabled: true,
          calibrationOfflineDraftEnabled: true,
          calibrationPhotoUploadEnabled: true,
          calibrationGenerationEnabled:
            availabilityKind !== 'missingCapabilityFlags',
          calibrationArtifactPromotionEnabled:
            availabilityKind !== 'missingCapabilityFlags',
        },
        // Canonical `resource:action` permissions, exactly as PrintFarmer's
        // capability payload spells them in `effectivePermissions`. The former
        // PascalCase values matched nothing in production, so a fixture using
        // them proved only that the assertion never fired.
        grantedScopes:
          availabilityKind === 'missingScopes'
            ? ['calibration:read']
            : ['calibration:read', 'calibration:create', 'calibration:update'],
        offlineEditingEnabled: true,
        serverUnavailableReasons: [],
      };
    });

    // Filament wizard reads its persisted state on mount; return `null`
    // (channel schema allows a nullable record) so the wizard always
    // starts fresh in fixtures. A previous persisted record is out of
    // scope for the a11y and journey specs — the restart-resilience
    // paths are covered by vitest unit tests.
    handle('calibration:getFilamentWizardState', () => null);

    // Workspace-state hydration lives on the calibration store from the
    // pre-#756 saga era. Under Path D the shipped dashboard does not
    // consume any of the returned state, but the store still fetches on
    // mount — an empty list is the safe stub that keeps the store's
    // error surface quiet without seeding a saga-flavoured record the
    // filament flow neither wants nor renders.
    handle('calibration:listWorkspaceStates', () => ({
      states: [],
      unhydratedProjects: [],
    }));

    const printerListScenario = scenario.printerList ?? 'populated';
    handle('calibration:listPrinters', () => {
      const printers =
        printerListScenario === 'populated'
          ? [
              {
                printerId: ids.printerId,
                displayName: ids.displayName,
                printerModel: 'A11y Reference Klipper',
                printerModelId: ids.printerModelId,
                isOnline: scenario.offline !== true,
              },
              {
                printerId: ids.altPrinterId,
                displayName: ids.altDisplayName,
                // Model unknown — exercises the wider-pool fallback the
                // retired candidate contract used to protect (see
                // `profileSelection.ts:49-53`).
                printerModel: null,
                printerModelId: null,
                isOnline: scenario.offline !== true,
              },
            ]
          : [];
      return {
        printers,
        printersTruncated: false,
        printersUnreadable: 0,
        fetchedAt: ids.now,
      };
    });
  }, args);

  // Seed a library source root so the onboarding modal does not block the
  // Filament Calibration nav button on reload.
  await page.evaluate(() => {
    localStorage.setItem(
      'printfarmer.library.sourceRoots.v1',
      JSON.stringify({
        version: 1,
        roots: [
          {
            rootId: 'a11y-fixture-root',
            path: '/fixtures/a11y-models',
            approvalId: null,
            removed: false,
            lastReport: null,
            lastScannedAt: null,
          },
        ],
      }),
    );
  });

  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await expect(
    page.getByRole('button', { name: 'Filament Calibration' }),
  ).toBeEnabled({ timeout: 20_000 });
}

/**
 * Navigates to the Filament Calibration dashboard and waits for it to render.
 * Idempotent — if the dashboard heading is already visible, returns
 * immediately.
 */
export async function openCalibrationWorkspace(page: Page): Promise<void> {
  const dashboardHeading = page.getByRole('heading', {
    name: 'Filament Calibration',
    level: 1,
  });
  if (!(await dashboardHeading.isVisible())) {
    const backToDashboard = page
      .getByRole('navigation', { name: 'Calibration views' })
      .getByRole('button', { name: 'Dashboard' });
    if (await backToDashboard.isVisible()) {
      await backToDashboard.click();
    } else {
      await page.getByRole('button', { name: 'Filament Calibration' }).click();
    }
  }
  await expect(
    page.getByRole('main', { name: 'Filament calibration workspace' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(dashboardHeading).toBeVisible({ timeout: 15_000 });
}

/**
 * Opens the Filament Calibration Wizard from the dashboard and waits for
 * Step 1 to render. Requires a scenario with `availability: 'ok'` and
 * `offline: false` (default) — otherwise the primary CTA is disabled and
 * this helper would time out on an unclickable button, which is the correct
 * failure for a test that expects to reach the wizard.
 */
export async function openFilamentCalibrationWizard(page: Page): Promise<void> {
  await openCalibrationWorkspace(page);
  await page
    .getByRole('button', { name: 'Calibrate a filament spool' })
    .click();
  await expect(
    page.getByRole('heading', {
      name: 'Filament calibration wizard',
      level: 1,
    }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * A control with no accessible name. Injected into a surface to prove the
 * scanner reports, because `0 violations` and `scanner not wired` are the same
 * observation until non-zero has been shown to be reachable. Sized explicitly
 * so it cannot be skipped as a zero-area element.
 */
const AXE_PROBE_RULE = 'button-name';

async function withAxeProbe<T>(
  container: Locator,
  run: () => Promise<T>,
): Promise<T> {
  await container.evaluate((node) => {
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.setAttribute('data-axe-probe', 'true');
    probe.style.cssText = 'width:44px;height:44px;opacity:0.01;';
    node.append(probe);
  });
  try {
    return await run();
  } finally {
    await container.evaluate((node) => {
      node.querySelector('[data-axe-probe]')?.remove();
    });
  }
}

/**
 * Asserts the surface actually rendered, that the scanner reports violations
 * in it, and only then that it has none.
 *
 * Two independent lies are defeated here. An axe scan of a container that
 * never rendered reports zero violations, so `present` must be visible and
 * non-empty first. And a misconfigured scanner — wrong scope, disabled rules,
 * a failed injection — reports zero violations on a fully rendered page, which
 * the render precondition cannot see. So a known violation is injected into
 * this specific surface and the scan must report it before the clean scan is
 * believed. `present` must be a locator unique to the surface under test.
 */
export async function scanSurface(
  page: Page,
  options: {
    readonly name: string;
    readonly present: Locator;
    readonly testInfo: TestInfo;
    readonly include?: string;
  },
): Promise<void> {
  const { name, present, testInfo } = options;
  await expect(
    present,
    `${name} did not render, so an axe scan of it would prove nothing`,
  ).toBeVisible({ timeout: 15_000 });
  const text = (await present.innerText()).trim();
  expect(
    text.length,
    `${name} rendered empty, so an axe scan of it would prove nothing`,
  ).toBeGreaterThan(0);

  const scan = async (): Promise<Result[]> => {
    // Electron's CDP target cannot create Axe's blank aggregation page. This
    // app has no frames, so legacy mode runs the same rules against the UI.
    let builder = new AxeBuilder({ page }).setLegacyMode().withTags(WCAG_TAGS);
    if (options.include !== undefined) {
      builder = builder.include(options.include);
    }
    const results = await builder.analyze();
    return results.violations.filter(
      (violation) =>
        typeof violation.impact === 'string' &&
        MATERIAL_IMPACTS.has(violation.impact),
    );
  };

  const probed = await withAxeProbe(present, scan);
  const detected = probed.find((violation) => violation.id === AXE_PROBE_RULE);
  expect(
    detected?.id,
    `the axe scan of ${name} did not report a deliberately unnamed button, so it is not scanning this surface and its zero-violation result would prove nothing (reported: ${probed.map((violation) => violation.id).join(', ') || 'nothing'})`,
  ).toBe(AXE_PROBE_RULE);
  expect(
    detected?.nodes.length ?? 0,
    `the axe scan of ${name} reported ${AXE_PROBE_RULE} with no nodes`,
  ).toBeGreaterThan(0);

  const material = await scan();
  if (material.length > 0) {
    await testInfo.attach(`axe-${name.replaceAll(' ', '-')}.json`, {
      body: Buffer.from(JSON.stringify(material, null, 2)),
      contentType: 'application/json',
    });
  }
  expect(material, `${name} has material WCAG A/AA violations`).toEqual([]);
}

/** Accessible name and role of the currently focused element. */
export async function focusedDescription(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return '<body>';
    const label =
      active.getAttribute('aria-label') ??
      (active.textContent ?? '').trim().slice(0, 80);
    return `${active.tagName.toLowerCase()}[${active.getAttribute('role') ?? 'implicit'}] "${label}"`;
  });
}

/**
 * Tabs forward until `target` is focused, asserting focus actually moved and
 * that the element reached sits inside `expectedContainer` when given.
 *
 * A traversal that ends where it started, or that never reaches the named
 * element, is a dead end — this reports which named element it could not
 * reach and where focus ended up.
 */
export async function expectTabReaches(
  page: Page,
  target: Locator,
  description: string,
  maxPresses = 60,
  expectedContainer?: Locator,
): Promise<void> {
  const start = await focusedDescription(page);
  const seen: string[] = [];
  for (let press = 0; press < maxPresses; press += 1) {
    await page.keyboard.press('Tab');
    const current = await focusedDescription(page);
    seen.push(current);
    if (await target.evaluate((node) => node === document.activeElement)) {
      expect(
        current,
        `Tab left focus on ${start}; a traversal that does not move proves nothing`,
      ).not.toBe(start);
      if (expectedContainer !== undefined) {
        expect(
          await focusIsInside(expectedContainer),
          `Tab reached ${description}, but that element is not inside the surface under test (focus is ${current})`,
        ).toBe(true);
      }
      return;
    }
  }
  throw new Error(
    `Tab never reached ${description} in ${String(maxPresses)} presses.\n` +
      `Focus started on ${start} and visited:\n  ${seen.join('\n  ')}`,
  );
}

/** True when the focused element is inside `container`. */
export async function focusIsInside(container: Locator): Promise<boolean> {
  return container.evaluate(
    (node) =>
      document.activeElement !== null && node.contains(document.activeElement),
  );
}
