import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { buildViewerSceneGraph } from '../src/renderer/viewer/sceneGraph';
import type { SceneMesh, SceneObject } from '../src/renderer/viewer/types';

function multiObjectScene(): SceneMesh {
  return {
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 2, 0, 0, 3, 0, 0, 2, 1, 0],
    indices: [0, 1, 2, 3, 4, 5],
    bounds: { min: [0, 0, 0], max: [3, 1, 0] },
    sourceFormat: 'threeMf',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [
      { name: 'Body', triangleStart: 0, triangleCount: 1 },
      { name: 'Lid', triangleStart: 1, triangleCount: 1 },
    ],
    objects: [
      {
        id: 'root',
        sourceId: '3d/3dmodel.model#object-1',
        name: 'Assembly',
        parentId: null,
        children: ['body', 'lid'],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: null,
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
      {
        id: 'body',
        sourceId: '3d/3dmodel.model#object-2',
        name: 'Body',
        parentId: 'root',
        children: [],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        },
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
      {
        id: 'lid',
        sourceId: '3d/3dmodel.model#object-3',
        name: 'Lid',
        parentId: 'root',
        children: [],
        transform: {
          matrix: [1, 0, 0, 2, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        },
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
    ],
    rootObjectIds: ['root'],
    plates: [
      { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['root'] },
    ],
  };
}

function matrixFromThreeMfTransform(values: readonly number[]): number[] {
  return [
    values[0] ?? 1,
    values[3] ?? 0,
    values[6] ?? 0,
    values[9] ?? 0,
    values[1] ?? 0,
    values[4] ?? 1,
    values[7] ?? 0,
    values[10] ?? 0,
    values[2] ?? 0,
    values[5] ?? 0,
    values[8] ?? 1,
    values[11] ?? 0,
    0,
    0,
    0,
    1,
  ];
}

describe('buildViewerSceneGraph', () => {
  it('builds a nested plate/object hierarchy and respects hidden ancestors', () => {
    const graph = buildViewerSceneGraph(multiObjectScene(), new Set(['root']));
    const plateGroup = graph.root.children[0];
    expect(plateGroup).toBeInstanceOf(THREE.Group);
    const rootNode = plateGroup?.children[0];
    expect(rootNode?.visible).toBe(false);

    graph.setHidden(new Set(['lid']));
    expect(rootNode?.visible).toBe(true);
    expect(rootNode?.children[1]?.visible).toBe(false);
  });

  it('disposes every geometry and material on teardown', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(
      THREE.MeshStandardMaterial.prototype,
      'dispose',
    );

    const graph = buildViewerSceneGraph(multiObjectScene());
    graph.dispose();

    expect(geometryDispose).toHaveBeenCalledTimes(2);
    expect(materialDispose).toHaveBeenCalledTimes(2);

    geometryDispose.mockRestore();
    materialDispose.mockRestore();
  });

  it('applies DTO matrices with translated and rotated child world transforms', () => {
    const scene: SceneMesh = {
      sceneVersion: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: null,
      status: 'complete',
      statusMessages: [],
      parts: [{ name: 'Body', triangleStart: 0, triangleCount: 1 }],
      objects: [
        {
          id: 'root',
          sourceId: '3d/3dmodel.model#object-1',
          name: 'Assembly',
          parentId: null,
          children: ['child'],
          transform: {
            matrix: matrixFromThreeMfTransform([
              1, 0, 0, 0, 1, 0, 0, 0, 1, 10, 0, 0,
            ]),
          },
          mesh: null,
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
        {
          id: 'child',
          sourceId: '3d/3dmodel.model#object-2',
          name: 'Body',
          parentId: 'root',
          children: [],
          transform: {
            matrix: matrixFromThreeMfTransform([
              0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 5, 0,
            ]),
          },
          mesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            bounds: { min: [0, 0, 0], max: [1, 1, 0] },
          },
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
      ],
      rootObjectIds: ['root'],
      plates: [
        { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['root'] },
      ],
    };

    const graph = buildViewerSceneGraph(scene);
    graph.root.updateMatrixWorld(true);
    const plateGroup = graph.root.children[0];
    const rootNode = plateGroup?.children[0] as THREE.Group;
    const childNode = rootNode.children[0] as THREE.Group;

    expect(childNode.getWorldPosition(new THREE.Vector3()).toArray()).toEqual([
      10, 5, 0,
    ]);
    expect(
      new THREE.Vector3(1, 0, 0).applyMatrix4(childNode.matrixWorld).toArray(),
    ).toEqual([10, 6, 0]);
  });

  it('parents root objects directly under the scene root when plates are absent', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(
      THREE.MeshStandardMaterial.prototype,
      'dispose',
    );
    const scene: SceneMesh = {
      sceneVersion: 2,
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: null,
      status: 'complete',
      statusMessages: [],
      parts: [],
      objects: [
        {
          id: 'root',
          sourceId: '3d/3dmodel.model#object-1',
          name: 'Legacy root',
          parentId: null,
          children: [],
          transform: {
            matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          },
          mesh: {
            positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
            indices: [0, 1, 2],
            bounds: { min: [0, 0, 0], max: [1, 1, 0] },
          },
          material: {},
          plateId: 'plate-0',
          buildItemIndex: 0,
        },
      ],
      rootObjectIds: ['root'],
      plates: [],
    };

    const graph = buildViewerSceneGraph(scene);
    expect(graph.root.children).toHaveLength(1);
    expect(graph.root.children[0]?.name).toBe('Legacy root');

    graph.dispose();
    expect(graph.root.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);

    geometryDispose.mockRestore();
    materialDispose.mockRestore();
  });
});

describe('buildViewerSceneGraph level of detail', () => {
  it('leaves a small scene at full detail', () => {
    const graph = buildViewerSceneGraph(multiObjectScene());

    expect(graph.lodObjectIds.size).toBe(0);
    expect(findLods(graph.root)).toHaveLength(0);
    graph.dispose();
  });

  it('gives a heavy object a reduced-detail level', () => {
    const scene = heavyScene();
    const graph = buildViewerSceneGraph(scene);
    const lods = findLods(graph.root);

    expect([...graph.lodObjectIds]).toEqual(['dense']);
    expect(lods).toHaveLength(1);
    expect(lods[0]!.levels).toHaveLength(2);
    // The full-detail level has to be the one active at the camera, or the
    // viewer would show the proxy even when the part is being inspected.
    expect(lods[0]!.levels[0]!.distance).toBe(0);
    expect(lods[0]!.levels[1]!.distance).toBeGreaterThan(0);
    graph.dispose();
  });

  it('makes the far level cheaper than the near one', () => {
    const graph = buildViewerSceneGraph(heavyScene());
    const [near, far] = findLods(graph.root)[0]!.levels;
    const trianglesOf = (level: THREE.Object3D): number => {
      const mesh = level as THREE.Mesh;
      return (mesh.geometry.getIndex()?.count ?? 0) / 3;
    };

    expect(trianglesOf(far!.object)).toBeGreaterThan(0);
    expect(trianglesOf(far!.object)).toBeLessThan(trianglesOf(near!.object));
    graph.dispose();
  });

  it('shares one material across both levels', () => {
    // A second material would make a wireframe or colour change apply to only
    // one level, so the object would visibly change as it crossed the switch.
    const graph = buildViewerSceneGraph(heavyScene());
    const [near, far] = findLods(graph.root)[0]!.levels;

    expect((far!.object as THREE.Mesh).material).toBe(
      (near!.object as THREE.Mesh).material,
    );
    graph.dispose();
  });

  it('disposes the proxy geometry too', () => {
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(
      THREE.MeshStandardMaterial.prototype,
      'dispose',
    );
    const graph = buildViewerSceneGraph(heavyScene());

    graph.dispose();

    // Three geometries - the dense object's own, its proxy, and the small
    // object's - but only two materials, because the proxy shares the dense
    // object's. Disposing that twice would tear down a material still in use.
    expect(geometryDispose).toHaveBeenCalledTimes(3);
    expect(materialDispose).toHaveBeenCalledTimes(2);
    geometryDispose.mockRestore();
    materialDispose.mockRestore();
  });

  it('still hides an object through its LOD wrapper', () => {
    const graph = buildViewerSceneGraph(heavyScene(), new Set(['dense']));
    const node = graph.root.getObjectByName('Dense');

    expect(node?.visible).toBe(false);
    graph.setHidden(new Set());
    expect(graph.root.getObjectByName('Dense')?.visible).toBe(true);
    graph.dispose();
  });

  it('keeps a per-face-coloured object at full detail', () => {
    // Clustering welds vertices, which destroys the triangle-per-vertex layout
    // the colour attribute depends on; the shared material would then demand a
    // colour buffer the proxy cannot supply and draw black. Per-face colours
    // only take effect on an unindexed soup mesh, so the fixture has to be one.
    const scene = heavyScene();
    const soup = denseSoup(300);
    const withSoup = (material: SceneObject['material']): SceneMesh => ({
      ...scene,
      objects: scene.objects.map((object) =>
        object.id === 'dense' ? { ...object, mesh: soup, material } : object,
      ),
    });

    // Control: the identical mesh without colours is big enough to qualify, so
    // a plain-grey soup really does get a proxy.
    const plain = buildViewerSceneGraph(withSoup({}));
    expect([...plain.lodObjectIds]).toEqual(['dense']);
    plain.dispose();

    const painted = buildViewerSceneGraph(
      withSoup({
        faceColors: Array.from({ length: soup.indices.length }, () => 128),
      }),
    );
    const dense = painted.root.getObjectByName('Dense:mesh') as THREE.Mesh;

    // The guard has to be reached: the colour attribute really is present.
    expect(dense.geometry.getAttribute('color')).toBeDefined();
    expect(painted.lodObjectIds.size).toBe(0);
    painted.dispose();
  });
});

function findLods(root: THREE.Object3D): THREE.LOD[] {
  const found: THREE.LOD[] = [];
  root.traverse((node) => {
    if (node instanceof THREE.LOD) found.push(node as THREE.LOD);
  });
  return found;
}

/**
 * A scene above both LOD thresholds: one dense object worth simplifying plus a
 * small one that must be left alone.
 */
function heavyScene(): SceneMesh {
  const dense = denseGrid(420);
  const small = {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0] as const, max: [1, 1, 0] as const },
  };
  return {
    sceneVersion: 2,
    positions: [],
    indices: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sourceFormat: 'threeMf',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [
      {
        id: 'dense',
        sourceId: 'dense#source',
        name: 'Dense',
        parentId: null,
        children: [],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: dense,
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
      {
        id: 'small',
        sourceId: 'small#source',
        name: 'Small',
        parentId: null,
        children: [],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: small,
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
    ],
    rootObjectIds: ['dense', 'small'],
    plates: [],
  };
}

function denseGrid(steps: number): {
  positions: number[];
  indices: number[];
  bounds: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  };
} {
  const positions: number[] = [];
  const indices: number[] = [];
  const step = 1 / steps;
  for (let y = 0; y <= steps; y += 1) {
    for (let x = 0; x <= steps; x += 1) {
      positions.push(x * step, y * step, Math.sin(x + y) * step);
    }
  }
  const stride = steps + 1;
  for (let y = 0; y < steps; y += 1) {
    for (let x = 0; x < steps; x += 1) {
      const a = y * stride + x;
      indices.push(a, a + 1, a + stride, a + 1, a + stride + 1, a + stride);
    }
  }
  return {
    positions,
    indices,
    bounds: { min: [0, 0, -step], max: [1, 1, step] },
  };
}

/**
 * The same grid as an unindexed triangle soup, the layout STL produces and the
 * only one for which per-face colours are applied.
 */
function denseSoup(steps: number): {
  positions: number[];
  indices: number[];
  bounds: {
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  };
} {
  const grid = denseGrid(steps);
  const positions: number[] = [];
  for (const index of grid.indices) {
    positions.push(
      grid.positions[index * 3] ?? 0,
      grid.positions[index * 3 + 1] ?? 0,
      grid.positions[index * 3 + 2] ?? 0,
    );
  }
  return {
    positions,
    indices: grid.indices.map((_, i) => i),
    bounds: grid.bounds,
  };
}
