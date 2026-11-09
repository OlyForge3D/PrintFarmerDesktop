import {
  expect,
  test,
  type ElectronApplication,
  type Page,
  type TestInfo,
} from '@playwright/test';
import { rmSync } from 'node:fs';
import type { SceneMesh, VendorMetadata } from '../src/shared/ipc';
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
  syntheticModelName,
  syntheticModelReplies,
  syntheticScene,
  syntheticVendor,
} from './helpers/syntheticModel';
import {
  applyPinnedRenderingProfile,
  captureVisualScenario,
} from './helpers/visualCoverage';

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
async function open(replies: IpcReplies = {}) {
  const launched = await launchCalibrationApp();
  app = launched.app;
  stateRoot = launched.stateRoot;
  await applyCalibrationScenario(app, launched.page, {});
  await installIpcReplies(app, { ...syntheticModelReplies(), ...replies });
  await launched.page.reload();
  await applyPinnedRenderingProfile(launched.page);
  await launched.page
    .getByRole('button', { name: `Select ${syntheticModelName}` })
    .click();
  return launched.page;
}
async function preview(page: Page) {
  await page.getByRole('button', { name: 'Preview in 3D' }).click();
  return page.getByRole('dialog', {
    name: `3D preview of ${syntheticModelName}`,
  });
}
async function capture(page: Page, state: string, info: TestInfo) {
  await captureVisualScenario(page, `details.states.${state}`, info);
  await scanSurface(page, {
    name: `details ${state}`,
    present: page.locator('#root'),
    testInfo: info,
    soft: true,
  });
}

test('synthetic library sidebar clamps, persists and stacks the model pane at its actual threshold', async () => {
  const info = test.info();
  const page = await open();
  const separator = page.getByRole('separator', {
    name: 'Resize library sidebar',
  });
  await separator.focus();
  await page.keyboard.press('Home');
  await expect(separator).toHaveAttribute('aria-valuenow', '200');
  await expect(page.locator('.library-commandbar')).toHaveCSS(
    'flex-wrap',
    'nowrap',
  );
  await capture(page, 'sidebar-minimum', info);
  await separator.focus();
  await page.keyboard.press('End');
  await expect(separator).toHaveAttribute('aria-valuenow', '480');
  await expect
    .poll(
      async () => (await page.locator('.library-pane').boundingBox())!.width,
    )
    .toBeLessThanOrEqual(640);
  await expect(page.locator('.library-commandbar')).toHaveCSS(
    'flex-wrap',
    'wrap',
  );
  await capture(page, 'sidebar-maximum-pane-stacked', info);
  await page.reload();
  await expect(separator).toHaveAttribute('aria-valuenow', '480');
  await applyPinnedRenderingProfile(
    page,
    'desktop-dark-1120x700-dsf1-en-US-UTC-reduced-motion-v1',
  );
  await expect(page.locator('.app-root')).toHaveCSS('--rail-width', '58px');
  await expect
    .poll(async () => Number(await separator.getAttribute('aria-valuenow')))
    .toBeLessThan(480);
  expect(await separator.getAttribute('aria-valuenow')).toBe(
    await separator.getAttribute('aria-valuemax'),
  );
  await expect
    .poll(
      async () => (await page.locator('.library-pane').boundingBox())!.width,
    )
    .toBeGreaterThanOrEqual(320);
  await capture(page, 'sidebar-narrow-runtime-cap', info);
});

test('synthetic preview keyboard orbit changes canvas and reset restores it', async () => {
  const info = test.info();
  const page = await open();
  const dialog = await preview(page);
  const viewer = dialog.getByRole('application');
  const canvas = viewer.locator('canvas');
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(300);
  const baseline = await canvas.screenshot();
  await viewer.focus();
  await page.keyboard.press('ArrowRight');
  await expect
    .poll(async () => (await canvas.screenshot()).equals(baseline))
    .toBe(false);
  await capture(page, 'camera-keyboard-orbit', info);
  await dialog.getByRole('button', { name: 'Reset view' }).click();
  await expect
    .poll(async () => (await canvas.screenshot()).equals(baseline))
    .toBe(true);
  await capture(page, 'camera-reset-restores-image', info);
});

test('synthetic preview WebGL constructor refusal is announced without a canvas', async () => {
  const info = test.info();
  const page = await open();
  await page.addInitScript(() => {
    const original: unknown = Object.getOwnPropertyDescriptor(
      HTMLCanvasElement.prototype,
      'getContext',
    )?.value;
    if (typeof original !== 'function') {
      throw new Error('Canvas getContext fixture requires the native method.');
    }
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      value: function (
        this: HTMLCanvasElement,
        contextId: string,
        ...args: unknown[]
      ) {
        if (contextId === 'webgl' || contextId === 'webgl2') return null;
        const context: unknown = Reflect.apply(original, this, [
          contextId,
          ...args,
        ]);
        return context;
      },
    });
  });
  await page.reload();
  await page
    .getByRole('button', { name: `Select ${syntheticModelName}` })
    .click();
  const dialog = await preview(page);
  await expect(dialog.getByRole('alert')).toHaveText(
    'WebGL is unavailable on this system.',
  );
  await expect(dialog.locator('canvas')).toHaveCount(0);
  await capture(page, 'webgl-constructor-unavailable', info);
});

for (const size of [273, 274]) {
  test(`synthetic preview actual LOD scene threshold grid ${size}`, async () => {
    const info = test.info();
    const scene = syntheticScene();
    const positions: number[] = [];
    const indices: number[] = [];
    for (let y = 0; y <= size; y += 1) {
      for (let x = 0; x <= size; x += 1) {
        positions.push((x / size) * 20, (y / size) * 20, 0);
      }
    }
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const a = y * (size + 1) + x;
        indices.push(a, a + 1, a + size + 1, a + 1, a + size + 2, a + size + 1);
      }
    }
    const mesh = {
      positions,
      indices,
      bounds: { min: [0, 0, 0], max: [20, 20, 0] },
    } satisfies Pick<SceneMesh, 'positions' | 'indices' | 'bounds'>;
    const dense: SceneMesh = {
      ...scene,
      ...mesh,
      objects: [{ ...scene.objects[0]!, mesh }],
      parts: [{ ...scene.parts[0]!, triangleCount: size * size * 2 }],
    };
    const page = await open({ 'model:loadScene': [{ value: dense }] });
    const dialog = await preview(page);
    await expect(dialog.locator('canvas')).toBeVisible();
    const notice = dialog.getByText(
      '1 large part is drawn at reduced detail when zoomed out.',
      { exact: true },
    );
    if (size === 273) {
      expect(indices.length / 3).toBe(149_058);
      await expect(notice).toHaveCount(0);
    } else {
      expect(indices.length / 3).toBe(150_152);
      await expect(notice).toBeVisible();
    }
    await capture(
      page,
      size === 273 ? 'lod-below-scene-floor' : 'lod-proxy-built',
      info,
    );
  });
}

test('synthetic details empty memberships, add/remove tag, collection toggle and create', async () => {
  const info = test.info();
  const collection = {
    id: 'synthetic-collection',
    name: 'Synthetic collection',
    memberCount: 0,
    sharedToFarm: false,
  };
  const page = await open({
    'catalog:listCollections': [{ value: [] }],
    'catalog:addModelTag': [
      { value: [{ id: 'synthetic-tag', name: 'Synthetic tag' }] },
    ],
    'catalog:removeModelTag': [{ value: [] }],
    'catalog:createCollection': [{ value: collection }],
    'catalog:addModelToCollection': [{ value: [collection] }],
    'catalog:removeModelFromCollection': [{ value: [] }],
  });
  const inspector = page.getByRole('complementary', {
    name: 'Model properties',
  });
  await expect(inspector.getByText('No tags', { exact: true })).toBeVisible();
  await expect(
    inspector.getByText('No collections yet', { exact: true }),
  ).toBeVisible();
  await capture(page, 'empty-memberships', info);
  await inspector
    .getByRole('textbox', { name: 'Add a tag' })
    .fill('Synthetic tag');
  await inspector.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(
    inspector.getByRole('button', { name: 'Remove tag Synthetic tag' }),
  ).toBeVisible();
  await capture(page, 'tag-added', info);
  await inspector
    .getByRole('button', { name: 'Remove tag Synthetic tag' })
    .click();
  await expect(inspector.getByText('No tags', { exact: true })).toBeVisible();
  await installIpcReplies(app!, {
    'catalog:listCollections': [{ value: [collection] }],
    'catalog:collectionsForModel': [{ value: [collection] }],
  });
  await inspector
    .getByRole('textbox', { name: 'New collection name' })
    .fill('Synthetic collection');
  await inspector.getByRole('button', { name: 'Create & add' }).click();
  const checkbox = inspector.getByRole('checkbox', {
    name: /Synthetic collection/,
  });
  await expect(checkbox).toBeChecked();
  await capture(page, 'collection-created-member', info);
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  await capture(page, 'collection-removed-member', info);
});

test('synthetic preview loading, scene error, retry, shading and projection states', async () => {
  const info = test.info();
  const page = await open({
    'model:loadScene': [
      { pending: true },
      { error: 'Synthetic scene parse failed.' },
      { value: syntheticScene() },
    ],
  });
  const dialog = await preview(page);
  await expect(dialog.getByRole('status')).toContainText('Loading');
  await expect(
    dialog.getByRole('button', { name: 'Wireframe', exact: true }),
  ).toBeDisabled();
  await capture(page, 'preview-loading', info);
  await releaseIpcReply(app!, 'model:loadScene');
  await expect(dialog.getByRole('alert')).toContainText(
    'Synthetic scene parse failed.',
  );
  await capture(page, 'preview-error', info);
  await dialog.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(dialog.locator('canvas')).toBeVisible();
  await expect(
    dialog.getByRole('heading', { name: 'Materials', exact: true }),
  ).toHaveCount(0);
  await expect(
    dialog.getByRole('group', { name: 'Plate', exact: true }),
  ).toHaveCount(0);
  await capture(page, 'preview-retry-default-material', info);
  await dialog.getByRole('button', { name: 'Wireframe', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Orthographic', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Wireframe', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    dialog.getByRole('button', { name: 'Orthographic', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Reset view' }).click();
  await capture(page, 'wireframe-orthographic-reset', info);
  await dialog.getByRole('button', { name: 'Solid', exact: true }).click();
  await dialog
    .getByRole('button', { name: 'Perspective', exact: true })
    .click();
  await expect(
    dialog.getByRole('button', { name: 'Solid', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
});

for (const [state, vendor, scene] of [
  [
    'vendor-absent',
    {
      slicer: 'unknown',
      printerTarget: 'unknown',
      core: {},
      plates: [],
      thumbnails: [],
    },
    syntheticScene(),
  ],
  [
    'vendor-unknown-authored',
    {
      ...syntheticVendor,
      slicer: 'unknown',
      core: {
        title: 'Unknown authored title',
        creationDate: 'non-date authored text',
      },
    },
    syntheticScene(),
  ],
  [
    'vendor-populated-material-mixture',
    {
      ...syntheticVendor,
      core: {
        title: 'Synthetic title',
        designer: 'Synthetic designer',
        description: 'Synthetic description',
        application: 'Synthetic author',
        licenseTerms: 'Synthetic license',
        copyright: 'Synthetic copyright',
        creationDate: '2026-01-02T00:00:00Z',
        modificationDate: 'non-date authored text',
      },
      plates: [
        {
          index: 1,
          predictionSeconds: 3660,
          weightGrams: 12.5,
          filamentTypes: ['PLA', 'PETG'],
        },
      ],
    },
    (() => {
      const mesh = syntheticScene();
      const authored = {
        ...mesh.objects[0]!,
        id: 'authored',
        name: 'Authored red',
        material: {
          baseColor: [255, 0, 0] as [number, number, number],
          faceColors: [255, 0, 0],
        },
      };
      return {
        ...mesh,
        objects: [...mesh.objects, authored],
        rootObjectIds: ['synthetic-root', 'authored'],
      };
    })(),
  ],
] satisfies Array<[string, VendorMetadata, SceneMesh]>) {
  test(`synthetic details ${state}`, async () => {
    const info = test.info();
    const page = await open({
      'model:extractVendorMetadata': [{ value: vendor }],
      'model:loadScene': [{ value: scene }],
    });
    const dialog = await preview(page);
    await expect(dialog.locator('canvas')).toBeVisible();
    if (state === 'vendor-absent')
      await expect(
        dialog.getByText('No slicer/vendor metadata in this file.'),
      ).toBeVisible();
    if (state === 'vendor-unknown-authored')
      await expect(
        dialog.getByText('Unknown slicer', { exact: true }),
      ).toBeVisible();
    if (state === 'vendor-populated-material-mixture') {
      await expect(
        dialog.getByRole('list', { name: 'Materials' }),
      ).toContainText('Default colour');
      await expect(
        dialog.getByRole('list', { name: 'Materials' }),
      ).toContainText('Per-face colours');
      await expect(
        dialog.getByRole('list', { name: 'Plates', exact: true }),
      ).toContainText('1h 1m');
    }
    await capture(page, state, info);
  });
}

test('synthetic details long authored content and deep tree fit the compact preview', async () => {
  const info = test.info();
  const mesh = syntheticScene();
  mesh.objects = Array.from({ length: 40 }, (_, index) => ({
    ...mesh.objects[0]!,
    id: `deep-${index}`,
    name: `Deep component ${index} ${'long-authored-name-'.repeat(8)}`,
    parentId: index ? `deep-${index - 1}` : null,
    children: index < 39 ? [`deep-${index + 1}`] : [],
    mesh: index === 39 ? mesh.objects[0]!.mesh : null,
  }));
  mesh.rootObjectIds = ['deep-0'];
  mesh.plates = [];
  const catalogReply = syntheticModelReplies()['catalog:queryModels']![0]!;
  if (!('value' in catalogReply))
    throw new Error('Synthetic catalog must be settled.');
  const longPath = `C:\\SyntheticPrintFarmer\\${'Long authored directory\\'.repeat(20)}${syntheticModelName}`;
  const page = await open({
    'catalog:queryModels': [
      {
        value: {
          ...catalogReply.value,
          models: catalogReply.value.models.map((model) => ({
            ...model,
            locations: model.locations.map((location) => ({
              ...location,
              path: longPath,
            })),
          })),
        },
      },
    ],
    'model:loadScene': [{ value: mesh }],
    'model:extractVendorMetadata': [
      {
        value: {
          ...syntheticVendor,
          core: {
            title: 'Long title '.repeat(60),
            description: 'Long description '.repeat(100),
            designer: 'Authored designer '.repeat(30),
          },
        },
      },
    ],
  });
  await applyPinnedRenderingProfile(
    page,
    'desktop-dark-720x450-2x-proxy-dsf1-en-US-UTC-reduced-motion-v1',
  );
  await expect(
    page
      .getByRole('complementary', { name: 'Model properties' })
      .getByText(longPath, { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(720);
  await capture(page, 'long-path-inspector-compact', info);
  const dialog = await preview(page);
  const tree = dialog.getByRole('tree', { name: 'Scene objects' });
  await expect(tree.getByRole('treeitem')).toHaveCount(40);
  const details = dialog.getByRole('complementary', {
    name: 'Preview details',
  });
  const metrics = await details.evaluate((element) => ({
    right: element.getBoundingClientRect().right,
    width: innerWidth,
    client: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(metrics.right).toBeLessThanOrEqual(metrics.width);
  expect(metrics.scroll).toBeGreaterThan(metrics.client);
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(720);
  await capture(page, 'long-deep-compact', info);
});

test('synthetic details keyboard roving, inherited visibility and isolation remain synchronized', async () => {
  const info = test.info();
  const mesh = syntheticScene();
  const root = mesh.objects[0]!;
  mesh.plates = [];
  mesh.objects = [
    { ...root, name: 'Assembly', mesh: null, children: ['child', 'sibling'] },
    { ...root, id: 'child', name: 'Child', parentId: root.id },
    { ...root, id: 'sibling', name: 'Sibling', parentId: root.id },
  ];
  const page = await open({ 'model:loadScene': [{ value: mesh }] });
  const dialog = await preview(page);
  const tree = dialog.getByRole('tree', { name: 'Scene objects' });
  const assembly = tree.getByRole('treeitem', {
    name: 'Assembly',
    exact: true,
  });
  await assembly.focus();
  await page.keyboard.press('ArrowRight');
  await expect(
    tree.getByRole('treeitem', { name: 'Child', exact: true }),
  ).toBeFocused();
  await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('Home');
  await page.keyboard.press('Space');
  await expect(
    tree.getByRole('button', { name: 'Show Child', exact: true }),
  ).toBeDisabled();
  await expect(
    tree.getByRole('treeitem', { name: 'Child, hidden', exact: true }),
  ).toBeVisible();
  await capture(page, 'tree-inherited-hidden', info);
  await page.keyboard.press('Space');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('i');
  await expect(
    dialog.getByRole('status').filter({ hasText: 'Isolating Child' }),
  ).toBeVisible();
  await expect(
    tree.getByRole('treeitem', { name: 'Sibling, hidden', exact: true }),
  ).toBeVisible();
  await expect(
    tree.getByRole('treeitem', { name: 'Child', exact: true }),
  ).toBeFocused();
  await capture(page, 'tree-keyboard-isolated', info);
  await dialog
    .getByRole('button', { name: 'Exit isolation', exact: true })
    .click();
  await expect(
    tree.getByRole('treeitem', { name: 'Sibling', exact: true }),
  ).toBeVisible();
  await assembly.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(tree.getByRole('treeitem')).toHaveCount(1);
  await expect(assembly).toHaveAttribute('aria-expanded', 'false');
  await capture(page, 'tree-collapsed-roving', info);
});

test('synthetic details repeated and cyclic nodes render read-only diagnostics', async () => {
  const info = test.info();
  const mesh = syntheticScene();
  mesh.objects[0]!.children = ['child', 'child', 'missing'];
  mesh.objects.push({
    ...mesh.objects[0]!,
    id: 'child',
    name: 'Cyclic child',
    parentId: 'synthetic-root',
    children: ['synthetic-root'],
  });
  const page = await open({ 'model:loadScene': [{ value: mesh }] });
  const dialog = await preview(page);
  await expect(
    dialog.getByText('Invalid scene node: Synthetic triangle'),
  ).toBeVisible();
  await expect(
    dialog.getByText('Invalid scene node: Cyclic child'),
  ).toBeVisible();
  await capture(page, 'malformed-tree-diagnostics', info);
});

test('synthetic details row budget truncates at the actual twenty-thousand row threshold', async () => {
  const info = test.info();
  test.setTimeout(240_000);
  const mesh = syntheticScene();
  const root = mesh.objects[0]!;
  mesh.objects = [
    {
      ...root,
      children: Array.from({ length: 20_001 }, (_, index) => `wide-${index}`),
    },
    ...Array.from({ length: 20_001 }, (_, index) => ({
      ...root,
      id: `wide-${index}`,
      name: `Component ${index}`,
      parentId: root.id,
      children: [],
      mesh: null,
    })),
  ];
  const page = await open({ 'model:loadScene': [{ value: mesh }] });
  const dialog = await preview(page);
  const tree = dialog.getByRole('tree', { name: 'Scene objects' });
  await expect(tree.getByRole('treeitem')).toHaveCount(20_001, {
    timeout: 60_000,
  });
  await expect(
    tree.getByText(
      'Scene too large to list in full; stopped after 20,000 rows.',
    ),
  ).toBeAttached();
  await expect(tree.locator('[tabindex="0"]')).toHaveCount(1);
  await tree.getByRole('treeitem').last().scrollIntoViewIfNeeded();
  await captureVisualScenario(
    page,
    'details.states.row-budget-truncated',
    info,
  );
  await scanSurface(page, {
    name: 'row-budget truncation diagnostic only',
    present: tree.locator('[data-row-key="notice:truncated"]'),
    include: '[data-row-key="notice:truncated"]',
    testInfo: info,
    soft: true,
  });
});
