import { expect, type Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const modelFixtureDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'models',
);

export const modelFixtureName =
  'precision-calibration-fixture-with-an-intentionally-long-name.obj';

export async function refreshCatalog(page: Page): Promise<void> {
  // Folder management lives in Settings; refresh there before returning.
  await page.getByRole('button', { name: /^Settings/ }).click();
  const sourcesPane = page.getByRole('main', { name: 'Settings' });
  await expect(sourcesPane).toBeVisible();
  await sourcesPane.getByRole('button', { name: 'Refresh catalog' }).click();
  await expect(
    sourcesPane.getByRole('region', { name: 'Source folders' }),
  ).toHaveAttribute('aria-busy', 'false');
  await page.getByRole('button', { name: 'Library', exact: true }).click();
  await expect(page.getByRole('main', { name: 'Model library' })).toBeVisible();
}

export async function importModelFixture(
  page: Page,
  rootId: string,
): Promise<void> {
  const approval = await page.evaluate(() => window.printFarmer.openFolder());
  if (!approval) {
    throw new Error('Packaged fixture folder approval failed.');
  }
  const preview = await page.evaluate(
    (approvalId) => window.printFarmer.previewImport({ approvalId }),
    approval.approvalId,
  );
  if (preview.modelCount !== 1 || preview.formats.obj !== 1) {
    throw new Error(
      `Expected one OBJ fixture, received ${preview.modelCount} models.`,
    );
  }
  const result = await page.evaluate(
    async ({ approvalId, approvedRootId }) =>
      window.printFarmer.importRoot({
        rootId: approvedRootId,
        approvalId,
        rules: [
          {
            relativePath: '',
            kind: 'collection',
            name: 'Release E2E fixtures',
          },
        ],
        commonTags: ['release-e2e'],
      }),
    {
      approvalId: approval.approvalId,
      approvedRootId: rootId,
    },
  );
  if (result.report.added !== 1 || result.modelsOrganized !== 1) {
    throw new Error(
      `Packaged fixture import added ${result.report.added} and organized ${result.modelsOrganized} models.`,
    );
  }
  await refreshCatalog(page);
}
