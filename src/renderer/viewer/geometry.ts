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

/** Angular step (radians) applied per arrow-key press when orbiting. */
export const KEYBOARD_ORBIT_STEP = Math.PI / 18; // 10 degrees
/** Multiplicative distance step applied per zoom-key press. */
export const KEYBOARD_DOLLY_STEP = 0.9;

/**
 * The default camera position for framing a model: placed along the (1,1,1)
 * diagonal from `center` at a distance that frames the bounding sphere. Shared
 * by the initial framing and the "reset view" action so both agree exactly.
 */
export function defaultCameraPosition(
  center: readonly [number, number, number],
  radius: number,
  aspect: number,
  projection: 'perspective' | 'orthographic',
  verticalFovDeg = 45,
): [number, number, number] {
  const distance =
    projection === 'perspective'
      ? fitPerspectiveDistance(verticalFovDeg, aspect, radius)
      : Math.max(radius, 0.001) * 4;
  return [center[0] + distance, center[1] + distance, center[2] + distance];
}

/**
 * A viewer interaction decoded from a keyboard key, or `null` when the key is
 * not a viewer control. Keeping this mapping pure lets the key bindings be
 * unit-tested without a GPU, while `ModelViewer` applies the action to the live
 * camera/controls.
 */
export type ViewerKeyAction =
  | { readonly type: 'orbit'; readonly azimuth: number; readonly polar: number }
  | { readonly type: 'dolly'; readonly factor: number }
  | { readonly type: 'reset' };

/** Map a keyboard key (KeyboardEvent.key) to a viewer action, if any. */
export function viewerKeyAction(key: string): ViewerKeyAction | null {
  switch (key) {
    case 'ArrowLeft':
      return { type: 'orbit', azimuth: -KEYBOARD_ORBIT_STEP, polar: 0 };
    case 'ArrowRight':
      return { type: 'orbit', azimuth: KEYBOARD_ORBIT_STEP, polar: 0 };
    case 'ArrowUp':
      return { type: 'orbit', azimuth: 0, polar: -KEYBOARD_ORBIT_STEP };
    case 'ArrowDown':
      return { type: 'orbit', azimuth: 0, polar: KEYBOARD_ORBIT_STEP };
    case '+':
    case '=':
      return { type: 'dolly', factor: KEYBOARD_DOLLY_STEP };
    case '-':
    case '_':
      return { type: 'dolly', factor: 1 / KEYBOARD_DOLLY_STEP };
    case 'r':
    case 'R':
    case 'Home':
      return { type: 'reset' };
    default:
      return null;
  }
}

/**
 * Build a Three.js geometry from a normalized scene mesh. Vertex normals are
 * computed for shading, and per-facet colors (when present and consistent with
 * a triangle-soup layout) are baked into a vertex color attribute.
 *
 * When `hiddenParts` is supplied and the mesh declares parts, triangles
 * belonging to hidden parts are omitted from the index (their vertices and
 * colors stay in place, so toggling never requires a re-parse).
 */
export function toBufferGeometry(
  mesh: SceneMesh,
  hiddenParts?: ReadonlySet<number>,
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = Float32Array.from(mesh.positions);
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(visibleIndices(mesh, hiddenParts));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  applyFaceColors(geometry, mesh);
  return geometry;
}

/**
 * The triangle indices to draw. With no hidden parts (or a mesh without a part
 * table) this is the full index buffer; otherwise it is the concatenation of
 * the index ranges of the parts that remain visible.
 */
export function visibleIndices(
  mesh: SceneMesh,
  hiddenParts?: ReadonlySet<number>,
): number[] {
  const parts = mesh.parts;
  if (!hiddenParts || hiddenParts.size === 0 || !parts || parts.length === 0) {
    return Array.from(mesh.indices);
  }
  const result: number[] = [];
  parts.forEach((part, partIndex) => {
    if (hiddenParts.has(partIndex)) return;
    const start = part.triangleStart * 3;
    const end = start + part.triangleCount * 3;
    for (let i = start; i < end && i < mesh.indices.length; i += 1) {
      result.push(mesh.indices[i] ?? 0);
    }
  });
  return result;
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
