import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { describe, expect, it } from 'vitest';

import modelCamera from '../src/shared/model-camera.json';
import {
  createCamera,
  frameCamera,
  orbitCamera,
  VIEWER_UP,
  type Projection,
} from '../src/renderer/viewer/ModelViewer';

/**
 * Printable models (STL/3MF) are Z-up; three.js defaults to Y-up. These run
 * against the real camera and the real OrbitControls (no mocks) so they catch
 * the viewer silently drifting back to three's default orientation (#823).
 */
const PROJECTIONS: readonly Projection[] = ['perspective', 'orthographic'];
const CENTER: [number, number, number] = [3, -2, 5];
const RADIUS = 4;

function framed(projection: Projection) {
  const camera = createCamera(projection, 1, RADIUS);
  frameCamera(camera, CENTER, RADIUS, 1);
  const controls = new OrbitControls(camera, document.createElement('div'));
  controls.target.set(...CENTER);
  controls.update();
  return { camera, controls };
}

function ndc(camera: THREE.Camera, point: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld();
  return point.clone().project(camera);
}

describe.each(PROJECTIONS)('Z-up viewer (%s)', (projection) => {
  it.each([0.25, 1, 16 / 9])(
    'matches the Rust-verified thumbnail basis at aspect %s and fits the model',
    (aspect) => {
      const camera = createCamera(projection, aspect, RADIUS);
      frameCamera(camera, CENTER, RADIUS, aspect);
      const controls = new OrbitControls(camera, document.createElement('div'));
      controls.target.set(...CENTER);
      controls.update();

      const { forward, worldUp } = modelCamera;
      const expectedForward = new THREE.Vector3(
        forward.x,
        forward.y,
        forward.z,
      ).normalize();
      const right = expectedForward
        .clone()
        .cross(new THREE.Vector3(worldUp.x, worldUp.y, worldUp.z))
        .normalize();
      const up = right.clone().cross(expectedForward);
      expect(
        camera
          .getWorldDirection(new THREE.Vector3())
          .distanceTo(expectedForward),
      ).toBeLessThan(1e-6);
      expect(
        new THREE.Vector3(1, 0, 0)
          .applyQuaternion(camera.quaternion)
          .distanceTo(right),
      ).toBeLessThan(1e-6);
      expect(
        new THREE.Vector3(0, 1, 0)
          .applyQuaternion(camera.quaternion)
          .distanceTo(up),
      ).toBeLessThan(1e-6);

      // Sample the enclosing sphere, not a symmetric cube that can hide clipping.
      for (let polar = 0; polar <= Math.PI; polar += Math.PI / 12) {
        for (let azimuth = 0; azimuth < 2 * Math.PI; azimuth += Math.PI / 12) {
          const point = new THREE.Vector3()
            .setFromSphericalCoords(RADIUS, polar, azimuth)
            .add(new THREE.Vector3(...CENTER));
          const projected = ndc(camera, point);
          expect(Math.abs(projected.x)).toBeLessThan(1);
          expect(Math.abs(projected.y)).toBeLessThan(1);
          expect(Math.abs(projected.z)).toBeLessThan(1);
        }
      }
      controls.dispose();
    },
  );

  it('builds the camera with +Z as world up', () => {
    expect(VIEWER_UP).toEqual([0, 0, 1]);
    const camera = createCamera(projection, 1, RADIUS);
    expect(camera.up.toArray()).toEqual([0, 0, 1]);
  });

  it('draws a point above the model in Z above its centre on screen', () => {
    const { camera, controls } = framed(projection);
    const center = ndc(camera, new THREE.Vector3(...CENTER));
    const above = ndc(
      camera,
      new THREE.Vector3(...CENTER).add(new THREE.Vector3(0, 0, 1)),
    );

    expect(above.y).toBeGreaterThan(center.y + 0.01);
    // Straight up stays vertical on screen rather than leaning sideways.
    expect(above.x).toBeCloseTo(center.x, 6);
    controls.dispose();
  });

  it('keeps world-up on +Z through the real OrbitControls update', () => {
    const { camera, controls } = framed(projection);
    // The camera's on-screen up vector is the world up projected into view.
    const viewUp = new THREE.Vector3(0, 1, 0).applyQuaternion(
      camera.quaternion,
    );
    expect(viewUp.z).toBeGreaterThan(0.5);
    controls.dispose();
  });

  it('spins azimuth around Z, leaving the camera height unchanged', () => {
    const { camera, controls } = framed(projection);
    const zBefore = camera.position.z;
    const distBefore = camera.position.distanceTo(controls.target);

    orbitCamera(camera, controls, Math.PI / 6, 0);

    expect(camera.position.z).toBeCloseTo(zBefore, 9);
    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(
      distBefore,
      9,
    );
    controls.dispose();
  });

  it('tilts polar toward and away from +Z monotonically', () => {
    const { camera, controls } = framed(projection);
    const heights = [camera.position.z];

    // Positive polar moves away from the up pole, i.e. lowers the camera.
    for (let i = 0; i < 3; i += 1) {
      orbitCamera(camera, controls, 0, Math.PI / 18);
      heights.push(camera.position.z);
    }
    for (let i = 1; i < heights.length; i += 1) {
      expect(heights[i]!).toBeLessThan(heights[i - 1]!);
    }

    const lowest = camera.position.z;
    orbitCamera(camera, controls, 0, -Math.PI / 9);
    expect(camera.position.z).toBeGreaterThan(lowest);
    controls.dispose();
  });
});
