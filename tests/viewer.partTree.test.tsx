import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { PartTree } from '../src/renderer/library/PartTree.js';
import {
  ancestorObjectIds,
  effectiveHiddenObjectIds,
  flattenPartTree,
  isFocusableRow,
  isObjectHidden,
  isolateHiddenObjectIds,
  MAX_PART_TREE_ROWS,
  objectRowKey,
  partTreeKeyAction,
  plateRowKey,
  subtreeObjectIds,
  type PartTreeRow,
} from '../src/renderer/library/partTreeModel.js';
import type { SceneObject, ScenePlate } from '../src/renderer/viewer/types.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] as const;

function object(
  id: string,
  name: string,
  overrides: Partial<SceneObject> = {},
): SceneObject {
  return {
    id,
    sourceId: `source-${id}`,
    name,
    parentId: null,
    children: [],
    transform: { matrix: [...IDENTITY] },
    mesh: null,
    material: {},
    plateId: 'plate-0',
    buildItemIndex: 0,
    ...overrides,
  };
}

function leafMesh(): NonNullable<SceneObject['mesh']> {
  return {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
}

/**
 * plate-0 → Body → { Lid (mesh), Base (mesh) }
 * plate-1 → Spare (mesh)
 */
function sampleObjects(): readonly SceneObject[] {
  return [
    object('body', 'Body', { children: ['lid', 'base'] }),
    object('lid', 'Lid', { parentId: 'body', mesh: leafMesh() }),
    object('base', 'Base', { parentId: 'body', mesh: leafMesh() }),
    object('spare', 'Spare', { plateId: 'plate-1', mesh: leafMesh() }),
  ];
}

function samplePlates(): readonly ScenePlate[] {
  return [
    { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
    { id: 'plate-1', name: 'Plate 2', index: 1, rootObjectIds: ['spare'] },
  ];
}

function flatten(
  overrides: {
    objects?: readonly SceneObject[];
    rootObjectIds?: readonly string[];
    plates?: readonly ScenePlate[];
    hidden?: ReadonlySet<string>;
    collapsed?: ReadonlySet<string>;
  } = {},
): readonly PartTreeRow[] {
  return flattenPartTree({
    objects: overrides.objects ?? sampleObjects(),
    rootObjectIds: overrides.rootObjectIds ?? ['body', 'spare'],
    plates: overrides.plates ?? samplePlates(),
    hidden: overrides.hidden ?? new Set(),
    collapsed: overrides.collapsed ?? new Set(),
  });
}

describe('flattenPartTree', () => {
  it('groups objects under plates with ARIA position metadata', () => {
    const rows = flatten();

    expect(rows.map((row) => [row.key, row.level])).toEqual([
      [plateRowKey('plate-0'), 1],
      [objectRowKey(plateRowKey('plate-0'), 'body'), 2],
      [objectRowKey(objectRowKey(plateRowKey('plate-0'), 'body'), 'lid'), 3],
      [objectRowKey(objectRowKey(plateRowKey('plate-0'), 'body'), 'base'), 3],
      [plateRowKey('plate-1'), 1],
      [objectRowKey(plateRowKey('plate-1'), 'spare'), 2],
    ]);

    const [plate, body, lid, base] = rows;
    expect(plate).toMatchObject({
      kind: 'plate',
      plateId: 'plate-0',
      plateRootObjectIds: ['body'],
      positionInSet: 1,
      setSize: 2,
      childCount: 1,
      objectId: null,
    });
    expect(body).toMatchObject({
      kind: 'object',
      objectId: 'body',
      hasChildren: true,
      childCount: 2,
      expanded: true,
      triangles: null,
    });
    expect(lid).toMatchObject({ positionInSet: 1, setSize: 2, triangles: 1 });
    expect(base).toMatchObject({ positionInSet: 2, setSize: 2, triangles: 1 });
  });

  it('falls back to root object ids when the scene has no plates', () => {
    const rows = flatten({ plates: [] });
    expect(rows.map((row) => row.objectId)).toEqual([
      'body',
      'lid',
      'base',
      'spare',
    ]);
    expect(rows[0]).toMatchObject({ level: 1, positionInSet: 1, setSize: 2 });
  });

  it('omits children of collapsed rows', () => {
    const bodyKey = objectRowKey(plateRowKey('plate-0'), 'body');
    const rows = flatten({ collapsed: new Set([bodyKey]) });
    expect(rows.map((row) => row.objectId)).toEqual([
      null,
      'body',
      null,
      'spare',
    ]);
    expect(rows[1]).toMatchObject({ hasChildren: true, expanded: false });
  });

  it('propagates hidden state down the hierarchy', () => {
    const rows = flatten({ hidden: new Set(['body']) });
    const byObject = new Map(rows.map((row) => [row.objectId, row]));
    expect(byObject.get('body')).toMatchObject({
      hidden: true,
      ancestorHidden: false,
    });
    expect(byObject.get('lid')).toMatchObject({
      hidden: true,
      ancestorHidden: true,
    });
    expect(byObject.get('spare')).toMatchObject({ hidden: false });
  });

  it('marks a plate hidden only when every root on it is hidden', () => {
    const partly = flatten({ hidden: new Set(['spare']) });
    expect(partly[0]?.hidden).toBe(false);
    expect(partly[4]?.hidden).toBe(true);

    const fully = flatten({ hidden: new Set(['body', 'spare']) });
    expect(fully[0]?.hidden).toBe(true);
  });

  it('stops at cyclic child references and flags the repeated node', () => {
    const rows = flatten({
      objects: [
        object('body', 'Body', { children: ['lid'] }),
        object('lid', 'Lid', { parentId: 'body', children: ['body'] }),
      ],
      rootObjectIds: ['body'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
      ],
    });

    expect(rows).toHaveLength(4);
    expect(rows[3]).toMatchObject({
      objectId: 'body',
      invalid: true,
      hasChildren: false,
    });
  });

  it('ignores child and root references that are not in the object table', () => {
    const rows = flatten({
      objects: [object('body', 'Body', { children: ['ghost'] })],
      rootObjectIds: ['body', 'ghost'],
      plates: [],
    });
    expect(rows.map((row) => row.objectId)).toEqual(['body']);
    expect(rows[0]).toMatchObject({ hasChildren: false, setSize: 1 });
  });
});

describe('scene graph walks', () => {
  it('collects a subtree including the root, cycle-safe', () => {
    expect([...subtreeObjectIds(sampleObjects(), 'body')].sort()).toEqual([
      'base',
      'body',
      'lid',
    ]);
    const cyclic = [
      object('body', 'Body', { children: ['lid'] }),
      object('lid', 'Lid', { parentId: 'body', children: ['body'] }),
    ];
    expect([...subtreeObjectIds(cyclic, 'body')].sort()).toEqual([
      'body',
      'lid',
    ]);
  });

  it('walks ancestors nearest-first and stops on a parent cycle', () => {
    expect(ancestorObjectIds(sampleObjects(), 'lid')).toEqual(['body']);
    expect(ancestorObjectIds(sampleObjects(), 'body')).toEqual([]);
    const cyclic = [
      object('a', 'A', { parentId: 'b' }),
      object('b', 'B', { parentId: 'a' }),
    ];
    expect(ancestorObjectIds(cyclic, 'a')).toEqual(['b']);
  });

  it('reports a node hidden when any ancestor is hidden', () => {
    const objects = sampleObjects();
    expect(isObjectHidden(objects, 'lid', new Set())).toBe(false);
    expect(isObjectHidden(objects, 'lid', new Set(['body']))).toBe(true);
    expect(isObjectHidden(objects, 'lid', new Set(['lid']))).toBe(true);
    expect(isObjectHidden(objects, 'spare', new Set(['body']))).toBe(false);
  });
});

describe('isolateHiddenObjectIds', () => {
  it('keeps the isolated subtree and hides its siblings', () => {
    expect([...isolateHiddenObjectIds(sampleObjects(), 'body')].sort()).toEqual(
      ['spare'],
    );
  });

  it('keeps ancestors visible so the isolated node still renders', () => {
    const hidden = isolateHiddenObjectIds(sampleObjects(), 'lid');
    expect(hidden.has('body')).toBe(false);
    expect([...hidden].sort()).toEqual(['base', 'spare']);
  });

  it('hides nothing for an unknown object id', () => {
    expect(isolateHiddenObjectIds(sampleObjects(), 'ghost').size).toBe(0);
  });
});

describe('effectiveHiddenObjectIds', () => {
  // The one-pass resolver replaced a per-object walk that was quadratic in
  // scene size. It is only a safe replacement if it gives the same answer as
  // the helper it replaced for every object, so that is asserted directly
  // rather than by re-deriving expectations by hand.
  const shapes = (objects: readonly SceneObject[]) =>
    [
      ['nothing hidden', new Set<string>()],
      ['one root hidden', new Set(['body'])],
      ['a leaf hidden', new Set(['lid'])],
      ['isolating a child', isolateHiddenObjectIds(objects, 'lid')],
      ['isolating a root', isolateHiddenObjectIds(objects, 'body')],
      ['scattered ids', new Set(['lid', 'spare'])],
      ['everything hidden', new Set(objects.map((o) => o.id))],
      ['an id not in the scene', new Set(['ghost'])],
    ] as const;

  it('agrees with isObjectHidden on every object for every hidden set', () => {
    const objects = sampleObjects();
    for (const [label, hidden] of shapes(objects)) {
      const resolved = effectiveHiddenObjectIds(objects, hidden);
      for (const object of objects) {
        expect(resolved.has(object.id), `${label}: ${object.id}`).toBe(
          isObjectHidden(objects, object.id, hidden),
        );
      }
    }
  });

  it('cascades a hidden root to its whole subtree', () => {
    // The control for the test above: without cascading, the two functions
    // would still agree on a flat scene, so the equivalence would prove little.
    const resolved = effectiveHiddenObjectIds(
      sampleObjects(),
      new Set(['body']),
    );

    expect([...resolved].sort()).toEqual(['base', 'body', 'lid']);
  });

  it('returns an empty set when nothing is hidden', () => {
    expect(effectiveHiddenObjectIds(sampleObjects(), new Set()).size).toBe(0);
  });

  it('terminates on a parent cycle, matching ancestorObjectIds', () => {
    const cycle: SceneObject[] = [
      object('a', 'A', { parentId: 'b', children: ['b'] }),
      object('b', 'B', { parentId: 'a', children: ['a'] }),
    ];

    for (const hidden of [new Set<string>(), new Set(['a']), new Set(['b'])]) {
      const resolved = effectiveHiddenObjectIds(cycle, hidden);
      for (const entry of cycle) {
        expect(resolved.has(entry.id)).toBe(
          isObjectHidden(cycle, entry.id, hidden),
        );
      }
    }
  });

  it('stops at a parent that is not in the scene', () => {
    const orphan = [object('lonely', 'Lonely', { parentId: 'ghost' })];

    expect(effectiveHiddenObjectIds(orphan, new Set(['ghost'])).size).toBe(0);
    expect([...effectiveHiddenObjectIds(orphan, new Set(['lonely']))]).toEqual([
      'lonely',
    ]);
  });
});

describe('partTreeKeyAction', () => {
  const rows = flatten();
  const plateKey = plateRowKey('plate-0');
  const bodyKey = objectRowKey(plateKey, 'body');
  const lidKey = objectRowKey(bodyKey, 'lid');
  const baseKey = objectRowKey(bodyKey, 'base');

  it('walks the flattened rows with the arrow, Home and End keys', () => {
    expect(partTreeKeyAction('ArrowDown', rows, plateKey)).toEqual({
      type: 'move',
      key: bodyKey,
    });
    expect(partTreeKeyAction('ArrowUp', rows, bodyKey)).toEqual({
      type: 'move',
      key: plateKey,
    });
    expect(partTreeKeyAction('Home', rows, lidKey)).toEqual({
      type: 'move',
      key: plateKey,
    });
    expect(partTreeKeyAction('End', rows, plateKey)).toEqual({
      type: 'move',
      key: rows[rows.length - 1]?.key,
    });
    expect(partTreeKeyAction('ArrowUp', rows, plateKey)).toBeNull();
    expect(partTreeKeyAction('ArrowDown', rows, rows[5]?.key ?? '')).toBeNull();
  });

  it('expands a collapsed row before descending into it', () => {
    const collapsed = flatten({ collapsed: new Set([bodyKey]) });
    expect(partTreeKeyAction('ArrowRight', collapsed, bodyKey)).toEqual({
      type: 'expand',
      key: bodyKey,
    });
    expect(partTreeKeyAction('ArrowRight', rows, bodyKey)).toEqual({
      type: 'move',
      key: lidKey,
    });
    expect(partTreeKeyAction('ArrowRight', rows, lidKey)).toBeNull();
  });

  it('collapses an expanded row before climbing to its parent', () => {
    expect(partTreeKeyAction('ArrowLeft', rows, bodyKey)).toEqual({
      type: 'collapse',
      key: bodyKey,
    });
    expect(partTreeKeyAction('ArrowLeft', rows, baseKey)).toEqual({
      type: 'move',
      key: bodyKey,
    });
    expect(partTreeKeyAction('ArrowLeft', rows, plateKey)).toEqual({
      type: 'collapse',
      key: plateKey,
    });
    // A collapsed top-level row has nowhere left to go.
    const collapsed = flatten({ collapsed: new Set([plateKey]) });
    expect(partTreeKeyAction('ArrowLeft', collapsed, plateKey)).toBeNull();
  });

  it('maps Space to visibility and I to isolation', () => {
    expect(partTreeKeyAction(' ', rows, lidKey)).toEqual({
      type: 'toggleVisibility',
      key: lidKey,
    });
    expect(partTreeKeyAction(' ', rows, plateKey)).toEqual({
      type: 'toggleVisibility',
      key: plateKey,
    });
    expect(partTreeKeyAction('i', rows, lidKey)).toEqual({
      type: 'isolate',
      key: lidKey,
    });
    expect(partTreeKeyAction('I', rows, lidKey)).toEqual({
      type: 'isolate',
      key: lidKey,
    });
    // Plate rows have no scene object to isolate.
    expect(partTreeKeyAction('i', rows, plateKey)).toBeNull();
  });

  it('ignores unhandled keys and unknown rows', () => {
    expect(partTreeKeyAction('Tab', rows, lidKey)).toBeNull();
    expect(partTreeKeyAction('ArrowDown', rows, 'missing')).toBeNull();
  });
});

function renderTree(
  overrides: Partial<React.ComponentProps<typeof PartTree>> = {},
): {
  onToggle: ReturnType<typeof vi.fn>;
  onToggleAll: ReturnType<typeof vi.fn>;
  onTogglePlate: ReturnType<typeof vi.fn>;
  onIsolate: ReturnType<typeof vi.fn>;
} {
  const handlers = {
    onToggle: vi.fn(),
    onToggleAll: vi.fn(),
    onTogglePlate: vi.fn(),
    onIsolate: vi.fn(),
  };
  render(
    <PartTree
      objects={sampleObjects()}
      rootObjectIds={['body', 'spare']}
      plates={samplePlates()}
      hidden={new Set()}
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

function treeitem(name: string | RegExp): HTMLElement {
  return screen.getByRole('treeitem', { name });
}

/** Focus a row the way a user would, flushing the roving-tabindex update. */
function focusRow(row: HTMLElement): HTMLElement {
  act(() => {
    row.focus();
  });
  return row;
}

describe('<PartTree /> tree semantics', () => {
  it('exposes an ARIA tree with level, position and expansion state', () => {
    renderTree();
    const tree = screen.getByRole('tree', { name: 'Scene objects' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items).toHaveLength(6);

    const body = treeitem('Body');
    expect(body).toHaveAttribute('aria-level', '2');
    expect(body).toHaveAttribute('aria-posinset', '1');
    expect(body).toHaveAttribute('aria-setsize', '1');
    expect(body).toHaveAttribute('aria-expanded', 'true');

    const lid = treeitem('Lid');
    expect(lid).toHaveAttribute('aria-level', '3');
    expect(lid).not.toHaveAttribute('aria-expanded');
  });

  it('keeps a single roving tab stop and moves it with the arrow keys', () => {
    renderTree();
    const plate = treeitem('Plate 1');
    const body = treeitem('Body');
    expect(plate).toHaveAttribute('tabindex', '0');
    expect(body).toHaveAttribute('tabindex', '-1');

    focusRow(plate);
    fireEvent.keyDown(plate, { key: 'ArrowDown' });
    expect(treeitem('Body')).toHaveFocus();
    expect(treeitem('Body')).toHaveAttribute('tabindex', '0');
    expect(treeitem('Plate 1')).toHaveAttribute('tabindex', '-1');

    fireEvent.keyDown(treeitem('Body'), { key: 'End' });
    expect(treeitem('Spare')).toHaveFocus();
    fireEvent.keyDown(treeitem('Spare'), { key: 'Home' });
    expect(treeitem('Plate 1')).toHaveFocus();
  });

  it('collapses and re-expands a subtree from the keyboard', () => {
    renderTree();
    const body = treeitem('Body');
    focusRow(body);
    fireEvent.keyDown(body, { key: 'ArrowLeft' });

    expect(screen.queryByRole('treeitem', { name: 'Lid' })).toBeNull();
    expect(treeitem('Body')).toHaveAttribute('aria-expanded', 'false');

    fireEvent.keyDown(treeitem('Body'), { key: 'ArrowRight' });
    expect(treeitem('Lid')).toBeInTheDocument();
    expect(treeitem('Body')).toHaveAttribute('aria-expanded', 'true');

    fireEvent.keyDown(treeitem('Body'), { key: 'ArrowRight' });
    expect(treeitem('Lid')).toHaveFocus();
  });

  it('collapses and re-expands a subtree by clicking the twisty', () => {
    const { container } = render(
      <PartTree
        objects={sampleObjects()}
        rootObjectIds={['body', 'spare']}
        plates={samplePlates()}
        hidden={new Set()}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    const twisty = container.querySelector(
      '[data-row-key$="/body"] .part-twisty',
    );
    expect(twisty).not.toBeNull();
    fireEvent.click(twisty as Element);
    expect(screen.queryByRole('treeitem', { name: 'Lid' })).toBeNull();
    fireEvent.click(
      container.querySelector(
        '[data-row-key$="/body"] .part-twisty',
      ) as Element,
    );
    expect(treeitem('Lid')).toBeInTheDocument();
  });
});

describe('<PartTree /> visibility controls', () => {
  it('renders nothing when there are no objects', () => {
    const { container } = render(
      <PartTree
        objects={[]}
        rootObjectIds={[]}
        plates={[]}
        hidden={new Set()}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('toggles an object from its button and from the Space key', () => {
    const { onToggle } = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Lid' }));
    expect(onToggle).toHaveBeenCalledWith('lid');

    const base = treeitem('Base');
    focusRow(base);
    fireEvent.keyDown(base, { key: ' ' });
    expect(onToggle).toHaveBeenLastCalledWith('base');
  });

  it('labels hidden rows and offers to show them again', () => {
    const { onToggle } = renderTree({ hidden: new Set(['lid']) });
    expect(treeitem('Lid, hidden')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show Lid' }));
    expect(onToggle).toHaveBeenCalledWith('lid');
  });

  it('disables the per-object control when an ancestor is hidden', () => {
    const { onToggle } = renderTree({ hidden: new Set(['body']) });
    const lidControl = screen.getByRole('button', { name: 'Show Lid' });
    expect(lidControl).toBeDisabled();

    const lid = treeitem('Lid, hidden');
    focusRow(lid);
    fireEvent.keyDown(lid, { key: ' ' });
    expect(onToggle).not.toHaveBeenCalled();
  });

  it('toggles every root on a plate at once', () => {
    const { onTogglePlate } = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'Hide Plate 1' }));
    expect(onTogglePlate).toHaveBeenCalledWith('plate-0', false);

    const plate = treeitem('Plate 2');
    focusRow(plate);
    fireEvent.keyDown(plate, { key: ' ' });
    expect(onTogglePlate).toHaveBeenLastCalledWith('plate-1', false);
  });

  it('shows all when anything is hidden and hides all otherwise', () => {
    const visible = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'Hide all' }));
    expect(visible.onToggleAll).toHaveBeenCalledWith(false);
    screen.getByRole('tree').remove();

    const partly = renderTree({ hidden: new Set(['lid']) });
    fireEvent.click(screen.getByRole('button', { name: 'Show all' }));
    expect(partly.onToggleAll).toHaveBeenCalledWith(true);
  });
});

describe('<PartTree /> isolation', () => {
  it('isolates from the button and from the I key', () => {
    const { onIsolate } = renderTree();
    fireEvent.click(screen.getByRole('button', { name: 'Isolate Body' }));
    expect(onIsolate).toHaveBeenCalledWith('body');

    const lid = treeitem('Lid');
    focusRow(lid);
    fireEvent.keyDown(lid, { key: 'i' });
    expect(onIsolate).toHaveBeenLastCalledWith('lid');
  });

  it('announces the isolated object and exits isolation', () => {
    const { onIsolate } = renderTree({
      isolatedObjectId: 'body',
      hidden: isolateHiddenObjectIds(sampleObjects(), 'body'),
    });
    expect(screen.getByRole('status')).toHaveTextContent('Isolating Body');

    const isolateControl = screen.getByRole('button', {
      name: 'Exit isolation of Body',
    });
    expect(isolateControl).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(isolateControl);
    expect(onIsolate).toHaveBeenCalledWith(null);

    fireEvent.click(screen.getByRole('button', { name: 'Exit isolation' }));
    expect(onIsolate).toHaveBeenLastCalledWith(null);
  });

  it('omits isolation affordances when no handler is supplied', () => {
    render(
      <PartTree
        objects={sampleObjects()}
        rootObjectIds={['body', 'spare']}
        plates={samplePlates()}
        hidden={new Set()}
        onToggle={vi.fn()}
        onToggleAll={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Isolate Body' })).toBeNull();
  });

  it('never offers isolation on a plate row', () => {
    renderTree();
    expect(
      screen.queryByRole('button', { name: 'Isolate Plate 1' }),
    ).toBeNull();
  });
});

describe('<PartTree /> malformed scenes', () => {
  it('renders a diagnostic row for a cyclic reference and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    renderTree({
      objects: [
        object('body', 'Body', { children: ['lid'] }),
        object('lid', 'Lid', { parentId: 'body', children: ['body'] }),
      ],
      rootObjectIds: ['body'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
      ],
    });

    expect(screen.getByText(/Invalid scene node: Body/i)).toBeInTheDocument();
    expect(warn).toHaveBeenCalledWith(
      '[PartTree] Skipping cyclic or duplicated scene object reference for "body".',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

/**
 * A chain of `levels` diamonds: `m{i}` reaches `m{i+1}` both directly and via
 * `s{i}`, so the number of distinct *paths* to the tail doubles every level.
 * With 14 levels that is 29 objects but 2^15-1 = 32,767 paths through the
 * `m` chain alone — the shape that made a path-local `seen` set explode.
 */
function diamondDag(levels: number): {
  objects: readonly SceneObject[];
  rootObjectIds: readonly string[];
} {
  const objects: SceneObject[] = [];
  for (let i = 0; i <= levels; i += 1) {
    objects.push(
      object(`m${i}`, `M${i}`, {
        children: i < levels ? [`s${i}`, `m${i + 1}`] : [],
      }),
    );
  }
  for (let i = 0; i < levels; i += 1) {
    objects.push(object(`s${i}`, `S${i}`, { children: [`m${i + 1}`] }));
  }
  return { objects, rootObjectIds: ['m0'] };
}

/** A single-child chain `n0 → n1 → … → n{length-1}`. */
function chain(length: number): {
  objects: readonly SceneObject[];
  rootObjectIds: readonly string[];
} {
  const objects: SceneObject[] = [];
  for (let i = 0; i < length; i += 1) {
    objects.push(
      object(`n${i}`, `N${i}`, {
        parentId: i === 0 ? null : `n${i - 1}`,
        children: i === length - 1 ? [] : [`n${i + 1}`],
      }),
    );
  }
  return { objects, rootObjectIds: ['n0'] };
}

/** Every `tabIndex={0}` element inside the rendered tree. */
function tabStops(): readonly Element[] {
  return [...screen.getByRole('tree').querySelectorAll('[tabindex="0"]')];
}

/**
 * Treeitems for `name` that the user can actually act on. Diagnostic rows are
 * `aria-disabled` and carry no controls, so a repeated reference must never
 * produce a second actionable row for the same part.
 */
function actionableItems(name: string): readonly Element[] {
  return screen
    .getAllByRole('treeitem')
    .filter(
      (item) =>
        item.getAttribute('aria-disabled') !== 'true' &&
        item.querySelector('.part-name')?.textContent === name,
    );
}

describe('flattenPartTree hostile shapes', () => {
  it('renders a duplicated child once and flags the repeat, with unique keys', () => {
    const rows = flatten({
      objects: [
        object('body', 'Body', { children: ['leaf', 'leaf'] }),
        object('leaf', 'Leaf', { parentId: 'body' }),
      ],
      rootObjectIds: ['body'],
      plates: [],
    });

    expect(rows.map((row) => [row.objectId, row.invalid])).toEqual([
      ['body', false],
      ['leaf', false],
      ['leaf', true],
    ]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
    // Sibling metadata stays honest: the repeat still occupies its slot.
    expect(rows[2]).toMatchObject({ positionInSet: 2, setSize: 2 });
  });

  it('renders an object referenced by two parents once', () => {
    const rows = flatten({
      objects: [
        object('a', 'A', { children: ['shared'] }),
        object('b', 'B', { children: ['shared'] }),
        object('shared', 'Shared'),
      ],
      rootObjectIds: ['a', 'b'],
      plates: [],
    });

    const valid = rows.filter((row) => !row.invalid);
    expect(valid.map((row) => row.objectId)).toEqual(['a', 'shared', 'b']);
    expect(rows.filter((row) => row.invalid)).toHaveLength(1);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('renders an object listed on two plates once', () => {
    const rows = flatten({
      objects: [object('body', 'Body')],
      rootObjectIds: ['body'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
        { id: 'plate-1', name: 'Plate 2', index: 1, rootObjectIds: ['body'] },
      ],
    });

    const objectRows = rows.filter((row) => row.kind === 'object');
    expect(objectRows.map((row) => row.invalid)).toEqual([false, true]);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('keeps a 29-object diamond DAG linear instead of exponential', () => {
    const { objects, rootObjectIds } = diamondDag(14);
    expect(objects).toHaveLength(29);

    const rows = flatten({ objects, rootObjectIds, plates: [] });

    // Was 32,767+ rows when the cycle guard was path-local.
    expect(rows.length).toBeLessThan(100);
    expect(rows.filter((row) => !row.invalid)).toHaveLength(objects.length);
    expect(rows.filter((row) => row.invalid)).toHaveLength(14);
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('flattens a 15,000-deep chain without a RangeError', () => {
    // Deeper than any call stack tolerates, and still under the row budget so
    // the whole chain has to come back.
    const { objects, rootObjectIds } = chain(15_000);
    let rows: readonly PartTreeRow[] = [];
    expect(() => {
      rows = flattenPartTree({
        objects,
        rootObjectIds,
        plates: [],
        hidden: new Set(),
        collapsed: new Set(),
      });
    }).not.toThrow();
    expect(rows).toHaveLength(15_000);
    expect(rows[14_999]).toMatchObject({ objectId: 'n14999', level: 15_000 });
  });

  it('truncates with a notice row instead of exceeding the budget', () => {
    const { objects, rootObjectIds } = chain(MAX_PART_TREE_ROWS + 50);
    const rows = flatten({ objects, rootObjectIds, plates: [] });

    expect(rows).toHaveLength(MAX_PART_TREE_ROWS + 1);
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ kind: 'notice', objectId: null });
    expect(last?.name).toMatch(/Scene too large/i);
    expect(isFocusableRow(last as PartTreeRow)).toBe(false);
  });

  it('clamps a fan-out wider than the budget and still flags truncation', () => {
    // A node may legally carry up to 100k children. Queueing all of them would
    // dwarf the rows that could ever be emitted, so the walk stops queueing —
    // and must still say it truncated, even though the drain ends on its own.
    const fanOut = MAX_PART_TREE_ROWS + 5_000;
    const rows = flatten({
      objects: [
        object('root', 'Root', {
          children: Array.from({ length: fanOut }, () => 'leaf'),
        }),
        object('leaf', 'Leaf', { parentId: 'root' }),
      ],
      rootObjectIds: ['root'],
      plates: [],
    });

    expect(rows).toHaveLength(MAX_PART_TREE_ROWS + 1);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'notice' });
    // Sibling metadata still describes the real scene, not the clamped view.
    expect(rows[1]).toMatchObject({ positionInSet: 1, setSize: fanOut });
  });

  it('leaves a scene one row under the budget alone', () => {
    const { objects, rootObjectIds } = chain(MAX_PART_TREE_ROWS - 1);
    const rows = flatten({ objects, rootObjectIds, plates: [] });

    expect(rows).toHaveLength(MAX_PART_TREE_ROWS - 1);
    expect(rows.some((row) => row.kind === 'notice')).toBe(false);
  });

  it('leaves a scene exactly at the budget alone', () => {
    const { objects, rootObjectIds } = chain(MAX_PART_TREE_ROWS);
    const rows = flatten({ objects, rootObjectIds, plates: [] });

    // Nothing was dropped, so nothing is announced as truncated.
    expect(rows).toHaveLength(MAX_PART_TREE_ROWS);
    expect(rows.some((row) => row.kind === 'notice')).toBe(false);
  });

  it('truncates the first row past the budget', () => {
    const { objects, rootObjectIds } = chain(MAX_PART_TREE_ROWS + 1);
    const rows = flatten({ objects, rootObjectIds, plates: [] });

    expect(rows).toHaveLength(MAX_PART_TREE_ROWS + 1);
    expect(rows[rows.length - 1]).toMatchObject({ kind: 'notice' });
  });

  it('gives the truncation notice no sibling-set metadata to lie about', () => {
    const { objects, rootObjectIds } = chain(MAX_PART_TREE_ROWS + 50);
    const rows = flatten({ objects, rootObjectIds, plates: [] });

    expect(rows[rows.length - 1]).toMatchObject({
      kind: 'notice',
      level: 1,
      positionInSet: 0,
      setSize: 0,
    });
  });

  it('treats prototype-shaped object ids as ordinary data', () => {
    const rows = flatten({
      objects: [
        object('__proto__', 'Proto', { children: ['constructor'] }),
        object('constructor', 'Ctor', {
          parentId: '__proto__',
          children: ['prototype'],
        }),
        object('prototype', 'Prototype', { parentId: 'constructor' }),
      ],
      rootObjectIds: ['__proto__'],
      plates: [],
    });

    expect(rows.map((row) => row.objectId)).toEqual([
      '__proto__',
      'constructor',
      'prototype',
    ]);
    expect(rows.every((row) => !row.invalid)).toBe(true);
    expect({}).not.toHaveProperty('polluted');
  });

  it('skips diagnostic rows when walking with the keyboard', () => {
    const rows = flatten({
      objects: [
        object('body', 'Body', { children: ['leaf', 'leaf', 'tail'] }),
        object('leaf', 'Leaf', { parentId: 'body' }),
        object('tail', 'Tail', { parentId: 'body' }),
      ],
      rootObjectIds: ['body'],
      plates: [],
    });
    const leaf = rows[1];
    const tail = rows[3];
    expect(rows[2]?.invalid).toBe(true);

    expect(partTreeKeyAction('ArrowDown', rows, leaf?.key ?? '')).toEqual({
      type: 'move',
      key: tail?.key,
    });
    expect(partTreeKeyAction('End', rows, leaf?.key ?? '')).toEqual({
      type: 'move',
      key: tail?.key,
    });
  });

  it('descends past a leading diagnostic child on ArrowRight', () => {
    const rows = flatten({
      objects: [
        object('root', 'Root', { children: ['dup', 'branch'] }),
        object('dup', 'Dup', { parentId: 'root' }),
        object('branch', 'Branch', {
          parentId: 'root',
          children: ['dup', 'tail'],
        }),
        object('tail', 'Tail', { parentId: 'branch' }),
      ],
      rootObjectIds: ['root'],
      plates: [],
    });
    // Root, Dup, Branch, Dup (diagnostic — already resolved), Tail.
    const branch = rows[2];
    expect(rows[3]?.invalid).toBe(true);

    expect(partTreeKeyAction('ArrowRight', rows, branch?.key ?? '')).toEqual({
      type: 'move',
      key: rows[4]?.key,
    });
  });

  it('stays put when every child of the focused row is a diagnostic', () => {
    const rows = flatten({
      objects: [
        object('root', 'Root', { children: ['dup', 'branch'] }),
        object('dup', 'Dup', { parentId: 'root' }),
        object('branch', 'Branch', { parentId: 'root', children: ['dup'] }),
      ],
      rootObjectIds: ['root'],
      plates: [],
    });
    const branch = rows[2];
    expect(rows[3]?.invalid).toBe(true);

    expect(partTreeKeyAction('ArrowRight', rows, branch?.key ?? '')).toBeNull();
  });
});

describe('<PartTree /> single roving tab stop', () => {
  // Duplicate references legitimately warn; the warning itself is asserted in
  // the diagnostics suite above, so keep it out of this suite's output.
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it('keeps exactly one tab stop for a duplicated child reference', () => {
    renderTree({
      objects: [
        object('body', 'Body', { children: ['leaf', 'leaf'] }),
        object('leaf', 'Leaf', { parentId: 'body' }),
      ],
      rootObjectIds: ['body'],
      plates: [],
    });

    // Focus has to land on the repeat's row: when both copies shared one row
    // key, activating either lit up the tab stop on both.
    focusRow(screen.getAllByRole('treeitem')[1] as HTMLElement);

    expect(tabStops()).toHaveLength(1);
    expect(actionableItems('Leaf')).toHaveLength(1);
  });

  it('keeps exactly one tab stop for a duplicated root reference', () => {
    renderTree({
      objects: [object('leaf', 'Leaf')],
      rootObjectIds: ['leaf', 'leaf'],
      plates: [],
    });
    expect(tabStops()).toHaveLength(1);
    expect(actionableItems('Leaf')).toHaveLength(1);
  });

  it('keeps exactly one tab stop for the same object on two plates', () => {
    renderTree({
      objects: [object('body', 'Body')],
      rootObjectIds: ['body'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
        { id: 'plate-1', name: 'Plate 2', index: 1, rootObjectIds: ['body'] },
      ],
    });
    expect(tabStops()).toHaveLength(1);
    // Two live rows would give the same part two independent visibility toggles.
    expect(actionableItems('Body')).toHaveLength(1);
  });

  it('keeps exactly one tab stop for a multi-parent reference', () => {
    renderTree({
      objects: [
        object('a', 'A', { children: ['shared'] }),
        object('b', 'B', { children: ['shared'] }),
        object('shared', 'Shared'),
      ],
      rootObjectIds: ['a', 'b'],
      plates: [],
    });
    expect(tabStops()).toHaveLength(1);
    expect(actionableItems('Shared')).toHaveLength(1);
  });

  it('keeps one tab stop after arrowing across a diagnostic row', () => {
    renderTree({
      objects: [
        object('body', 'Body', { children: ['leaf', 'leaf', 'tail'] }),
        object('leaf', 'Leaf', { parentId: 'body' }),
        object('tail', 'Tail', { parentId: 'body' }),
      ],
      rootObjectIds: ['body'],
      plates: [],
    });

    const leaf = focusRow(treeitem('Leaf'));
    fireEvent.keyDown(leaf, { key: 'ArrowDown' });

    expect(tabStops()).toHaveLength(1);
    expect(treeitem('Tail')).toHaveFocus();
  });

  it('still moves focus when a row key contains selector metacharacters', () => {
    // Object ids come from untrusted files, and the key is fed straight into a
    // `[data-row-key="…"]` lookup when focus follows a keyboard move.
    renderTree({
      objects: [
        object('a"b\\c', 'Quoted', { children: ['tail'] }),
        object('tail', 'Tail', { parentId: 'a"b\\c' }),
      ],
      rootObjectIds: ['a"b\\c'],
      plates: [],
    });

    const root = focusRow(treeitem('Quoted'));
    fireEvent.keyDown(root, { key: 'ArrowDown' });

    expect(treeitem('Tail')).toHaveFocus();
    expect(tabStops()).toHaveLength(1);
  });
});

describe('<PartTree /> mouse collapse', () => {
  function twistyOf(name: string): Element {
    const twisty = treeitem(name).querySelector('.part-twisty');
    if (!twisty) throw new Error(`no twisty on "${name}"`);
    return twisty;
  }

  it('moves focus to the collapsing node when its focused child unmounts', () => {
    renderTree();
    focusRow(treeitem('Lid'));
    expect(treeitem('Lid')).toHaveFocus();

    fireEvent.click(twistyOf('Body'));

    expect(screen.queryByRole('treeitem', { name: 'Lid' })).toBeNull();
    expect(treeitem('Body')).toHaveFocus();
    expect(tabStops()).toHaveLength(1);
  });

  it('leaves focus alone when it is outside the tree', () => {
    renderTree();
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => {
      outside.focus();
    });

    fireEvent.click(twistyOf('Body'));

    expect(outside).toHaveFocus();
    outside.remove();
  });

  it('does not grab focus when expanding', () => {
    renderTree();
    fireEvent.click(twistyOf('Body'));
    const outside = document.createElement('button');
    document.body.append(outside);
    act(() => {
      outside.focus();
    });

    fireEvent.click(twistyOf('Body'));

    expect(treeitem('Lid')).toBeInTheDocument();
    expect(outside).toHaveFocus();
    outside.remove();
  });
});
