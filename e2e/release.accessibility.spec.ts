import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  attachPackagedFailureDiagnostics,
  cleanupPackagedApp,
  createPackagedProcessLog,
  launchPackagedApp,
  type PackagedApp,
  type PackagedProcessLog,
  runWithPackagedTestCleanup,
} from './helpers/packagedApp';
import {
  modelFixtureDirectory,
  modelFixtureName,
} from './helpers/modelLibrary';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage.js';
import { scanSurface } from './helpers/calibrationA11yFixture';
import { findPackagedExecutable } from './helpers/retargetFixture';

// CI discovers accessibility tests across every spec with `playwright test --grep "@a11y"`.
// The calibration suite (issue #153) lives in a non-spec module for readability
// and is registered here by import.
//
// Registering here rather than adding a workflow step is deliberate: this file
// already runs inside a required status check, so these tests gate merges the
// moment they land, with no branch-protection change and no window in which
// they run but do not block.
import './calibrationA11yTests';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const materialImpacts = new Set(['moderate', 'serious', 'critical']);

test('@a11y packaged onboarding, library, and viewer meet material WCAG checks', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(120_000);
  let root: string | null = null;
  let launched: PackagedApp | null = null;
  let processLog: PackagedProcessLog | null = null;

  await runWithPackagedTestCleanup(
    async () => {
      processLog = createPackagedProcessLog();
      root = mkdtempSync(path.join(tmpdir(), 'pf-a11y-'));
      const userDataPath = path.join(root, 'user-data');
      const catalogDb = path.join(root, 'catalog.sqlite3');
      mkdirSync(userDataPath, { recursive: true });
      launched = await launchPackagedApp({
        executablePath: findPackagedExecutable(repoRoot),
        userDataPath,
        catalogDb,
        processLog,
        environment: {
          PRINTFARMER_E2E: '1',
          PRINTFARMER_E2E_OPEN_DIALOGS: JSON.stringify([modelFixtureDirectory]),
        },
      });
      const page = launched.page;
      await applyPinnedRenderingProfile(page);
      const onboarding = page.getByRole('dialog', {
        name: 'Set up your model library',
      });
      await expect(onboarding).toBeVisible();
      const addFolder = page.getByRole('button', {
        name: 'Add your first folder',
      });
      await expect(addFolder).toBeFocused();
      await expectNoMaterialViolations(page, 'onboarding', testInfo);
      await captureVisualScenario(
        page,
        'library.home.first-run-onboarding',
        testInfo,
      );
      await captureVisualScenario(page, 'onboarding.first-run', testInfo);
      await expect(
        page.getByText(
          /Connecting a PrintFarmer server sets this library up to upload selected models/,
        ),
      ).toBeVisible();
      await expect(
        page.getByRole('button', {
          name: 'Connect to PrintFarmer',
          exact: true,
        }),
      ).toBeEnabled();
      await captureVisualScenario(page, 'library.connection-nudge', testInfo);
      await expect(onboarding).toHaveAttribute('aria-modal', 'true');
      await expectNoMaterialViolations(
        page,
        'compact onboarding and live rail',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'onboarding.rail-interaction-compact',
        testInfo,
      );
      await page.getByRole('button', { name: /^Settings/ }).click();
      await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(onboarding).toHaveCount(0);
      await page.reload();
      await expect(onboarding).toBeVisible();
      await applyPinnedRenderingProfile(page);

      const closeOnboarding = page.getByRole('button', {
        name: 'Close onboarding',
      });
      await closeOnboarding.focus();
      await page.keyboard.press('Shift+Tab');
      const maybeLater = onboarding.getByRole('button', {
        name: 'Maybe later',
      });
      await expect(maybeLater).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(closeOnboarding).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(addFolder).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(
        onboarding.getByRole('button', { name: 'Maybe later' }),
      ).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(closeOnboarding).toBeFocused();
      await addFolder.click();

      const importDialog = page.getByRole('dialog', {
        name: 'Organize models before importing',
      });
      await expect(importDialog).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Cancel import' }),
      ).toBeFocused();
      await expectNoMaterialViolations(page, 'import review', testInfo);
      await captureVisualScenario(page, 'import.review', testInfo);
      const importButton = page.getByRole('button', { name: 'Import 1 file' });
      await importButton.scrollIntoViewIfNeeded();
      await importButton.click();
      await expect(importDialog).toHaveCount(0);

      await expect(
        page.getByRole('button', { name: `Select ${modelFixtureName}` }),
      ).toBeVisible();
      await expectNoMaterialViolations(page, 'populated model card', testInfo);
      await captureVisualScenario(
        page,
        'library.grid.populated-card',
        testInfo,
      );
      await page
        .getByRole('button', { name: `Select ${modelFixtureName}` })
        .click();
      const selectedModelCard = page.getByRole('button', {
        name: `Deselect ${modelFixtureName}`,
      });
      await expect(selectedModelCard).toHaveAttribute('aria-pressed', 'true');
      await expectNoMaterialViolations(
        page,
        'selected populated model card',
        testInfo,
      );
      await captureVisualScenario(page, 'library.grid.selection', testInfo);
      await selectedModelCard.click({
        modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'],
      });
      await expect(
        page.getByRole('button', { name: `Select ${modelFixtureName}` }),
      ).toHaveAttribute('aria-pressed', 'false');
      const favoriteButton = page.getByRole('button', {
        name: `Favorite ${modelFixtureName}`,
      });
      await favoriteButton.click();
      await expect(favoriteButton).toHaveAttribute('aria-pressed', 'true');
      const favoritesFilter = page
        .getByRole('navigation', { name: 'Model scopes' })
        .getByRole('button', { name: /^Favorites 1$/ });
      await expect(favoritesFilter).toBeVisible();
      await expectNoMaterialViolations(
        page,
        'favorited populated model card',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'library.grid.favorite-toggle',
        testInfo,
      );
      await page
        .getByRole('button', { name: `Unfavorite ${modelFixtureName}` })
        .click();
      await expect(
        page.getByRole('button', {
          name: `Favorite ${modelFixtureName}`,
        }),
      ).toHaveAttribute('aria-pressed', 'false');

      const libraryMain = page.getByRole('main', {
        name: 'Model library',
        exact: true,
      });
      const modelScopes = page.getByRole('navigation', {
        name: 'Model scopes',
      });
      const filterChoices = [
        { label: 'Favorites', count: 0 },
        { label: 'STL', count: 0 },
        { label: '3MF', count: 0 },
        { label: 'OBJ', count: 1 },
        { label: 'STEP', count: 0 },
        { label: 'Duplicates', count: 0 },
        { label: 'Missing files', count: 0 },
      ];
      for (const filter of filterChoices) {
        const filterButton = modelScopes.getByRole('button', {
          name: new RegExp(`^${filter.label} ${filter.count}$`),
        });
        await filterButton.click();
        await expect(libraryMain).toBeVisible();
        await expect(filterButton).toHaveAttribute('aria-current', 'page');
        await expectNoMaterialViolations(
          page,
          `library ${filter.label} filter`,
          testInfo,
        );
        if (filter.label === 'OBJ') {
          await expect(
            page.getByRole('button', {
              name: `Select ${modelFixtureName}`,
            }),
          ).toBeVisible();
          await captureVisualScenario(
            page,
            'library.sidebar.filter-modes-counts',
            testInfo,
          );
        }
      }
      await modelScopes.getByRole('button', { name: /^All models 1$/ }).click();
      const pagination = page.getByRole('navigation', {
        name: 'Library pages',
      });
      const pageSize = pagination.getByRole('combobox', {
        name: 'Items per page',
      });
      await expect(pageSize.locator('option')).toHaveText([
        '24',
        '48',
        '96',
        '192',
      ]);
      await pageSize.selectOption('48');
      await expect(pagination.getByRole('status')).toHaveText(
        '1-1 of 1 matches',
      );
      await expect(pagination).toContainText('Page 1 of 1');
      await expectNoMaterialViolations(
        page,
        'library pagination with one matching model',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'library.pagination.single-match-page-size',
        testInfo,
      );
      await pageSize.selectOption('24');

      const searchModels = page.getByRole('searchbox', {
        name: 'Search models',
      });
      await searchModels.fill('no-synthetic-model-matches-this-query');
      await expect(
        page.getByRole('heading', { name: 'No matching models' }),
      ).toBeVisible();
      await expectNoMaterialViolations(page, 'empty model search', testInfo);
      await captureVisualScenario(page, 'library.empty-search', testInfo);
      await page.getByRole('button', { name: 'Clear filters' }).click();
      await expect(pagination.getByRole('status')).toHaveText(
        '1-1 of 1 matches',
      );
      await expect(pageSize).toBeEnabled();

      const railSources = page.getByRole('button', { name: /^Settings/ });
      await railSources.click();
      const sourcesPane = page.getByRole('region', {
        name: 'Source folders',
        exact: true,
      });
      await expect(sourcesPane).toBeVisible();
      await expect(sourcesPane).toHaveAttribute('aria-busy', 'false');
      const configuredRoots = sourcesPane
        .getByRole('list', { name: 'Source folders' })
        .getByRole('listitem');
      await expect(configuredRoots).toHaveCount(1);
      await expect(configuredRoots).toContainText(modelFixtureDirectory);
      await expect(
        configuredRoots.getByText('Available', { exact: true }),
      ).toBeVisible();
      await expect(configuredRoots).toContainText('1 of 1 models available');
      await expect(
        sourcesPane.getByRole('button', { name: 'Add source folder' }),
      ).toBeEnabled();
      await expect(
        sourcesPane.getByRole('button', { name: 'Refresh catalog' }),
      ).toBeEnabled();
      await expect(
        page.getByRole('heading', { name: 'Settings', level: 1 }),
      ).toBeFocused();
      await expect(
        page.locator('.settings-pane [aria-busy="true"]'),
      ).toHaveCount(0);
      await expectNoMaterialViolations(page, 'catalog sources', testInfo);
      await captureVisualScenario(page, 'sources.configured', testInfo);
      await page.getByRole('button', { name: 'Reset catalog' }).click();
      await expect(
        page.getByRole('button', { name: 'Keep catalog' }),
      ).toBeFocused();
      await expect(page.getByText('Clear this local catalog?')).toBeVisible();
      await expectNoMaterialViolations(
        page,
        'catalog reset confirmation',
        testInfo,
      );
      await captureVisualScenario(page, 'sources.reset-confirmation', testInfo);
      // A destructive confirmation that takes focus stays cancellable from the
      // keyboard even though the place around it is not modal.
      await page.keyboard.press('Escape');
      await expect(page.getByText('Clear this local catalog?')).toHaveCount(0);
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(
        page.getByRole('main', { name: 'Model library' }),
      ).toBeVisible();

      const selectModel = page.getByRole('button', {
        name: `Select ${modelFixtureName}`,
      });
      await expect(selectModel).toBeVisible();
      await selectModel.click();
      const inspector = page.getByLabel('Model properties');
      await expect(
        inspector.getByRole('heading', { name: modelFixtureName }),
      ).toBeVisible();
      await expectNoMaterialViolations(page, 'populated library', testInfo);
      await captureVisualScenario(
        page,
        'library.populated-inspector',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'library.home.populated-library',
        testInfo,
      );

      const previewButton = inspector.getByRole('button', {
        name: 'Preview in 3D',
      });
      await previewButton.click();
      const viewerDialog = page.getByRole('dialog', {
        name: `3D preview of ${modelFixtureName}`,
      });
      await expect(viewerDialog).toBeVisible();
      const back = page.getByRole('button', { name: 'Back to library' });
      await expect(back).toBeFocused();
      await expect(
        page
          .locator('.app-body')
          .evaluate((element) => element.hasAttribute('inert')),
      ).resolves.toBe(true);
      await expectNoMaterialViolations(page, '3D viewer', testInfo);
      await captureVisualScenario(page, 'preview.loaded', testInfo);

      await page.keyboard.press(
        process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
      );
      await expect(page.getByLabel('Search models')).not.toBeFocused();
      expect(
        await viewerDialog.evaluate((dialog) =>
          dialog.contains(document.activeElement),
        ),
      ).toBe(true);
      const viewer = page.getByRole('application', {
        name: /3D model preview/i,
      });
      const canvas = viewer.locator('canvas');
      await expect(canvas).toBeVisible();
      const contextLossPrevented = await canvas.evaluate((element) => {
        const event = new Event('webglcontextlost', { cancelable: true });
        element.dispatchEvent(event);
        return event.defaultPrevented;
      });
      expect(contextLossPrevented).toBe(true);
      const contextLossAlert = viewer.getByRole('alert');
      await expect(contextLossAlert).toHaveText(
        'GPU context lost — attempting to recover…',
      );
      await scanSurface(page, {
        name: 'synthetic WebGL context-loss notice',
        present: viewer,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'viewer.webgl.synthetic-context-loss',
        testInfo,
      );
      await canvas.evaluate((element) => {
        element.dispatchEvent(new Event('webglcontextrestored'));
      });
      await expect(contextLossAlert).toHaveCount(0);
      await viewer.focus();
      await page.keyboard.press('ArrowRight');
      await expect(viewer).toBeFocused();

      await back.click();
      await expect(viewerDialog).toHaveCount(0);
      await expect(previewButton).toBeFocused();

      await railSources.click();
      await expect(sourcesPane).toBeVisible();
      await page.getByRole('button', { name: 'Reset catalog' }).click();
      await page.getByRole('button', { name: 'Clear local catalog' }).click();
      await expect(
        page.getByText(
          /^Catalog cleared\. Removed 1 indexed model, 1 source folder, \d+ tags?, and \d+ collections?\.$/,
        ),
      ).toBeVisible();
      await expect(sourcesPane.getByText('No folders connected')).toBeVisible();
      await expectNoMaterialViolations(page, 'catalog reset result', testInfo);
      await captureVisualScenario(page, 'sources.reset-result', testInfo);
      await captureVisualScenario(page, 'sources.empty-roots', testInfo);
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(
        page.getByRole('main', { name: 'Model library' }),
      ).toBeVisible();
      await expect(selectModel).toHaveCount(0);
      await expect(
        page.getByRole('heading', { name: 'Build your model library' }),
      ).toBeVisible();
      await expectNoMaterialViolations(
        page,
        'completed empty catalog',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'library.completed-empty-catalog',
        testInfo,
      );
    },
    async () => {
      await cleanupPackagedApp(launched, root === null ? [] : [root]);
    },
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        processLog?.read() ?? '',
        diagnostics,
      ),
  );
});

test('@a11y workspace destinations and Library filters stay within their routes', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  test.setTimeout(180_000);
  let root: string | null = null;
  let launched: PackagedApp | null = null;
  let processLog: PackagedProcessLog | null = null;

  await runWithPackagedTestCleanup(
    async () => {
      processLog = createPackagedProcessLog();
      root = mkdtempSync(path.join(tmpdir(), 'pf-a11y-routes-'));
      const userDataPath = path.join(root, 'user-data');
      const catalogDb = path.join(root, 'catalog.sqlite3');
      mkdirSync(userDataPath, { recursive: true });
      launched = await launchPackagedApp({
        executablePath: findPackagedExecutable(repoRoot),
        userDataPath,
        catalogDb,
        processLog,
        environment: { PRINTFARMER_E2E: '1' },
      });
      const page = launched.page;
      await applyPinnedRenderingProfile(page);
      const onboarding = page.getByRole('dialog', {
        name: 'Set up your model library',
      });
      await expect(onboarding).toBeVisible();
      await onboarding.getByRole('button', { name: 'Maybe later' }).click();

      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      const cacheDialog = page.getByRole('region', {
        name: 'Thumbnail cache',
      });
      await expect(cacheDialog).toBeVisible();
      await expect(
        cacheDialog.getByText('Loading cache settings…'),
      ).toHaveCount(0);
      await expect(
        cacheDialog.getByRole('button', {
          name: 'Clear cached thumbnails…',
        }),
      ).toBeDisabled();
      await expect(
        page.locator('.settings-pane [aria-busy="true"]'),
      ).toHaveCount(0);
      await expectNoMaterialViolations(page, 'empty thumbnail cache', testInfo);
      await captureVisualScenario(
        page,
        'dialogs.thumbnail-cache.empty-cache-disabled-clear',
        testInfo,
      );
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(cacheDialog).toHaveCount(0);

      const workspaceRoutes = [
        {
          buttonName: /^Filament Calibration/,
          mainName: 'Filament calibration workspace',
        },
        { buttonName: /^Uploads/, mainName: 'Upload queue' },
        { buttonName: /^Tags & Collections/, mainName: 'Tags and collections' },
        { buttonName: /^Settings/, mainName: 'Settings' },
      ];
      for (const [index, route] of workspaceRoutes.entries()) {
        await page.getByRole('button', { name: route.buttonName }).click();
        const main = page.getByRole('main', {
          name: route.mainName,
          exact: true,
        });
        await expect(main).toBeVisible();
        await expect(
          page.getByRole('button', { name: route.buttonName }),
        ).toHaveAttribute('aria-current', 'page');
        await expect(main.locator('[aria-busy="true"]')).toHaveCount(0);
        if (route.mainName === 'Settings') {
          await expect(
            main.getByRole('spinbutton', {
              name: 'Maximum ZIP size (MiB)',
            }),
          ).toBeEnabled();
          await expect(
            main.getByRole('button', { name: 'Save ZIP limit', exact: true }),
          ).toHaveCSS('opacity', '1');
        }
        await expectNoMaterialViolations(page, route.mainName, testInfo);
        if (index === workspaceRoutes.length - 1) {
          await captureVisualScenario(
            page,
            'shell.workspace-rail.five-workspace-routes',
            testInfo,
          );
        }
      }

      await page.getByRole('button', { name: 'Library', exact: true }).click();
      const libraryMain = page.getByRole('main', {
        name: 'Model library',
        exact: true,
      });
      await expect(libraryMain).toBeVisible();
      await page.getByRole('button', { name: 'Favorites' }).click();
      await expect(libraryMain).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Library', exact: true }),
      ).toHaveAttribute('aria-current', 'page');
      await expect(
        page.getByRole('button', { name: 'Favorites' }),
      ).toHaveAttribute('aria-current', 'page');
      await expectNoMaterialViolations(
        page,
        'library favorites filter',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'shell.workspace-rail.library-filters-not-routes',
        testInfo,
      );
    },
    async () => {
      await cleanupPackagedApp(launched, root === null ? [] : [root]);
    },
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        processLog?.read() ?? '',
        diagnostics,
      ),
  );
});

async function expectNoMaterialViolations(
  page: Page,
  surface: string,
  testInfo: TestInfo,
): Promise<void> {
  // Electron's CDP target cannot create Axe's blank aggregation page. This app
  // has no frames, so legacy mode runs the same rules against the complete UI.
  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(wcagTags)
    .analyze();
  const material = results.violations.filter(
    (violation) =>
      typeof violation.impact === 'string' &&
      materialImpacts.has(violation.impact),
  );
  if (material.length > 0) {
    const liveStyles = await page.evaluate(() =>
      [...document.querySelectorAll('button, input')].map((element) => {
        const style = getComputedStyle(element);
        return {
          html: element.outerHTML,
          disabled: element.matches(':disabled'),
          opacity: style.opacity,
          color: style.color,
          background: style.backgroundColor,
        };
      }),
    );
    await testInfo.attach(`styles-${surface.replaceAll(' ', '-')}.json`, {
      body: Buffer.from(JSON.stringify(liveStyles, null, 2)),
      contentType: 'application/json',
    });
    await testInfo.attach(`axe-${surface.replaceAll(' ', '-')}.json`, {
      body: Buffer.from(JSON.stringify(material, null, 2)),
      contentType: 'application/json',
    });
  }
  expect(material, `${surface} has material WCAG A/AA violations`).toEqual([]);
}
