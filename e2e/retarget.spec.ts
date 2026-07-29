import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEditableRetargetFixture,
  findPackagedExecutable,
} from './helpers/retargetFixture';
import {
  attachPackagedFailureDiagnostics,
  cleanupPackagedApp,
  createPackagedProcessLog,
  launchPackagedApp,
  removePackagedAppTempRoot,
  runWithPackagedTestCleanup,
  type PackagedApp,
  type PackagedProcessLog,
} from './helpers/packagedApp';
import { SidecarClient, spawnSidecarChannel } from '../src/main/sidecar';
import { RootApprovalStore } from '../src/main/rootApprovals';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const retargetRoot = path.join(tmpdir(), 'PrintFarmer', 'retarget');

function hash(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function instanceRoots(): string[] {
  try {
    return readdirSync(retargetRoot).map((entry) =>
      path.join(retargetRoot, entry),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function dismissOnboarding(page: Page): Promise<void> {
  const maybeLater = page.getByRole('button', { name: 'Maybe later' });
  try {
    await maybeLater.waitFor({ state: 'visible', timeout: 2_000 });
    await maybeLater.click();
  } catch {
    // A previously initialized user-data directory has no onboarding dialog.
  }
}

async function openWorkflow(page: Page, fileName: string): Promise<void> {
  await page.getByRole('button', { name: `Select ${fileName}` }).click();
  await page
    .getByLabel('Model properties')
    .getByRole('button', { name: 'Prepare for Snapmaker U1' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Prepare for Snapmaker U1' }),
  ).toBeVisible();
}

async function expectPackagedThumbnail(
  page: Page,
  fileName: string,
): Promise<void> {
  const image = page
    .getByRole('button', { name: `Select ${fileName}` })
    .locator('img.model-thumb-img');
  await expect(image).toBeVisible();
  const rendered = await image.evaluate(async (element) => {
    if (!(element instanceof HTMLImageElement)) {
      throw new Error('Thumbnail did not render as an image.');
    }
    await element.decode();
    return {
      naturalWidth: element.naturalWidth,
      naturalHeight: element.naturalHeight,
      source: element.currentSrc || element.src,
    };
  });

  expect(rendered).toMatchObject({
    naturalWidth: 256,
    naturalHeight: 256,
  });
  expect(rendered.source).toMatch(/^data:image\/png;base64,/);
}

test('runs the U1 workflow in the packaged app without changing the source', async ({
  browserName,
}, testInfo) => {
  test.setTimeout(180_000);
  let root: string | null = null;
  let rootsBefore: Set<string> | null = null;
  let launched: PackagedApp | null = null;
  let processLog: PackagedProcessLog | null = null;

  await runWithPackagedTestCleanup(
    async () => {
      expect(browserName).toBe('chromium');
      processLog = createPackagedProcessLog();
      const executable = findPackagedExecutable(repoRoot);
      root = mkdtempSync(path.join(tmpdir(), 'pf-u1-packaged-'));
      const fixtureDirectory = path.join(root, 'fixtures');
      const fixture = createEditableRetargetFixture(fixtureDirectory);
      const fileName = path.basename(fixture.file);
      const catalogDb = path.join(root, 'catalog.sqlite3');
      const userData = path.join(root, 'user-data');
      const savedOutput = path.join(root, 'saved-u1.3mf');
      const initialInstanceRoots = new Set(instanceRoots());
      rootsBefore = initialInstanceRoots;
      const dialogEnvironment = {
        PRINTFARMER_E2E: '1',
        PRINTFARMER_E2E_OPEN_DIALOGS: JSON.stringify([
          savedOutput,
          savedOutput,
        ]),
        PRINTFARMER_E2E_SAVE_DIALOGS: JSON.stringify([
          { canceled: false, filePath: savedOutput },
        ]),
      };

      const stagedSidecar = path.join(
        repoRoot,
        'resources',
        'sidecar',
        process.platform === 'win32' ? 'model-core.exe' : 'model-core',
      );
      mkdirSync(userData, { recursive: true });
      const approvals = new RootApprovalStore({ userDataPath: userData });
      await approvals.approveFromPicker(fixtureDirectory);

      const previousCatalogDb = process.env.PRINTFARMER_CATALOG_DB;
      process.env.PRINTFARMER_CATALOG_DB = catalogDb;
      let seedSidecar: SidecarClient | null = null;
      await runWithPackagedTestCleanup(
        async () => {
          seedSidecar = new SidecarClient(() =>
            spawnSidecarChannel(stagedSidecar),
          );
          await seedSidecar.importRoot(
            'packaged-u1-fixtures',
            fixtureDirectory,
            [
              {
                relativePath: '',
                kind: 'collection',
                name: 'Packaged U1 fixtures',
              },
            ],
            ['u1-e2e'],
          );
        },
        () => {
          try {
            seedSidecar?.dispose();
          } finally {
            if (previousCatalogDb === undefined) {
              delete process.env.PRINTFARMER_CATALOG_DB;
            } else {
              process.env.PRINTFARMER_CATALOG_DB = previousCatalogDb;
            }
          }
          return Promise.resolve();
        },
      );

      launched = await launchPackagedApp({
        executablePath: executable,
        userDataPath: userData,
        catalogDb,
        processLog,
        environment: dialogEnvironment,
      });
      await dismissOnboarding(launched.page);
      await launched.page
        .getByRole('button', { name: 'Refresh catalog' })
        .click();
      await expectPackagedThumbnail(launched.page, fileName);
      const imported = await launched.page.evaluate(() =>
        window.printFarmer.listModels(),
      );
      const importedModel = imported.find(
        (model) => model.hash === fixture.sha256,
      );
      expect(importedModel).toBeDefined();
      const importedRootId = importedModel?.locations[0]?.rootId;
      expect(importedRootId).toBeTruthy();
      const directPreflight = await launched.page.evaluate(
        async ({ modelHash }) => {
          const catalog = await window.printFarmer.listRetargetProfiles();
          if (catalog.status !== 'ok') return catalog;
          const profileId = catalog.value.profiles.find(
            (profile) => profile.source === 'bundled',
          )?.id;
          if (!profileId) return { missingBundledProfile: true };
          try {
            return await window.printFarmer.preflightRetarget({
              modelHash,
              rootId: 'packaged-u1-fixtures',
              profileId,
              objectExclusion: false,
            });
          } catch (error) {
            return { thrown: String(error) };
          }
        },
        { modelHash: fixture.sha256, rootId: importedRootId! },
      );
      expect(directPreflight).not.toHaveProperty('thrown');
      await launched.page
        .getByRole('button', { name: 'Refresh catalog' })
        .click();
      await openWorkflow(launched.page, fileName);

      const bundled = launched.page
        .getByRole('radio', { name: /\(bundled\)$/ })
        .first();
      await bundled.click();
      const build = launched.page.getByRole('button', {
        name: 'Build review copy',
      });
      await expect(build).toBeEnabled();
      expect(hash(fixture.file)).toBe(fixture.sha256);
      await build.click();
      await expect(
        launched.page.getByRole('heading', { name: 'Review changes' }),
      ).toBeVisible();
      await expect(launched.page.getByText('Source preserved.')).toBeVisible();
      expect(hash(fixture.file)).toBe(fixture.sha256);

      await launched.page.getByRole('button', { name: 'Source' }).click();
      await expect(
        launched.page.getByRole('button', { name: 'Source' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await launched.page
        .getByRole('button', { name: 'Snapmaker U1 output' })
        .click();
      await expect(
        launched.page.getByRole('button', { name: 'Snapmaker U1 output' }),
      ).toHaveAttribute('aria-pressed', 'true');

      const saveAs = launched.page.getByRole('button', { name: 'Save As…' });
      await expect(saveAs).toBeEnabled();
      await saveAs.scrollIntoViewIfNeeded({ timeout: 10_000 });
      await saveAs.click({ trial: true, timeout: 10_000 });
      await saveAs.click({ timeout: 10_000 });
      await expect(
        launched.page.getByText(/Saved saved-u1\.3mf/).first(),
      ).toBeVisible();
      expect(existsSync(savedOutput)).toBe(true);
      expect(hash(fixture.file)).toBe(fixture.sha256);
      await launched.page
        .getByRole('status')
        .filter({ hasText: /Saved saved-u1\.3mf/ })
        .getByRole('button', { name: 'Close' })
        .click();

      await openWorkflow(launched.page, fileName);
      const directImport = await launched.page.evaluate(() =>
        window.printFarmer.importRetargetProfile(),
      );
      expect(directImport).toMatchObject({ status: 'ok' });
      await launched.page
        .getByRole('button', { name: 'Import U1 reference' })
        .click();
      await expect(
        launched.page.getByRole('radio', { name: /\(imported\)$/ }).first(),
      ).toBeChecked();
      await expect(
        launched.page.getByRole('button', { name: 'Build review copy' }),
      ).toBeEnabled();
      await launched.page
        .getByRole('button', { name: 'Build review copy' })
        .click();
      await expect(
        launched.page.getByRole('heading', { name: 'Review changes' }),
      ).toBeVisible();
      expect(hash(fixture.file)).toBe(fixture.sha256);

      const createdRoots = instanceRoots().filter(
        (entry) => !initialInstanceRoots.has(entry),
      );
      expect(createdRoots.length).toBeGreaterThan(0);
      await launched.close();
      launched = null;
      expect(hash(fixture.file)).toBe(fixture.sha256);

      launched = await launchPackagedApp({
        executablePath: executable,
        userDataPath: userData,
        catalogDb,
        processLog,
        environment: dialogEnvironment,
      });
      await dismissOnboarding(launched.page);
      await expect
        .poll(() => createdRoots.every((entry) => !existsSync(entry)))
        .toBe(true);
      expect(hash(fixture.file)).toBe(fixture.sha256);
      await launched.page
        .getByRole('button', { name: 'Refresh catalog' })
        .click();
      await openWorkflow(launched.page, fileName);
      await expect(
        launched.page.getByRole('radio', { name: /\(imported\)$/ }).first(),
      ).toBeVisible();
    },
    async () => {
      await cleanupPackagedApp(launched, root === null ? [] : [root], () => {
        if (rootsBefore === null) {
          return;
        }
        const baselineRoots = rootsBefore;

        const instanceCleanupErrors: unknown[] = [];
        let createdInstanceRoots: string[] = [];
        try {
          createdInstanceRoots = instanceRoots().filter(
            (entry) => !baselineRoots.has(entry),
          );
        } catch (error) {
          instanceCleanupErrors.push(error);
        }
        for (const instanceRoot of createdInstanceRoots) {
          try {
            removePackagedAppTempRoot(instanceRoot);
          } catch (error) {
            instanceCleanupErrors.push(error);
          }
        }
        if (instanceCleanupErrors.length > 0) {
          throw new AggregateError(
            instanceCleanupErrors,
            'Retarget instance diagnostics cleanup failed.',
          );
        }
      });
    },
    (diagnostics) =>
      attachPackagedFailureDiagnostics(
        testInfo,
        processLog?.read() ?? '',
        diagnostics,
      ),
  );
});
