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
  await expect(page.getByText('Local-first 3D model library')).toBeVisible();
});

test('exposes the printFarmer preload bridge', async () => {
  const bridgeType = await page.evaluate(
    () => typeof (window as unknown as { printFarmer?: unknown }).printFarmer,
  );
  expect(bridgeType).toBe('object');
});

test('reports app info from the main process over IPC', async () => {
  // App info is fetched via `window.printFarmer.getAppInfo()` on mount; the
  // status grid only renders once that IPC round-trip resolves, proving the
  // preload bridge and main-process handlers are wired end to end.
  await expect(page.getByText('App version')).toBeVisible();
  await expect(page.getByText('IPC contract')).toBeVisible();
});

test('loads the catalog from the sidecar', async () => {
  // The toolbar model count is populated by the sidecar's `listModels` RPC. A
  // fresh, isolated catalog is empty, but the control must still render, which
  // proves the sidecar spawned and answered without error.
  await expect(page.getByLabel('Model library')).toBeVisible();
  await expect(page.getByText(/^\d+ models?$/)).toBeVisible();
  await expect(page.getByLabel('Search models')).toBeVisible();
});

test('the 3D viewer supports reset and keyboard controls', async () => {
  // The viewer canvas is an accessible, focusable application widget.
  const viewer = page.getByRole('application', {
    name: /3D model preview/i,
  });
  await expect(viewer).toBeVisible();

  // The "Reset view" toolbar button reframes the model without error.
  await page.getByRole('button', { name: 'Reset view' }).click();

  // Keyboard controls (orbit / zoom / reset) are handled on the focused viewer.
  await viewer.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('+');
  await page.keyboard.press('-');
  await page.keyboard.press('r');

  // The viewer remains mounted and healthy after the interactions.
  await expect(viewer).toBeVisible();
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
