/**
 * Cost invariants for plate selection.
 *
 * These live apart from the behaviour suite because they need module mocks,
 * which are hoisted and would apply to every test in a file.
 *
 * The regression they pin: resolving effective visibility one object at a time
 * rebuilt the whole scene index per call, so selecting a plate on a
 * 5,000-object scene took over a second - and moving the call into a `useMemo`
 * lifted it above the `plates.length < 2` early return, so single-plate scenes
 * paid the same bill to render nothing.
 *
 * Both are asserted as operation counts rather than wall-clock. A timing
 * assertion states a machine-dependent proxy for the invariant and can flake on
 * a loaded runner; a call count states the invariant itself.
 */

import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SceneObject, ScenePlate } from '../src/renderer/viewer/types';

const resolveCalls = vi.fn();
const activeCalls = vi.fn();

vi.mock('../src/renderer/library/partTreeModel', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/library/partTreeModel')
    >();
  return {
    ...actual,
    effectiveHiddenObjectIds: (
      objects: readonly SceneObject[],
      hidden: ReadonlySet<string>,
    ) => {
      resolveCalls();
      return actual.effectiveHiddenObjectIds(objects, hidden);
    },
  };
});

vi.mock('../src/renderer/viewer/plateSelection', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../src/renderer/viewer/plateSelection')
    >();
  return {
    ...actual,
    activePlateId: (
      plates: readonly ScenePlate[],
      objects: readonly SceneObject[],
      hidden: ReadonlySet<string>,
    ) => {
      activeCalls();
      return actual.activePlateId(plates, objects, hidden);
    },
  };
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function object(
  id: string,
  plateId: string,
  parentId: string | null = null,
): SceneObject {
  return {
    id,
    sourceId: `${id}#source`,
    name: id,
    parentId,
    children: [],
    transform: { matrix: IDENTITY },
    mesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    },
    material: {},
    plateId,
    buildItemIndex: 0,
  };
}

/**
 * `size` objects hanging off `plateCount` roots, so resolving visibility has to
 * walk ancestors rather than reading the hidden set directly.
 */
function scene(size: number, plateCount: number): SceneObject[] {
  const objects: SceneObject[] = [];
  for (let p = 0; p < plateCount; p += 1) {
    objects.push(object(`root-${p}`, `plate-${p}`));
  }
  for (let i = 0; objects.length < size; i += 1) {
    const p = i % plateCount;
    objects.push(object(`child-${i}`, `plate-${p}`, `root-${p}`));
  }
  return objects;
}

function plates(count: number): ScenePlate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `plate-${index}`,
    name: `Plate ${index + 1}`,
    index,
    rootObjectIds: [`root-${index}`],
  }));
}

beforeEach(() => {
  resolveCalls.mockClear();
  activeCalls.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('activePlateId cost', () => {
  it('resolves visibility once for the whole scene, not once per object', async () => {
    const { activePlateId } =
      await import('../src/renderer/viewer/plateSelection');
    const objects = scene(5000, 2);

    // A small hidden set on a large scene: the state that misses both of the
    // cheap fast paths, and exactly what selecting a plate produces.
    activePlateId(plates(2), objects, new Set(['root-1']));

    expect(resolveCalls).toHaveBeenCalledTimes(1);
  });

  it('costs one pass at 50 objects and one at 5,000', async () => {
    // Test above pins a single size; this pins that the count does not grow
    // with the scene, which is the actual complexity claim.
    const { activePlateId } =
      await import('../src/renderer/viewer/plateSelection');

    activePlateId(plates(2), scene(50, 2), new Set(['root-1']));
    expect(resolveCalls).toHaveBeenCalledTimes(1);
    resolveCalls.mockClear();

    activePlateId(plates(2), scene(5000, 2), new Set(['root-1']));
    expect(resolveCalls).toHaveBeenCalledTimes(1);
  });
});

describe('<PlateSelector /> cost', () => {
  it('does no work at all for a single-plate scene', async () => {
    // The acceptance bar from the review: a single-plate 5,000-object scene
    // with a non-empty hidden set - the ordinary case, where the selector is
    // deliberately not rendered - must not compute a plate selection.
    const { PlateSelector } =
      await import('../src/renderer/viewer/PlateSelector');
    const { container } = render(
      <PlateSelector
        plates={plates(1)}
        objects={scene(5000, 1)}
        hidden={new Set(['child-0'])}
        onSelect={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(activeCalls).not.toHaveBeenCalled();
    expect(resolveCalls).not.toHaveBeenCalled();
  });

  it('does no work when the scene declares no plates', async () => {
    const { PlateSelector } =
      await import('../src/renderer/viewer/PlateSelector');
    render(
      <PlateSelector
        plates={[]}
        objects={scene(5000, 1)}
        hidden={new Set(['child-0'])}
        onSelect={vi.fn()}
      />,
    );

    expect(activeCalls).not.toHaveBeenCalled();
  });

  it('does the work once for a multi-plate scene', async () => {
    // The control: without this the previous two tests would pass against a
    // component that never computes anything.
    const { PlateSelector } =
      await import('../src/renderer/viewer/PlateSelector');
    render(
      <PlateSelector
        plates={plates(2)}
        objects={scene(500, 2)}
        hidden={new Set(['root-1'])}
        onSelect={vi.fn()}
      />,
    );

    expect(activeCalls).toHaveBeenCalledTimes(1);
    expect(resolveCalls).toHaveBeenCalledTimes(1);
  });

  it('collapses duplicate plate ids to a single option', async () => {
    // Two plates sharing an id are indistinguishable downstream, so rendering
    // both would duplicate a React key and check two radios at once.
    const { PlateSelector } =
      await import('../src/renderer/viewer/PlateSelector');
    const duplicated: ScenePlate[] = [
      { id: 'plate-0', name: 'Left', index: 0, rootObjectIds: ['root-0'] },
      { id: 'plate-0', name: 'Also left', index: 1, rootObjectIds: ['root-0'] },
      { id: 'plate-1', name: 'Right', index: 2, rootObjectIds: ['root-1'] },
    ];
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { container } = render(
      <PlateSelector
        plates={duplicated}
        objects={scene(6, 2)}
        hidden={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('input[type="radio"]')).toHaveLength(3);
    expect(warn).not.toHaveBeenCalled();
  });
});
