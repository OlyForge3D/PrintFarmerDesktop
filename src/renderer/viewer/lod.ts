/**
 * Level of detail for large meshes.
 *
 * A printable model routinely carries far more triangles than a viewport a few
 * hundred pixels across can resolve. Drawing all of them while the user is
 * orbiting costs frame time for detail that is never visible, so this module
 * derives a cheaper stand-in geometry to show once an object is far enough away
 * that the difference cannot be seen.
 *
 * Everything here is pure and GPU-free so the decimation can be tested for its
 * geometric invariants directly, without a WebGL context.
 */

import type { SceneMesh, SceneObjectMesh } from './types';

/**
 * Triangle count below which an object is left alone.
 *
 * Decimation is not free - it allocates a second geometry - so it has to buy
 * more than it costs. Below roughly this size an object draws comfortably
 * within a frame budget on integrated graphics, and the proxy would only add
 * memory.
 */
export const LOD_MIN_TRIANGLES = 20_000;

/**
 * Scene triangle total above which proxies are built at all.
 *
 * A scene can be under this total yet contain one object above
 * {@link LOD_MIN_TRIANGLES}; that single object still renders fine, so the
 * whole-scene total is what decides whether the work is worth doing.
 */
export const LOD_MIN_SCENE_TRIANGLES = 150_000;

/**
 * Cells along the longest axis of an object's bounding box.
 *
 * Vertices sharing a cell collapse to one point, so this is the knob that
 * trades fidelity for triangle count. 48 keeps a recognizable silhouette -
 * enough to orient and select by - while typically cutting a dense organic mesh
 * by an order of magnitude.
 */
export const LOD_GRID_RESOLUTION = 48;

/**
 * Share of the viewport half-height an object's bounding sphere may cover
 * before the proxy takes over.
 *
 * The thing that decides whether clustered detail is visible is how much of the
 * screen the object occupies, so that is what the policy is expressed in. At
 * 15% of half-height the object is a small figure in the view - roughly a
 * fifteenth of the window's height - and a 48-cell grid is well below one pixel
 * of error.
 *
 * Stating it as screen coverage rather than as a multiple of the object's
 * radius is deliberate. A distance threshold has to be chosen against whatever
 * distance the camera is actually placed at, and that placement lives in
 * `defaultCameraPosition` / `applyOrthoFrustum`, two functions away. The first
 * version of this policy used a fixed 3 radii, which sat *inside* the default
 * framing distance of ~6.2 radii, so the proxy was showing the moment a model
 * loaded. Reading the frustum instead of assuming it cannot drift that way.
 */
export const LOD_SWITCH_SCREEN_FRACTION = 0.15;

/**
 * The projection facts needed to turn a distance into an apparent size.
 *
 * Both variants fold in the camera's zoom, so a caller only has to supply what
 * it reads off the live camera. Keeping this structural rather than taking a
 * `THREE.Camera` is what lets the policy be exercised as plain arithmetic.
 */
export type LodCamera =
  | {
      readonly kind: 'perspective';
      /** tan(vertical fov / 2), divided by zoom. */
      readonly halfFovTangent: number;
    }
  | {
      readonly kind: 'orthographic';
      /** Half the frustum height in world units, divided by zoom. */
      readonly halfHeight: number;
    };

/** Triangles in a mesh whose indices come in triples. */
export function triangleCount(mesh: SceneObjectMesh): number {
  return Math.floor(mesh.indices.length / 3);
}

/** Total triangles across every object that carries geometry. */
export function sceneTriangleCount(sceneMesh: SceneMesh): number {
  let total = 0;
  for (const object of sceneMesh.objects) {
    if (object.mesh) total += triangleCount(object.mesh);
  }
  return total;
}

/**
 * Whether a scene is large enough that building proxies pays for itself.
 *
 * Both conditions matter: a scene has to be heavy overall, and it has to
 * contain at least one object big enough to be worth simplifying. A scene made
 * of ten thousand tiny objects is bottlenecked on draw calls, not triangles,
 * and decimation would not help it.
 */
export function shouldBuildLod(sceneMesh: SceneMesh): boolean {
  if (sceneTriangleCount(sceneMesh) < LOD_MIN_SCENE_TRIANGLES) return false;
  return sceneMesh.objects.some(
    (object) => object.mesh && triangleCount(object.mesh) >= LOD_MIN_TRIANGLES,
  );
}

/** Whether one object is dense enough to be given a proxy. */
export function shouldSimplifyObject(mesh: SceneObjectMesh): boolean {
  return triangleCount(mesh) >= LOD_MIN_TRIANGLES;
}

/**
 * Radius of the sphere enclosing a mesh's bounds, used to place the LOD switch
 * relative to the object's own size rather than at a fixed world distance.
 */
export function boundsRadius(mesh: SceneObjectMesh): number {
  const [minX, minY, minZ] = mesh.bounds.min;
  const [maxX, maxY, maxZ] = mesh.bounds.max;
  return (
    Math.hypot(
      Math.max(0, maxX - minX),
      Math.max(0, maxY - minY),
      Math.max(0, maxZ - minZ),
    ) / 2
  );
}

/**
 * Fraction of the viewport half-height covered by a sphere of `radius` whose
 * centre is `distance` from the camera.
 *
 * Under an orthographic projection distance does not affect apparent size at
 * all - only the frustum height and zoom do - which is why this cannot be
 * written as a single distance comparison shared by both projections.
 */
export function apparentRadiusFraction(
  camera: LodCamera,
  distance: number,
  radius: number,
): number {
  if (!(radius > 0)) return 0;
  const halfHeight =
    camera.kind === 'orthographic'
      ? camera.halfHeight
      : Math.max(0, distance) * camera.halfFovTangent;
  // A camera behind or exactly at the object, or a collapsed frustum, gives no
  // usable scale. Report the object as filling the view so the full-detail
  // level is kept: showing too much detail is a performance cost, showing too
  // little is a visible defect.
  if (!(halfHeight > 0) || !Number.isFinite(halfHeight)) return Infinity;
  return radius / halfHeight;
}

/** Whether an object at this apparent size should be drawn as its proxy. */
export function shouldUseLodProxy(
  camera: LodCamera,
  distance: number,
  radius: number,
): boolean {
  // A sphere with no radius covers nothing, which would read as "far away" and
  // swap in a proxy for an object there is no proxy to gain anything from.
  // Anything we cannot size stays at full detail.
  if (!(radius > 0) || !Number.isFinite(distance)) return false;
  return (
    apparentRadiusFraction(camera, distance, radius) <
    LOD_SWITCH_SCREEN_FRACTION
  );
}

/**
 * Collapse a mesh onto a uniform grid, welding vertices that land in the same
 * cell and dropping triangles that degenerate as a result.
 *
 * Vertex clustering is chosen over edge-collapse simplification because it is
 * O(n) in a single pass, needs no connectivity structure, and is fully
 * deterministic - the same input always yields byte-identical output, so the
 * proxy cannot vary between runs or platforms. It does not preserve topology,
 * which is fine for a stand-in that is only ever seen at a distance.
 *
 * Returns `null` when nothing was gained, so callers can skip allocating a
 * proxy that is no cheaper than the original.
 */
export function simplifyMesh(
  mesh: SceneObjectMesh,
  resolution: number = LOD_GRID_RESOLUTION,
): SceneObjectMesh | null {
  const cells = Math.max(1, Math.floor(resolution));
  const [minX, minY, minZ] = mesh.bounds.min;
  const [maxX, maxY, maxZ] = mesh.bounds.max;
  const sizeX = Math.max(0, maxX - minX);
  const sizeY = Math.max(0, maxY - minY);
  const sizeZ = Math.max(0, maxZ - minZ);
  const longest = Math.max(sizeX, sizeY, sizeZ);
  // A flat or point-like object has no axis to subdivide along; clustering it
  // would collapse it to a single vertex and erase it.
  if (!Number.isFinite(longest) || longest <= 0) return null;
  const cellSize = longest / cells;

  const vertexCount = Math.floor(mesh.positions.length / 3);
  // Cell coordinates are per-axis, so an index has to be built from all three.
  // A string key keeps this exact for any vertex count, where packing into a
  // number would overflow once the grid is subdivided finely.
  const cellToVertex = new Map<string, number>();
  /** Original vertex index -> index in the simplified vertex list. */
  const remap = new Int32Array(vertexCount).fill(-1);
  const positions: number[] = [];

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const x = mesh.positions[vertex * 3] ?? 0;
    const y = mesh.positions[vertex * 3 + 1] ?? 0;
    const z = mesh.positions[vertex * 3 + 2] ?? 0;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    const cellX = Math.floor((x - minX) / cellSize);
    const cellY = Math.floor((y - minY) / cellSize);
    const cellZ = Math.floor((z - minZ) / cellSize);
    const key = `${cellX},${cellY},${cellZ}`;
    const existing = cellToVertex.get(key);
    if (existing !== undefined) {
      remap[vertex] = existing;
      continue;
    }
    // The first vertex to claim a cell represents it. Averaging the cell's
    // members would need a second pass and shifts the surface inward; keeping a
    // real input vertex guarantees every proxy point lies on the original mesh
    // and so within its bounds.
    const next = positions.length / 3;
    positions.push(x, y, z);
    cellToVertex.set(key, next);
    remap[vertex] = next;
  }

  const indices: number[] = [];
  const triangles = Math.floor(mesh.indices.length / 3);
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const a = remap[mesh.indices[triangle * 3] ?? -1] ?? -1;
    const b = remap[mesh.indices[triangle * 3 + 1] ?? -1] ?? -1;
    const c = remap[mesh.indices[triangle * 3 + 2] ?? -1] ?? -1;
    // Out-of-range or non-finite source vertices never got a mapping.
    if (a < 0 || b < 0 || c < 0) continue;
    // Two corners in one cell leaves a zero-area triangle, which contributes
    // nothing but still costs a draw and breaks normal computation.
    if (a === b || b === c || a === c) continue;
    indices.push(a, b, c);
  }

  if (indices.length === 0) return null;
  if (indices.length >= mesh.indices.length) return null;

  return {
    positions,
    indices,
    // Clustering only removes vertices, and every survivor is an original
    // point, so the source bounds still enclose the result. Reusing them keeps
    // the proxy framed and culled identically to the object it stands in for.
    bounds: mesh.bounds,
  };
}
