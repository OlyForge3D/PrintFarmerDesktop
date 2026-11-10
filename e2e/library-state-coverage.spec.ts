import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  attachPackagedFailureDiagnostics,
  cleanupPackagedApp,
  createPackagedProcessLog,
  launchPackagedApp,
  runWithPackagedTestCleanup,
  type PackagedApp,
} from './helpers/packagedApp';
import { scanSurface } from './helpers/calibrationA11yFixture';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage.js';
import {
  findPackagedExecutable,
  packagedSidecarPath,
} from './helpers/retargetFixture';
import { RootApprovalStore } from '../src/main/rootApprovals';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

function objFixture(index: number): string {
  return [
    `o coverage-${String(index).padStart(2, '0')}`,
    'v 0 0 0',
    `v ${index + 2} 0 0`,
    `v 0 ${index + 3} 0`,
    'f 1 2 3',
    '',
  ].join('\n');
}

test('@a11y missing, duplicate, thumbnail and paginated library states are rendered', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(150_000);
  expect(browserName).toBe('chromium');
  const root = mkdtempSync(path.join(tmpdir(), 'pf-library-states-'));
  const userDataPath = path.join(root, 'user-data');
  const catalogDb = path.join(root, 'catalog.sqlite3');
  const modelRoot = path.join(root, 'models');
  const duplicateDirectory = path.join(modelRoot, 'duplicate-location');
  const processLog = createPackagedProcessLog();
  let launched: PackagedApp | null = null;

  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(duplicateDirectory, { recursive: true });
  const missingDuplicate = path.join(modelRoot, 'coverage-00-missing.obj');
  const duplicateBytes = Buffer.from(objFixture(0), 'utf8');
  writeFileSync(missingDuplicate, duplicateBytes);
  writeFileSync(
    path.join(duplicateDirectory, 'coverage-00-copy.obj'),
    duplicateBytes,
  );
  for (let index = 1; index < 25; index += 1) {
    writeFileSync(
      path.join(
        modelRoot,
        `coverage-${String(index).padStart(2, '0')}-healthy.obj`,
      ),
      objFixture(index),
    );
  }
  for (let index = 0; index < 25; index += 1) {
    writeFileSync(
      path.join(
        duplicateDirectory,
        `coverage-01-copy-${String(index).padStart(2, '0')}.obj`,
      ),
      objFixture(1),
    );
  }

  await runWithPackagedTestCleanup(
    async () => {
      const approval = await new RootApprovalStore({
        userDataPath,
      }).approveFromPicker(modelRoot);
      const executablePath = findPackagedExecutable(repoRoot);
      const seed = spawnSync(
        packagedSidecarPath(executablePath),
        ['--catalog-db', catalogDb],
        {
          input: `${JSON.stringify({
            id: 1,
            method: 'importRoot',
            params: {
              rootId: approval.id,
              path: approval.canonicalPath,
              rules: [
                {
                  relativePath: '',
                  kind: 'collection',
                  name: 'Visual coverage fixtures',
                },
              ],
              commonTags: ['visual-coverage'],
            },
          })}\n`,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      if (seed.error) {
        throw new Error(
          'Failed to seed the isolated visual coverage catalog.',
          {
            cause: seed.error,
          },
        );
      }
      expect(seed.status, seed.stderr).toBe(0);
      const seedResult: unknown = JSON.parse(seed.stdout.trim());
      expect(seedResult).toMatchObject({
        ok: true,
        result: { report: { added: 51 } },
      });

      rmSync(missingDuplicate);
      rmSync(path.join(duplicateDirectory, 'coverage-00-copy.obj'));
      launched = await launchPackagedApp({
        executablePath,
        userDataPath,
        catalogDb,
        processLog,
        environment: { PRINTFARMER_USER_DATA_PATH: userDataPath },
      });
      const page = launched.page;
      await applyPinnedRenderingProfile(page);
      const maybeLater = page.getByRole('button', { name: 'Maybe later' });
      if (await maybeLater.isVisible()) await maybeLater.click();

      await page.getByRole('button', { name: /^Settings/ }).click();
      const sources = page.getByRole('region', {
        name: 'Source folders',
        exact: true,
      });
      await sources.getByRole('button', { name: 'Refresh catalog' }).click();
      await expect(sources).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      const library = page.getByRole('main', { name: 'Model library' });
      await expect(library).toBeVisible();
      const allModels = page
        .getByRole('navigation', { name: 'Model scopes' })
        .getByRole('button', { name: /^All models 25$/ });
      await expect(allModels).toBeVisible();

      const search = page.getByRole('searchbox', { name: 'Search models' });
      await search.fill('coverage-00-missing.obj');
      const missingCard = page.getByRole('button', {
        name: 'Select coverage-00-missing.obj',
      });
      await expect(missingCard).toBeVisible();
      await expect(missingCard.locator('.model-missing')).toHaveText('Missing');
      await expect(missingCard.locator('.model-copies')).toHaveText('2 copies');
      await expect(missingCard.locator('.model-thumb')).toHaveText('OBJ');
      await expect(missingCard.locator('img.model-thumb-img')).toHaveCount(0);
      await expect(page.locator('.model-card')).toHaveCount(1);
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.grid.missing-duplicate-fallback',
        testInfo,
      );

      await search.fill('coverage-01-healthy.obj');
      const healthyImage = page
        .getByRole('button', { name: 'Select coverage-01-healthy.obj' })
        .locator('img.model-thumb-img');
      await expect(healthyImage).toBeVisible();
      await expect
        .poll(() =>
          healthyImage.evaluate((image) =>
            image instanceof HTMLImageElement ? image.naturalWidth : 0,
          ),
        )
        .toBeGreaterThan(0);
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.grid.thumbnail-ready',
        testInfo,
      );

      const healthyCard = page.getByRole('button', {
        name: 'Select coverage-01-healthy.obj',
      });
      await healthyCard.click();
      const inspector = page.getByRole('complementary', {
        name: 'Model properties',
      });
      await expect(
        inspector
          .getByRole('list', { name: 'Model tags' })
          .getByText('visual-coverage'),
      ).toBeVisible();
      await expect(
        inspector
          .getByRole('list', { name: 'Collections' })
          .getByRole('checkbox', { name: /Visual coverage fixtures/ }),
      ).toBeChecked();
      await expect(
        inspector.getByText('Showing the first 25 of 26 locations.'),
      ).toBeVisible();
      await scanSurface(page, {
        name: 'selected model properties and location overflow',
        present: inspector,
        include: '.properties-inspector',
        testInfo,
      });
      await captureVisualScenario(
        page,
        'library.inspector.synthetic-tags-collections',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'library.inspector.location-overflow',
        testInfo,
      );
      await healthyCard.click();

      await search.fill('coverage-02-healthy.obj');
      const singleCopyCard = page.getByRole('button', {
        name: 'Select coverage-02-healthy.obj',
      });
      await expect(singleCopyCard).toBeVisible();
      await expect(singleCopyCard.locator('.model-missing')).toHaveCount(0);
      await expect(singleCopyCard.locator('.model-copies')).toHaveCount(0);
      rmSync(path.join(modelRoot, 'coverage-02-healthy.obj'));
      await page.getByRole('button', { name: /^Settings/ }).click();
      const refreshedSources = page.getByRole('region', {
        name: 'Source folders',
        exact: true,
      });
      await refreshedSources
        .getByRole('button', { name: 'Refresh catalog' })
        .click();
      await expect(refreshedSources).toHaveAttribute('aria-busy', 'false');
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await search.fill('coverage-02-healthy.obj');
      await expect(singleCopyCard.locator('.model-missing')).toHaveText(
        'Missing',
      );
      await expect(singleCopyCard.locator('.model-copies')).toHaveCount(0);
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.grid.single-copy-became-missing',
        testInfo,
      );

      await search.fill('');
      const pagination = page.getByRole('navigation', {
        name: 'Library pages',
      });
      await pagination
        .getByRole('combobox', { name: 'Items per page' })
        .selectOption('24');
      await expect(pagination.getByRole('status')).toHaveText(
        '1-24 of 25 matches',
      );
      await expect(page.locator('.model-card')).toHaveCount(24);
      await expect(pagination).toContainText('Page 1 of 2');
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.grid.page-bounded-first-page',
        testInfo,
      );

      await pagination.getByRole('button', { name: 'Next page' }).click();
      await expect(pagination.getByRole('status')).toHaveText(
        '25-25 of 25 matches',
      );
      await expect(pagination).toContainText('Page 2 of 2');
      await expect(page.locator('.model-card')).toHaveCount(1);
      await expect(
        pagination.getByRole('button', { name: 'Previous page' }),
      ).toBeEnabled();
      await expect(
        pagination.getByRole('button', { name: 'Next page' }),
      ).toBeDisabled();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.pagination.multiple-page-navigation',
        testInfo,
      );
      await pagination.getByRole('button', { name: 'First page' }).click();
      await expect(pagination).toContainText('Page 1 of 2');
      await pagination.getByRole('button', { name: 'Last page' }).click();
      await expect(pagination).toContainText('Page 2 of 2');
      await pagination.getByRole('button', { name: 'Previous page' }).click();
      await expect(pagination).toContainText('Page 1 of 2');

      await search.fill('no-matching-coverage-model');
      await expect(page.locator('.model-card')).toHaveCount(0);
      await expect(pagination.getByRole('status')).toHaveText(
        '0-0 of 0 matches',
      );
      await expect(pagination).toContainText('Page 1 of 1');
      for (const name of [
        'First page',
        'Previous page',
        'Next page',
        'Last page',
      ]) {
        await expect(pagination.getByRole('button', { name })).toBeDisabled();
      }
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.pagination.zero-results-disabled',
        testInfo,
      );
    },
    () => cleanupPackagedApp(launched, [root]),
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        processLog.read(),
        diagnostics,
      ),
  );
});

test('@a11y imported 3MF materials, parts and tree interactions render in preview', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(150_000);
  expect(browserName).toBe('chromium');
  const root = mkdtempSync(path.join(tmpdir(), 'pf-library-3mf-states-'));
  const userDataPath = path.join(root, 'user-data');
  const catalogDb = path.join(root, 'catalog.sqlite3');
  const modelRoot = path.join(root, 'models');
  const processLog = createPackagedProcessLog();
  let launched: PackagedApp | null = null;
  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(modelRoot, { recursive: true });

  const fixtureDirectory = path.join(
    repoRoot,
    'native',
    'model-core',
    'tests',
    'fixtures',
    'threemf',
  );
  for (const file of [
    'multi_part.3mf',
    'color_material.3mf',
    'multi_scene_plate.3mf',
    'transform_chain.3mf',
  ]) {
    copyFileSync(path.join(fixtureDirectory, file), path.join(modelRoot, file));
  }

  await runWithPackagedTestCleanup(
    async () => {
      const approval = await new RootApprovalStore({
        userDataPath,
      }).approveFromPicker(modelRoot);
      const executablePath = findPackagedExecutable(repoRoot);
      const seed = spawnSync(
        packagedSidecarPath(executablePath),
        ['--catalog-db', catalogDb],
        {
          input: `${JSON.stringify({
            id: 1,
            method: 'importRoot',
            params: {
              rootId: approval.id,
              path: approval.canonicalPath,
              rules: [
                {
                  relativePath: '',
                  kind: 'collection',
                  name: '3MF visual coverage fixtures',
                },
              ],
              commonTags: ['visual-coverage'],
            },
          })}\n`,
          encoding: 'utf8',
          timeout: 60_000,
        },
      );
      if (seed.error) {
        throw new Error('Failed to seed the isolated 3MF visual catalog.', {
          cause: seed.error,
        });
      }
      expect(seed.status, seed.stderr).toBe(0);
      expect(JSON.parse(seed.stdout.trim())).toMatchObject({
        ok: true,
        result: { report: { added: 4 } },
      });

      launched = await launchPackagedApp({
        executablePath,
        userDataPath,
        catalogDb,
        processLog,
        environment: { PRINTFARMER_USER_DATA_PATH: userDataPath },
      });
      const page = launched.page;
      await applyPinnedRenderingProfile(page);
      const maybeLater = page.getByRole('button', { name: 'Maybe later' });
      if (await maybeLater.isVisible()) await maybeLater.click();

      await page.getByRole('button', { name: 'Select multi_part.3mf' }).click();
      await page.getByRole('button', { name: /^Settings/ }).click();
      await expect(page.getByRole('main', { name: 'Settings' })).toBeVisible();
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      const restoredSelection = page.getByRole('button', {
        name: 'Deselect multi_part.3mf',
      });
      await expect(restoredSelection).toHaveAttribute('aria-pressed', 'true');
      await scanSurface(page, {
        name: 'library selection after workspace switch',
        present: restoredSelection,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'shell.main-window.library-selection-survives-route-switch',
        testInfo,
      );
      await applyPinnedRenderingProfile(
        page,
        'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1',
      );
      await page
        .getByRole('complementary', { name: 'Model properties' })
        .getByRole('button', { name: 'Preview in 3D' })
        .click();
      const partPreview = page.getByRole('dialog', {
        name: '3D preview of multi_part.3mf',
      });
      const tree = partPreview.getByRole('tree', { name: 'Scene objects' });
      for (const partName of ['Bracket', 'Spacer', 'Cap']) {
        await expect(
          tree.getByRole('treeitem', { name: partName }),
        ).toBeVisible();
      }
      const details = partPreview.getByRole('complementary', {
        name: 'Preview details',
      });
      const layout = await details.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: bounds.left,
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          clientWidth: element.clientWidth,
          clientHeight: element.clientHeight,
          scrollWidth: element.scrollWidth,
          scrollHeight: element.scrollHeight,
        };
      });
      expect(layout.left).toBeGreaterThanOrEqual(0);
      expect(layout.top).toBeGreaterThanOrEqual(0);
      expect(layout.right).toBeLessThanOrEqual(layout.viewportWidth);
      expect(layout.bottom).toBeLessThanOrEqual(layout.viewportHeight);
      expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth);
      expect(layout.scrollHeight).toBeGreaterThan(layout.clientHeight);
      await expect
        .poll(() =>
          details.evaluate((element) => {
            element.scrollTop = element.scrollHeight;
            return element.scrollTop;
          }),
        )
        .toBeGreaterThan(0);
      await scanSurface(page, {
        name: 'narrow 3MF preview details',
        present: partPreview,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'library.preview.named-3mf-parts',
        testInfo,
      );
      await captureVisualScenario(
        page,
        'library.preview.narrow-rendered-layout',
        testInfo,
      );

      await partPreview
        .getByRole('button', { name: 'Back to library' })
        .click();
      await page
        .getByRole('button', { name: 'Select color_material.3mf' })
        .click();
      await page
        .getByRole('complementary', { name: 'Model properties' })
        .getByRole('button', { name: 'Preview in 3D' })
        .click();
      const materialPreview = page.getByRole('dialog', {
        name: '3D preview of color_material.3mf',
      });
      const materials = materialPreview.getByRole('list', {
        name: 'Materials',
      });
      await expect(materials.getByText('#ff0000')).toBeVisible();
      await expect(materials.getByText('Per-face colours')).toBeVisible();
      await scanSurface(page, {
        name: '3MF authored and per-face materials',
        present: materialPreview,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'library.preview.authored-3mf-materials',
        testInfo,
      );

      await materialPreview
        .getByRole('button', { name: 'Back to library' })
        .click();
      await page
        .getByRole('button', { name: 'Select multi_scene_plate.3mf' })
        .click();
      await page
        .getByRole('complementary', { name: 'Model properties' })
        .getByRole('button', { name: 'Preview in 3D' })
        .click();
      const platePreview = page.getByRole('dialog', {
        name: '3D preview of multi_scene_plate.3mf',
      });
      const plates = platePreview.getByRole('group', { name: 'Plate' });
      const allPlates = plates.getByRole('radio', { name: 'All plates' });
      const leftPlate = plates.getByRole('radio', { name: 'Left Plate' });
      const rightPlate = plates.getByRole('radio', { name: 'Right Plate' });
      await expect(allPlates).toBeChecked();
      await expect(leftPlate).toBeVisible();
      await expect(rightPlate).toBeVisible();
      await scanSurface(page, {
        name: 'multi-plate preview selector',
        present: platePreview,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'library.preview.multi-scene-plate-selector',
        testInfo,
      );

      await rightPlate.click();
      await expect(rightPlate).toBeChecked();
      await expect(leftPlate).not.toBeChecked();
      await rightPlate.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(leftPlate).toBeChecked();

      const plateTree = platePreview.getByRole('tree', {
        name: 'Scene objects',
      });
      await expect(
        plateTree.getByRole('treeitem', { name: 'Left plate accessory' }),
      ).toBeVisible();
      await plateTree
        .getByRole('button', { name: 'Hide Left plate body' })
        .click();
      await expect(
        platePreview
          .getByRole('status')
          .filter({ hasText: 'Custom visibility' }),
      ).toBeVisible();
      await expect(allPlates).not.toBeChecked();
      await expect(leftPlate).not.toBeChecked();
      await expect(rightPlate).not.toBeChecked();
      await scanSurface(page, {
        name: 'multi-plate custom visibility',
        present: platePreview,
        testInfo,
      });

      await platePreview
        .getByRole('button', { name: 'Back to library' })
        .click();
      await page
        .getByRole('button', { name: 'Select transform_chain.3mf' })
        .click();
      await page
        .getByRole('complementary', { name: 'Model properties' })
        .getByRole('button', { name: 'Preview in 3D' })
        .click();
      const hierarchyPreview = page.getByRole('dialog', {
        name: '3D preview of transform_chain.3mf',
      });
      const hierarchyTree = hierarchyPreview.getByRole('tree', {
        name: 'Scene objects',
      });
      const assembly = hierarchyTree.getByRole('treeitem', {
        name: 'Assembly',
      });
      await expect(assembly).toHaveAttribute('aria-expanded', 'true');
      await expect(
        hierarchyTree.getByRole('treeitem', { name: 'Unit' }),
      ).toHaveCount(2);
      await scanSurface(page, {
        name: 'nested 3MF part tree',
        present: hierarchyPreview,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'library.preview.hierarchical-part-tree',
        testInfo,
      );

      await assembly.focus();
      await page.keyboard.press('ArrowLeft');
      await expect(assembly).toHaveAttribute('aria-expanded', 'false');
      await page.keyboard.press('ArrowRight');
      await expect(assembly).toHaveAttribute('aria-expanded', 'true');
      const firstUnit = hierarchyTree
        .getByRole('treeitem', { name: 'Unit' })
        .first();
      await firstUnit.getByRole('button', { name: 'Isolate Unit' }).click();
      await expect(
        firstUnit.getByRole('button', { name: 'Exit isolation of Unit' }),
      ).toBeVisible();
      await expect(
        hierarchyPreview.getByRole('button', {
          name: 'Exit isolation',
          exact: true,
        }),
      ).toBeVisible();
      await scanSurface(page, {
        name: 'nested 3MF tree keyboard and isolation state',
        present: hierarchyPreview,
        testInfo,
      });
      await captureVisualScenario(
        page,
        'library.preview.part-tree-keyboard-isolation',
        testInfo,
      );
    },
    () => cleanupPackagedApp(launched, [root]),
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        processLog.read(),
        diagnostics,
      ),
  );
});

async function expectNoMaterialViolations(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page })
    .setLegacyMode()
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.filter((violation) =>
      ['moderate', 'serious', 'critical'].includes(violation.impact ?? ''),
    ),
  ).toEqual([]);
}
