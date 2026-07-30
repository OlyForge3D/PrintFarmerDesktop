import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

import {
  buildViewerSceneGraph,
  lodCameraOf,
} from '../src/renderer/viewer/sceneGraph';
import {
  summarizeSceneMaterials,
  toHex,
} from '../src/renderer/library/sceneMaterials';
import {
  LOD_MIN_TRIANGLES,
  LOD_SWITCH_SCREEN_FRACTION,
  apparentRadiusFraction,
  boundsRadius as meshBoundsRadius,
  simplifyMesh,
  triangleCount,
} from '../src/renderer/viewer/lod';
import {
  boundsCenter,
  boundsRadius,
  defaultCameraPosition,
  fitPerspectiveDistance,
} from '../src/renderer/viewer/geometry';
import {
  ORTHO_FRUSTUM_MULTIPLIER,
  PERSPECTIVE_FOV,
  applyOrthoFrustum,
  createCamera,
  frameCamera,
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

  it('builds a bounded proxy for a representative 500k-triangle workload', () => {
    const scene = heavyScene(500);
    const dense = scene.objects.find((entry) => entry.id === 'dense')!;
    expect(triangleCount(dense.mesh!)).toBe(500_000);

    const startedAt = Date.now();
    const graph = buildViewerSceneGraph(scene);
    const elapsedMs = Date.now() - startedAt;
    try {
      expect([...graph.lodObjectIds]).toEqual(['dense']);
      const [lod] = findLods(graph.root);
      expect(lod?.levels).toHaveLength(2);
      const near = lod!.levels[0]!.object as THREE.Mesh;
      const far = lod!.levels[1]!.object as THREE.Mesh;
      const nearTriangles = (near.geometry.getIndex()?.count ?? 0) / 3;
      const farTriangles = (far.geometry.getIndex()?.count ?? 0) / 3;
      expect(nearTriangles).toBe(500_000);
      expect(farTriangles).toBeGreaterThan(0);
      expect(farTriangles).toBeLessThan(nearTriangles);
      expect(elapsedMs).toBeLessThan(10_000);
    } finally {
      graph.dispose();
    }
  }, 20_000);

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
 * Every number this helper feeds into a camera, checked for finiteness first.
 *
 * A named import that does not resolve is `undefined` here rather than a load
 * error, and `undefined` arithmetic yields `NaN` frustum bounds.
 * `apparentRadiusFraction` deliberately reports a non-finite frustum as
 * "fills the view" so an unusable camera keeps full detail - which means the
 * tests that assert full detail pass identically for a camera that has no
 * framing at all. When the exports were briefly missing, 18 of these 21 tests
 * stayed green that way. Failing loudly here is what stops a broken harness
 * reading as a passing one.
 */
function framingInput(label: string, value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `framedCamera: ${label} is ${String(value)}, not a finite number. ` +
        'A framing constant is missing or unresolvable, and the cameras built ' +
        'from it would silently keep full detail rather than fail.',
    );
  }
  return value;
}

/**
 * Frame a scene the way `ModelViewer` frames it - by calling the same two
 * functions the viewer calls, rather than restating what they do.
 *
 * This helper used to *reproduce* production framing: it constructed the
 * cameras itself from `PERSPECTIVE_FOV` and `ORTHO_FRUSTUM_MULTIPLIER`. That
 * pinned the two constants perfectly while leaving `applyOrthoFrustum` and
 * `frameCamera` - the functions that actually consume them - completely
 * unpinned. Both of these passed the entire 661-test suite:
 *
 *   ModelViewer.applyOrthoFrustum: `radius * ORTHO_FRUSTUM_MULTIPLIER` -> `* 3`
 *   ModelViewer.frameCamera:       the FOV it frames with            -> `* 2`
 *
 * A helper that agrees with production by construction cannot notice
 * production changing. Delegating is what turns these tests into a measurement
 * of the viewer instead of a measurement of a copy of the viewer.
 *
 * `verticalFovDeg` is deliberately optional with no default. Omitted, the lens
 * is whatever `createCamera` chose, so `expect(camera.fov).toBe(PERSPECTIVE_FOV)`
 * observes production's choice instead of restating this helper's own default
 * back to itself. Passed, it overrides the lens so a test can frame with a FOV
 * production never uses.
 */
function framedCamera(
  projection: 'perspective' | 'orthographic',
  mesh: SceneMesh,
  aspect = 16 / 9,
  verticalFovDeg?: number,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  // Unconditional, and on the imports themselves rather than on whatever the
  // caller happened to pass: an unresolvable named import is `undefined`, and
  // every camera built from it frames to `NaN`, which `apparentRadiusFraction`
  // reports as "fills the view" and 18 of 21 tests read as a pass.
  framingInput('PERSPECTIVE_FOV', PERSPECTIVE_FOV);
  framingInput('ORTHO_FRUSTUM_MULTIPLIER', ORTHO_FRUSTUM_MULTIPLIER);

  const center = boundsCenter(mesh.bounds);
  const radius = Math.max(boundsRadius(mesh.bounds), 0.001);

  const camera = createCamera(projection, aspect, radius);
  if (verticalFovDeg !== undefined) {
    if (!(camera instanceof THREE.PerspectiveCamera)) {
      throw new Error('framedCamera: only a perspective camera has a FOV');
    }
    camera.fov = framingInput('verticalFovDeg', verticalFovDeg);
  }
  camera.updateProjectionMatrix();
  frameCamera(camera, center, radius, aspect);
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

/**
 * Half the frustum height in world units at the model's centre - the quantity
 * `apparentRadiusFraction` divides an object's radius by, and therefore the one
 * common currency in which the two projections' framings can be compared.
 */
function framedHalfHeight(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  center: readonly [number, number, number],
): number {
  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  if (camera instanceof THREE.OrthographicCamera) {
    return Math.abs(camera.top - camera.bottom) / 2 / zoom;
  }
  const distance = camera.position.distanceTo(new THREE.Vector3(...center));
  return (distance * Math.tan((camera.fov * Math.PI) / 360)) / zoom;
}

/**
 * What the default framing constants are allowed to be, rather than what they
 * happen to be.
 *
 * The behavioural LOD tests above leave `ORTHO_FRUSTUM_MULTIPLIER` a very wide
 * berth: measured by bisection, anything in `(0.272167, 5.443341]` - a 20x
 * window - keeps the whole suite green, because the switch fires only once the
 * model has shrunk past 15% of the viewport half-height. Both cliffs are
 * artefacts of the fixture's radii, not statements about the constant.
 *
 * These pin the constant against limits that are *derived* rather than chosen,
 * so they admit every value that frames the model correctly and reject the
 * drift. Deliberately not `=== 1.2`: the multiplier is free to move with the
 * framing policy, and pinning the literal would over-constrain it the same way
 * pinning `PERSPECTIVE_FOV` would (see #86).
 */
describe('default framing bounds', () => {
  const aspect = 16 / 9;

  it('frames at the distance the exported FOV implies, not a duplicated literal', () => {
    const scene = heavyScene();
    const center = boundsCenter(scene.bounds);
    const radius = Math.max(boundsRadius(scene.bounds), 0.001);
    const camera = framedCamera(
      'perspective',
      scene,
      aspect,
    ) as THREE.PerspectiveCamera;

    // Not a tautology any more: this helper no longer chooses the lens. The
    // camera comes back from production `createCamera`, so this asserts what
    // *the viewer* builds a perspective camera with. It used to restate the
    // helper's own `verticalFovDeg = PERSPECTIVE_FOV` default back to itself,
    // which is true for any value the constant could possibly hold.
    expect(camera.fov).toBe(PERSPECTIVE_FOV);
    // Delegation, not magnitude: the absolute value of `fitPerspectiveDistance`
    // is pinned by hand in `viewer.geometry.test.ts`. What this catches is the
    // framing being computed from some *other* FOV than the lens it was built
    // with - which is what happened while the 5th argument was left off the
    // `defaultCameraPosition` call and it fell back to its own hardcoded 45.
    expect(camera.position.x - center[0]).toBeCloseTo(
      fitPerspectiveDistance(PERSPECTIVE_FOV, aspect, radius),
      12,
    );
  });

  it('moves the framing distance when the FOV it frames with changes', () => {
    // The test that would have caught the missing argument: change the FOV the
    // helper is handed and the distance has to follow. A narrower lens sees
    // less, so it must be framed from further out. Equal distances for
    // different lenses is a camera `ModelViewer` never builds.
    const scene = heavyScene();
    const center = boundsCenter(scene.bounds);
    const wide = framedCamera(
      'perspective',
      scene,
      aspect,
      PERSPECTIVE_FOV,
    ) as THREE.PerspectiveCamera;
    const narrow = framedCamera(
      'perspective',
      scene,
      aspect,
      PERSPECTIVE_FOV / 2,
    ) as THREE.PerspectiveCamera;

    expect(narrow.fov).toBeLessThan(wide.fov);
    expect(narrow.position.x - center[0]).toBeGreaterThan(
      wide.position.x - center[0],
    );
  });

  it('keeps the whole model inside the default orthographic frustum', () => {
    // Floor on ORTHO_FRUSTUM_MULTIPLIER, and the one end that needs no chosen
    // number at all: below 1 the bounding sphere does not fit and the model is
    // clipped at the view the user is handed on load. Nothing above catches
    // that - 0.3 and 0.6 both leave the suite green, because a clipped model is
    // still a *large* model and the LOD switch is the only thing watching.
    const scene = heavyScene();
    const radius = Math.max(boundsRadius(scene.bounds), 0.001);
    const camera = framedCamera(
      'orthographic',
      scene,
      aspect,
    ) as THREE.OrthographicCamera;

    expect(
      framedHalfHeight(camera, boundsCenter(scene.bounds)),
    ).toBeGreaterThanOrEqual(radius);
  });

  it('never frames orthographic looser than perspective frames the same model', () => {
    // Cap on ORTHO_FRUSTUM_MULTIPLIER, derived rather than chosen: toggling
    // projection must not shrink the model. The perspective half-height is
    // `sqrt(3) * padding * radius / cos(fov/2)`, which is at least
    // `sqrt(3) * 1.15 = 1.9919` radii for *every* FOV - so this cap can never
    // kill the benign `PERSPECTIVE_FOV` mutation #86 requires to survive, and
    // it is not a disguised FOV pin. At 45 degrees it admits any multiplier up
    // to 2.155972; combined with the floor above that is a 2.16x window, down
    // from the measured 20x.
    const scene = heavyScene();
    const center = boundsCenter(scene.bounds);
    const ortho = framedCamera('orthographic', scene, aspect);
    const perspective = framedCamera('perspective', scene, aspect);

    expect(framedHalfHeight(ortho, center)).toBeLessThanOrEqual(
      framedHalfHeight(perspective, center),
    );
  });

  it('sizes the default orthographic framing from a real frustum, not the degenerate-frustum fallback', () => {
    // `apparentRadiusFraction` reports a frustum it cannot size as Infinity, so
    // full detail is kept for a camera that has no framing at all. That makes
    // "shows full detail at the default orthographic framing" true for a camera
    // with NaN bounds as well as for a correctly framed one, which is how 18 of
    // the 21 tests in this file stayed green while ORTHO_FRUSTUM_MULTIPLIER was
    // unresolvable. Requiring a finite fraction is what makes that assertion a
    // measurement rather than a fallback.
    const scene = heavyScene();
    const dense = scene.objects.find((object) => object.id === 'dense')!.mesh!;
    const camera = framedCamera('orthographic', scene, aspect);
    const fraction = apparentRadiusFraction(
      lodCameraOf(camera),
      0,
      meshBoundsRadius(dense),
    );

    expect(Number.isFinite(fraction)).toBe(true);
    expect(fraction).toBeGreaterThan(LOD_SWITCH_SCREEN_FRACTION);
  });
});

/**
 * The framing functions themselves, called directly.
 *
 * Everything above frames through `framedCamera`, which now delegates here - so
 * these would be caught there too. They exist separately because a kill routed
 * through the LOD fixtures says "some camera ended up wrong"; these say which
 * function computed it wrong, and they hold whatever the fixture radii happen
 * to be. `radius` cancels out of every assertion below, so none of them is a
 * statement about `heavyScene`.
 *
 * All assertions are delegation-not-magnitude: each compares production against
 * the constant or the geometry helper it is supposed to be using, never against
 * a transcribed number. Changing `PERSPECTIVE_FOV` or `ORTHO_FRUSTUM_MULTIPLIER`
 * moves both sides of every one of these, so they cannot become the equality pin
 * on `PERSPECTIVE_FOV` that #86 AC4 forbids.
 *
 * That survival used to be explained by saying `fitPerspectiveDistance` cancels
 * FOV out of the framing distance by construction. It does not - see
 * `viewer.geometry.test.ts`, which measures the residue. Mutating
 * `PERSPECTIVE_FOV` survives for two concrete reasons instead:
 *
 *  1. every assertion that names the constant is a delegation, so both sides
 *     move together and the difference under test is unchanged; and
 *  2. the one inequality that could bind - orthographic framing must not be
 *     looser than perspective framing - has the two sides 1.2 and 1.9919 radii
 *     apart. The perspective half-height at the framing position is
 *     `sqrt(3) * 1.15 * radius / cos(fov/2)` (the `sqrt(3)` because the camera
 *     sits on the (1,1,1) diagonal), so its infimum over all FOVs is
 *     `sqrt(3) * 1.15 = 1.991858` radii, which exceeds
 *     `ORTHO_FRUSTUM_MULTIPLIER = 1.2` by 65.99% of the ortho value. No FOV
 *     brings them within reach of each other, so the cap can never bind on FOV.
 *
 * The distinction is load-bearing: the drift is 6.26% between 45 and 60 degrees
 * in the measure `lod.apparentRadiusFraction` uses, so an inequality with less
 * slack than that would start catching FOV changes and become the pin AC4
 * forbids.
 */
describe('ModelViewer framing primitives', () => {
  const aspect = 16 / 9;

  it('sizes the orthographic frustum to the model radius by the exported multiplier', () => {
    // `applyOrthoFrustum` was free to compute any half-height at all: the suite
    // stayed 661/661 with `radius * ORTHO_FRUSTUM_MULTIPLIER` replaced by
    // `radius * 3`, because the only helper that framed an orthographic camera
    // built the frustum itself from the same constant instead of calling this.
    const radius = 7.5;
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    applyOrthoFrustum(camera, radius, aspect);

    const halfHeight = radius * ORTHO_FRUSTUM_MULTIPLIER;
    expect(camera.top).toBeCloseTo(halfHeight, 12);
    expect(camera.bottom).toBeCloseTo(-halfHeight, 12);
    expect(camera.right).toBeCloseTo(halfHeight * aspect, 12);
    expect(camera.left).toBeCloseTo(-halfHeight * aspect, 12);
  });

  it('keeps the orthographic frustum centred and widening with the aspect ratio', () => {
    // Shape rather than size: a frustum that is off-centre or that stretches
    // the wrong axis frames the model just as badly as one of the wrong scale,
    // and the half-height assertion above sees neither.
    const radius = 2;
    const wide = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    const square = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    applyOrthoFrustum(wide, radius, 2);
    applyOrthoFrustum(square, radius, 1);

    expect(wide.left).toBeCloseTo(-wide.right, 12);
    expect(wide.bottom).toBeCloseTo(-wide.top, 12);
    expect(wide.top).toBeCloseTo(square.top, 12);
    expect(wide.right - wide.left).toBeCloseTo(
      2 * (square.right - square.left),
      12,
    );
  });

  it('frames a perspective camera at the distance its own lens implies', () => {
    // `frameCamera` was equally free: framing with `PERSPECTIVE_FOV * 2` left
    // the suite 661/661. This is the assertion that notices, and it notices
    // without pinning the FOV - both sides move together when the constant does.
    const radius = 4;
    const center: [number, number, number] = [1, -2, 3];
    const camera = createCamera('perspective', aspect, radius);
    frameCamera(camera, center, radius, aspect);

    const distance = fitPerspectiveDistance(
      (camera as THREE.PerspectiveCamera).fov,
      aspect,
      radius,
    );
    expect(camera.position.x - center[0]).toBeCloseTo(distance, 12);
    expect(camera.position.y - center[1]).toBeCloseTo(distance, 12);
    expect(camera.position.z - center[2]).toBeCloseTo(distance, 12);
  });

  it('frames from the lens the camera is actually looking through, not the default constant', () => {
    // The reason `frameCamera` reads `camera.fov` instead of `PERSPECTIVE_FOV`.
    // Production only ever builds cameras at the constant, so reading the
    // constant is invisible there - and that is exactly what makes it a
    // duplicated literal. A narrower lens sees less and must be framed from
    // further out; equal distances for different lenses is the defect.
    const radius = 4;
    const center: [number, number, number] = [0, 0, 0];
    const wide = createCamera(
      'perspective',
      aspect,
      radius,
    ) as THREE.PerspectiveCamera;
    const narrow = createCamera(
      'perspective',
      aspect,
      radius,
    ) as THREE.PerspectiveCamera;
    narrow.fov = wide.fov / 2;

    frameCamera(wide, center, radius, aspect);
    frameCamera(narrow, center, radius, aspect);

    expect(narrow.position.x).toBeGreaterThan(wide.position.x);
    expect(narrow.position.x).toBeCloseTo(
      fitPerspectiveDistance(narrow.fov, aspect, radius),
      12,
    );
  });

  it('frames an orthographic camera at the shared default position', () => {
    // The orthographic branch has no lens, so the only thing to pin is that it
    // agrees with `defaultCameraPosition` - the function "reset view" also
    // frames through, which is the whole reason it is shared.
    const radius = 4;
    const center: [number, number, number] = [-5, 6, 0.5];
    const camera = createCamera('orthographic', aspect, radius);
    frameCamera(camera, center, radius, aspect);

    const [x, y, z] = defaultCameraPosition(center, radius, aspect, {
      projection: 'orthographic',
    });
    expect(camera.position.x).toBeCloseTo(x, 12);
    expect(camera.position.y).toBeCloseTo(y, 12);
    expect(camera.position.z).toBeCloseTo(z, 12);
  });

  it('points the framed camera back at the model center', () => {
    // Position without orientation is half a framing: a camera at the right
    // distance looking somewhere else shows nothing, and every distance
    // assertion above passes for it.
    const radius = 3;
    const center: [number, number, number] = [2, 2, 2];
    const camera = createCamera('perspective', aspect, radius);
    frameCamera(camera, center, radius, aspect);
    camera.updateMatrixWorld(true);

    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(
      camera.quaternion,
    );
    const toCenter = new THREE.Vector3(...center)
      .sub(camera.position)
      .normalize();
    expect(forward.dot(toCenter)).toBeCloseTo(1, 10);
  });

  it('keeps perspective framing looser than orthographic at every FOV', () => {
    // Reason (2) from the block comment above, measured rather than asserted -
    // a replacement mechanism that nothing checks is just a better-sounding
    // version of the claim being retired.
    //
    // Perspective half-height at the framing position is
    //   sqrt(3) * padding * radius / cos(fov/2)
    // (sqrt(3) because the camera sits on the (1,1,1) diagonal), minimised as
    // fov -> 0 at sqrt(3) * 1.15 = 1.991858 radii. Orthographic is a flat
    // ORTHO_FRUSTUM_MULTIPLIER radii. The gap is what lets a FOV change pass
    // unnoticed, so it is the thing to pin.
    const radius = 4;
    const center: [number, number, number] = [0, 0, 0];
    let tightest = Infinity;
    // Literal FOVs, not PERSPECTIVE_FOV: this must survive the AC4 mutation.
    for (const fov of [1, 10, 20, 45, 60, 90, 120, 170]) {
      const camera = createCamera(
        'perspective',
        aspect,
        radius,
      ) as THREE.PerspectiveCamera;
      camera.fov = fov;
      frameCamera(camera, center, radius, aspect);
      const distance = camera.position.distanceTo(new THREE.Vector3(...center));
      const halfHeight = distance * Math.tan((fov * Math.PI) / 180 / 2);
      expect(halfHeight).toBeGreaterThan(radius * ORTHO_FRUSTUM_MULTIPLIER);
      tightest = Math.min(tightest, halfHeight / radius);
    }
    // The infimum is approached from above as the lens narrows and is never
    // reached, so bracket it rather than pinning it.
    expect(tightest).toBeGreaterThan(Math.sqrt(3) * 1.15);
    expect(tightest).toBeLessThan(Math.sqrt(3) * 1.15 * 1.001);
  });

  /**
   * NB3: the projection matrix must agree with the lens the framing was
   * computed from.
   *
   * These measure through THREE's real projection pipeline rather than reading
   * matrix elements, because the matrix is the thing under suspicion. The
   * apparent radius is recovered by projecting the model center and a point one
   * radius away along the camera's own up axis and taking the NDC-y difference:
   * that is what the renderer draws, and it depends on the *matrix*. It is then
   * compared against `apparentRadiusFraction(lodCameraOf(camera), …)`, which
   * reads `camera.fov` *live*. Agreement is the invariant; the hazard is that
   * the LOD policy and the picture disagree.
   *
   * Measured before the fix: framing a camera set to half the default FOV left
   * the matrix on the old lens and drew the model at 0.4802x the intended size,
   * with LOD nonetheless computing the intended fraction.
   *
   * Both assertions delegate - neither names a FOV - so mutating
   * `PERSPECTIVE_FOV` moves the camera, the matrix and the expectation together
   * and survives, as AC4 requires.
   */
  function ndcApparentRadius(
    camera: THREE.Camera,
    center: [number, number, number],
    radius: number,
  ): number {
    camera.updateMatrixWorld(true);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    const at = new THREE.Vector3(...center).project(camera);
    const edge = new THREE.Vector3(...center)
      .add(up.multiplyScalar(radius))
      .project(camera);
    return Math.abs(edge.y - at.y);
  }

  it('leaves the perspective projection matrix agreeing with the lens it framed from', () => {
    const radius = 4;
    const center: [number, number, number] = [0, 0, 0];
    const camera = createCamera(
      'perspective',
      aspect,
      radius,
    ) as THREE.PerspectiveCamera;
    // The mutation a caller performs: pick a lens, then ask to be framed for it.
    // `frameCamera` consumes `camera.fov`, so it owns reconciling the matrix.
    camera.fov = camera.fov / 2;
    frameCamera(camera, center, radius, aspect);

    const distance = camera.position.distanceTo(new THREE.Vector3(...center));
    const drawn = ndcApparentRadius(camera, center, radius);
    const believed = apparentRadiusFraction(
      lodCameraOf(camera),
      distance,
      radius,
    );
    expect(drawn).toBeCloseTo(believed, 12);
  });

  it('leaves the orthographic projection matrix agreeing with the frustum it was given', () => {
    // `applyOrthoFrustum` had the same defect and worse: `createCamera` returned
    // `top = radius * ORTHO_FRUSTUM_MULTIPLIER` over a matrix still holding the
    // constructor's -1..1 placeholder, measured at 0.208x at radius 4. The
    // viewer never saw it because `resize()` runs straight afterwards, so no
    // test that went through the viewer could have caught it.
    const radius = 4;
    const center: [number, number, number] = [0, 0, 0];
    const camera = createCamera(
      'orthographic',
      aspect,
      radius,
    ) as THREE.OrthographicCamera;
    frameCamera(camera, center, radius, aspect);

    // Orthographic apparent size is distance-independent: one radius spans
    // radius/top of the half-height, i.e. radius/(radius*MULT) of it, and NDC-y
    // runs -1..1 so the half-height is 1.
    const drawn = ndcApparentRadius(camera, center, radius);
    expect(drawn).toBeCloseTo(radius / camera.top, 12);
    expect(drawn).toBeCloseTo(1 / ORTHO_FRUSTUM_MULTIPLIER, 12);
  });

  it('keeps the orthographic frustum bounds and its matrix in step after a re-fit', () => {
    // The bounds-vs-matrix agreement stated directly, and re-applied at a second
    // radius so a matrix that happened to be right once cannot carry the test.
    const camera = createCamera(
      'orthographic',
      aspect,
      4,
    ) as THREE.OrthographicCamera;
    for (const radius of [4, 11]) {
      applyOrthoFrustum(camera, radius, aspect);
      // Perspective-free identity: elements[5] = 2 / (top - bottom).
      expect(camera.projectionMatrix.elements[5]).toBeCloseTo(
        2 / (camera.top - camera.bottom),
        12,
      );
      expect(camera.projectionMatrix.elements[0]).toBeCloseTo(
        2 / (camera.right - camera.left),
        12,
      );
    }
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
function heavyScene(denseSteps = 420): SceneMesh {
  const dense = denseGrid(denseSteps);
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
