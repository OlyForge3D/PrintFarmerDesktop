import type { SceneMesh } from '../viewer/types';

export interface SceneStats {
  triangles: number;
  vertices: number;
  /** Bounding-box size along x, y, z, in the model's native units. */
  dimensions: [number, number, number];
  parts: number;
  format: SceneMesh['sourceFormat'];
}

/** Derive display statistics from a loaded scene mesh (pure, GPU-free). */
export function computeSceneStats(mesh: SceneMesh): SceneStats {
  const [minX, minY, minZ] = mesh.bounds.min;
  const [maxX, maxY, maxZ] = mesh.bounds.max;
  return {
    triangles: Math.floor(mesh.indices.length / 3),
    vertices: Math.floor(mesh.positions.length / 3),
    dimensions: [
      Math.max(0, maxX - minX),
      Math.max(0, maxY - minY),
      Math.max(0, maxZ - minZ),
    ],
    parts: mesh.parts?.length ?? 0,
    format: mesh.sourceFormat,
  };
}

/** Round a dimension to at most two decimals, trimming trailing zeros. */
export function formatDimension(value: number): string {
  return Number(value.toFixed(2)).toString();
}
