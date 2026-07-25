import * as THREE from 'three';

import { DEFAULT_BASE_COLOR } from '../library/sceneMaterials';
import { boundsCenter } from './geometry';
import {
  boundsRadius,
  shouldBuildLod,
  shouldUseLodProxy,
  simplifyMesh,
} from './lod';
import type { LodCamera } from './lod';
import type {
  SceneMaterial,
  SceneMesh,
  SceneObject,
  SceneObjectMesh,
} from './types';

export interface ViewerSceneGraph {
  readonly root: THREE.Group;
  setHidden(hiddenObjectIds?: ReadonlySet<string>): void;
  /**
   * Objects given a reduced-detail stand-in, by object id. Empty when the scene
   * is small enough to draw at full detail.
   */
  readonly lodObjectIds: ReadonlySet<string>;
  /**
   * Pick a detail level for every proxied object against the current camera.
   *
   * Must be called before each draw. `THREE.LOD`'s own automatic selection is
   * switched off because it keys purely on camera distance, which does not
   * describe apparent size under an orthographic projection - there the camera
   * never moves and only zoom changes what the user sees.
   */
  updateLod(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): void;
  dispose(): void;
}

/** One proxied object and the local-space sphere used to size it on screen. */
interface LodEntry {
  readonly lod: THREE.LOD;
  readonly center: THREE.Vector3;
  readonly radius: number;
}

/**
 * Reduce a live camera to the projection facts the LOD policy needs, folding in
 * zoom so both variants are directly comparable.
 */
export function lodCameraOf(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
): LodCamera {
  const zoom = camera.zoom > 0 ? camera.zoom : 1;
  if (camera instanceof THREE.OrthographicCamera) {
    return {
      kind: 'orthographic',
      halfHeight: Math.abs(camera.top - camera.bottom) / 2 / zoom,
    };
  }
  return {
    kind: 'perspective',
    halfFovTangent: Math.tan((camera.fov * Math.PI) / 180 / 2) / zoom,
  };
}

export function buildViewerSceneGraph(
  sceneMesh: SceneMesh,
  hiddenObjectIds?: ReadonlySet<string>,
): ViewerSceneGraph {
  const root = new THREE.Group();
  root.name = 'scene-root';

  const objectMap = new Map(
    sceneMesh.objects.map((object) => [object.id, object]),
  );
  const nodeMap = new Map<string, THREE.Group>();
  const geometries: THREE.BufferGeometry[] = [];
  const materials: THREE.Material[] = [];
  const lodObjectIds = new Set<string>();
  const lodEntries: LodEntry[] = [];
  const useLod = shouldBuildLod(sceneMesh);

  const plateGroupMap = new Map<string, THREE.Group>();
  for (const plate of sceneMesh.plates) {
    const plateGroup = new THREE.Group();
    plateGroup.name = plate.name;
    root.add(plateGroup);
    plateGroupMap.set(plate.id, plateGroup);
  }

  for (const object of sceneMesh.objects) {
    const node = new THREE.Group();
    node.name = object.name;
    node.matrixAutoUpdate = false;
    applyRowMajorMatrix(node.matrix, object.transform.matrix);
    node.matrixWorldNeedsUpdate = true;

    if (object.mesh) {
      const geometry = createObjectGeometry(
        object.mesh,
        object.material.faceColors,
      );
      const material = createObjectMaterial(
        sceneMesh.sourceFormat,
        object.material,
        geometry,
      );
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${object.name}:mesh`;
      geometries.push(geometry);
      materials.push(material);

      const proxy = useLod
        ? createLodProxy(object.mesh, geometry, material)
        : null;
      if (proxy) {
        const lod = new THREE.LOD();
        lod.name = `${object.name}:lod`;
        // Level selection is driven by `updateLod` instead, so three.js must
        // not also apply its own distance rule during rendering.
        lod.autoUpdate = false;
        // matrixAutoUpdate stays on: the world matrix is what places the
        // object's bounding sphere for the apparent-size test.
        lod.addLevel(mesh, 0);
        lod.addLevel(proxy.mesh, 1);
        // addLevel does not touch visibility, and both meshes default to
        // visible. Without this the first frame draws the proxy on top of the
        // full mesh until the first update runs.
        proxy.mesh.visible = false;
        node.add(lod);
        geometries.push(proxy.geometry);
        lodObjectIds.add(object.id);
        const [cx, cy, cz] = boundsCenter(object.mesh.bounds);
        lodEntries.push({
          lod,
          center: new THREE.Vector3(cx, cy, cz),
          radius: boundsRadius(object.mesh),
        });
      } else {
        node.add(mesh);
      }
    }

    nodeMap.set(object.id, node);
  }

  for (const object of sceneMesh.objects) {
    const node = nodeMap.get(object.id);
    if (!node) continue;
    const parent = object.parentId ? nodeMap.get(object.parentId) : undefined;
    if (parent) {
      parent.add(node);
      continue;
    }
    const plateGroup = plateGroupMap.get(object.plateId);
    (plateGroup ?? root).add(node);
  }

  if (plateGroupMap.size === 0) {
    for (const rootObjectId of sceneMesh.rootObjectIds) {
      const node = nodeMap.get(rootObjectId);
      if (node?.parent === null) {
        root.add(node);
      }
    }
  }

  const setHidden = (nextHidden?: ReadonlySet<string>): void => {
    for (const object of sceneMesh.objects) {
      const node = nodeMap.get(object.id);
      if (!node) continue;
      node.visible = isObjectVisible(object, objectMap, nextHidden);
    }
  };

  setHidden(hiddenObjectIds);

  const cameraPosition = new THREE.Vector3();
  const worldCenter = new THREE.Vector3();
  const worldScale = new THREE.Vector3();
  const updateLod = (
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  ): void => {
    if (lodEntries.length === 0) return;
    const lodCamera = lodCameraOf(camera);
    camera.updateWorldMatrix(true, false);
    cameraPosition.setFromMatrixPosition(camera.matrixWorld);
    for (const entry of lodEntries) {
      // The caller may have moved a parent since the last draw, and nothing
      // else refreshes these matrices before the level is chosen.
      entry.lod.updateWorldMatrix(true, false);
      worldCenter.copy(entry.center).applyMatrix4(entry.lod.matrixWorld);
      worldScale.setFromMatrixScale(entry.lod.matrixWorld);
      // A non-uniform scale makes the bounding sphere an ellipsoid; the largest
      // axis is the one that decides how big it looks.
      const radius =
        entry.radius *
        Math.max(
          Math.abs(worldScale.x),
          Math.abs(worldScale.y),
          Math.abs(worldScale.z),
        );
      const useProxy = shouldUseLodProxy(
        lodCamera,
        cameraPosition.distanceTo(worldCenter),
        radius,
      );
      const levels = entry.lod.levels;
      if (levels[0]) levels[0].object.visible = !useProxy;
      if (levels[1]) levels[1].object.visible = useProxy;
    }
  };

  return {
    root,
    setHidden,
    lodObjectIds,
    updateLod,
    dispose: () => {
      for (const geometry of geometries) {
        geometry.dispose();
      }
      for (const material of materials) {
        disposeMaterial(material);
      }
      root.clear();
    },
  };
}

/**
 * Build the reduced-detail stand-in for one object, or `null` when clustering
 * gained nothing.
 *
 * The proxy shares the full-detail material instance rather than making its
 * own, so a wireframe toggle or colour applies to both levels at once and
 * switching detail can never change how the object looks beyond its silhouette.
 * That sharing is also why the proxy's material is not pushed onto the disposal
 * list - disposing it twice would tear down the material still in use.
 */
function createLodProxy(
  objectMesh: SceneObjectMesh,
  fullGeometry: THREE.BufferGeometry,
  material: THREE.Material,
): { mesh: THREE.Mesh; geometry: THREE.BufferGeometry } | null {
  // Sharing the material means sharing its `vertexColors` flag. Clustering
  // welds vertices, which destroys the triangle-per-vertex layout per-face
  // colours rely on, so a proxy could not supply the colour attribute the
  // shared material would then demand - it would draw black. Such objects keep
  // full detail rather than being drawn wrong at a distance.
  if (fullGeometry.getAttribute('color') !== undefined) return null;
  const simplified = simplifyMesh(objectMesh);
  if (!simplified) return null;
  const geometry = createObjectGeometry(simplified, null);
  const mesh = new THREE.Mesh(geometry, material);
  return { mesh, geometry };
}

function applyRowMajorMatrix(
  matrix: THREE.Matrix4,
  rowMajorValues: readonly number[],
): void {
  // The sidecar already transposes 3MF's row-vector transforms into the
  // row-major argument order Matrix4.set() expects, so this can pass them
  // straight through without reinterpretation.
  matrix.set(
    rowMajorValues[0] ?? 1,
    rowMajorValues[1] ?? 0,
    rowMajorValues[2] ?? 0,
    rowMajorValues[3] ?? 0,
    rowMajorValues[4] ?? 0,
    rowMajorValues[5] ?? 1,
    rowMajorValues[6] ?? 0,
    rowMajorValues[7] ?? 0,
    rowMajorValues[8] ?? 0,
    rowMajorValues[9] ?? 0,
    rowMajorValues[10] ?? 1,
    rowMajorValues[11] ?? 0,
    rowMajorValues[12] ?? 0,
    rowMajorValues[13] ?? 0,
    rowMajorValues[14] ?? 0,
    rowMajorValues[15] ?? 1,
  );
}

function createObjectGeometry(
  objectMesh: SceneObjectMesh,
  faceColors?: readonly number[] | null,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.BufferAttribute(Float32Array.from(objectMesh.positions), 3),
  );
  geometry.setIndex(Array.from(objectMesh.indices));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  applyFaceColors(geometry, objectMesh, faceColors);
  return geometry;
}

function createObjectMaterial(
  sourceFormat: SceneMesh['sourceFormat'],
  material: SceneMaterial,
  geometry: THREE.BufferGeometry,
): THREE.MeshStandardMaterial {
  const hasVertexColors = geometry.getAttribute('color') !== undefined;
  const baseColor = material.baseColor ?? DEFAULT_BASE_COLOR;
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(
      baseColor[0] / 255,
      baseColor[1] / 255,
      baseColor[2] / 255,
    ),
    vertexColors: hasVertexColors,
    metalness: 0.1,
    roughness: 0.75,
    flatShading: sourceFormat === 'stl',
  });
}

function applyFaceColors(
  geometry: THREE.BufferGeometry,
  objectMesh: SceneObjectMesh,
  faceColors?: readonly number[] | null,
): void {
  if (!faceColors || faceColors.length === 0) return;
  const triangleCount = objectMesh.indices.length / 3;
  const vertexCount = objectMesh.positions.length / 3;
  const isSoup = vertexCount === objectMesh.indices.length;
  if (!isSoup || faceColors.length !== triangleCount * 3) return;

  const colors = new Float32Array(vertexCount * 3);
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const r = (faceColors[tri * 3] ?? 0) / 255;
    const g = (faceColors[tri * 3 + 1] ?? 0) / 255;
    const b = (faceColors[tri * 3 + 2] ?? 0) / 255;
    for (let vertex = 0; vertex < 3; vertex += 1) {
      const offset = (tri * 3 + vertex) * 3;
      colors[offset] = r;
      colors[offset + 1] = g;
      colors[offset + 2] = b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

function isObjectVisible(
  object: SceneObject,
  objectsById: ReadonlyMap<string, SceneObject>,
  hiddenObjectIds?: ReadonlySet<string>,
): boolean {
  if (!hiddenObjectIds || hiddenObjectIds.size === 0) return true;
  let current: SceneObject | undefined = object;
  while (current) {
    if (hiddenObjectIds.has(current.id)) {
      return false;
    }
    current = current.parentId ? objectsById.get(current.parentId) : undefined;
  }
  return true;
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(
    material as unknown as Record<string, unknown>,
  )) {
    if (hasDisposeMethod(value)) {
      value.dispose();
    }
  }
  material.dispose();
}

function hasDisposeMethod(value: unknown): value is { dispose(): void } {
  if (!value || typeof value !== 'object') {
    return false;
  }
  return typeof Reflect.get(value, 'dispose') === 'function';
}
