/**
 * Pure geometry helpers for the 3D viewer: bounds math, camera-fit distance,
 * and construction of a Three.js `BufferGeometry` from a {@link SceneMesh}.
 *
 * Nothing here touches a WebGL context, so it is fully unit-testable in a plain
 * Node/jsdom environment. All GPU/rendering concerns live in `ModelViewer.tsx`.
 */

import * as THREE from 'three';

import type { Bounds, SceneMesh } from './types';

/** Compute the axis-aligned bounds of a flat `[x, y, z, ...]` position array. */
export function computeBounds(positions: readonly number[]): Bounds {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0] };
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i] ?? 0;
    const y = positions[i + 1] ?? 0;
    const z = positions[i + 2] ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

/** Geometric center of a bounds box. */
export function boundsCenter(bounds: Bounds): [number, number, number] {
  return [
    (bounds.min[0] + bounds.max[0]) * 0.5,
    (bounds.min[1] + bounds.max[1]) * 0.5,
    (bounds.min[2] + bounds.max[2]) * 0.5,
  ];
}

/** Size of a bounds box along each axis. */
export function boundsSize(bounds: Bounds): [number, number, number] {
  return [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ];
}

/** Radius of the sphere enclosing the bounds box (half the diagonal). */
export function boundsRadius(bounds: Bounds): number {
  const [sx, sy, sz] = boundsSize(bounds);
  return Math.sqrt(sx * sx + sy * sy + sz * sz) * 0.5;
}

/**
 * Distance a perspective camera must sit from a bounding sphere of `radius` so
 * the whole sphere is framed, accounting for the narrower of the vertical and
 * horizontal fields of view. `padding` (>= 1) leaves margin around the model.
 */
export function fitPerspectiveDistance(
  verticalFovDeg: number,
  aspect: number,
  radius: number,
  padding = 1.15,
): number {
  if (radius <= 0) return padding;
  const vFov = (verticalFovDeg * Math.PI) / 180;
  const safeAspect = aspect > 0 ? aspect : 1;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * safeAspect);
  const limitingFov = Math.min(vFov, hFov);
  return (radius / Math.sin(limitingFov / 2)) * padding;
}

/**
 * Build a Three.js geometry from a normalized scene mesh. Vertex normals are
 * computed for shading, and per-facet colors (when present and consistent with
 * a triangle-soup layout) are baked into a vertex color attribute.
 */
export function toBufferGeometry(mesh: SceneMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = Float32Array.from(mesh.positions);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(Array.from(mesh.indices));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  applyFaceColors(geometry, mesh);
  return geometry;
}

/**
 * When the mesh carries one color per triangle and its vertices are not shared
 * across triangles (a triangle soup, as STL produces), assign each triangle's
 * color to its three vertices. Shared-vertex meshes (indexed 3MF) are left
 * uncolored because a per-vertex color cannot represent per-face colors there.
 */
function applyFaceColors(
  geometry: THREE.BufferGeometry,
  mesh: SceneMesh,
): void {
  const faceColors = mesh.faceColors;
  if (!faceColors || faceColors.length === 0) return;

  const triangleCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  const isSoup = vertexCount === mesh.indices.length;
  if (!isSoup || faceColors.length !== triangleCount * 3) return;

  const colors = new Float32Array(vertexCount * 3);
  for (let tri = 0; tri < triangleCount; tri += 1) {
    const r = (faceColors[tri * 3] ?? 0) / 255;
    const g = (faceColors[tri * 3 + 1] ?? 0) / 255;
    const b = (faceColors[tri * 3 + 2] ?? 0) / 255;
    for (let v = 0; v < 3; v += 1) {
      const vertex = tri * 3 + v;
      colors[vertex * 3] = r;
      colors[vertex * 3 + 1] = g;
      colors[vertex * 3 + 2] = b;
    }
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * A unit-less sample cube centered at the origin, useful for exercising the
 * render pipeline before real models are wired through the sidecar.
 */
export function sampleCubeScene(size = 20): SceneMesh {
  const h = size / 2;
  const corners: [number, number, number][] = [
    [-h, -h, -h],
    [h, -h, -h],
    [h, h, -h],
    [-h, h, -h],
    [-h, -h, h],
    [h, -h, h],
    [h, h, h],
    [-h, h, h],
  ];
  const faces: [number, number, number, number][] = [
    [0, 1, 2, 3], // -z
    [5, 4, 7, 6], // +z
    [4, 0, 3, 7], // -x
    [1, 5, 6, 2], // +x
    [4, 5, 1, 0], // -y
    [3, 2, 6, 7], // +y
  ];

  const positions: number[] = [];
  const indices: number[] = [];
  for (const [a, b, c, d] of faces) {
    const base = positions.length / 3;
    for (const corner of [corners[a], corners[b], corners[c], corners[d]]) {
      positions.push(corner?.[0] ?? 0, corner?.[1] ?? 0, corner?.[2] ?? 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  return {
    positions,
    indices,
    bounds: { min: [-h, -h, -h], max: [h, h, h] },
    sourceFormat: 'stl',
  };
}
