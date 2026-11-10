import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
const PROJECT_COUNT_PER_MAKER = 300;

test('folder policies page through a large tree and organize without moving sources', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(180_000);
  expect(browserName).toBe('chromium');
  expect(existsSync(path.join(repoRoot, '.vite/build/main.js'))).toBe(true);

  const state = testInfo.outputPath('import-policy-state');
  const source = path.join(state, 'import-policy-source');
  const userData = path.join(state, 'user-data');
  const catalogDb = path.join(state, 'catalog.sqlite3');
  rmSync(state, { recursive: true, force: true });
  mkdirSync(source, { recursive: true });
  mkdirSync(userData, { recursive: true });
  const sourceFiles: string[] = [];

  const addObj = (relativePath: string, marker: string): void => {
    const filePath = path.join(source, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(
      filePath,
      `o ${marker}\nv 0 0 0\nv ${marker.length + 1} 0 0\nv 0 1 0\nf 1 2 3\n`,
      'utf8',
    );
    sourceFiles.push(filePath);
  };

  for (const [maker, start] of [
    ['MakerA', 0],
    ['MakerB', PROJECT_COUNT_PER_MAKER],
  ] as const) {
    for (let index = 0; index < PROJECT_COUNT_PER_MAKER; index += 1) {
      const project = `Project-${String(start + index).padStart(3, '0')}`;
      addObj(
        path.join('Miniatures', maker, project, 'model.obj'),
        `miniature-${maker}-${project}`,
      );
    }
  }
  addObj(path.join('Gift-Boxes', 'Ready', 'ready.obj'), 'gift-ready');
  addObj(path.join('Gift-Boxes', 'Archive', 'archived.obj'), 'gift-archived');

  const originalSources = sourceFiles.map((filePath) => ({
    filePath,
    digest: createHash('sha256').update(readFileSync(filePath)).digest('hex'),
  }));
  const log = createPackagedProcessLog();
  const trace = createPackagedStartupTrace();
  let launched: ElectronApplication | null = null;
  const saveEvidence = async (page: Page, name: string): Promise<void> => {
    const screenshotPath = testInfo.outputPath(name);
    await page.screenshot({ path: screenshotPath });
    const externalDirectory = process.env.PRINTFARMER_IMPORT_EVIDENCE_DIR;
    if (externalDirectory) {
      mkdirSync(externalDirectory, { recursive: true });
      copyFileSync(
        screenshotPath,
        path.join(externalDirectory, `${testInfo.testId}-${name}`),
      );
    }
  };

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
            PRINTFARMER_CATALOG_DB: catalogDb,
            PRINTFARMER_USER_DATA_PATH: userData,
          },
        }),
      log,
      trace,
    );
    launched = result.app;
    const page = result.page;
    await page.waitForLoadState('domcontentloaded');
    await expect(
      page.getByRole('button', { name: 'Maybe later' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Maybe later' }).click();
    await launched.evaluate(({ dialog, BrowserWindow }, sourcePath) => {
      dialog.showOpenDialog = () =>
        Promise.resolve({ canceled: false, filePaths: [sourcePath] });
      const window = BrowserWindow.getAllWindows()[0];
      if (!window) throw new Error('No application window');
      window.setMinimumSize(820, 620);
      window.setSize(1440, 1000);
    }, source);

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /Add.*folder/i }).click();
    const wizard = page.getByRole('dialog', {
      name: 'Organize models before importing',
    });
    await expect(wizard).toBeVisible();
    await expect(wizard.getByText(/60[0-9] folders/)).toBeVisible();

    const rootMode = (relativePath: string) =>
      wizard.getByRole('combobox', {
        name: `Folder organization for ${relativePath}`,
        exact: true,
      });
    const rootPathButton = (relativePath: string) =>
      wizard.getByRole('button', {
        name: `Edit policy for ${relativePath}`,
        exact: true,
      });
    const miniaturesMode = rootMode('Miniatures');
    await rootPathButton('Miniatures').click();
    await miniaturesMode.selectOption('recipe');
    await wizard
      .getByRole('textbox', { name: 'Path pattern for Miniatures' })
      .fill('{maker}/{project}/**');
    await wizard
      .getByRole('textbox', { name: 'Recipe collection name for Miniatures' })
      .fill('{maker}');
    await wizard
      .getByRole('textbox', { name: 'Recipe tags for Miniatures' })
      .fill('miniatures');

    await wizard.getByRole('button', { name: 'Expand Miniatures' }).click();
    await wizard
      .getByRole('button', { name: 'Expand Miniatures/MakerB' })
      .click();
    await wizard
      .getByRole('button', { name: 'Expand Miniatures/MakerA' })
      .click();
    const nextPage = wizard.getByRole('button', { name: 'Next 100' });
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      await nextPage.click();
    }
    await expect(wizard.locator('.import-tree-pagination')).toContainText(
      /Showing 501–600 of 60[0-9] visible/,
    );
    await saveEvidence(page, 'folder-policy-tree-page-six.png');
    for (let pageIndex = 0; pageIndex < 5; pageIndex += 1) {
      await wizard.getByRole('button', { name: 'Previous 100' }).click();
    }

    await wizard
      .getByRole('button', { name: 'Select all folders in source' })
      .click();
    await expect(wizard.getByText(/\d{3,} selected/)).toBeVisible();
    await wizard.getByRole('button', { name: 'Clear selection' }).click();

    const giftRoot = rootPathButton('Gift-Boxes');
    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
      if (await giftRoot.isVisible().catch(() => false)) break;
      await nextPage.click();
    }
    await expect(giftRoot).toBeVisible();
    await giftRoot.click();
    const giftMode = rootMode('Gift-Boxes');
    await giftMode.selectOption('collection');
    await wizard
      .getByRole('combobox', { name: 'Collection name for Gift-Boxes' })
      .fill('Gift Box Collection');
    await wizard.getByRole('button', { name: 'Expand Gift-Boxes' }).click();

    const giftCheckbox = wizard.getByRole('checkbox', {
      name: 'Select Gift-Boxes and descendants',
    });
    await giftCheckbox.check();
    await wizard
      .getByRole('button', { name: 'Disable folder organization' })
      .click();
    const archivePath = rootPathButton('Gift-Boxes/Archive');
    await expect(archivePath).toBeVisible();
    await archivePath.click();
    await expect(
      wizard.getByRole('combobox', {
        name: 'Folder organization for Gift-Boxes/Archive',
      }),
    ).toHaveValue('inherit');
    await expect(wizard).toContainText('Disabled by Gift-Boxes');
    await saveEvidence(page, 'folder-policy-bulk-disabled.png');

    await giftRoot.click();
    await giftCheckbox.check();
    await wizard.getByRole('button', { name: 'Clear policy; inherit' }).click();
    await expect(giftMode).toHaveValue('inherit');
    await giftRoot.click();
    await giftMode.selectOption('collection');
    await wizard
      .getByRole('combobox', { name: 'Collection name for Gift-Boxes' })
      .fill('Gift Box Collection');
    await archivePath.click();
    await wizard
      .getByRole('combobox', {
        name: 'Folder organization for Gift-Boxes/Archive',
      })
      .selectOption('disabled');

    await expect(
      wizard.getByText('Calculating organization changes…'),
    ).toBeVisible();
    await expect(wizard.getByText('Up to date')).toBeVisible({
      timeout: 30_000,
    });
    await expect(wizard.locator('.import-preview-metrics')).toContainText(
      '602',
    );
    await expect(
      wizard.getByRole('button', { name: 'Import', exact: true }),
    ).toBeEnabled();
    await saveEvidence(page, 'folder-policy-preview.png');

    await wizard.getByRole('button', { name: 'Import', exact: true }).click();
    await expect(wizard).toHaveCount(0, { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.printFarmer.listModels())).length,
        { timeout: 60_000 },
      )
      .toBe(602);
    await saveEvidence(page, 'folder-policy-imported.png');

    const lookup = async (relativePath: string) =>
      page.evaluate(async (modelPath) => {
        const models = await window.printFarmer.listModels();
        const model = models.find((entry) =>
          entry.locations.some((location) =>
            location.path.replaceAll('\\', '/').endsWith(modelPath),
          ),
        );
        if (!model) throw new Error(`Missing imported model ${modelPath}`);
        const [collections, tags] = await Promise.all([
          window.printFarmer.collectionsForModel({ hash: model.hash }),
          window.printFarmer.tagsForModel({ hash: model.hash }),
        ]);
        return {
          collections: collections.map((collection) => collection.name).sort(),
          tags: tags.map((tag) => tag.name).sort(),
        };
      }, relativePath);

    expect(await lookup('Miniatures/MakerA/Project-000/model.obj')).toEqual({
      collections: ['MakerA', 'import-policy-source'],
      tags: ['miniatures'],
    });
    expect(await lookup('Gift-Boxes/Ready/ready.obj')).toEqual({
      collections: ['Gift Box Collection', 'import-policy-source'],
      tags: [],
    });
    expect(await lookup('Gift-Boxes/Archive/archived.obj')).toEqual({
      collections: ['import-policy-source'],
      tags: [],
    });

    expect(
      sourceFiles.map((filePath) => ({
        filePath,
        digest: createHash('sha256')
          .update(readFileSync(filePath))
          .digest('hex'),
      })),
    ).toEqual(originalSources);

    await page.getByRole('button', { name: /Add.*folder/i }).click();
    const repeatWizard = page.getByRole('dialog', {
      name: 'Organize models before importing',
    });
    await expect(repeatWizard).toBeVisible();
    await repeatWizard
      .getByRole('button', { name: 'Edit policy for Miniatures' })
      .click();
    await expect(
      repeatWizard.getByRole('combobox', {
        name: 'Folder organization for Miniatures',
      }),
    ).toHaveValue('recipe');
    await expect(
      repeatWizard.getByRole('textbox', {
        name: 'Path pattern for Miniatures',
      }),
    ).toHaveValue('{maker}/{project}/**');
    await expect(repeatWizard.getByText('Up to date')).toBeVisible({
      timeout: 30_000,
    });
    await repeatWizard
      .getByRole('button', { name: 'Import', exact: true })
      .click();
    await expect(repeatWizard).toHaveCount(0, { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.printFarmer.listModels())).length,
        { timeout: 60_000 },
      )
      .toBe(602);
    expect(await lookup('Miniatures/MakerA/Project-000/model.obj')).toEqual({
      collections: ['MakerA', 'import-policy-source'],
      tags: ['miniatures'],
    });
    expect(
      sourceFiles.map((filePath) => ({
        filePath,
        digest: createHash('sha256')
          .update(readFileSync(filePath))
          .digest('hex'),
      })),
    ).toEqual(originalSources);
    await saveEvidence(page, 'folder-policy-repeat-import.png');
  } catch (error) {
    await testInfo.attach('electron-sidecar.log', {
      body: Buffer.from(log.read()),
      contentType: 'text/plain',
    });
    throw error;
  } finally {
    await launched?.close();
    rmSync(state, { recursive: true, force: true });
  }
});
