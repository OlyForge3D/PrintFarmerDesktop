import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { execFileSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createPackagedProcessLog,
  createPackagedStartupTrace,
  launchInstrumentedElectronTestApp,
} from './helpers/packagedApp';
import {
  modelFixtureDirectory,
  modelFixtureName,
} from './helpers/modelLibrary';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

test('many skipped ZIPs keep import actions reachable while details scroll', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(120_000);
  expect(browserName).toBe('chromium');
  expect(existsSync(path.join(repoRoot, '.vite/build/main.js'))).toBe(true);
  const state = mkdtempSync(path.join(tmpdir(), 'pf-scan-feedback-'));
  const source = path.join(state, 'models-with-many-skips');
  const userData = path.join(state, 'user-data');
  mkdirSync(source, { recursive: true });
  mkdirSync(userData);
  copyFileSync(
    path.join(modelFixtureDirectory, modelFixtureName),
    path.join(source, 'local.obj'),
  );
  const log = createPackagedProcessLog();
  const trace = createPackagedStartupTrace();
  let launched: Awaited<ReturnType<typeof electron.launch>> | null = null;
  try {
    const archivePath = (index: number) =>
      path.join(source, `archive-${index}-${'long-name-'.repeat(12)}.zip`);
    const firstArchive = archivePath(0);
    const file = openSync(firstArchive, 'w');
    try {
      // NTFS needs an explicit sparse flag before extending the file.
      if (process.platform === 'win32') {
        execFileSync('fsutil.exe', ['sparse', 'setflag', firstArchive]);
      }
      ftruncateSync(file, 512 * 1024 * 1024 + 1);
    } finally {
      closeSync(file);
    }
    for (let index = 1; index < 225; index += 1) {
      linkSync(firstArchive, archivePath(index));
    }
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
      if (!window) {
        throw new Error('No application window');
      }
      window.setMinimumSize(480, 400);
      window.setSize(640, 520);
    }, source);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: /Add.*folder/i }).click();
    const wizard = page.getByRole('dialog', {
      name: 'Organize models before importing',
    });
    await expect(wizard).toBeVisible();
    const actualImportButton = wizard.getByRole('button', {
      name: /Import 1 file/,
    });
    await expect(actualImportButton).toBeEnabled();
    await expect(wizard).toContainText('225');
    await expect
      .poll(() =>
        wizard.evaluate(
          (element) => element.scrollWidth <= element.clientWidth,
        ),
      )
      .toBe(true);
    await expect
      .poll(() =>
        wizard.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return bounds.left >= 0 && bounds.right <= window.innerWidth;
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        wizard
          .locator('.import-body')
          .evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    const details = wizard
      .locator('details')
      .filter({ has: page.locator('summary', { hasText: /skip/i }) });
    await expect(details).toHaveCount(1);
    await expect(details).not.toHaveAttribute('open', '');
    await page.screenshot({ path: testInfo.outputPath('scan-summary.png') });
    await details.locator('summary').click();
    await page.screenshot({
      path: testInfo.outputPath('scan-details-expanded.png'),
    });
    const body = wizard.locator('.import-body');
    await expect
      .poll(() =>
        body.evaluate((element) => element.scrollWidth <= element.clientWidth),
      )
      .toBe(true);
    const scrollBefore = await body.evaluate((element) => {
      if (element.scrollHeight <= element.clientHeight) {
        throw new Error(
          'Expanded scan details did not create scrollable content',
        );
      }
      return element.scrollTop;
    });
    await body.hover();
    await page.mouse.wheel(0, 1200);
    await expect
      .poll(() => body.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBefore);
    await expect(actualImportButton).toBeInViewport();
    await page.screenshot({
      path: testInfo.outputPath('scan-details-scrolled.png'),
    });
    await actualImportButton.focus();
    await page.keyboard.press('Enter');
    await expect(wizard).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.printFarmer.listModels())).length,
      )
      .toBe(1);
    await expect(page.locator('.scan-feedback-actions button')).toHaveCount(2);
    const contrast = await new AxeBuilder({ page })
      .setLegacyMode()
      .include('.scan-feedback')
      .withRules(['color-contrast'])
      .analyze();
    expect(contrast.violations).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath('scan-import-completed.png'),
    });
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
