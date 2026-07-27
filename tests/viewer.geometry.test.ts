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
    //            ≈ 3.005094819
    //
    // 3.005094819 is the corrected #86 value. The withdrawn 3.0043 differs by
    // 7.9e-4, which this assertion's 5e-5 tolerance already rejects; the
    // `.not` below states that rather than leaving it to be re-derived.
    expect(fitPerspectiveDistance(45, 1, 1)).toBeCloseTo(3.005095, 4);
    expect(fitPerspectiveDistance(45, 1, 1)).toBeCloseTo(3.005094819, 9);
    expect(fitPerspectiveDistance(45, 1, 1)).not.toBeCloseTo(3.0043, 4);
  });
});

/**
 * Why `PERSPECTIVE_FOV` is not pinned, stated as the mechanism that is actually
 * true rather than the one that sounds true.
 *
 * The conclusion is unchanged and is correct: #86 AC4 forbids pinning the FOV,
 * and mutating `PERSPECTIVE_FOV` must keep surviving. Only the reason changes.
 *
 * The retired claim was that `fitPerspectiveDistance` "cancels FOV out of the
 * framing distance by construction" - that distance ∝ `1/sin(fov/2)` and
 * apparent size ∝ `tan(fov/2)`, so the two cancel. They do not: `tan/sin` is
 * `1/cos`, so the cancellation leaves a residue of `1/cos(fov/2)`, which is
 * 1.0824 at 45° and 1.1547 at 60°. It looks like a cancellation only because
 * `cos` is flat near zero.
 *
 * What is exactly FOV-free is one step further in: the construction fixes
 * `sin(angular radius) / sin(fov/2) = 1/padding`, to the last bit, for every
 * FOV. Everything derived from that by a non-linear step drifts. These tests
 * pin the invariant, and measure the drift of both quantities a reader might
 * mean by "apparent size", so that anyone sizing the slack on an inequality has
 * the number instead of an adjective.
 *
 * None of this references `PERSPECTIVE_FOV`; the FOVs below are literal inputs
 * to a pure function, so mutating the exported constant cannot be caught here -
 * which is the point.
 */
describe('fitPerspectiveDistance FOV dependence', () => {
  const PADDING = 1.15;
  const halfFov = (fovDeg: number): number => (fovDeg * Math.PI) / 180 / 2;

  it('does not cancel FOV out of the framing distance', () => {
    // The direct falsification of the retired claim. If FOV genuinely cancelled,
    // these would be equal.
    const at20 = fitPerspectiveDistance(20, 16 / 9, 1);
    const at45 = fitPerspectiveDistance(45, 16 / 9, 1);
    const at60 = fitPerspectiveDistance(60, 16 / 9, 1);
    expect(at20).toBeGreaterThan(at45);
    expect(at45).toBeGreaterThan(at60);
    // Closed form: radius * padding / sin(fov/2) once the vertical FOV limits,
    // which it does for any aspect >= 1.
    expect(at45).toBeCloseTo(PADDING / Math.sin(halfFov(45)), 12);
  });

  it('holds sin(angular radius) / sin(half FOV) exactly at 1/padding', () => {
    // The quantity that IS invariant by construction, which is what the retired
    // comment was reaching for. Exact to floating point across the whole range.
    for (const fov of [5, 20, 45, 60, 100, 170]) {
      const distance = fitPerspectiveDistance(fov, 16 / 9, 1);
      const sinAngularRadius = 1 / distance;
      expect(sinAngularRadius / Math.sin(halfFov(fov))).toBeCloseTo(
        1 / PADDING,
        14,
      );
    }
  });

  it('drifts 6.26% in the apparent-size measure the LOD policy uses', () => {
    // `lod.apparentRadiusFraction` computes radius / (distance * tan(fov/2)),
    // which closes to cos(fov/2)/padding - the residue of the false
    // cancellation. This is the number that matters when sizing slack, and it
    // is an order of magnitude larger than the angular drift below.
    const linear = (fovDeg: number): number =>
      1 /
      (fitPerspectiveDistance(fovDeg, 16 / 9, 1) * Math.tan(halfFov(fovDeg)));

    expect(linear(45)).toBeCloseTo(Math.cos(halfFov(45)) / PADDING, 12);

    const drift = (linear(45) - linear(60)) / linear(45);
    // Bracketed from both sides: a one-sided bound cannot tell a real drift
    // from a runaway one. Measured 6.262086%.
    expect(drift).toBeGreaterThan(0.06);
    expect(drift).toBeLessThan(0.065);
    // Padding cancels out of the ratio, so this is a statement about the
    // trigonometry and not about the padding constant.
    expect(linear(45) / linear(60)).toBeCloseTo(
      Math.cos(halfFov(45)) / Math.cos(halfFov(60)),
      12,
    );
  });

  it('drifts 0.557% in the angular measure, monotonically', () => {
    const angular = (fovDeg: number): number =>
      Math.asin(1 / fitPerspectiveDistance(fovDeg, 16 / 9, 1)) /
      halfFov(fovDeg);

    const drift = (angular(45) - angular(60)) / angular(45);
    expect(drift).toBeGreaterThan(0.005);
    expect(drift).toBeLessThan(0.006);

    // Monotone decreasing across the usable range, approaching 1/padding as the
    // lens narrows - so no FOV makes the fraction larger than 1/padding.
    let previous = Infinity;
    for (let fov = 1; fov <= 179; fov += 1) {
      const value = angular(fov);
      expect(value).toBeLessThan(previous);
      previous = value;
    }
    expect(angular(1)).toBeLessThan(1 / PADDING);
    expect(angular(1)).toBeGreaterThan(1 / PADDING - 1e-5);
  });
});

describe('defaultCameraPosition', () => {
  it('offsets along the (1,1,1) diagonal from the center by the fit distance', () => {
    const center: [number, number, number] = [2, -3, 4];
    const distance = fitPerspectiveDistance(45, 1, 5);
    const pos = defaultCameraPosition(center, 5, 1, {
      projection: 'perspective',
      verticalFovDeg: 45,
    });
    expect(pos[0]).toBeCloseTo(center[0] + distance, 5);
    expect(pos[1]).toBeCloseTo(center[1] + distance, 5);
    expect(pos[2]).toBeCloseTo(center[2] + distance, 5);
  });

  it('places an orthographic camera at four radii from the center', () => {
    // No FOV to state: the orthographic arm of `FramingLens` has no such field,
    // so the argument that used to be passed here and ignored no longer exists.
    const pos = defaultCameraPosition([0, 0, 0], 3, 1.5, {
      projection: 'orthographic',
    });
    expect(pos).toEqual([12, 12, 12]);
  });

  it('stays finite for a zero-radius model', () => {
    const pos = defaultCameraPosition([0, 0, 0], 0, 1, {
      projection: 'perspective',
      verticalFovDeg: 45,
    });
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
