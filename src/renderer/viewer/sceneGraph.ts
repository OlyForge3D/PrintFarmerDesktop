import * as THREE from 'three';

import type {
  SceneMaterial,
  SceneMesh,
  SceneObject,
  SceneObjectMesh,
} from './types';

export interface ViewerSceneGraph {
  readonly root: THREE.Group;
  setHidden(hiddenObjectIds?: ReadonlySet<string>): void;
  dispose(): void;
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
      node.add(mesh);
      geometries.push(geometry);
      materials.push(material);
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

  return {
    root,
    setHidden,
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

function applyRowMajorMatrix(
  matrix: THREE.Matrix4,
  rowMajorValues: readonly number[],
): void {
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
  const baseColor = material.baseColor ?? [185, 192, 204];
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
  for (const value of Object.values(material)) {
    if (
      value &&
      typeof value === 'object' &&
      'dispose' in value &&
      typeof value.dispose === 'function'
    ) {
      value.dispose();
    }
  }
  material.dispose();
}
