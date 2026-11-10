import AxeBuilder from '@axe-core/playwright';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
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

for (const entry of ['settings', 'onboarding', 'empty library'] as const) {
  test(`folder inspection remains visible and accessible from ${entry}`, async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBe('chromium');
    const state = mkdtempSync(path.join(tmpdir(), 'pf-import-preparation-'));
    const source = path.join(state, 'Hundreds of model folders');
    const userData = path.join(state, 'user-data');
    mkdirSync(userData);
    for (let index = 0; index < 600; index += 1) {
      const folder = path.join(source, `Project-${index}`);
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        path.join(folder, 'part.obj'),
        'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
      );
    }

    const { app, page } = await launchInstrumentedElectronTestApp<
      Page,
      ElectronApplication
    >(
      () =>
        electron.launch({
          args: ['.'],
          cwd: repoRoot,
          env: {
            ...process.env,
            PRINTFARMER_USER_DATA_PATH: userData,
            PRINTFARMER_CATALOG_DB: path.join(state, 'catalog.sqlite3'),
          },
        }),
      createPackagedProcessLog(),
      createPackagedStartupTrace(),
    );
    try {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await app.evaluate(({ dialog, ipcMain }, sourcePath) => {
        dialog.showOpenDialog = () =>
          Promise.resolve({
            canceled: false,
            filePaths: [sourcePath],
          });
        // Retain the real IPC/sidecar work and result, only hold its delivery.
        const handlers = Reflect.get(ipcMain, '_invokeHandlers') as Map<
          string,
          (
            event: Electron.IpcMainInvokeEvent,
            request: unknown,
          ) => Promise<unknown>
        >;
        const original = handlers.get('catalog:previewImport');
        if (!original) throw new Error('Real preview handler missing');
        let first = true;
        ipcMain.removeHandler('catalog:previewImport');
        ipcMain.handle(
          'catalog:previewImport',
          async (event, request: unknown) => {
            const result = await original(event, request);
            if (first) {
              first = false;
              await new Promise<void>((resolve) => {
                Reflect.set(globalThis, 'releaseInspection', resolve);
              });
            }
            return result;
          },
        );
      }, source);

      const onboarding = page.getByRole('dialog', {
        name: 'Set up your model library',
      });
      await expect(onboarding).toBeVisible();
      if (entry !== 'onboarding') {
        await onboarding.getByRole('button', { name: 'Maybe later' }).click();
      }
      if (entry === 'settings') {
        await page
          .getByRole('button', { name: 'Settings', exact: true })
          .click();
      }
      const triggerName =
        entry === 'settings' ? 'Add source folder' : 'Add your first folder';
      await page
        .getByRole('button', { name: triggerName, exact: true })
        .click();
      const status = page.getByRole('status', { name: 'Folder inspection' });
      await expect(status).toContainText(
        'Inspecting folder: Hundreds of model folders',
      );
      await expect(status).toHaveAttribute('aria-live', 'polite');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      if (entry !== 'onboarding') {
        await expect(
          page.getByRole('button', { name: triggerName, exact: true }),
        ).toBeDisabled();
      }
      const animation = await status
        .locator('.loading-indicator')
        .evaluate((element) => getComputedStyle(element).animationDuration);
      expect(parseFloat(animation)).toBeLessThanOrEqual(0.01);
      const accessibility = await new AxeBuilder({ page })
        .setLegacyMode()
        .include('.import-preparation-status')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await page.screenshot({
        path: testInfo.outputPath('folder-inspection.png'),
      });
      await app.evaluate(() => {
        const release = Reflect.get(globalThis, 'releaseInspection') as
          (() => void) | undefined;
        if (typeof release !== 'function')
          throw new Error('Inspection hold not reached');
        release();
      });
      const wizard = page.getByRole('dialog', {
        name: 'Organize models before importing',
      });
      await expect(wizard).toBeVisible();
      await expect(status).toBeEmpty();
      const cancel = wizard.getByRole('button', {
        name: 'Cancel import',
        exact: true,
      });
      await expect(cancel).toBeFocused();
      await cancel.click();
      await expect(
        page.getByRole('button', { name: triggerName, exact: true }),
      ).toBeFocused();
    } finally {
      await app.close();
      rmSync(state, { recursive: true, force: true });
    }
  });
}
