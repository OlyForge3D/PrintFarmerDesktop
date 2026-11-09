import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { rmSync } from 'node:fs';
import type {
  ImportPreviewResponse,
  ThumbnailCacheSettings,
} from '../src/shared/ipc';
import type { StoredSourceRoot } from '../src/renderer/library/sourceRoots';
import {
  applyCalibrationScenario,
  launchCalibrationApp,
  scanSurface,
} from './helpers/calibrationA11yFixture';
import {
  installIpcReplies,
  releaseIpcReply,
  type IpcReplies,
} from './helpers/syntheticIpc';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage';
import { syntheticModelReplies } from './helpers/syntheticModel';

let app: ElectronApplication | null = null;
let stateRoot: string | null = null;
test.afterEach(async () => {
  try {
    await app?.close();
  } finally {
    app = null;
    if (stateRoot) rmSync(stateRoot, { recursive: true, force: true });
    stateRoot = null;
  }
});
async function open(replies: IpcReplies = {}, roots: StoredSourceRoot[] = []) {
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  await applyCalibrationScenario(app, launched.page, { noProfile: true });
  await installIpcReplies(app, replies);
  await launched.page.evaluate((storedRoots) => {
    localStorage.removeItem('printfarmer.library.sourceRoots.v1');
    if (storedRoots.length)
      localStorage.setItem(
        'printfarmer.library.sourceRoots.v1',
        JSON.stringify({ version: 1, roots: storedRoots }),
      );
  }, roots);
  await launched.page.reload();
  await applyPinnedRenderingProfile(launched.page);
  return launched.page;
}
async function capture(page: Page, state: string, info: TestInfo) {
  await captureVisualScenario(page, `shell.states.${state}`, info);
  await scanSurface(page, {
    name: `shell ${state}`,
    present: page.locator('#root'),
    testInfo: info,
    soft: true,
  });
}
const preview: ImportPreviewResponse = {
  modelCount: 4,
  totalBytes: 4096,
  skippedErrors: 2,
  complete: true,
  formats: { stl: 1, threeMf: 1, obj: 1, step: 1 },
  folders: [
    { name: 'Parts', relativePath: 'Parts', depth: 1, modelCount: 3 },
    {
      name: 'Decorative',
      relativePath: 'Parts/Decorative',
      depth: 2,
      modelCount: 1,
    },
  ],
  foldersTruncated: true,
};
const approval = {
  path: 'C:\\SyntheticPrintFarmer\\Models',
  approvalId: 'f7777777-7777-4777-8777-777777777777',
};

test('synthetic shell initial load, dismissal, modal exclusion and reload default', async () => {
  const info = test.info();
  const page = await open();
  await expect(page.getByRole('main', { name: 'Model library' })).toBeVisible();
  await expect(
    page.getByRole('dialog', { name: 'Set up your model library' }),
  ).toBeVisible();
  await capture(page, 'initial-library', info);
  await page.getByRole('button', { name: 'Maybe later' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await capture(page, 'onboarding-dismissed', info);
  await page.getByRole('button', { name: 'Thumbnail cache' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Thumbnail cache' }),
  ).toBeVisible();
  await expect(page.locator('.app-body')).toHaveAttribute('inert', '');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await capture(page, 'modal-exclusion', info);
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: 'Filament Calibration', exact: true })
    .click();
  await expect(
    page.getByRole('main', { name: 'Filament calibration workspace' }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole('main', { name: 'Model library' })).toBeVisible();
  await capture(page, 'reload-default-library', info);
});

test('synthetic onboarding import preparation hides onboarding and announces failure', async () => {
  const info = test.info();
  const page = await open({
    'dialog:openFolder': [
      { pending: true },
      { error: 'Synthetic folder selection unavailable.' },
    ],
  });
  await page.getByRole('button', { name: 'Add your first folder' }).click();
  await expect(
    page.getByRole('dialog', { name: 'Set up your model library' }),
  ).toHaveCount(0);
  await capture(page, 'import-preparation', info);
  await releaseIpcReply(app!, 'dialog:openFolder');
  await expect(page.getByRole('alert')).toContainText(
    'Synthetic folder selection unavailable.',
  );
  await capture(page, 'onboarding-folder-error', info);
});

test('synthetic import review displays format warnings, rules, tags and pending/error recovery', async () => {
  const info = test.info();
  const page = await open({
    'dialog:openFolder': [{ value: approval }],
    'catalog:previewImport': [{ value: preview }],
    'catalog:listCollections': [{ value: [] }],
    'catalog:listTags': [{ value: [] }],
    'catalog:importRoot': [
      { pending: true },
      { error: 'Synthetic import failed; no files changed.' },
    ],
  });
  await page.getByRole('button', { name: 'Add your first folder' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Organize models before importing',
  });
  await expect(
    dialog.getByText('2 unreadable filesystem entries were skipped.'),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Folder choices are limited to the first 500/),
  ).toBeVisible();
  await dialog
    .getByRole('combobox', { name: 'Organization for Parts', exact: true })
    .selectOption('ignore');
  await expect(
    dialog.getByRole('textbox', { name: 'Name for Parts', exact: true }),
  ).toBeDisabled();
  await dialog
    .getByRole('combobox', {
      name: 'Organization for Parts/Decorative',
      exact: true,
    })
    .selectOption('tag');
  await dialog
    .getByRole('textbox', { name: 'Tags for all imported models' })
    .fill('fixture, synthetic');
  await capture(page, 'import-rules-warnings', info);
  await dialog.getByRole('button', { name: 'Import 4 files' }).click();
  await expect(
    dialog.getByRole('button', { name: 'Importing...' }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole('button', { name: 'Cancel import' }),
  ).toBeDisabled();
  await capture(page, 'import-pending', info);
  await releaseIpcReply(app!, 'catalog:importRoot');
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic import failed; no files changed.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Import 4 files' }),
  ).toBeEnabled();
  await dialog.getByRole('button', { name: 'Dismiss library error' }).hover();
  await capture(page, 'import-error-retry', info);
});

test('synthetic empty import warns that reconcile marks prior files missing', async () => {
  const info = test.info();
  const page = await open({
    'dialog:openFolder': [{ value: approval }],
    'catalog:previewImport': [
      {
        value: {
          ...preview,
          modelCount: 0,
          totalBytes: 0,
          skippedErrors: 0,
          formats: { stl: 0, threeMf: 0, obj: 0 },
          folders: [],
          foldersTruncated: false,
        },
      },
    ],
    'catalog:listCollections': [{ value: [] }],
    'catalog:listTags': [{ value: [] }],
  });
  await page.getByRole('button', { name: 'Add your first folder' }).click();
  const dialog = page.getByRole('dialog', {
    name: 'Organize models before importing',
  });
  await expect(dialog.getByText(/No supported files were found/)).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: 'Reconcile source' }),
  ).toBeEnabled();
  await capture(page, 'empty-import-reconcile', info);
});

test('synthetic incomplete import is refused before review and error can be dismissed', async () => {
  const info = test.info();
  const page = await open({
    'dialog:openFolder': [{ value: approval }],
    'catalog:previewImport': [{ value: { ...preview, complete: false } }],
    'catalog:listCollections': [{ value: [] }],
    'catalog:listTags': [{ value: [] }],
  });
  await page.getByRole('button', { name: 'Maybe later' }).click();
  await page
    .getByRole('complementary', { name: 'Library navigation' })
    .getByRole('button', { name: 'Add folder', exact: true })
    .click();
  await expect(
    page.getByRole('dialog', { name: 'Organize models before importing' }),
  ).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText(
    'Could not inspect the entire folder (2 filesystem errors). No files were imported.',
  );
  await capture(page, 'import-incomplete-refused', info);
  await page.getByRole('button', { name: 'Dismiss library error' }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await capture(page, 'import-error-dismissed', info);
});

test('synthetic cache location cancel/error/long path and pending save/clear recovery', async () => {
  const info = test.info();
  const settings: ThumbnailCacheSettings = {
    location: null,
    effectiveLocation: 'C:\\SyntheticPrintFarmer\\Cache',
    maxBytes: 512 * 1024 * 1024,
    retentionDays: 30,
    usedBytes: 1024,
    entryCount: 2,
    warning: null,
  };
  const longPath = `C:\\SyntheticPrintFarmer\\${'Long authored cache folder\\'.repeat(12)}Cache`;
  const page = await open({
    'thumbnailCache:getSettings': [{ value: settings }],
    'thumbnailCache:chooseLocation': [
      { value: { canceled: true, path: null } },
      { error: 'Synthetic cache picker unavailable.' },
      { value: { canceled: false, path: longPath } },
    ],
    'thumbnailCache:setSettings': [
      { pending: true },
      { error: 'Synthetic cache save failed.' },
      { value: settings },
    ],
    'thumbnailCache:clear': [
      { pending: true },
      { error: 'Synthetic cache clear failed.' },
      {
        value: {
          clearedEntries: 2,
          settings: { ...settings, entryCount: 0, usedBytes: 0 },
        },
      },
    ],
  });
  await page
    .getByRole('button', { name: 'Thumbnail cache settings', exact: true })
    .click();
  const dialog = page.getByRole('dialog', {
    name: 'Thumbnail cache',
    exact: true,
  });
  await expect(
    dialog.getByText(settings.effectiveLocation, { exact: true }),
  ).toBeVisible();
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(
    dialog.getByText(settings.effectiveLocation, { exact: true }),
  ).toBeVisible();
  await capture(page, 'cache-picker-canceled', info);
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic cache picker unavailable.',
  );
  await capture(page, 'cache-picker-error', info);
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(
    dialog.getByText(`Selected folder: ${longPath}`, { exact: true }),
  ).toBeVisible();
  await applyPinnedRenderingProfile(
    page,
    'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1',
  );
  const bounds = await dialog.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    width: innerWidth,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.documentWidth).toBeLessThanOrEqual(bounds.width);
  await capture(page, 'cache-long-path-compact', info);
  await dialog.getByRole('button', { name: 'Use app data folder' }).click();
  await dialog
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Close thumbnail cache settings' }),
  ).toBeDisabled();
  await capture(page, 'cache-save-pending', info);
  await releaseIpcReply(app!, 'thumbnailCache:setSettings');
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic cache save failed.',
  );
  await capture(page, 'cache-save-error', info);
  await dialog
    .getByRole('button', { name: 'Save settings', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'Thumbnail cache settings saved.',
  );
  await dialog
    .getByRole('button', { name: 'Clear cached thumbnails…' })
    .click();
  await dialog
    .getByRole('button', { name: 'Clear thumbnails', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Keep cache' }),
  ).toBeDisabled();
  await capture(page, 'cache-clear-pending', info);
  await releaseIpcReply(app!, 'thumbnailCache:clear');
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic cache clear failed.',
  );
  await expect(dialog.getByRole('alertdialog')).toBeVisible();
  await capture(page, 'cache-clear-error', info);
  await dialog
    .getByRole('button', { name: 'Clear thumbnails', exact: true })
    .click();
  await expect(dialog.getByRole('status')).toContainText(
    'Cleared 2 cached thumbnails.',
  );
  await expect(
    dialog.getByRole('button', { name: 'Clear cached thumbnails…' }),
  ).toBeDisabled();
  await capture(page, 'cache-clear-retry-success', info);
});

test('synthetic Sources shows missing and offline needs-scan states without conflating them', async () => {
  const info = test.info();
  const reply = syntheticModelReplies()['catalog:queryModels']![0]!;
  if (!('value' in reply))
    throw new Error('Synthetic catalog must be settled.');
  const location = reply.value.models[0]!.locations[0]!;
  const page = await open(
    {
      'catalog:queryModels': [
        {
          value: {
            ...reply.value,
            models: [
              {
                ...reply.value.models[0]!,
                locations: [
                  {
                    ...location,
                    rootId: 'missing-root',
                    path: 'C:\\SyntheticPrintFarmer\\Missing\\part.3mf',
                    available: false,
                  },
                ],
              },
            ],
            counts: { ...reply.value.counts, missing: 1 },
            sources: [
              {
                rootId: 'missing-root',
                totalModels: 1,
                availableModels: 0,
                availableLocations: 0,
                missingLocations: 1,
                sample: {
                  ...location,
                  rootId: 'missing-root',
                  path: 'C:\\SyntheticPrintFarmer\\Missing\\part.3mf',
                  rootRelative: 'part.3mf',
                  available: false,
                },
              },
            ],
          },
        },
      ],
    },
    [
      { rootId: 'missing-root', path: 'C:\\SyntheticPrintFarmer\\Missing' },
      {
        rootId: 'offline-root',
        path: 'C:\\SyntheticPrintFarmer\\Never-scanned',
      },
    ],
  );
  const later = page.getByRole('button', { name: 'Maybe later' });
  if (await later.isVisible()) await later.click();
  await page.getByRole('button', { name: /^Sources/ }).click();
  const sources = page.getByRole('main', { name: 'Catalog sources' });
  await expect(
    sources.getByText('Missing files', { exact: true }),
  ).toBeVisible();
  await expect(sources.getByText('Needs scan', { exact: true })).toBeVisible();
  await expect(
    sources.getByRole('button', { name: 'Reconnect', exact: true }),
  ).toHaveCount(2);
  const addFolder = sources.getByRole('button', { name: 'Add source folder' });
  const refresh = sources.getByRole('button', { name: 'Refresh catalog' });
  await expect(addFolder).toBeEnabled();
  await expect(refresh).toBeEnabled();
  await addFolder.hover();
  await scanSurface(page, {
    name: 'Sources primary action hovered',
    present: sources,
    testInfo: info,
  });
  await refresh.hover();
  await capture(page, 'sources-missing-offline', info);
});
