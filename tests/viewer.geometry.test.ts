import { describe, expect, it } from 'vitest';

import {
  boundsCenter,
  boundsRadius,
  boundsSize,
  computeBounds,
  defaultCameraPosition,
  fitPerspectiveDistance,
  KEYBOARD_DOLLY_STEP,
  KEYBOARD_ORBIT_STEP,
  sampleCubeScene,
  toBufferGeometry,
  viewerKeyAction,
} from '../src/renderer/viewer/geometry';
import type { SceneMesh } from '../src/renderer/viewer/types';

function scene(overrides: Partial<SceneMesh>): SceneMesh {
  const base: SceneMesh = {
    sceneVersion: 2,
    positions: [],
    indices: [],
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    sourceFormat: 'stl',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [],
    rootObjectIds: [],
    plates: [],
  };
  return {
    ...base,
    ...overrides,
    status: overrides.status ?? base.status,
    statusMessages: overrides.statusMessages ?? base.statusMessages,
    parts: overrides.parts ?? base.parts,
    objects: overrides.objects ?? base.objects,
    rootObjectIds: overrides.rootObjectIds ?? base.rootObjectIds,
    plates: overrides.plates ?? base.plates,
  };
}

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

  it('matches a hand-derived absolute distance for the unit sphere', () => {
    // Hand derivation (independent of the function under test):
    //   vFov = 45° = π/4,  aspect = 1,  radius = 1,  padding = 1.15
    //   hFov = 2·atan(tan(π/8)·1) = π/4  (same as vFov at aspect 1)
    //   limitingFov = min(π/4, π/4) = π/4
    //   distance = (radius / sin(limitingFov/2)) × padding
    //            = (1 / sin(π/8)) × 1.15
    //            = (1 / 0.382683…) × 1.15
    //            = 2.613126… × 1.15
    //            ≈ 3.005095
    //
    // NOTE on the PERSPECTIVE_FOV mutation (45 → 20): it is benign and
    // this test intentionally does NOT kill it. The mechanism:
    // fitPerspectiveDistance ∝ 1/sin(fov/2), and the apparent-size formula
    // carries tan(fov/2), so the two cancel under FOV change — perspective
    // framing is self-correcting. Orthographic is linear in its frustum
    // multiplier and has nothing to cancel against, which is why
    // ORTHO_FRUSTUM_MULTIPLIER is the dangerous constant that must be
    // pinned. Do not "fix" the surviving FOV mutation.
    expect(fitPerspectiveDistance(45, 1, 1)).toBeCloseTo(3.005095, 4);
  });
});

describe('defaultCameraPosition', () => {
  it('offsets along the (1,1,1) diagonal from the center by the fit distance', () => {
    const center: [number, number, number] = [2, -3, 4];
    const distance = fitPerspectiveDistance(45, 1, 5);
    const pos = defaultCameraPosition(center, 5, 1, 'perspective', 45);
    expect(pos[0]).toBeCloseTo(center[0] + distance, 5);
    expect(pos[1]).toBeCloseTo(center[1] + distance, 5);
    expect(pos[2]).toBeCloseTo(center[2] + distance, 5);
  });

  it('places an orthographic camera at four radii from the center', () => {
    const pos = defaultCameraPosition([0, 0, 0], 3, 1.5, 'orthographic');
    expect(pos).toEqual([12, 12, 12]);
  });

  it('stays finite for a zero-radius model', () => {
    const pos = defaultCameraPosition([0, 0, 0], 0, 1, 'perspective');
    expect(pos.every((v) => Number.isFinite(v) && v > 0)).toBe(true);
  });
});

describe('viewerKeyAction', () => {
  it('maps arrow keys to opposite-sign orbit deltas', () => {
    expect(viewerKeyAction('ArrowLeft')).toEqual({
      type: 'orbit',
      azimuth: -KEYBOARD_ORBIT_STEP,
      polar: 0,
    });
    expect(viewerKeyAction('ArrowRight')).toEqual({
      type: 'orbit',
      azimuth: KEYBOARD_ORBIT_STEP,
      polar: 0,
    });
    expect(viewerKeyAction('ArrowUp')).toEqual({
      type: 'orbit',
      azimuth: 0,
      polar: -KEYBOARD_ORBIT_STEP,
    });
    expect(viewerKeyAction('ArrowDown')).toEqual({
      type: 'orbit',
      azimuth: 0,
      polar: KEYBOARD_ORBIT_STEP,
    });
  });

  it('maps +/- to inverse dolly factors so they cancel', () => {
    const zoomIn = viewerKeyAction('+');
    const zoomOut = viewerKeyAction('-');
    expect(zoomIn).toEqual({ type: 'dolly', factor: KEYBOARD_DOLLY_STEP });
    expect(zoomOut).toEqual({ type: 'dolly', factor: 1 / KEYBOARD_DOLLY_STEP });
    if (zoomIn?.type === 'dolly' && zoomOut?.type === 'dolly') {
      expect(zoomIn.factor * zoomOut.factor).toBeCloseTo(1, 10);
    }
  });

  it('treats R and Home as reset and ignores unrelated keys', () => {
    expect(viewerKeyAction('r')).toEqual({ type: 'reset' });
    expect(viewerKeyAction('R')).toEqual({ type: 'reset' });
    expect(viewerKeyAction('Home')).toEqual({ type: 'reset' });
    expect(viewerKeyAction('a')).toBeNull();
    expect(viewerKeyAction('Enter')).toBeNull();
  });
});

describe('toBufferGeometry', () => {
  it('builds position, index, and normal attributes', () => {
    const mesh = scene({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
    });

    const geometry = toBufferGeometry(mesh);
    expect(geometry.getAttribute('position').count).toBe(3);
    expect(geometry.getIndex()?.count).toBe(3);
    expect(geometry.getAttribute('normal')).toBeDefined();
    expect(geometry.getAttribute('color')).toBeUndefined();
  });

  it('bakes per-facet colors for a triangle soup', () => {
    const mesh = scene({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: [0, 1, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'stl',
      faceColors: [255, 0, 0],
    });

    const geometry = toBufferGeometry(mesh);
    const color = geometry.getAttribute('color');
    expect(color).toBeDefined();
    expect(color.count).toBe(3);
    expect(color.getX(0)).toBeCloseTo(1);
    expect(color.getY(0)).toBeCloseTo(0);
  });

  it('ignores per-facet colors on shared-vertex meshes', () => {
    const mesh = scene({
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0],
      indices: [0, 1, 2, 1, 3, 2],
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
      sourceFormat: 'threeMf',
      faceColors: [255, 0, 0, 0, 255, 0],
    });

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
