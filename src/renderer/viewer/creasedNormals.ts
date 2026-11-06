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
  const incidentCount = new Uint32Array(vertexCount + 1);

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
      const vertex = (indices[tri * 3 + k] ?? 0) + 1;
      incidentCount[vertex] = (incidentCount[vertex] ?? 0) + 1;
    }
  }

  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    incidentCount[vertex + 1] =
      (incidentCount[vertex + 1] ?? 0) + (incidentCount[vertex] ?? 0);
  }
  const fill = incidentCount.slice(0, vertexCount);
  const incident = new Uint32Array(triangleCount * 3);
  for (let corner = 0; corner < triangleCount * 3; corner += 1) {
    const vertex = indices[corner] ?? 0;
    incident[fill[vertex] as number] = corner;
    fill[vertex] = (fill[vertex] as number) + 1;
  }

  // One output vertex per (source vertex, smoothing group): corners of a
  // vertex whose creased normals coincide share it, so memory stays near the
  // source size instead of tripling.
  const outIndices = new Uint32Array(triangleCount * 3);
  const outPosition: number[] = [];
  const outNormal: number[] = [];
  const groupsByVertex = new Map<number, number[]>();
  const sameNormal = 1 - 1e-6;
  for (let corner = 0; corner < triangleCount * 3; corner += 1) {
    const tri = Math.floor(corner / 3);
    const vertex = indices[corner] ?? 0;
    const nx = faceNormals[tri * 3] as number;
    const ny = faceNormals[tri * 3 + 1] as number;
    const nz = faceNormals[tri * 3 + 2] as number;
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    const start = incidentCount[vertex] as number;
    const end = incidentCount[vertex + 1] as number;
    for (let slot = start; slot < end; slot += 1) {
      const other = incident[slot] as number;
      const otherTri = Math.floor(other / 3);
      const ox = faceNormals[otherTri * 3] as number;
      const oy = faceNormals[otherTri * 3 + 1] as number;
      const oz = faceNormals[otherTri * 3 + 2] as number;
      if (nx * ox + ny * oy + nz * oz < creaseDot) continue;
      const weight = cornerAngles[other] as number;
      sumX += ox * weight;
      sumY += oy * weight;
      sumZ += oz * weight;
    }
    let cx = nx;
    let cy = ny;
    let cz = nz;
    const length = Math.hypot(sumX, sumY, sumZ);
    if (length > 0) {
      cx = sumX / length;
      cy = sumY / length;
      cz = sumZ / length;
    }
    let groups = groupsByVertex.get(vertex);
    if (!groups) {
      groups = [];
      groupsByVertex.set(vertex, groups);
    }
    let found = -1;
    for (const candidate of groups) {
      const dot =
        (outNormal[candidate * 3] as number) * cx +
        (outNormal[candidate * 3 + 1] as number) * cy +
        (outNormal[candidate * 3 + 2] as number) * cz;
      if (dot >= sameNormal) {
        found = candidate;
        break;
      }
    }
    if (found < 0) {
      found = outPosition.length / 3;
      outPosition.push(
        positions[vertex * 3] ?? 0,
        positions[vertex * 3 + 1] ?? 0,
        positions[vertex * 3 + 2] ?? 0,
      );
      outNormal.push(cx, cy, cz);
      groups.push(found);
    }
    outIndices[corner] = found;
  }

  return {
    positions: Float32Array.from(outPosition),
    normals: Float32Array.from(outNormal),
    indices: outIndices,
  };
}
