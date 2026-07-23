import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
  type Page,
} from '@playwright/test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * Artifacts that `npm run package` (or a raw Forge Vite build) emits at the
 * repository root. The app is launched unpackaged from these so the security
 * Fuses baked into the packaged binary do not interfere with Playwright's
 * DevTools pipe. `main.ts` still takes the production code path (no dev server),
 * exercising the strict production CSP and the staged sidecar resolution.
 */
const requiredArtifacts = [
  path.join(repoRoot, '.vite', 'build', 'main.js'),
  path.join(repoRoot, '.vite', 'build', 'preload.js'),
  path.join(repoRoot, '.vite', 'renderer', 'main_window', 'index.html'),
];
const modelFixtureDir = path.join(repoRoot, 'e2e', 'fixtures', 'models');

let app: ElectronApplication;
let page: Page;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  for (const artifact of requiredArtifacts) {
    if (!existsSync(artifact)) {
      throw new Error(
        `Missing build artifact ${artifact}.\n` +
          'Run `npm run package` (which builds the renderer/main/preload bundles ' +
          'and stages the sidecar) before running the E2E suite.',
      );
    }
  }

  // Isolate the catalog so the suite never touches the developer's real
  // per-user database. The main process only sets this when unset.
  const catalogDb = path.join(
    mkdtempSync(path.join(tmpdir(), 'pf-e2e-')),
    'catalog.sqlite3',
  );

  app = await electron.launch({
    args: ['.'],
    cwd: repoRoot,
    env: { ...process.env, PRINTFARMER_CATALOG_DB: catalogDb },
  });

  page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    consoleErrors.push(error.message);
  });
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
});

test('mounts the React app shell', async () => {
  // A blank window (failed preload/CSP) leaves #root empty; a mounted app fills
  // it and renders the header.
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(
    page.getByRole('heading', { name: 'PrintFarmer Desktop' }),
  ).toBeVisible();
  await expect(page.getByLabel('UI design concepts')).toBeVisible();
  await expect(page.getByLabel('Library navigation')).toBeVisible();
  await expect(page.getByLabel('Model properties')).toBeVisible();
});

test('exposes the printFarmer preload bridge', async () => {
  const bridgeType = await page.evaluate(
    () => typeof (window as unknown as { printFarmer?: unknown }).printFarmer,
  );
  expect(bridgeType).toBe('object');
});

test('reports app info from the main process over IPC', async () => {
  const info = await page.evaluate(() => window.printFarmer.getAppInfo());
  expect(info.contractVersion).toBe(1);
  await expect(page.getByLabel('Application status')).toContainText(
    `v${info.appVersion}`,
  );
});

test('loads the catalog from the sidecar', async () => {
  // The toolbar model count is populated by the sidecar's `listModels` RPC. A
  // fresh, isolated catalog is empty, but the control must still render, which
  // proves the sidecar spawned and answered without error.
  await expect(page.getByLabel('Model library')).toBeVisible();
  await expect(page.getByText('0 of 0')).toBeVisible();
  await expect(page.getByLabel('Search models')).toBeVisible();
});

test('shows onboarding CTA for a fresh empty catalog', async () => {
  await expect(
    page.getByRole('heading', { name: 'Build your model library' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Add your first folder',
    }),
  ).toBeVisible();
});

test('switches between all three working design concepts', async () => {
  for (const [button, design] of [
    ['Studio', 'studio'],
    ['Archive', 'archive'],
    ['Console', 'console'],
  ] as const) {
    await page.getByRole('button', { name: button }).click();
    await expect(page.locator('.app-root')).toHaveAttribute(
      'data-design',
      design,
    );
  }

  await page.getByRole('button', { name: 'Archive' }).click();
  await page.reload();
  await expect(page.locator('.app-root')).toHaveAttribute(
    'data-design',
    'archive',
  );
  // Leave a deterministic concept for tests that run with or without this test.
  await page.getByRole('button', { name: 'Studio' }).click();
});

test('uses reliable custom window chrome', async () => {
  const chrome = await app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return {
      platform: process.platform,
      applicationMenuRemoved: Menu.getApplicationMenu() === null,
      menuBarVisible: window?.isMenuBarVisible() ?? true,
      windowVisible: window?.isVisible() ?? false,
    };
  });

  expect(chrome.windowVisible).toBe(true);
  expect(chrome.menuBarVisible).toBe(false);
  expect(chrome.applicationMenuRemoved).toBe(chrome.platform !== 'darwin');
  await expect(page.locator('.window-titlebar')).toBeVisible();
});

test('selects a model without mounting 3D, then previews explicitly', async () => {
  // The normal library surface must not spend GPU resources or show a sample
  // scene before the user requests a preview.
  await expect(page.getByRole('application')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.evaluate(
    async (fixturePath) =>
      window.printFarmer.scanRoot({
        rootId: 'e2e-model-fixtures',
        path: fixturePath,
      }),
    modelFixtureDir,
  );
  await page.getByRole('button', { name: 'Refresh catalog' }).click();

  const filename =
    'precision-calibration-fixture-with-an-intentionally-long-name.obj';
  const select = page.getByRole('button', { name: `Select ${filename}` });
  await expect(select).toBeVisible();

  const truncation = await page.locator('.model-name').evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      whiteSpace: style.whiteSpace,
      clipped: element.scrollWidth > element.clientWidth,
      title: element.closest('button')?.title,
    };
  });
  expect(truncation).toEqual({
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    clipped: true,
    title: filename,
  });

  await select.click();
  await expect(
    page.locator('.properties-inspector').getByRole('heading', {
      name: filename,
    }),
  ).toBeVisible();
  await expect(page.getByRole('application')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  for (const [button, design] of [
    ['Studio', 'studio'],
    ['Archive', 'archive'],
    ['Console', 'console'],
  ] as const) {
    await page.getByRole('button', { name: button }).click();
    await expect(page.locator('.app-root')).toHaveAttribute(
      'data-design',
      design,
    );
    await expect(select).toBeVisible();
    await expect(
      page.locator('.properties-inspector').getByRole('heading', {
        name: filename,
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.locator('.model-name').evaluate((element) => ({
          clipped: element.scrollWidth > element.clientWidth,
          textOverflow: getComputedStyle(element).textOverflow,
        })),
      )
      .toEqual({ clipped: true, textOverflow: 'ellipsis' });
  }

  const inspectorPreview = page
    .locator('.properties-inspector')
    .getByRole('button', { name: 'Preview in 3D' });
  await inspectorPreview.click();
  await expect(
    page.getByRole('dialog', { name: `3D preview of ${filename}` }),
  ).toBeVisible();
  expect(
    await page
      .locator('.workspace')
      .evaluate((element) => element.hasAttribute('inert')),
  ).toBe(true);

  await page.keyboard.press(
    process.platform === 'darwin' ? 'Meta+f' : 'Control+f',
  );
  await expect(page.getByLabel('Search models')).not.toBeFocused();
  expect(
    await page
      .getByRole('dialog', { name: `3D preview of ${filename}` })
      .evaluate((dialog) => dialog.contains(document.activeElement)),
  ).toBe(true);

  // The viewer canvas is mounted only after explicit Preview.
  const viewer = page.getByRole('application', {
    name: /3D model preview/i,
  });
  await expect(viewer).toBeVisible();

  // The "Reset view" toolbar button reframes the model without error.
  await page.getByRole('button', { name: 'Reset' }).click();
  const wireframe = page.getByRole('button', { name: 'Wireframe' });
  await wireframe.click();
  await expect(page.getByRole('button', { name: 'Solid' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Orthographic' }).click();
  await expect(page.getByRole('button', { name: 'Perspective' })).toBeVisible();

  // Keyboard controls (orbit / zoom / reset) are handled on the focused viewer.
  await viewer.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('+');
  await page.keyboard.press('-');
  await page.keyboard.press('r');

  // The viewer remains mounted and healthy after the interactions.
  await expect(viewer).toBeVisible();

  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.getByRole('application')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(inspectorPreview).toBeFocused();
});

test('renders without severe renderer console errors', () => {
  // Guards against regressions of the CSP / preload / sidecar bugs that
  // previously left the window blank. Benign GPU/DevTools noise is ignored.
  const severe = consoleErrors.filter(
    (message) =>
      !/DevTools|Autofill|GPU stall|WebGL|Electron Security Warning/i.test(
        message,
      ),
  );
  expect(severe).toEqual([]);
});
