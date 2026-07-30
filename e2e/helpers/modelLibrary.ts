import type { Page } from '@playwright/test';
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
  await page.getByRole('button', { name: 'Manage sources' }).click();
  const sourcesDialog = page.getByRole('dialog', {
    name: 'Catalog sources',
  });
  await sourcesDialog.getByRole('button', { name: 'Refresh catalog' }).click();
  await sourcesDialog
    .getByRole('button', { name: 'Close catalog sources' })
    .click();
  await sourcesDialog.waitFor({ state: 'detached' });
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
