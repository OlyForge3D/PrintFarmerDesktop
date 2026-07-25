import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PartTree } from '../src/renderer/library/PartTree.js';
import {
  ancestorObjectIds,
  flattenPartTree,
  isObjectHidden,
  isolateHiddenObjectIds,
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
