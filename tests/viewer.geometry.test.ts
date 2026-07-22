import { describe, expect, it } from 'vitest';

import {
  boundsCenter,
  boundsRadius,
  boundsSize,
  computeBounds,
  fitPerspectiveDistance,
  sampleCubeScene,
  toBufferGeometry,
} from '../src/renderer/viewer/geometry';
import type { SceneMesh } from '../src/renderer/viewer/types';

describe('bounds math', () => {
  it('computes bounds from a flat position array', () => {
    const bounds = computeBounds([-1, 2, 0, 3, -4, 6, 0, 0, 0]);
    expect(bounds.min).toEqual([-1, -4, 0]);
    expect(bounds.max).toEqual([3, 2, 6]);
  });

  it('returns a zero box for empty input', () => {
    const bounds = computeBounds([]);
    expect(bounds.min).toEqual([0, 0, 0]);
    expect(bounds.max).toEqual([0, 0, 0]);
  });

  it('derives center, size, and radius', () => {
    const bounds = { min: [-1, -1, -1], max: [1, 1, 1] } as const;
    expect(boundsCenter(bounds)).toEqual([0, 0, 0]);
    expect(boundsSize(bounds)).toEqual([2, 2, 2]);
    expect(boundsRadius(bounds)).toBeCloseTo(Math.sqrt(12) / 2);
  });
});

describe('fitPerspectiveDistance', () => {
  it('places the camera farther for larger models', () => {
    const near = fitPerspectiveDistance(45, 1, 1);
    const far = fitPerspectiveDistance(45, 1, 10);
    expect(far).toBeGreaterThan(near);
    expect(far / near).toBeCloseTo(10, 5);
  });

  it('accounts for the limiting field of view on wide aspect ratios', () => {
    // A very wide viewport is limited by the vertical fov, pushing the camera
    // back at least as far as the square case.
    const square = fitPerspectiveDistance(45, 1, 5, 1);
    const wide = fitPerspectiveDistance(45, 3, 5, 1);
    expect(wide).toBeGreaterThanOrEqual(square);
  });

  it('is robust to a zero radius', () => {
    expect(fitPerspectiveDistance(45, 1, 0)).toBeGreaterThan(0);
  });
});

describe('toBufferGeometry', () => {
  it('builds position, index, and normal attributes', () => {
    const mesh: SceneMesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
    };
    const geometry = toBufferGeometry(mesh);
    expect(geometry.getAttribute('position').count).toBe(3);
    expect(geometry.getIndex()?.count).toBe(3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    expect(geometry.getAttribute('color')).toBeUndefined();
  });

  it('bakes per-facet colors for a triangle soup', () => {
    const mesh: SceneMesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'stl',
      faceColors: [255, 0, 0],
    };
    const geometry = toBufferGeometry(mesh);
    const color = geometry.getAttribute('color');
    expect(color).toBeDefined();
    expect(color.count).toBe(3);
    expect(color.getX(0)).toBeCloseTo(1);
    expect(color.getY(0)).toBeCloseTo(0);
  });

  it('ignores per-facet colors on shared-vertex meshes', () => {
    const mesh: SceneMesh = {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      indices: [0, 1, 2, 1, 3, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: [255, 0, 0, 0, 255, 0],
    };
    const geometry = toBufferGeometry(mesh);
    expect(geometry.getAttribute('color')).toBeUndefined();
  });
});

describe('sampleCubeScene', () => {
  it('produces a closed cube of the requested size', () => {
    const cube = sampleCubeScene(20);
    expect(cube.positions.length).toBe(24 * 3); // 6 faces * 4 corners
    expect(cube.indices.length).toBe(36); // 6 faces * 2 triangles * 3
    expect(cube.bounds.min).toEqual([-10, -10, -10]);
    expect(cube.bounds.max).toEqual([10, 10, 10]);
    const geometry = toBufferGeometry(cube);
    expect(geometry.getIndex()?.count).toBe(36);
  });
});
