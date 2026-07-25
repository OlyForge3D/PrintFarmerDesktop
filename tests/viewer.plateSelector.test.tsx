import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import * as THREE from 'three';

import { PlateSelector } from '../src/renderer/viewer/PlateSelector';
import {
  ALL_PLATES,
  activePlateId,
  plateHiddenObjectIds,
} from '../src/renderer/viewer/plateSelection';
import { buildViewerSceneGraph } from '../src/renderer/viewer/sceneGraph';
import type {
  SceneMesh,
  SceneObject,
  ScenePlate,
} from '../src/renderer/viewer/types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function plate(index: number, roots: string[], name?: string): ScenePlate {
  return {
    id: `plate-${index}`,
    name: name ?? `Plate ${index + 1}`,
    index,
    rootObjectIds: roots,
  };
}

/** Two plates carrying one root each, the shape the sidecar now emits. */
function twoPlates(): ScenePlate[] {
  return [
    plate(0, ['plate-0/item-0/object-1']),
    plate(1, ['plate-1/item-1/object-1']),
  ];
}

function object(
  id: string,
  plateId: string,
  overrides: Partial<SceneObject> = {},
): SceneObject {
  return {
    id,
    sourceId: `${id}#source`,
    name: id,
    parentId: null,
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
    ...overrides,
  };
}

function twoPlateScene(): SceneMesh {
  const plates = twoPlates();
  return {
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
    indices: [0, 1, 2, 3, 4, 5],
    bounds: { min: [0, 0, 0], max: [3, 1, 0] },
    sourceFormat: 'threeMf',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [
      object(plates[0]!.rootObjectIds[0]!, 'plate-0', {
        children: ['plate-0/child'],
        material: { baseColor: [0, 1, 0] },
      }),
      object('plate-0/child', 'plate-0', {
        parentId: plates[0]!.rootObjectIds[0]!,
      }),
      object(plates[1]!.rootObjectIds[0]!, 'plate-1', {
        material: { baseColor: [1, 0, 0] },
      }),
    ],
    rootObjectIds: [plates[0]!.rootObjectIds[0]!, plates[1]!.rootObjectIds[0]!],
    plates,
  };
}

function renderSelector(
  plates: readonly ScenePlate[],
  hidden: ReadonlySet<string>,
  onSelect = vi.fn(),
): { onSelect: ReturnType<typeof vi.fn> } {
  render(<PlateSelector plates={plates} hidden={hidden} onSelect={onSelect} />);
  return { onSelect };
}

describe('plateHiddenObjectIds', () => {
  it('hides nothing for the all-plates sentinel', () => {
    expect(plateHiddenObjectIds(twoPlates(), ALL_PLATES).size).toBe(0);
  });

  it('hides only the roots of the other plates', () => {
    const hidden = plateHiddenObjectIds(twoPlates(), 'plate-1');

    expect([...hidden]).toEqual(['plate-0/item-0/object-1']);
  });

  it('hides every plate when the requested plate does not exist', () => {
    // A stale selection must not silently degrade into "show everything".
    const hidden = plateHiddenObjectIds(twoPlates(), 'plate-9');

    expect([...hidden].sort()).toEqual([
      'plate-0/item-0/object-1',
      'plate-1/item-1/object-1',
    ]);
  });

  it('does not list descendants, because visibility cascades', () => {
    const plates = [plate(0, ['root']), plate(1, ['other'])];

    expect([...plateHiddenObjectIds(plates, 'plate-0')]).toEqual(['other']);
  });
});

describe('activePlateId', () => {
  it('reports all plates when nothing is hidden', () => {
    expect(activePlateId(twoPlates(), new Set())).toBe(ALL_PLATES);
  });

  it('reports the one plate left visible', () => {
    const plates = twoPlates();

    expect(activePlateId(plates, new Set(['plate-0/item-0/object-1']))).toBe(
      'plate-1',
    );
  });

  it('round-trips every plate through the hidden set', () => {
    const plates = [
      plate(0, ['a1', 'a2']),
      plate(1, ['b1']),
      plate(2, ['c1', 'c2']),
    ];

    for (const entry of plates) {
      expect(
        activePlateId(plates, plateHiddenObjectIds(plates, entry.id)),
      ).toBe(entry.id);
    }
  });

  it('reports no plate when one is partially hidden', () => {
    const plates = [plate(0, ['a1', 'a2']), plate(1, ['b1'])];

    // 'a2' still visible, so "plate 1 only" is not an honest description.
    expect(activePlateId(plates, new Set(['a1', 'b1']))).toBeNull();
  });

  it('reports no plate when several plates are visible alongside a hidden one', () => {
    const plates = [plate(0, ['a1']), plate(1, ['b1']), plate(2, ['c1'])];

    expect(activePlateId(plates, new Set(['c1']))).toBeNull();
  });

  it('reports no plate when everything is hidden', () => {
    const plates = twoPlates();

    expect(
      activePlateId(
        plates,
        new Set(plates.flatMap((entry) => entry.rootObjectIds)),
      ),
    ).toBeNull();
  });

  it('ignores plates that carry no geometry', () => {
    const plates = [plate(0, []), plate(1, ['b1']), plate(2, ['c1'])];

    // The empty plate cannot be hidden, so it must not block the answer.
    expect(activePlateId(plates, new Set(['c1']))).toBe('plate-1');
  });

  it('reports all plates when no plate carries geometry', () => {
    expect(activePlateId([plate(0, []), plate(1, [])], new Set())).toBe(
      ALL_PLATES,
    );
  });

  it('reports all plates when there are no plates at all', () => {
    expect(activePlateId([], new Set())).toBe(ALL_PLATES);
  });
});

describe('<PlateSelector />', () => {
  it('renders nothing for a single-plate scene', () => {
    const { container } = render(
      <PlateSelector
        plates={[plate(0, ['a1'])]}
        hidden={new Set()}
        onSelect={vi.fn()}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the scene has no plates', () => {
    const { container } = render(
      <PlateSelector plates={[]} hidden={new Set()} onSelect={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('offers an all-plates option plus every plate by name', () => {
    renderSelector(
      [plate(0, ['a1'], 'Left'), plate(1, ['b1'], 'Right')],
      new Set(),
    );

    expect(
      screen.getAllByRole('radio').map((radio) => radio.getAttribute('value')),
    ).toEqual([ALL_PLATES, 'plate-0', 'plate-1']);
    expect(screen.getByRole('radio', { name: 'All plates' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Left' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Right' })).not.toBeChecked();
  });

  it('checks the plate implied by the hidden set', () => {
    const plates = twoPlates();
    renderSelector(plates, new Set(['plate-0/item-0/object-1']));

    expect(screen.getByRole('radio', { name: 'Plate 2' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'All plates' })).not.toBeChecked();
  });

  it('reports the selected plate id when a plate is chosen', () => {
    const { onSelect } = renderSelector(twoPlates(), new Set());

    fireEvent.click(screen.getByRole('radio', { name: 'Plate 2' }));

    expect(onSelect).toHaveBeenCalledWith('plate-1');
  });

  it('reports the sentinel when all plates are chosen', () => {
    const { onSelect } = renderSelector(
      twoPlates(),
      new Set(['plate-0/item-0/object-1']),
    );

    fireEvent.click(screen.getByRole('radio', { name: 'All plates' }));

    expect(onSelect).toHaveBeenCalledWith(ALL_PLATES);
  });

  it('shows a custom state rather than a wrong plate', () => {
    const plates = [plate(0, ['a1', 'a2']), plate(1, ['b1'])];
    renderSelector(plates, new Set(['a1', 'b1']));

    expect(
      screen
        .getAllByRole('radio')
        .every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);
    expect(screen.getByRole('status')).toHaveTextContent('Custom visibility');
  });

  it('hides the custom state once a plate is fully selected', () => {
    renderSelector(twoPlates(), new Set(['plate-0/item-0/object-1']));

    expect(screen.queryByRole('status')).toBeNull();
  });

  it('puts every radio in one group so arrow keys stay inside it', () => {
    renderSelector(twoPlates(), new Set());
    const group = screen.getByRole('group', { name: 'Plate' });
    const names = within(group)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('name'));

    expect(new Set(names).size).toBe(1);
    expect(names[0]).toBeTruthy();
  });

  it('keeps groups distinct across two mounted selectors', () => {
    const plates = twoPlates();
    render(
      <>
        <PlateSelector plates={plates} hidden={new Set()} onSelect={vi.fn()} />
        <PlateSelector plates={plates} hidden={new Set()} onSelect={vi.fn()} />
      </>,
    );
    const groups = screen.getAllByRole('group', { name: 'Plate' });
    const [first] = within(groups[0]!)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('name'));
    const [second] = within(groups[1]!)
      .getAllByRole('radio')
      .map((radio) => radio.getAttribute('name'));

    expect(first).not.toBe(second);
  });
});

describe('plate visibility in the scene graph', () => {
  it('hides the whole subtree of an inactive plate', () => {
    const scene = twoPlateScene();
    const graph = buildViewerSceneGraph(
      scene,
      plateHiddenObjectIds(scene.plates, 'plate-1'),
    );

    const visible = new Map<string, boolean>();
    graph.root.traverse((node) => {
      if (node instanceof THREE.Group && node.name) {
        visible.set(node.name, node.visible);
      }
    });

    expect(visible.get('plate-0/item-0/object-1')).toBe(false);
    expect(visible.get('plate-0/child')).toBe(false);
    expect(visible.get('plate-1/item-1/object-1')).toBe(true);
    graph.dispose();
  });

  it('preserves materials and their colors across a plate switch', () => {
    const scene = twoPlateScene();
    const graph = buildViewerSceneGraph(scene, new Set());

    const materialsOf = (): THREE.Material[] => {
      const found: THREE.Material[] = [];
      graph.root.traverse((node) => {
        if (node instanceof THREE.Mesh)
          found.push(node.material as THREE.Material);
      });
      return found;
    };
    const colorsOf = (): number[] =>
      materialsOf().map((material) =>
        'color' in material
          ? (material as THREE.MeshStandardMaterial).color.getHex()
          : -1,
      );
    const before = materialsOf();
    const beforeColors = colorsOf();
    // The fixture uses distinct per-object colors, so a rebuild that reset them
    // to a shared default would be visible here.
    expect(new Set(beforeColors).size).toBeGreaterThan(1);

    graph.setHidden(plateHiddenObjectIds(scene.plates, 'plate-1'));
    graph.setHidden(plateHiddenObjectIds(scene.plates, 'plate-0'));
    graph.setHidden(new Set());

    // Switching plates only toggles `visible`, so the exact same material and
    // geometry instances survive - colors cannot be lost to a rebuild.
    const after = materialsOf();
    expect(after).toHaveLength(before.length);
    for (const [index, material] of after.entries()) {
      expect(material).toBe(before[index]);
    }
    expect(colorsOf()).toEqual(beforeColors);
    graph.dispose();
  });
});
