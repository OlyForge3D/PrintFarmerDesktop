import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
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
import { findPackagedExecutable } from './helpers/retargetFixture';
import { RootApprovalStore } from '../src/main/rootApprovals';

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
  const fixture = path.join(modelFixtureDirectory, modelFixtureName);
  const originalHash = createHash('sha256')
    .update(readFileSync(fixture))
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
      }).approveFromPicker(modelFixtureDirectory);
      const sidecar = path.join(
        path.dirname(executablePath),
        'resources',
        'sidecar',
        process.platform === 'win32' ? 'model-core.exe' : 'model-core',
      );
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
      await tagsToggle.click();
      await expect(tagsToggle).toHaveAttribute('aria-expanded', 'true');

      const pane = page.locator('.library-sidebar-pane');
      const resizer = page.getByRole('separator', {
        name: 'Resize library sidebar',
      });
      const startWidth = (await pane.boundingBox())!.width;
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
      const searchBox = await sidebar
        .getByRole('searchbox', { name: 'Search models' })
        .boundingBox();
      expect(searchBox!.width).toBeGreaterThan(startWidth);
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

      await tags.getByRole('checkbox', { name: 'release-e2e' }).check();
      await collections
        .getByRole('checkbox', { name: /Release E2E fixtures/ })
        .check();
      await expect(page.locator('.library-result-count')).toHaveText('1 of 1');
      await expect(page.getByText(modelFixtureName)).toBeVisible();

      await page.getByRole('button', { name: 'Collect all matching…' }).click();
      const dialog = page.getByRole('dialog', { name: 'Manage collections' });
      await expect(dialog).toBeVisible();
      await page.screenshot({
        path: testInfo.outputPath('organization-desktop.png'),
      });
      await page.setViewportSize({ width: 1120, height: 700 });
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
      await dialog
        .getByRole('button', { name: 'Confirm: add 1 membership' })
        .click();
      await expect(
        dialog.getByText(/Added 1 membership across 1 model/),
      ).toBeVisible();

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
        collections.getByRole('checkbox', { name: /Empty shelf/ }),
      ).toHaveCount(0);
      await page.getByRole('button', { name: /^Tags & Collections/ }).click();

      await organization.getByText('Tags', { exact: true }).click();
      await expect(
        organization.getByRole('row', { name: /release-e2e/ }),
      ).toContainText('1');

      // Reset clears models, sources, tags, and collections; never files.
      await page.getByRole('button', { name: /^Sources/ }).click();
      await page.getByRole('button', { name: 'Reset catalog' }).click();
      await page.getByRole('button', { name: 'Clear local catalog' }).click();
      await expect(
        page.getByText(
          'Catalog cleared. Removed 1 indexed model, 1 source folder, 1 tag, and 1 collection.',
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
