import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
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
import {
  modelFixtureDirectory,
  modelFixtureName,
} from './helpers/modelLibrary';
import {
  findPackagedExecutable,
  packagedSidecarPath,
} from './helpers/retargetFixture';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage.js';
import { RootApprovalStore } from '../src/main/rootApprovals';
import { createSidebarResizeRecorder } from './helpers/sidebarResizeDiagnostics';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('packaged collection management preserves models and source files', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const root = mkdtempSync(path.join(tmpdir(), 'pf-collections-e2e-'));
  const userDataPath = path.join(root, 'user-data');
  const catalogDb = path.join(root, 'catalog.sqlite3');
  const processLog = createPackagedProcessLog();
  const fixtureSource = path.join(modelFixtureDirectory, modelFixtureName);
  const fixtureDirectory = path.join(root, 'models');
  const nestedFixtureDirectory = path.join(
    fixtureDirectory,
    `deep-layout-${'segment-'.repeat(4)}`,
  );
  const fixture = path.join(nestedFixtureDirectory, modelFixtureName);
  mkdirSync(nestedFixtureDirectory, { recursive: true });
  copyFileSync(fixtureSource, fixture);
  const originalHash = createHash('sha256')
    .update(readFileSync(fixtureSource))
    .digest('hex');
  let launched: PackagedApp | null = null;

  await runWithPackagedTestCleanup(
    async () => {
      mkdirSync(userDataPath, { recursive: true });
      const executablePath =
        process.env.PRINTFARMER_E2E_PACKAGED_EXECUTABLE ??
        findPackagedExecutable(repoRoot);
      // Seed the throwaway catalog with the shipped sidecar rather than the
      // test-only dialog hook, so this runs against a production build.
      const approved = await new RootApprovalStore({
        userDataPath,
      }).approveFromPicker(fixtureDirectory);
      const sidecar = packagedSidecarPath(executablePath);
      const seed = spawnSync(sidecar, ['--catalog-db', catalogDb], {
        input: `${JSON.stringify({
          id: 1,
          method: 'importRoot',
          params: {
            rootId: approved.id,
            path: approved.canonicalPath,
            rules: [
              {
                relativePath: '',
                kind: 'collection',
                name: 'Release E2E fixtures',
              },
            ],
            commonTags: ['release-e2e'],
          },
        })}\n`,
        encoding: 'utf8',
        timeout: 60_000,
      });
      if (seed.error) {
        throw new Error(`Failed to spawn shipped sidecar at ${sidecar}`, {
          cause: seed.error,
        });
      }
      expect(seed.status, seed.stderr).toBe(0);
      expect(
        (JSON.parse(seed.stdout.trim()) as { ok?: unknown }).ok,
        seed.stdout,
      ).toBe(true);

      launched = await launchPackagedApp({
        executablePath,
        userDataPath,
        catalogDb,
        processLog,
        environment: { PRINTFARMER_USER_DATA_PATH: userDataPath },
      });
      const page = launched.page;
      await applyPinnedRenderingProfile(page);
      const resizeRecorder = await page.evaluateHandle(
        createSidebarResizeRecorder,
      );
      await expect(page.getByText(modelFixtureName)).toBeVisible();
      const models = await page.evaluate(() => window.printFarmer.listModels());
      expect(models).toHaveLength(1);
      const modelHash = models[0]!.hash;

      const tags = page.getByRole('group', { name: 'Tags filter' });
      const collections = page.getByRole('group', {
        name: 'Collections filter',
      });

      // Sidebar layout: Collections precede Tags, no Manage shortcuts, both
      // groups collapse, and the column resizes by pointer and keyboard.
      const sidebar = page.getByRole('complementary', {
        name: 'Library navigation',
      });
      await expect(
        page.getByText(
          /Tag and collection scopes are combined|Matches any selected|Selection applies to this page|The 3D viewer opens only/,
        ),
      ).toHaveCount(0);
      await expect(collections).toHaveAccessibleDescription(
        'Matches any selected collection. Tag and collection filters are combined.',
      );
      const collectionsBox = await collections.boundingBox();
      const tagsBox = await tags.boundingBox();
      expect(collectionsBox!.y).toBeLessThan(tagsBox!.y);
      await expect(sidebar.getByRole('button', { name: /Manage/ })).toHaveCount(
        0,
      );
      const tagsToggle = tags.getByRole('button', { name: /^Tags/ });
      await tagsToggle.click();
      await expect(tagsToggle).toHaveAttribute('aria-expanded', 'false');
      await expect(
        tags.getByRole('checkbox', { name: 'release-e2e' }),
      ).toBeHidden();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.sidebar.tags-collapsed',
        testInfo,
      );
      await tagsToggle.click();
      await expect(tagsToggle).toHaveAttribute('aria-expanded', 'true');

      const tagSearch = tags.getByRole('searchbox', {
        name: 'Search tags',
      });
      await tagSearch.fill('release');
      await expect(
        tags.getByRole('checkbox', { name: 'release-e2e' }),
      ).toBeVisible();
      await tagSearch.fill('no-matching-tag');
      await expect(tags.getByText('No matching tags.')).toBeVisible();

      const collectionSearch = collections.getByRole('searchbox', {
        name: 'Search collections',
      });
      await collectionSearch.fill('Release');
      await expect(
        collections.getByRole('checkbox', {
          name: 'Release E2E fixtures',
        }),
      ).toBeVisible();
      await collectionSearch.fill('no-matching-collection');
      await expect(
        collections.getByText('No matching collections.'),
      ).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.sidebar.tag-collection-search',
        testInfo,
      );
      await tagSearch.fill('');
      await collectionSearch.fill('');

      const pane = page.locator('.library-sidebar-pane');
      const resizer = page.getByRole('separator', {
        name: 'Resize library sidebar',
      });
      let startWidth = 0;
      let resizePassed = false;
      let resizeEvidence:
        | ReturnType<ReturnType<typeof createSidebarResizeRecorder>['stop']>
        | undefined;
      await runWithPackagedTestCleanup(
        async () => {
          await resizeRecorder.evaluate((recorder) => recorder.start());
          startWidth = (await pane.boundingBox())!.width;
          const handle = (await resizer.boundingBox())!;
          await page.mouse.move(
            handle.x + handle.width / 2,
            handle.y + handle.height / 2,
          );
          await page.mouse.down();
          await page.mouse.move(
            handle.x + handle.width / 2 + 120,
            handle.y + handle.height / 2,
            { steps: 4 },
          );
          await page.mouse.up();
          await expect
            .poll(async () => Math.round((await pane.boundingBox())!.width))
            .toBe(Math.round(startWidth) + 120);
          resizePassed = true;
        },
        async () => {
          try {
            resizeEvidence = await resizeRecorder.evaluate(
              (recorder, passed) =>
                recorder.stop(
                  passed ? 'assertion-success' : 'assertion-failure',
                ),
              resizePassed,
            );
          } finally {
            await resizeRecorder.dispose();
          }
        },
        async () => {
          if (!resizeEvidence) {
            throw new Error(
              'Sidebar resize diagnostics could not be collected.',
            );
          }
          const evidencePath = testInfo.outputPath(
            'sidebar-resize-diagnostics.json',
          );
          await writeFile(
            evidencePath,
            JSON.stringify(resizeEvidence, null, 2),
          );
          await testInfo.attach('sidebar-resize-diagnostics', {
            path: evidencePath,
            contentType: 'application/json',
          });
        },
      );
      const searchBox = await sidebar
        .getByRole('searchbox', { name: 'Search models' })
        .boundingBox();
      expect(searchBox!.width).toBeGreaterThan(startWidth);
      await expectNoMaterialViolations(page);
      await captureVisualScenario(page, 'library.sidebar.resized', testInfo);
      await page.screenshot({
        path: testInfo.outputPath('library-sidebar-resized.png'),
      });
      await resizer.press('Home');
      await expect(resizer).toHaveAttribute('aria-valuenow', '200');
      await resizer.dblclick();
      await expect(resizer).toHaveAttribute('aria-valuenow', '224');

      // Inspector: every location shows its full path inside File.
      await page
        .getByRole('button', { name: `Select ${modelFixtureName}` })
        .click();
      const inspector = page.getByLabel('Model properties');
      const fileSection = inspector
        .locator('section.inspector-section')
        .filter({ has: page.getByRole('heading', { name: 'File', level: 3 }) });
      await expect(
        fileSection.getByRole('heading', { name: 'Locations', level: 4 }),
      ).toBeVisible();
      await expect(
        inspector.getByRole('heading', { name: 'Locations', level: 3 }),
      ).toHaveCount(0);
      const locationPath = fileSection.locator('.location-path').first();
      await expect(locationPath).toHaveText(models[0]!.locations[0]!.path);
      expect(
        await locationPath.evaluate((element) => ({
          clipped: element.scrollHeight > element.clientHeight + 1,
          clamp: getComputedStyle(element).webkitLineClamp,
        })),
      ).toEqual({ clipped: false, clamp: 'none' });
      await page.screenshot({
        path: testInfo.outputPath('inspector-file-locations.png'),
      });
      const upload = page.getByRole('button', {
        name: 'Upload selected models to PrintFarmer',
      });
      await expect(upload).toHaveText('Upload');
      await expect(upload).toBeDisabled();
      const uploadHelp = page.getByRole('group', {
        name: 'Upload selected models to PrintFarmer',
      });
      await uploadHelp.focus();
      await expect(page.getByRole('tooltip')).toHaveText(
        'Upload selected models to PrintFarmer. Connect a PrintFarmer server profile first.',
      );
      await uploadHelp.hover();
      await page.mouse.move(0, 0);
      await expect(uploadHelp).toBeFocused();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await uploadHelp.press('Escape');
      await expect(page.getByRole('tooltip')).toBeHidden();
      await uploadHelp.hover();
      await expect(page.getByRole('tooltip')).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('library-upload-tooltip.png'),
      });
      await page.mouse.move(0, 0);
      await uploadHelp.press('Tab');
      await expect(page.getByRole('tooltip')).toBeHidden();

      await tags.getByRole('checkbox', { name: 'release-e2e' }).check();
      await collections
        .getByRole('checkbox', { name: /Release E2E fixtures/ })
        .check();
      await expect(page.locator('.library-result-count')).toHaveText('1 of 1');
      await expect(page.getByText(modelFixtureName)).toBeVisible();

      await page.getByRole('button', { name: 'Collect all matching…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Manage collections' });
      await expect(dialog).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(page, 'collections.manager-crud', testInfo);
      await page.screenshot({
        path: testInfo.outputPath('organization-desktop.png'),
      });
      await page.setViewportSize({ width: 1120, height: 700 });
      await expectNoMaterialViolations(page);
      await captureVisualScenario(page, 'collections.compact-layout', testInfo);
      await page.screenshot({
        path: testInfo.outputPath('organization-compact.png'),
      });
      await page.setViewportSize({ width: 1440, height: 860 });
      await dialog
        .getByRole('textbox', { name: 'New collection name' })
        .fill('Test grouping');
      await dialog.getByRole('button', { name: 'Create', exact: true }).click();
      await expect(
        dialog.getByRole('checkbox', {
          name: 'Use Test grouping for bulk change',
        }),
      ).toBeChecked();
      expect(
        (
          await page.evaluate(
            (hash) => window.printFarmer.collectionsForModel({ hash }),
            modelHash,
          )
        ).map((entry) => entry.name),
      ).toEqual(['Release E2E fixtures']);

      await dialog.getByRole('button', { name: 'Preview add' }).click();
      await expect(
        dialog.getByText(/1 will be added, 0 already members/),
      ).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(page, 'collections.bulk-preview', testInfo);
      await dialog
        .getByRole('button', { name: 'Confirm: add 1 membership' })
        .click();
      await expect(
        dialog.getByText(/Added 1 membership across 1 model/),
      ).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(page, 'collections.bulk-applied', testInfo);

      await dialog
        .getByRole('button', { name: 'Rename Test grouping' })
        .click();
      await dialog
        .getByRole('textbox', { name: 'New name for Test grouping' })
        .fill('Renamed grouping');
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(
        dialog.getByRole('button', { name: 'Rename Renamed grouping' }),
      ).toBeVisible();

      await dialog
        .getByRole('button', { name: 'Delete Release E2E fixtures' })
        .click();
      const confirmation = dialog.getByRole('group', {
        name: 'Confirm deleting Release E2E fixtures',
      });
      await expect(confirmation).toContainText('Models and source files stay');
      await expect(confirmation).toContainText('cannot be undone');
      await expect(confirmation).toContainText('PrintFarmer');
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.delete-confirmation',
        testInfo,
      );
      await confirmation.getByRole('button', { name: 'Keep' }).click();
      await expect(confirmation).toHaveCount(0);
      expect(
        await page.evaluate(() => window.printFarmer.listCollections()),
      ).toHaveLength(2);

      await dialog
        .getByRole('button', { name: 'Delete Release E2E fixtures' })
        .click();
      await dialog
        .getByRole('group', { name: 'Confirm deleting Release E2E fixtures' })
        .getByRole('button', { name: 'Delete collection' })
        .click();
      await expect(
        dialog.getByText('Deleted “Release E2E fixtures”.'),
      ).toBeVisible();
      expect(
        (
          await page.evaluate(
            (hash) => window.printFarmer.collectionsForModel({ hash }),
            modelHash,
          )
        ).map((entry) => entry.name),
      ).toEqual(['Renamed grouping']);
      expect(
        await page.evaluate(() => window.printFarmer.listModels()),
      ).toHaveLength(1);
      expect(
        createHash('sha256').update(readFileSync(fixture)).digest('hex'),
      ).toBe(originalHash);
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.workspace.delete-local-effects',
        testInfo,
      );

      await dialog
        .getByRole('button', { name: 'Close collection manager' })
        .click();
      await expect(
        collections.getByRole('checkbox', { name: /Release E2E fixtures/ }),
      ).toHaveCount(0);
      await expect(page.locator('.library-result-count')).toHaveText('1 of 1');
      await expect(page.getByText(modelFixtureName)).toBeVisible();

      // Definitions: manage, review, and bulk-delete unused ones.
      await page.getByRole('button', { name: /^Tags & Collections/ }).click();
      const organization = page.getByRole('main', {
        name: 'Tags and collections',
      });
      await expect(organization).toBeVisible();
      await organization
        .getByRole('textbox', { name: 'New collection name' })
        .fill('Empty shelf');
      await organization
        .getByRole('button', { name: 'Create collection' })
        .click();
      await expect(
        organization.getByText('Created “Empty shelf”.'),
      ).toBeVisible();
      await expect(
        organization.getByRole('row', { name: /Renamed grouping/ }),
      ).toContainText('1');
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.collections-table',
        testInfo,
      );
      await organization
        .getByRole('button', { name: 'Rename Empty shelf' })
        .click();
      const renameEmptyShelf = organization.getByRole('textbox', {
        name: 'New name for Empty shelf',
      });
      await renameEmptyShelf.fill('Renamed empty shelf');
      await organization.getByRole('button', { name: 'Save' }).click();
      await expect(
        organization.getByRole('row', { name: /Renamed empty shelf/ }),
      ).toBeVisible();
      await expect(
        organization.getByText(
          'Renamed “Empty shelf” to “Renamed empty shelf”.',
        ),
      ).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.workspace.inline-local-rename',
        testInfo,
      );
      await page.screenshot({
        path: testInfo.outputPath('organization-workspace-desktop.png'),
      });
      await organization
        .getByRole('button', { name: 'Select all unused (1)' })
        .click();
      await organization
        .getByRole('button', { name: 'Review deletion…' })
        .click();
      const review = organization.getByRole('alert');
      await expect(review).toContainText('Delete 1 collection?');
      await expect(review).toContainText(
        'This collection is not on any model.',
      );
      await page.setViewportSize({ width: 1120, height: 700 });
      await page.screenshot({
        path: testInfo.outputPath('organization-review-compact.png'),
      });
      await page.setViewportSize({ width: 1440, height: 860 });
      await review.getByRole('button', { name: 'Delete 1 collection' }).click();
      await expect(
        organization.getByText('Deleted 1 collection.'),
      ).toBeVisible();
      expect(
        (await page.evaluate(() => window.printFarmer.listCollections())).map(
          (entry) => entry.name,
        ),
      ).toEqual(['Renamed grouping']);

      // The library sidebar reflects the deletion without a manual refresh.
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(
        collections.getByRole('checkbox', { name: /Renamed grouping/ }),
      ).toBeVisible();
      await expect(
        collections.getByRole('checkbox', { name: /Renamed empty shelf/ }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: /^Tags & Collections/ }).click();

      await organization.getByText('Tags', { exact: true }).click();
      await expect(
        organization.getByRole('row', { name: /release-e2e/ }),
      ).toContainText('1');
      await expectNoMaterialViolations(page);
      await captureVisualScenario(page, 'organization.tags-table', testInfo);

      const organizationTagSearch = organization.getByRole('searchbox', {
        name: 'Search tags',
      });
      await organizationTagSearch.fill('no-matching-tag');
      await expect(organization.getByRole('status')).toContainText(
        'No tags match these filters.',
      );
      await organizationTagSearch.fill('');

      await organization.getByText('Collections', { exact: true }).click();
      const organizationCollectionSearch = organization.getByRole('searchbox', {
        name: 'Search collections',
      });
      await organizationCollectionSearch.fill('no-matching-collection');
      await expect(organization.getByRole('status')).toContainText(
        'No collections match these filters.',
      );
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.workspace.filter-no-match',
        testInfo,
      );
      await organizationCollectionSearch.fill('');

      const deleteReviewFixture = await page.evaluate(async (hash) => {
        const collections = [];
        for (let index = 1; index <= 9; index += 1) {
          const created = await window.printFarmer.createCollection({
            name: `Coverage review ${String(index).padStart(2, '0')}`,
          });
          await window.printFarmer.addModelToCollection({
            collectionId: created.id,
            hash,
          });
          collections.push({ id: created.id, name: created.name });
        }
        const preview = await window.printFarmer.previewOrganizationDeletion({
          kind: 'collection',
          ids: collections.map((collection) => collection.id),
          emptyOnly: false,
        });
        return { collections, preview };
      }, modelHash);
      expect(deleteReviewFixture.preview.entries).toHaveLength(9);
      expect(deleteReviewFixture.preview.assignmentsRemoved).toBe(9);
      expect(deleteReviewFixture.preview.serverDeletions).toBe(0);
      expect(deleteReviewFixture.preview.fingerprint).toMatch(/^[a-f0-9]{64}$/);

      await organization.getByRole('button', { name: 'Refresh' }).click();
      const reviewSearch = organization.getByRole('searchbox', {
        name: 'Search collections',
      });
      await reviewSearch.fill('Coverage review');
      await expect(
        organization.getByRole('table').getByRole('row'),
      ).toHaveCount(10);
      await organization
        .getByRole('checkbox', { name: 'Select all shown collections' })
        .check();
      await expect(
        organization.getByText('9 selected', { exact: true }),
      ).toBeVisible();
      await organization
        .getByRole('button', { name: 'Review deletion…' })
        .click();
      const overflowReview = organization.getByRole('alert');
      await expect(overflowReview).toContainText('Delete 9 collections?');
      await expect(overflowReview).toContainText(
        '9 model assignments will be removed. The models themselves stay in the library.',
      );
      const reviewedNames = await overflowReview
        .locator('.organization-review-list li')
        .allTextContents();
      expect(reviewedNames).toHaveLength(9);
      expect(reviewedNames[8]).toBe('and 1 more');
      for (const entry of deleteReviewFixture.preview.entries.slice(0, 8)) {
        expect(reviewedNames.join('\n')).toContain(entry.name);
      }
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.workspace.delete-review-overflow',
        testInfo,
      );
      await overflowReview
        .getByRole('button', { name: 'Keep collections' })
        .click();
      await expect(overflowReview).toHaveCount(0);
      const collectionsAfterKeep = await page.evaluate(() =>
        window.printFarmer.listOrganization(),
      );
      const remainingCollectionIds = new Set(
        collectionsAfterKeep
          .filter((entry) => entry.kind === 'collection')
          .map((entry) => entry.id),
      );
      for (const collection of deleteReviewFixture.collections) {
        expect(remainingCollectionIds.has(collection.id)).toBe(true);
      }
      await reviewSearch.fill('');

      const longCollectionName = `Long ${'collection-name-'.repeat(7)}end`;
      await organization
        .getByRole('textbox', { name: 'New collection name' })
        .fill(longCollectionName);
      await organization
        .getByRole('button', { name: 'Create collection' })
        .click();
      const longCollectionRow = organization
        .getByRole('row')
        .filter({ hasText: longCollectionName });
      await expect(longCollectionRow).toBeVisible();
      const renameLongCollection = longCollectionRow.getByRole('button', {
        name: `Rename ${longCollectionName}`,
      });

      await captureVisualScenario(
        page,
        'organization.wide-layout-zoom',
        testInfo,
      );
      await expect(renameLongCollection).toBeVisible();
      const renameBox = await renameLongCollection.boundingBox();
      expect(renameBox).not.toBeNull();
      expect(renameBox!.x).toBeGreaterThanOrEqual(0);
      expect(renameBox!.x + renameBox!.width).toBeLessThanOrEqual(720);
      await expectNoMaterialViolations(page);

      await applyPinnedRenderingProfile(
        page,
        'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1',
      );
      await page.getByRole('button', { name: 'Library', exact: true }).click();
      await expect(
        collections.getByRole('checkbox', {
          name: new RegExp(longCollectionName),
        }),
      ).toBeVisible();
      await page
        .getByRole('button', { name: `Select ${modelFixtureName}` })
        .click();
      const compactLocationPath = page
        .getByLabel('Model properties')
        .locator('section.inspector-section')
        .filter({
          has: page.getByRole('heading', { name: 'File', level: 3 }),
        })
        .locator('.location-path')
        .first();
      await expect(compactLocationPath).toHaveText(
        models[0]!.locations[0]!.path,
      );
      await expect(compactLocationPath).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'library.sidebar.extreme-labels-paths',
        testInfo,
      );
      await page.setViewportSize({ width: 1440, height: 900 });

      // Reset clears models, sources, tags, and collections; never files.
      await page.getByRole('button', { name: /^Settings/ }).click();
      await page.getByRole('button', { name: 'Reset catalog' }).click();
      await page.getByRole('button', { name: 'Clear local catalog' }).click();
      await expect(
        page.getByText(
          'Catalog cleared. Removed 1 indexed model, 1 source folder, 1 tag, and 11 collections.',
        ),
      ).toBeVisible();
      expect(
        await page.evaluate(() => window.printFarmer.listOrganization()),
      ).toEqual([]);
      expect(await page.evaluate(() => window.printFarmer.listTags())).toEqual(
        [],
      );
      expect(
        createHash('sha256').update(readFileSync(fixture)).digest('hex'),
      ).toBe(originalHash);
      await page.getByRole('button', { name: /^Tags & Collections/ }).click();
      await expect(organization.getByText('No collections yet')).toBeVisible();
      await expect(
        organization.getByText(
          'Create a collection below, then add models from the library.',
        ),
      ).toBeVisible();
      await expect(
        organization.getByRole('textbox', { name: 'New collection name' }),
      ).toBeVisible();
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.workspace.empty-collections',
        testInfo,
      );

      await organization.getByText('Tags', { exact: true }).click();
      await expect(organization.getByText('No tags yet')).toBeVisible();
      await expect(
        organization.getByText('Add tags to a model from its inspector.'),
      ).toBeVisible();
      expect(await page.evaluate(() => window.printFarmer.listTags())).toEqual(
        [],
      );
      await expectNoMaterialViolations(page);
      await captureVisualScenario(
        page,
        'organization.workspace.empty-tags',
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
  const material = results.violations.filter((violation) =>
    ['moderate', 'serious', 'critical'].includes(violation.impact ?? ''),
  );
  expect(material).toEqual([]);
}
