import { describe, expect, it } from 'vitest';

import {
  LOD_GRID_RESOLUTION,
  LOD_MIN_SCENE_TRIANGLES,
  LOD_MIN_TRIANGLES,
  LOD_SWITCH_RADII,
  boundsRadius,
  lodSwitchDistance,
  sceneTriangleCount,
  shouldBuildLod,
  shouldSimplifyObject,
  simplifyMesh,
  triangleCount,
} from '../src/renderer/viewer/lod';
import type {
  Bounds,
  SceneMesh,
  SceneObject,
  SceneObjectMesh,
} from '../src/renderer/viewer/types';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function boundsOf(positions: readonly number[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i] ?? 0);
    minY = Math.min(minY, positions[i + 1] ?? 0);
    minZ = Math.min(minZ, positions[i + 2] ?? 0);
    maxX = Math.max(maxX, positions[i] ?? 0);
    maxY = Math.max(maxY, positions[i + 1] ?? 0);
    maxZ = Math.max(maxZ, positions[i + 2] ?? 0);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ] };
}

function meshOf(
  positions: readonly number[],
  indices: readonly number[],
): SceneObjectMesh {
  return { positions, indices, bounds: boundsOf(positions) };
}

/**
 * A dense grid of triangles across the unit square, subdivided finely enough
 * that clustering has something to collapse.
 */
function grid(steps: number, extent = 1): SceneObjectMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const step = extent / steps;
  for (let y = 0; y <= steps; y += 1) {
    for (let x = 0; x <= steps; x += 1) {
      // A slight z ripple keeps the mesh from being perfectly flat, so it has
      // three usable axes.
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
  return meshOf(positions, indices);
}

function object(
  id: string,
  mesh: SceneObjectMesh | null,
  overrides: Partial<SceneObject> = {},
): SceneObject {
  return {
    id,
    sourceId: `${id}#source`,
    name: id,
    parentId: null,
    children: [],
    transform: { matrix: IDENTITY },
    mesh,
    material: {},
    plateId: 'plate-0',
    buildItemIndex: 0,
    ...overrides,
  };
}

function scene(objects: readonly SceneObject[]): SceneMesh {
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
    objects,
    rootObjectIds: objects.map((entry) => entry.id),
    plates: [],
  };
}

/** A mesh with exactly `triangles` triangles, each with distinct vertices. */
function fakeMeshOfSize(triangles: number): SceneObjectMesh {
  return {
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: Array.from({ length: triangles * 3 }, (_, i) => i % 3),
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
  };
}

describe('triangle counting', () => {
  it('counts index triples', () => {
    expect(triangleCount(meshOf([], [0, 1, 2, 0, 2, 3]))).toBe(2);
  });

  it('ignores a trailing partial triple rather than rounding up', () => {
    expect(triangleCount(meshOf([], [0, 1, 2, 0, 2]))).toBe(1);
  });

  it('sums only objects that carry geometry', () => {
    const mesh = scene([
      object('a', fakeMeshOfSize(10)),
      object('b', null),
      object('c', fakeMeshOfSize(5)),
    ]);

    expect(sceneTriangleCount(mesh)).toBe(15);
  });
});

describe('shouldSimplifyObject', () => {
  it('leaves an object one triangle under the threshold alone', () => {
    expect(shouldSimplifyObject(fakeMeshOfSize(LOD_MIN_TRIANGLES - 1))).toBe(
      false,
    );
  });

  it('simplifies an object exactly at the threshold', () => {
    expect(shouldSimplifyObject(fakeMeshOfSize(LOD_MIN_TRIANGLES))).toBe(true);
  });
});

describe('shouldBuildLod', () => {
  it('declines a scene one triangle under the scene threshold', () => {
    // Split across two objects so neither could be the deciding factor.
    const mesh = scene([
      object('a', fakeMeshOfSize(LOD_MIN_SCENE_TRIANGLES - 1 - 60_000)),
      object('b', fakeMeshOfSize(60_000)),
    ]);
    expect(sceneTriangleCount(mesh)).toBe(LOD_MIN_SCENE_TRIANGLES - 1);

    expect(shouldBuildLod(mesh)).toBe(false);
  });

  it('accepts a scene exactly at the scene threshold', () => {
    const mesh = scene([
      object('a', fakeMeshOfSize(LOD_MIN_SCENE_TRIANGLES - 60_000)),
      object('b', fakeMeshOfSize(60_000)),
    ]);
    expect(sceneTriangleCount(mesh)).toBe(LOD_MIN_SCENE_TRIANGLES);

    expect(shouldBuildLod(mesh)).toBe(true);
  });

  it('declines a heavy scene made only of small objects', () => {
    // Draw-call bound, not triangle bound: decimation would not help, so the
    // scene total alone must not be enough to trigger it.
    const objects = Array.from({ length: 400 }, (_, i) =>
      object(`o${i}`, fakeMeshOfSize(LOD_MIN_TRIANGLES - 1)),
    );
    const mesh = scene(objects);
    expect(sceneTriangleCount(mesh)).toBeGreaterThan(LOD_MIN_SCENE_TRIANGLES);

    expect(shouldBuildLod(mesh)).toBe(false);
  });

  it('declines a scene with no geometry at all', () => {
    expect(shouldBuildLod(scene([object('a', null)]))).toBe(false);
  });
});

describe('lodSwitchDistance', () => {
  it('scales with the object, not with a fixed world distance', () => {
    const small = meshOf([0, 0, 0, 1, 0, 0, 0, 1, 0], [0, 1, 2]);
    const large = meshOf([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);

    expect(lodSwitchDistance(large)).toBeCloseTo(
      lodSwitchDistance(small) * 10,
      6,
    );
    expect(lodSwitchDistance(small)).toBeCloseTo(
      boundsRadius(small) * LOD_SWITCH_RADII,
      6,
    );
  });

  it('never returns zero for a degenerate object', () => {
    // three.js treats a level at distance 0 as always active, which would make
    // the proxy permanently replace the real geometry.
    const point = meshOf([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2]);

    expect(lodSwitchDistance(point)).toBeGreaterThan(0);
  });
});

describe('simplifyMesh', () => {
  it('reduces the triangle count of a dense mesh', () => {
    const dense = grid(120);
    const simplified = simplifyMesh(dense);

    expect(simplified).not.toBeNull();
    expect(triangleCount(simplified!)).toBeLessThan(triangleCount(dense));
    expect(triangleCount(simplified!)).toBeGreaterThan(0);
  });

  it('never emits an index outside its own vertex list', () => {
    const simplified = simplifyMesh(grid(120));
    const vertices = Math.floor(simplified!.positions.length / 3);

    expect(simplified!.indices.length % 3).toBe(0);
    for (const index of simplified!.indices) {
      expect(Number.isInteger(index)).toBe(true);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(vertices);
    }
  });

  it('emits no degenerate triangles', () => {
    const simplified = simplifyMesh(grid(120));

    for (let i = 0; i < simplified!.indices.length; i += 3) {
      const [a, b, c] = simplified!.indices.slice(i, i + 3);
      expect(a).not.toBe(b);
      expect(b).not.toBe(c);
      expect(a).not.toBe(c);
    }
  });

  it('keeps every proxy vertex inside the original bounds', () => {
    const dense = grid(120);
    const simplified = simplifyMesh(dense)!;
    const { min, max } = dense.bounds;

    for (let i = 0; i < simplified.positions.length; i += 3) {
      for (const axis of [0, 1, 2] as const) {
        expect(simplified.positions[i + axis]!).toBeGreaterThanOrEqual(
          min[axis],
        );
        expect(simplified.positions[i + axis]!).toBeLessThanOrEqual(max[axis]);
      }
    }
    // Reusing the source bounds is only sound because of the above; assert the
    // contract the scene graph relies on for framing and culling.
    expect(simplified.bounds).toEqual(dense.bounds);
  });

  it('is deterministic', () => {
    const dense = grid(80);
    const first = simplifyMesh(dense);
    const second = simplifyMesh(dense);

    expect(second).toEqual(first);
  });

  it('collapses harder at a coarser grid', () => {
    const dense = grid(120);
    const coarse = simplifyMesh(dense, 8);
    const fine = simplifyMesh(dense, 64);

    expect(triangleCount(coarse!)).toBeLessThan(triangleCount(fine!));
  });

  it('returns null when clustering gains nothing', () => {
    // Three vertices far apart land in three different cells, so the "reduced"
    // mesh would be the original with an extra allocation.
    const triangle = meshOf([0, 0, 0, 10, 0, 0, 0, 10, 0], [0, 1, 2]);

    expect(simplifyMesh(triangle)).toBeNull();
  });

  it('returns null for a zero-size object instead of erasing it', () => {
    const point = meshOf([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2]);

    expect(simplifyMesh(point)).toBeNull();
  });

  it('returns null when every triangle degenerates', () => {
    // A line has extent, so it is not caught by the zero-size guard, but every
    // vertex collapses onto the same few cells along one axis.
    const line = meshOf([0, 0, 0, 1e-9, 0, 0, 2e-9, 0, 0, 5, 0, 0], [0, 1, 2]);

    expect(simplifyMesh(line)).toBeNull();
  });

  it('drops triangles referencing a non-finite vertex rather than emitting NaN', () => {
    const positions = [
      ...grid(40).positions.slice(0, 300),
      Number.NaN,
      0,
      0,
      0.5,
      0.5,
      0,
    ];
    const vertexCount = Math.floor(positions.length / 3);
    const bad = vertexCount - 2;
    const good = vertexCount - 1;
    const simplified = simplifyMesh(
      {
        positions,
        indices: [0, 1, 2, bad, good, 0],
        bounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
      2,
    );

    for (const value of simplified?.positions ?? []) {
      expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('drops triangles whose indices are out of range', () => {
    const dense = grid(40);
    const vertices = Math.floor(dense.positions.length / 3);
    const simplified = simplifyMesh({
      ...dense,
      indices: [...dense.indices, vertices + 5, vertices + 6, vertices + 7],
    });
    const proxyVertices = Math.floor(simplified!.positions.length / 3);

    for (const index of simplified!.indices) {
      expect(index).toBeLessThan(proxyVertices);
    }
  });

  it('treats a fractional or zero resolution as at least one cell', () => {
    const dense = grid(60);

    // One cell per axis leaves only the bucket boundaries, so the proxy
    // collapses to at most the eight corners of the bounding box. It must clamp
    // rather than divide by zero or produce a negative cell size.
    for (const resolution of [0, 0.5, -4]) {
      const simplified = simplifyMesh(dense, resolution);
      expect(simplified).not.toBeNull();
      expect(Math.floor(simplified!.positions.length / 3)).toBeLessThanOrEqual(
        8,
      );
      for (const value of simplified!.positions) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  });

  it('defaults to the documented grid resolution', () => {
    const dense = grid(120);

    expect(simplifyMesh(dense)).toEqual(
      simplifyMesh(dense, LOD_GRID_RESOLUTION),
    );
  });
});
