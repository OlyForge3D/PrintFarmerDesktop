/**
 * Shading normals that keep sharp edges sharp.
 *
 * Formats that share vertices between triangles (3MF, OBJ) cannot use plain
 * per-vertex normals: averaging every incident face smears light across a
 * bracket's flat faces and hole rims. Splitting normals where adjacent faces
 * meet at more than the crease angle keeps those edges crisp while gently
 * curved surfaces, whose neighbouring faces differ by a few degrees, stay
 * smooth. Positions are never moved; only the shading normal changes.
 *
 * Pure and GPU-free so it can be tested against exact expected normals.
 */

/** Neighbouring faces meeting at more than this angle are shaded separately. */
export const CREASE_ANGLE = Math.PI / 6;

export interface CreasedMesh {
  /** One vertex per (source vertex, smoothing group). */
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  /** Triangles in source order, so winding and triangle ids are unchanged. */
  readonly indices: Uint32Array;
}

export function buildCreasedMesh(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
  creaseAngle: number = CREASE_ANGLE,
): CreasedMesh {
  const triangleCount = Math.floor(indices.length / 3);
  const vertexCount = Math.floor(positions.length / 3);
  const creaseDot = Math.cos(creaseAngle);

  const faceNormals = new Float32Array(triangleCount * 3);
  const cornerAngles = new Float32Array(triangleCount * 3);

  for (let tri = 0; tri < triangleCount; tri += 1) {
    const corner = [
      (indices[tri * 3] ?? 0) * 3,
      (indices[tri * 3 + 1] ?? 0) * 3,
      (indices[tri * 3 + 2] ?? 0) * 3,
    ] as const;
    for (let k = 0; k < 3; k += 1) {
      const at = corner[k] as number;
      const next = corner[(k + 1) % 3] as number;
      const prev = corner[(k + 2) % 3] as number;
      const e1x = (positions[next] ?? 0) - (positions[at] ?? 0);
      const e1y = (positions[next + 1] ?? 0) - (positions[at + 1] ?? 0);
      const e1z = (positions[next + 2] ?? 0) - (positions[at + 2] ?? 0);
      const e2x = (positions[prev] ?? 0) - (positions[at] ?? 0);
      const e2y = (positions[prev + 1] ?? 0) - (positions[at + 1] ?? 0);
      const e2z = (positions[prev + 2] ?? 0) - (positions[at + 2] ?? 0);
      const crossX = e1y * e2z - e1z * e2y;
      const crossY = e1z * e2x - e1x * e2z;
      const crossZ = e1x * e2y - e1y * e2x;
      const crossLength = Math.hypot(crossX, crossY, crossZ);
      const lengths = Math.hypot(e1x, e1y, e1z) * Math.hypot(e2x, e2y, e2z);
      cornerAngles[tri * 3 + k] =
        lengths > 0
          ? Math.atan2(crossLength, e1x * e2x + e1y * e2y + e1z * e2z)
          : 0;
      if (k === 0 && crossLength > 0) {
        faceNormals[tri * 3] = crossX / crossLength;
        faceNormals[tri * 3 + 1] = crossY / crossLength;
        faceNormals[tri * 3 + 2] = crossZ / crossLength;
      }
    }
  }

  // Smoothing groups: a vertex's corners are joined when their faces share an
  // edge whose dihedral angle is within the crease angle, so a chain of gently
  // turning faces forms one group however far its ends diverge.
  const parent = new Uint32Array(triangleCount * 3);
  for (let corner = 0; corner < parent.length; corner += 1) {
    parent[corner] = corner;
  }
  const find = (corner: number): number => {
    let root = corner;
    while (parent[root] !== root) root = parent[root] as number;
    let walk = corner;
    while (parent[walk] !== root) {
      const next = parent[walk] as number;
      parent[walk] = root;
      walk = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  const dotOfFaces = (a: number, b: number): number =>
    (faceNormals[a * 3] as number) * (faceNormals[b * 3] as number) +
    (faceNormals[a * 3 + 1] as number) * (faceNormals[b * 3 + 1] as number) +
    (faceNormals[a * 3 + 2] as number) * (faceNormals[b * 3 + 2] as number);
  const cornerAt = (tri: number, vertex: number): number => {
    for (let k = 0; k < 3; k += 1) {
      if (indices[tri * 3 + k] === vertex) return tri * 3 + k;
    }
    return -1;
  };
  // Every face seen per undirected edge, so a non-manifold edge compares each
  // new face with all earlier ones and the result is independent of order.
  const edgeFaces = new Map<number, number[]>();
  for (let tri = 0; tri < triangleCount; tri += 1) {
    for (let k = 0; k < 3; k += 1) {
      const u = indices[tri * 3 + k] as number;
      const v = indices[tri * 3 + ((k + 1) % 3)] as number;
      if (u === v) continue;
      const key = Math.min(u, v) * vertexCount + Math.max(u, v);
      const seen = edgeFaces.get(key);
      if (seen === undefined) {
        edgeFaces.set(key, [tri]);
        continue;
      }
      for (const previous of seen) {
        if (dotOfFaces(tri, previous) < creaseDot) continue;
        union(cornerAt(tri, u), cornerAt(previous, u));
        union(cornerAt(tri, v), cornerAt(previous, v));
      }
      seen.push(tri);
    }
  }

  const sums = new Float64Array(triangleCount * 9);
  for (let corner = 0; corner < triangleCount * 3; corner += 1) {
    const root = find(corner);
    const tri = Math.floor(corner / 3);
    const weight = cornerAngles[corner] as number;
    sums[root * 3] =
      (sums[root * 3] as number) + (faceNormals[tri * 3] as number) * weight;
    sums[root * 3 + 1] =
      (sums[root * 3 + 1] as number) +
      (faceNormals[tri * 3 + 1] as number) * weight;
    sums[root * 3 + 2] =
      (sums[root * 3 + 2] as number) +
      (faceNormals[tri * 3 + 2] as number) * weight;
  }

  const outIndices = new Uint32Array(triangleCount * 3);
  const outPosition: number[] = [];
  const outNormal: number[] = [];
  const outputOfRoot = new Map<number, number>();
  for (let corner = 0; corner < triangleCount * 3; corner += 1) {
    const root = find(corner);
    let output = outputOfRoot.get(root);
    if (output === undefined) {
      const tri = Math.floor(corner / 3);
      const vertex = indices[corner] ?? 0;
      let nx = sums[root * 3] as number;
      let ny = sums[root * 3 + 1] as number;
      let nz = sums[root * 3 + 2] as number;
      const length = Math.hypot(nx, ny, nz);
      if (length > 0) {
        nx /= length;
        ny /= length;
        nz /= length;
      } else {
        nx = faceNormals[tri * 3] as number;
        ny = faceNormals[tri * 3 + 1] as number;
        nz = faceNormals[tri * 3 + 2] as number;
      }
      output = outPosition.length / 3;
      outPosition.push(
        positions[vertex * 3] ?? 0,
        positions[vertex * 3 + 1] ?? 0,
        positions[vertex * 3 + 2] ?? 0,
      );
      outNormal.push(nx, ny, nz);
      outputOfRoot.set(root, output);
    }
    outIndices[corner] = output;
  }

  return {
    positions: Float32Array.from(outPosition),
    normals: Float32Array.from(outNormal),
    indices: outIndices,
  };
}
