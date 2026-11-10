import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPackagedProcessLog,
  createPackagedStartupTrace,
  launchInstrumentedElectronTestApp,
} from './helpers/packagedApp';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('automatic summary, responsive width and explicit stale-target recovery use the real sidecar', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  const state = mkdtempSync(path.join(tmpdir(), 'pf-import-summary-'));
  const source = path.join(state, 'Models');
  mkdirSync(path.join(source, 'Miniatures'), { recursive: true });
  writeFileSync(
    path.join(source, 'Miniatures', 'dragon.obj'),
    'o dragon\nv 0 0 0\nv 2 0 0\nv 0 1 0\nf 1 2 3\n',
  );
  const log = createPackagedProcessLog();
  const trace = createPackagedStartupTrace();
  let app: ElectronApplication | null = null;
  try {
    const result = await launchInstrumentedElectronTestApp<
      Page,
      ElectronApplication
    >(
      () =>
        electron.launch({
          args: ['.'],
          cwd: repoRoot,
          env: {
            ...process.env,
            PRINTFARMER_CATALOG_DB: path.join(state, 'catalog.sqlite3'),
            PRINTFARMER_USER_DATA_PATH: path.join(state, 'user-data'),
          },
        }),
      log,
      trace,
    );
    app = result.app;
    const page = result.page;
    await page.getByRole('button', { name: 'Maybe later' }).click();
    await app.evaluate(({ dialog, BrowserWindow }, sourcePath) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [sourcePath] });
      BrowserWindow.getAllWindows()[0]!.setMinimumSize(480, 400);
    }, source);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /Add.*folder/i }).click();
    const wizard = page.getByRole('dialog', {
      name: 'Organize models before importing',
    });
    await expect(wizard.getByText('Up to date')).toBeVisible();
    const importButton = wizard.getByRole('button', {
      name: 'Import',
      exact: true,
    });
    await expect(importButton).toBeEnabled();
    await expect(importButton).toHaveCSS('color', 'rgb(255, 255, 255)');
    const contrast = await new AxeBuilder({ page })
      .setLegacyMode()
      .include('.import-primary')
      .withRules(['color-contrast'])
      .analyze();
    expect(contrast.violations).toEqual([]);
    await wizard
      .getByRole('checkbox', { name: 'Add all models to collection' })
      .uncheck();
    await expect(importButton).toBeDisabled();
    await expect(
      wizard.getByText(
        'No collections or tags will be added. Model files will still be imported.',
      ),
    ).toBeVisible();
    await expect(importButton).toBeEnabled();
    await expect(wizard.locator('.import-preview-metrics')).toHaveCount(0);
    for (const width of [640, 1200, 1920]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0]!.setSize(size, 900),
        width,
      );
      await expect
        .poll(() =>
          wizard.evaluate((element) => {
            const bounds = element.getBoundingClientRect();
            return (
              bounds.left >= 15 &&
              bounds.right <= innerWidth - 15 &&
              element.scrollWidth <= element.clientWidth
            );
          }),
        )
        .toBe(true);
      if (width >= 1200) {
        const ratio = await wizard.evaluate(
          (element) => element.getBoundingClientRect().width / innerWidth,
        );
        expect(ratio).toBeCloseTo(0.9, 2);
      }
      for (const selector of [
        '.import-body',
        '.import-tree-layout',
        '.import-folder-editor',
      ]) {
        expect(
          await wizard
            .locator(selector)
            .evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      }
      await page.screenshot({
        path: testInfo.outputPath(`automatic-summary-${width}.png`),
      });
    }
    const approvedPath = await wizard
      .locator('.import-source-path')
      .innerText();
    await wizard.getByRole('button', { name: 'Cancel', exact: true }).click();
    const key = await page.evaluate((sourcePath) => {
      let hash = 5381;
      for (let index = 0; index < sourcePath.length; index += 1)
        hash = (hash * 33) ^ sourcePath.charCodeAt(index);
      const recipeKey = `printfarmer.import-recipe.v2.root-${(hash >>> 0).toString(16)}`;
      localStorage.setItem(
        recipeKey,
        JSON.stringify({
          rules: [
            {
              relativePath: 'Miniatures',
              kind: 'collection',
              name: 'Dragons',
              collectionId: 'deleted-legacy-id',
            },
            { relativePath: 'Miniatures', kind: 'tag', name: 'miniatures' },
          ],
          policies: [
            {
              relativePath: 'Hidden/Archive',
              mode: 'organize',
              collectionName: 'Archive',
              collectionId: 'deleted-policy-id',
              tags: [],
            },
          ],
          commonTags: [],
        }),
      );
      return recipeKey;
    }, approvedPath);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setSize(1440, 1000),
    );
    await page.getByRole('button', { name: /Add.*folder/i }).click();
    const targets = wizard.getByRole('alert', {
      name: 'Collection targets need attention',
    });
    await expect(targets).toContainText('Miniatures — Dragons');
    await expect(targets).toContainText('Hidden/Archive — Archive');
    await expect(wizard).not.toContainText('deleted-legacy-id');
    await expect(wizard.locator('.import-preview-metrics')).toHaveCount(0);
    await expect(importButton).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('missing-targets.png') });
    await targets
      .getByLabel('Resolve rule collection for Miniatures')
      .selectOption('__name__');
    await targets
      .getByLabel('Resolve policy collection for Hidden/Archive')
      .selectOption('__name__');
    await expect(wizard.getByText('Up to date')).toBeVisible();
    await expect(importButton).toBeEnabled();
    await importButton.click();
    await expect(wizard).toHaveCount(0);
    await expect
      .poll(() =>
        page.evaluate(
          async () => (await window.printFarmer.listModels()).length,
        ),
      )
      .toBe(1);
    const organized = await page.evaluate(async () => {
      const [model] = await window.printFarmer.listModels();
      if (!model) throw new Error('Imported model missing');
      return {
        collections: (
          await window.printFarmer.collectionsForModel({ hash: model.hash })
        ).map((item) => item.name),
        tags: (await window.printFarmer.tagsForModel({ hash: model.hash })).map(
          (item) => item.name,
        ),
      };
    });
    expect(organized).toEqual({
      collections: ['Dragons'],
      tags: ['miniatures'],
    });
    expect(
      await page.evaluate((key) => localStorage.getItem(key), key),
    ).not.toContain('deleted-');
    await page
      .getByRole('button', { name: 'Reset catalog', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Clear local catalog', exact: true })
      .click();
    await expect
      .poll(() => page.evaluate((key) => localStorage.getItem(key), key))
      .toBeNull();
    await page.getByRole('button', { name: /Add.*folder/i }).click();
    await expect(wizard.getByText('Up to date')).toBeVisible();
    await expect(
      wizard.getByRole('alert', { name: 'Collection targets need attention' }),
    ).toHaveCount(0);
    await expect(importButton).toBeEnabled();
  } catch (error) {
    await testInfo.attach('electron-sidecar.log', {
      body: Buffer.from(log.read()),
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    await app?.close();
    rmSync(state, { recursive: true, force: true });
  }
});
