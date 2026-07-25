import {
  test,
  expect,
  chromium,
  type Browser,
  type Page,
} from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEditableRetargetFixture,
  findPackagedExecutable,
} from './helpers/retargetFixture';

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
  } catch {
    return [];
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

async function launchPackaged(
  executablePath: string,
  userData: string,
  catalogDb: string,
  dialogEnvironment: Record<string, string>,
): Promise<{
  browser: Browser;
  child: ChildProcess;
  page: Page;
  close: () => Promise<void>;
}> {
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a debugging port.'));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
  const child = spawn(
    executablePath,
    [`--remote-debugging-port=${port}`, `--user-data-dir=${userData}`],
    {
      env: {
        ...process.env,
        PRINTFARMER_CATALOG_DB: catalogDb,
        ...dialogEnvironment,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let processOutput = '';
  child.stdout?.on('data', (bytes: Buffer) => {
    processOutput += bytes.toString();
  });
  child.stderr?.on('data', (bytes: Buffer) => {
    processOutput += bytes.toString();
  });
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `Packaged app exited with ${child.exitCode} before CDP was ready.\n${processOutput}`,
      );
    }
    try {
      const response = await fetch(`${endpoint}/json/version`);
      if (response.ok) break;
    } catch {
      // The packaged process is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const browser = await chromium.connectOverCDP(endpoint);
  const context = browser.contexts()[0];
  if (!context)
    throw new Error('Packaged app did not expose a browser context.');
  let page = context.pages()[0];
  while (!page && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    page = context.pages()[0];
  }
  if (!page) throw new Error('Packaged app did not create a BrowserWindow.');
  await page.waitForLoadState('domcontentloaded');
  return {
    browser,
    child,
    page,
    close: async () => {
      await page.close().catch(() => undefined);
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => {
          if (child.exitCode !== null) resolve(true);
          else child.once('exit', () => resolve(true));
        }),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 3_000),
        ),
      ]);
      if (!exited) child.kill();
      await browser.close().catch(() => undefined);
    },
  };
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

test('runs the U1 workflow in the packaged app without changing the source', async () => {
  test.setTimeout(180_000);
  const executable = findPackagedExecutable(repoRoot);
  const root = mkdtempSync(path.join(tmpdir(), 'pf-u1-packaged-'));
  const fixtureDirectory = path.join(root, 'fixtures');
  const fixture = createEditableRetargetFixture(fixtureDirectory);
  const fileName = path.basename(fixture.file);
  const catalogDb = path.join(root, 'catalog.sqlite3');
  const userData = path.join(root, 'user-data');
  const savedOutput = path.join(root, 'saved-u1.3mf');
  const collision = path.join(root, 'collision.3mf');
  writeFileSync(collision, 'do not overwrite');
  const rootsBefore = new Set(instanceRoots());

  const dialogEnvironment = {
    PRINTFARMER_E2E: '1',
    PRINTFARMER_E2E_OPEN_DIALOG: fixtureDirectory,
    PRINTFARMER_E2E_SAVE_DIALOGS: JSON.stringify([
      { canceled: true, filePath: '' },
      { canceled: false, filePath: collision },
      { canceled: false, filePath: savedOutput },
    ]),
  };
  let launched = await launchPackaged(
    executable,
    userData,
    catalogDb,
    dialogEnvironment,
  );
  await dismissOnboarding(launched.page);
  const imported = await launched.page.evaluate(async () => {
    const approval = await window.printFarmer.openFolder();
    if (!approval) {
      throw new Error('fixture folder approval failed');
    }
    await window.printFarmer.previewImport({ approvalId: approval.approvalId });
    await window.printFarmer.importRoot({
      rootId: 'packaged-u1-fixtures',
      approvalId: approval.approvalId,
      rules: [
        {
          relativePath: '',
          kind: 'collection',
          name: 'Packaged U1 fixtures',
        },
      ],
      commonTags: ['u1-e2e'],
    });
    return window.printFarmer.listModels();
  });
  expect(imported.some((model) => model.hash === fixture.sha256)).toBe(true);
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
    { modelHash: fixture.sha256 },
  );
  expect(directPreflight).not.toHaveProperty('thrown');
  await launched.page.getByRole('button', { name: 'Refresh catalog' }).click();
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

  await launched.page.getByRole('button', { name: 'Save As…' }).click();
  await expect(
    launched.page.getByRole('heading', { name: 'Review changes' }),
  ).toBeVisible();
  expect(hash(fixture.file)).toBe(fixture.sha256);
  await launched.page.getByRole('button', { name: 'Save As…' }).click();
  await expect(launched.page.getByRole('alert')).toContainText(
    'saveDestinationExists',
  );
  await expect(
    launched.page.getByRole('heading', { name: 'Review changes' }),
  ).toBeVisible();
  expect(readFileSync(collision, 'utf8')).toBe('do not overwrite');
  await launched.page.getByRole('button', { name: 'Save As…' }).click();
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
    (entry) => !rootsBefore.has(entry),
  );
  expect(createdRoots.length).toBeGreaterThan(0);
  await launched.close();
  expect(hash(fixture.file)).toBe(fixture.sha256);

  launched = await launchPackaged(
    executable,
    userData,
    catalogDb,
    dialogEnvironment,
  );
  await dismissOnboarding(launched.page);
  await expect
    .poll(() => createdRoots.every((entry) => !existsSync(entry)))
    .toBe(true);
  expect(hash(fixture.file)).toBe(fixture.sha256);
  await launched.page.getByRole('button', { name: 'Refresh catalog' }).click();
  await openWorkflow(launched.page, fileName);
  await expect(
    launched.page.getByRole('radio', { name: /\(imported\)$/ }).first(),
  ).toBeVisible();
  await launched.close();
});
