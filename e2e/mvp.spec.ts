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
  await expect(page.locator('.window-titlebar')).toBeVisible();
  await expect(page.getByLabel('UI design concepts')).toHaveCount(0);
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
  await expect(page.getByRole('main', { name: 'Model library' })).toBeVisible();
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

test('uses reliable custom window chrome', async () => {
  const chrome = await app.evaluate(({ BrowserWindow, Menu }) => {
    const window = BrowserWindow.getAllWindows()[0];
    const applicationMenu = Menu.getApplicationMenu();
    return {
      platform: process.platform,
      applicationMenuRemoved: applicationMenu === null,
      menuLabels: applicationMenu?.items.map((item) => item.label) ?? [],
      menuBarVisible: window?.isMenuBarVisible() ?? true,
      windowVisible: window?.isVisible() ?? false,
    };
  });

  expect(chrome.windowVisible).toBe(true);
  expect(chrome.applicationMenuRemoved).toBe(chrome.platform !== 'darwin');
  if (chrome.platform === 'darwin') {
    expect(chrome.menuLabels).toEqual(
      expect.arrayContaining(['Edit', 'File', 'Window']),
    );
  } else {
    expect(chrome.menuBarVisible).toBe(false);
  }
  await expect(page.locator('.window-titlebar')).toBeVisible();
});

test('selects a model without mounting 3D, then previews explicitly', async () => {
  // The normal library surface must not spend GPU resources or show a sample
  // scene before the user requests a preview.
  await expect(page.getByRole('application')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);

  const importPreview = await page.evaluate(
    async (fixturePath) =>
      window.printFarmer.previewImport({ path: fixturePath }),
    modelFixtureDir,
  );
  expect(importPreview.modelCount).toBe(1);
  expect(importPreview.formats.obj).toBe(1);
  const importResult = await page.evaluate(
    async (fixturePath) =>
      window.printFarmer.importRoot({
        rootId: 'e2e-model-fixtures',
        path: fixturePath,
        rules: [
          {
            relativePath: '',
            kind: 'collection',
            name: 'E2E fixtures',
          },
        ],
        commonTags: ['e2e'],
      }),
    modelFixtureDir,
  );
  expect(importResult.report.added).toBe(1);
  expect(importResult.modelsOrganized).toBe(1);
  await page.getByRole('button', { name: 'Refresh catalog' }).click();

  const filename =
    'precision-calibration-fixture-with-an-intentionally-long-name.obj';
  const select = page.getByRole('button', { name: `Select ${filename}` });
  await expect(select).toBeVisible();

  await select.hover();
  await expect(
    select.locator('..').getByRole('button', {
      name: `Preview ${filename} in 3D`,
    }),
  ).toHaveCSS('opacity', '1');
  const cardActions = await select.locator('..').evaluate((card) => {
    const favorite = card.querySelector('.model-fav-button');
    const preview = card.querySelector('.model-preview-button');
    if (
      !(favorite instanceof HTMLElement) ||
      !(preview instanceof HTMLElement)
    ) {
      throw new Error('Model card actions did not render');
    }
    const favoriteBounds = favorite.getBoundingClientRect();
    const previewBounds = preview.getBoundingClientRect();
    return {
      favoriteWidth: favoriteBounds.width,
      favoriteHeight: favoriteBounds.height,
      previewWidth: previewBounds.width,
      previewHeight: previewBounds.height,
      horizontalOffset: previewBounds.left - favoriteBounds.left,
      verticalGap: previewBounds.top - favoriteBounds.bottom,
      visibleText: preview.innerText.trim(),
      beforeContent: getComputedStyle(preview, '::before').content,
      afterContent: getComputedStyle(preview, '::after').content,
    };
  });
  expect(cardActions).toEqual({
    favoriteWidth: 28,
    favoriteHeight: 28,
    previewWidth: 28,
    previewHeight: 28,
    horizontalOffset: 0,
    verticalGap: 6,
    visibleText: '',
    beforeContent: 'none',
    afterContent: 'none',
  });

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
  const inspector = page.getByLabel('Model properties');
  await expect(
    inspector.getByLabel('Model tags').getByText('e2e'),
  ).toBeVisible();
  await expect(
    inspector
      .getByLabel('Collections')
      .getByRole('checkbox', { name: /E2E fixtures/ }),
  ).toBeChecked();

  await expect
    .poll(() =>
      page.locator('.model-name').evaluate((element) => ({
        clipped: element.scrollWidth > element.clientWidth,
        textOverflow: getComputedStyle(element).textOverflow,
      })),
    )
    .toEqual({ clipped: true, textOverflow: 'ellipsis' });
  const studioMetrics = await page.evaluate(() => {
    const root = document.querySelector('.app-root');
    const grid = document.querySelector('.model-grid');
    const card = document.querySelector('.model-card');
    if (!root || !grid || !card) {
      throw new Error('Studio layout did not render');
    }
    return {
      accent: getComputedStyle(root).getPropertyValue('--accent').trim(),
      columnCount: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      cardHeight: card.getBoundingClientRect().height,
    };
  });
  expect(studioMetrics.accent).toBe('#62b0e8');
  expect(studioMetrics.columnCount).toBeGreaterThan(1);
  expect(studioMetrics.cardHeight).toBeGreaterThan(120);

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

  const canvas = viewer.locator('canvas');
  await page.waitForTimeout(200);
  const baselineView = await canvas.screenshot();

  // Keyboard orbit must change the rendered camera view.
  await viewer.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  const orbitedView = await canvas.screenshot();
  expect(orbitedView.equals(baselineView)).toBe(false);

  // The toolbar reset must return to the deterministic fitted view.
  await page.getByRole('button', { name: 'Reset' }).click();
  await page.waitForTimeout(250);
  const toolbarResetView = await canvas.screenshot();
  expect(toolbarResetView.equals(baselineView)).toBe(true);

  // Keyboard zoom and keyboard reset are observable as well.
  await viewer.focus();
  await page.keyboard.press('+');
  await page.waitForTimeout(250);
  const zoomedView = await canvas.screenshot();
  expect(zoomedView.equals(baselineView)).toBe(false);
  await page.keyboard.press('r');
  await page.waitForTimeout(250);
  const keyboardResetView = await canvas.screenshot();
  expect(keyboardResetView.equals(baselineView)).toBe(true);

  const wireframe = page.getByRole('button', { name: 'Wireframe' });
  await wireframe.click();
  await expect(page.getByRole('button', { name: 'Solid' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Orthographic' }).click();
  await expect(page.getByRole('button', { name: 'Perspective' })).toBeVisible();

  // The viewer remains mounted and healthy after the interactions.
  await expect(viewer).toBeVisible();

  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.getByRole('application')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(inspectorPreview).toBeFocused();
  await expect(
    page.locator('.properties-inspector').getByLabel('Model statistics'),
  ).toContainText('OBJ');
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
