import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import { buildViewerSceneGraph } from '../src/renderer/viewer/sceneGraph';
import {
  summarizeSceneMaterials,
  toHex,
} from '../src/renderer/library/sceneMaterials';
import {
  LOD_MIN_TRIANGLES,
  simplifyMesh,
  triangleCount,
} from '../src/renderer/viewer/lod';
import {
  boundsCenter,
  boundsRadius,
  defaultCameraPosition,
} from '../src/renderer/viewer/geometry';
import {
  ORTHO_FRUSTUM_MULTIPLIER,
  PERSPECTIVE_FOV,
} from '../src/renderer/viewer/ModelViewer';
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

  it('paints unauthored objects the colour the materials panel advertises', () => {
    // Deliberately names no literal. The panel's fallback swatch and the pixels
    // the viewer actually draws are two ends of one claim, and asserting either
    // against a constant only proves that end agrees with itself: a viewer
    // holding its own copy of the grey would pass while showing the user a
    // colour the model is not drawn in.
    const scene = multiObjectScene(); // every object here has `material: {}`
    const graph = buildViewerSceneGraph(scene);
    const painted: string[] = [];
    graph.root.traverse((node) => {
      if (!(node instanceof THREE.Mesh)) return;
      const { color } = node.material as THREE.MeshStandardMaterial;
      painted.push(toHex([color.r * 255, color.g * 255, color.b * 255]));
    });

    const fallback = summarizeSceneMaterials(scene).groups.find(
      (group) => group.isDefault,
    );

    expect(painted.length).toBeGreaterThan(0);
    expect(fallback).toBeDefined();
    expect(new Set(painted)).toEqual(new Set([fallback!.hex]));
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

    // Both objects are compressible; only one is over the floor. Asserting the
    // counts here is what stops this passing for the wrong reason again.
    const small = scene.objects.find((entry) => entry.id === 'small')!;
    expect(triangleCount(small.mesh!)).toBeLessThan(LOD_MIN_TRIANGLES);
    expect(simplifyMesh(small.mesh!)).not.toBeNull();

    expect([...graph.lodObjectIds]).toEqual(['dense']);
    expect(lods).toHaveLength(1);
    expect(lods[0]!.levels).toHaveLength(2);
    // Level order is what `updateLod` indexes into: 0 is full detail, 1 is the
    // proxy. three.js's own distance-based selection is switched off, because
    // distance does not describe apparent size under an orthographic camera.
    expect(lods[0]!.autoUpdate).toBe(false);
    expect(lods[0]!.levels[0]!.distance).toBeLessThan(
      lods[0]!.levels[1]!.distance,
    );
    graph.dispose();
  });

  it('starts with the proxy hidden so the first frame is not drawn twice', () => {
    // addLevel does not touch visibility and meshes default to visible, so
    // without an explicit hide both levels would render on top of each other
    // until the first updateLod call.
    const graph = buildViewerSceneGraph(heavyScene());
    const [near, far] = findLods(graph.root)[0]!.levels;

    expect(near!.object.visible).toBe(true);
    expect(far!.object.visible).toBe(false);
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

/**
 * Reproduce exactly how `ModelViewer` frames a scene, so these tests fail if
 * either the framing or the LOD policy moves out from under the other. The
 * first version of the policy used a fixed multiple of the object radius that
 * happened to sit inside the default framing distance, so the proxy was showing
 * the instant a model loaded and every shape-only assertion still passed.
 */
function framedCamera(
  projection: 'perspective' | 'orthographic',
  mesh: SceneMesh,
  aspect = 16 / 9,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const center = boundsCenter(mesh.bounds);
  const radius = Math.max(boundsRadius(mesh.bounds), 0.001);
  const far = radius * 100 + 1000;
  const camera =
    projection === 'perspective'
      ? new THREE.PerspectiveCamera(PERSPECTIVE_FOV, aspect, 0.01, far)
      : new THREE.OrthographicCamera(
          -radius * ORTHO_FRUSTUM_MULTIPLIER * aspect,
          radius * ORTHO_FRUSTUM_MULTIPLIER * aspect,
          radius * ORTHO_FRUSTUM_MULTIPLIER,
          -radius * ORTHO_FRUSTUM_MULTIPLIER,
          0.01,
          far,
        );
  const [x, y, z] = defaultCameraPosition(center, radius, aspect, projection);
  camera.position.set(x, y, z);
  camera.lookAt(center[0], center[1], center[2]);
  camera.updateMatrixWorld(true);
  return camera;
}

describe('ViewerSceneGraph.updateLod', () => {
  for (const projection of ['perspective', 'orthographic'] as const) {
    it(`shows full detail at the default ${projection} framing`, () => {
      // The regression this whole mechanism exists for: at the view the user is
      // handed on load, the real mesh must be what they see.
      const scene = heavyScene();
      const graph = buildViewerSceneGraph(scene);
      const camera = framedCamera(projection, scene);

      graph.updateLod(camera);
      const [near, far] = findLods(graph.root)[0]!.levels;

      expect(near!.object.visible).toBe(true);
      expect(far!.object.visible).toBe(false);
      graph.dispose();
    });
  }

  it('swaps in the proxy once a perspective camera is far enough out', () => {
    const scene = heavyScene();
    const graph = buildViewerSceneGraph(scene);
    const camera = framedCamera('perspective', scene);
    const center = boundsCenter(scene.bounds);

    // Pull straight back along the view ray, the way dollying out does.
    const offset = camera.position.clone().sub(new THREE.Vector3(...center));
    camera.position
      .copy(new THREE.Vector3(...center))
      .add(offset.setLength(30));
    camera.updateMatrixWorld(true);

    graph.updateLod(camera);
    const [near, far] = findLods(graph.root)[0]!.levels;

    expect(near!.object.visible).toBe(false);
    expect(far!.object.visible).toBe(true);
    graph.dispose();
  });

  it('swaps in the proxy on orthographic zoom alone, without the camera moving', () => {
    // Under an orthographic projection the camera never moves - `dollyCamera`
    // only changes zoom - so a rule keyed on camera distance could not react to
    // the user zooming out at all.
    const scene = heavyScene();
    const graph = buildViewerSceneGraph(scene);
    const camera = framedCamera('orthographic', scene);
    const before = camera.position.clone();

    camera.zoom = 0.05;
    camera.updateProjectionMatrix();

    graph.updateLod(camera);
    const [near, far] = findLods(graph.root)[0]!.levels;

    expect(camera.position.equals(before)).toBe(true);
    expect(near!.object.visible).toBe(false);
    expect(far!.object.visible).toBe(true);
    graph.dispose();
  });

  it('returns to full detail when the camera comes back', () => {
    const scene = heavyScene();
    const graph = buildViewerSceneGraph(scene);
    const camera = framedCamera('orthographic', scene);
    const [near, far] = findLods(graph.root)[0]!.levels;

    camera.zoom = 0.05;
    camera.updateProjectionMatrix();
    graph.updateLod(camera);
    expect(far!.object.visible).toBe(true);

    camera.zoom = 1;
    camera.updateProjectionMatrix();
    graph.updateLod(camera);

    expect(near!.object.visible).toBe(true);
    expect(far!.object.visible).toBe(false);
    graph.dispose();
  });

  it('sizes an object by its scaled world radius, not its local one', () => {
    // A build transform can scale an object, and a scaled-up object stays
    // legible on screen for longer than its local bounds suggest.
    const scene = heavyScene();
    const scaled: SceneMesh = {
      ...scene,
      objects: scene.objects.map((object) =>
        object.id === 'dense'
          ? {
              ...object,
              transform: {
                matrix: [20, 0, 0, 0, 0, 20, 0, 0, 0, 0, 20, 0, 0, 0, 0, 1],
              },
            }
          : object,
      ),
    };
    const camera = framedCamera('perspective', scene);
    const center = boundsCenter(scene.bounds);
    const offset = camera.position.clone().sub(new THREE.Vector3(...center));
    camera.position
      .copy(new THREE.Vector3(...center))
      .add(offset.setLength(30));
    camera.updateMatrixWorld(true);

    // Control: unscaled, this distance selects the proxy.
    const plain = buildViewerSceneGraph(scene);
    plain.updateLod(camera);
    expect(findLods(plain.root)[0]!.levels[1]!.object.visible).toBe(true);
    plain.dispose();

    const graph = buildViewerSceneGraph(scaled);
    graph.updateLod(camera);
    const [near, far] = findLods(graph.root)[0]!.levels;

    expect(near!.object.visible).toBe(true);
    expect(far!.object.visible).toBe(false);
    graph.dispose();
  });

  it('keeps hiding an object while its proxy is the active level', () => {
    // Visibility, selection and plate switching are all built on per-object
    // identity, and inserting an LOD node changes the shape of the graph those
    // features walk. The proxy-active case needs its own coverage.
    const scene = heavyScene();
    const graph = buildViewerSceneGraph(scene);
    const camera = framedCamera('orthographic', scene);
    camera.zoom = 0.05;
    camera.updateProjectionMatrix();
    graph.updateLod(camera);

    const node = graph.root.getObjectByName('Dense')!;
    expect(findLods(graph.root)[0]!.levels[1]!.object.visible).toBe(true);
    expect(node.visible).toBe(true);

    graph.setHidden(new Set(['dense']));
    graph.updateLod(camera);

    expect(node.visible).toBe(false);
    // The level choice is independent of hiding: re-showing must not strand the
    // object on whichever level was current when it was hidden.
    graph.setHidden(new Set());
    expect(node.visible).toBe(true);
    graph.dispose();
  });

  it('does nothing on a scene with no proxies', () => {
    const graph = buildViewerSceneGraph(multiObjectScene());

    expect(() =>
      graph.updateLod(framedCamera('perspective', multiObjectScene())),
    ).not.toThrow();
    graph.dispose();
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
  // Deliberately compressible and deliberately under the object floor: 7,200
  // triangles over a 61x61 grid welds heavily at 48 cells, so `simplifyMesh`
  // would happily return a cheaper mesh for it. A one-triangle control made the
  // `['dense']` assertion below pass because clustering had nothing to gain,
  // which held whether or not the floor was enforced - and it was not.
  const small = denseGrid(60);
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
