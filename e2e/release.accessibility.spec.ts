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
import { findPackagedExecutable } from './helpers/retargetFixture';

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
      const onboarding = page.getByRole('dialog', {
        name: 'Set up your model library',
      });
      await expect(onboarding).toBeVisible();
      const addFolder = page.getByRole('button', {
        name: 'Add your first folder',
      });
      await expect(addFolder).toBeFocused();
      await expectNoMaterialViolations(page, 'onboarding', testInfo);

      const closeOnboarding = page.getByRole('button', {
        name: 'Close onboarding',
      });
      await closeOnboarding.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(
        page.getByRole('button', { name: 'Maybe later' }),
      ).toBeFocused();
      await addFolder.click();

      const importDialog = page.getByRole('dialog', {
        name: 'Organize models before importing',
      });
      await expect(importDialog).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'Cancel import' }),
      ).toBeFocused();
      await expectNoMaterialViolations(page, 'import review', testInfo);
      const importButton = page.getByRole('button', { name: 'Import 1 files' });
      await importButton.scrollIntoViewIfNeeded();
      await importButton.click();
      await expect(importDialog).toHaveCount(0);

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
          .locator('.workspace')
          .evaluate((element) => element.hasAttribute('inert')),
      ).resolves.toBe(true);
      await expectNoMaterialViolations(page, '3D viewer', testInfo);

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
      await viewer.focus();
      await page.keyboard.press('ArrowRight');
      await expect(viewer).toBeFocused();

      await back.click();
      await expect(viewerDialog).toHaveCount(0);
      await expect(previewButton).toBeFocused();
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
    await testInfo.attach(`axe-${surface.replaceAll(' ', '-')}.json`, {
      body: Buffer.from(JSON.stringify(material, null, 2)),
      contentType: 'application/json',
    });
  }
  expect(material, `${surface} has material WCAG A/AA violations`).toEqual([]);
}
