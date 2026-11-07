import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  createCamera,
  fitDepthRange,
  frameCamera,
} from '../src/renderer/viewer/ModelViewer';
import { depthRangeFor } from '../src/renderer/viewer/geometry';

const DEPTH_BITS = 24;
// Smallest depth step a 24-bit buffer resolves at `distance` for these planes.
function depthResolution(distance: number, near: number, far: number): number {
  return (distance * distance) / (near * 2 ** DEPTH_BITS) / (1 - near / far);
}

// A multi-plate Bambu scene is hundreds of millimetres across; the bed sits
// only max(0.2, 0.2% of footprint) below the parts.
const RADIUS = 500;
const BED_GAP = 0.2;
const CENTER: [number, number, number] = [440, 44, 55];

describe('depthRangeFor', () => {
  it.each([0, 0.2, 0.9, 1, 1.05, 1.5, 3, 6, 20, 50, 200])(
    'keeps the whole scene sphere in front of near and behind far at %f radii',
    (radii) => {
      const distance = radii * RADIUS;
      const { near, far } = depthRangeFor(distance, RADIUS);
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(near);
      // The nearest/farthest point of the sphere along the view axis.
      expect(near).toBeLessThanOrEqual(Math.max(distance - RADIUS, near));
      expect(far).toBeGreaterThanOrEqual(distance + RADIUS);
      // Never the old ~3e6 ratio.
      expect(far / near).toBeLessThanOrEqual(5000);
    },
  );

  it('resolves far finer than the bed gap at every distance outside the model', () => {
    for (let radii = 1.06; radii <= 50; radii *= 1.1) {
      const distance = radii * RADIUS;
      const { near, far } = depthRangeFor(distance, RADIUS);
      expect(depthResolution(distance, near, far)).toBeLessThan(BED_GAP / 10);
    }
  });

  it('documents the regression: the old fixed planes cannot resolve the bed gap', () => {
    const oldFar = RADIUS * 100 + 1000;
    expect(depthResolution(6 * RADIUS, 0.01, oldFar)).toBeGreaterThan(BED_GAP);
  });

  it('tolerates degenerate input', () => {
    for (const [distance, radius] of [
      [Number.NaN, 10],
      [-5, 10],
      [10, 0],
    ] as const) {
      const { near, far } = depthRangeFor(distance, radius);
      expect(near).toBeGreaterThan(0);
      expect(far).toBeGreaterThan(near);
    }
  });
});

describe.each(['perspective', 'orthographic'] as const)(
  'viewer camera depth planes (%s)',
  (projection) => {
    it('frames with planes fitted to the scene, not the old fixed range', () => {
      const camera = createCamera(projection, 1.5, RADIUS);
      frameCamera(camera, CENTER, RADIUS, 1.5);
      expect(camera.far / camera.near).toBeLessThanOrEqual(5000);
      expect(camera.far).toBeLessThan(RADIUS * 100);
    });

    it('refits as the camera dollies in and out without clipping the scene', () => {
      const camera = createCamera(projection, 1.5, RADIUS);
      frameCamera(camera, CENTER, RADIUS, 1.5);
      const target = new THREE.Vector3(...CENTER);
      const direction = camera.position.clone().sub(target).normalize();
      for (const radii of [0.05, 0.5, 1, 2, 6, 25, 100]) {
        camera.position.copy(target).addScaledVector(direction, radii * RADIUS);
        fitDepthRange(camera, CENTER, RADIUS);
        const { near, far } = depthRangeFor(radii * RADIUS, RADIUS);
        expect(camera.near).toBeCloseTo(near, 6);
        expect(camera.far).toBeCloseTo(far, 6);
        expect(camera.far).toBeGreaterThanOrEqual(radii * RADIUS + RADIUS);
        expect(camera.far / camera.near).toBeLessThanOrEqual(5000);
      }
    });

    it('keeps on-screen geometry unclipped when panned sideways', () => {
      const camera = createCamera(projection, 3, RADIUS);
      frameCamera(camera, CENTER, RADIUS, 3);
      const target = new THREE.Vector3(...CENTER);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(
        camera.quaternion,
      );
      // Pan like OrbitControls: camera and target shift together.
      camera.position.addScaledVector(right, RADIUS * 0.9);
      target.addScaledVector(right, RADIUS * 0.9);
      camera.lookAt(target);
      camera.updateMatrixWorld(true);
      fitDepthRange(camera, CENTER, RADIUS);
      camera.updateMatrixWorld(true);
      // Points of the scene sphere nearest to and farthest from the camera.
      const centre = new THREE.Vector3(...CENTER);
      const axis = camera.getWorldDirection(new THREE.Vector3());
      for (const sign of [-1, 1]) {
        const point = centre.clone().addScaledVector(axis, sign * RADIUS);
        const depth = point.clone().sub(camera.position).dot(axis);
        expect(depth).toBeGreaterThanOrEqual(camera.near);
        expect(depth).toBeLessThanOrEqual(camera.far);
      }
    });

    it('reports whether the planes changed', () => {
      const camera = createCamera(projection, 1, RADIUS);
      frameCamera(camera, CENTER, RADIUS, 1);
      expect(fitDepthRange(camera, CENTER, RADIUS)).toBe(false);
      camera.position.multiplyScalar(2);
      expect(fitDepthRange(camera, CENTER, RADIUS)).toBe(true);
    });
  },
);
