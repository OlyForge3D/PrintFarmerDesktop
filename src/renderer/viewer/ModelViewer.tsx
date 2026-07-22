/**
 * WebGL model viewer. Owns a Three.js renderer, camera, lights, and orbit
 * controls, and renders a {@link SceneMesh} produced by the sidecar. Supports
 * perspective/orthographic projection, solid/wireframe display, automatic
 * framing, live resize, and graceful recovery from a lost GPU context.
 *
 * All non-visual math lives in `./geometry` so it can be unit-tested without a
 * GPU; this file is the thin GPU-bound shell around it.
 */

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
  boundsCenter,
  boundsRadius,
  defaultCameraPosition,
  toBufferGeometry,
  viewerKeyAction,
  visibleIndices,
} from './geometry';
import type { SceneMesh } from './types';

export type Projection = 'perspective' | 'orthographic';

export interface ModelViewerProps {
  mesh: SceneMesh;
  wireframe?: boolean;
  projection?: Projection;
  background?: string;
  hiddenParts?: ReadonlySet<number>;
  className?: string;
  /**
   * Changing this value reframes the camera to its default fit. The App
   * increments it when the user activates "Reset view"; the value itself is not
   * interpreted, only its change is observed.
   */
  resetToken?: number;
}

const PERSPECTIVE_FOV = 45;

export function ModelViewer({
  mesh,
  wireframe = false,
  projection = 'perspective',
  background = '#14151a',
  hiddenParts,
  className,
  resetToken = 0,
}: ModelViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const geometryRef = useRef<THREE.BufferGeometry | null>(null);
  const cameraRef = useRef<
    THREE.PerspectiveCamera | THREE.OrthographicCamera | null
  >(null);
  const controlsRef = useRef<OrbitControls | null>(null);
  const frameRef = useRef<{
    center: [number, number, number];
    radius: number;
  } | null>(null);
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;
  const hiddenPartsRef = useRef(hiddenParts);
  hiddenPartsRef.current = hiddenParts;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    } catch {
      setError('WebGL is unavailable on this system.');
      return;
    }
    setError(null);

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(background);

    const geometry = toBufferGeometry(mesh, hiddenPartsRef.current);
    geometryRef.current = geometry;
    const hasVertexColors = geometry.getAttribute('color') !== undefined;
    const material = new THREE.MeshStandardMaterial({
      color: hasVertexColors ? 0xffffff : 0xb9c0cc,
      vertexColors: hasVertexColors,
      metalness: 0.1,
      roughness: 0.75,
      flatShading: mesh.sourceFormat === 'stl',
      wireframe: wireframeRef.current,
    });
    materialRef.current = material;
    const model = new THREE.Mesh(geometry, material);
    scene.add(model);

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.9);
    key.position.set(1, 1.4, 1.2);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff, 0.35);
    fill.position.set(-1, -0.6, -0.8);
    scene.add(fill);

    const center = boundsCenter(mesh.bounds);
    const radius = Math.max(boundsRadius(mesh.bounds), 0.001);
    frameRef.current = { center, radius };
    const initialAspect = aspectOf(container);

    const camera = createCamera(projection, initialAspect, radius);
    cameraRef.current = camera;
    frameCamera(camera, center, radius, initialAspect);

    const controls = new OrbitControls(camera, renderer.domElement);
    controlsRef.current = controls;
    controls.enableDamping = true;
    controls.target.set(center[0], center[1], center[2]);
    controls.update();

    const resize = (): void => {
      const width = container.clientWidth;
      const height = container.clientHeight;
      if (width === 0 || height === 0) return;
      renderer.setSize(width, height, false);
      const aspect = width / height;
      if (camera instanceof THREE.PerspectiveCamera) {
        camera.aspect = aspect;
      } else {
        applyOrthoFrustum(camera, radius, aspect);
      }
      camera.updateProjectionMatrix();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frame = 0;
    let disposed = false;
    const animate = (): void => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();

    const onContextLost = (event: Event): void => {
      event.preventDefault();
      setError('GPU context lost — attempting to recover…');
    };
    const onContextRestored = (): void => setError(null);
    renderer.domElement.addEventListener('webglcontextlost', onContextLost);
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      onContextRestored,
    );

    const onKeyDown = (event: KeyboardEvent): void => {
      const action = viewerKeyAction(event.key);
      if (!action) return;
      event.preventDefault();
      if (action.type === 'orbit') {
        orbitCamera(camera, controls, action.azimuth, action.polar);
      } else if (action.type === 'dolly') {
        dollyCamera(camera, controls, action.factor);
      } else {
        resetView(camera, controls, center, radius, aspectOf(container));
      }
    };
    container.addEventListener('keydown', onKeyDown);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      container.removeEventListener('keydown', onKeyDown);
      renderer.domElement.removeEventListener(
        'webglcontextlost',
        onContextLost,
      );
      renderer.domElement.removeEventListener(
        'webglcontextrestored',
        onContextRestored,
      );
      controls.dispose();
      controlsRef.current = null;
      cameraRef.current = null;
      geometry.dispose();
      geometryRef.current = null;
      material.dispose();
      materialRef.current = null;
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mesh, projection, background]);

  useEffect(() => {
    if (materialRef.current) {
      materialRef.current.wireframe = wireframe;
    }
  }, [wireframe]);

  useEffect(() => {
    const geometry = geometryRef.current;
    if (!geometry) return;
    geometry.setIndex(visibleIndices(mesh, hiddenParts));
  }, [mesh, hiddenParts]);

  // Reframe to the default fit whenever the reset token changes. The initial
  // mount already frames the model, so the token===0 first run is a no-op fit.
  useEffect(() => {
    const camera = cameraRef.current;
    const controls = controlsRef.current;
    const container = containerRef.current;
    const frame = frameRef.current;
    if (!camera || !controls || !container || !frame) return;
    resetView(
      camera,
      controls,
      frame.center,
      frame.radius,
      aspectOf(container),
    );
  }, [resetToken]);

  return (
    <div
      ref={containerRef}
      className={className}
      role="application"
      aria-roledescription="3D model viewer"
      aria-label="3D model preview. Use arrow keys to orbit, plus and minus to zoom, and R to reset the view."
      tabIndex={0}
      style={{ position: 'relative', width: '100%', height: '100%' }}
    >
      {error && (
        <p role="alert" className="viewer-error">
          {error}
        </p>
      )}
    </div>
  );
}

function aspectOf(container: HTMLElement): number {
  const width = container.clientWidth || 1;
  const height = container.clientHeight || 1;
  return width / height;
}

function createCamera(
  projection: Projection,
  aspect: number,
  radius: number,
): THREE.PerspectiveCamera | THREE.OrthographicCamera {
  const far = radius * 100 + 1000;
  if (projection === 'orthographic') {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, far);
    applyOrthoFrustum(camera, radius, aspect);
    return camera;
  }
  return new THREE.PerspectiveCamera(PERSPECTIVE_FOV, aspect, 0.01, far);
}

function applyOrthoFrustum(
  camera: THREE.OrthographicCamera,
  radius: number,
  aspect: number,
): void {
  const halfHeight = radius * 1.2;
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
}

function frameCamera(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  center: [number, number, number],
  radius: number,
  aspect: number,
): void {
  const projection: Projection =
    camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic';
  const [x, y, z] = defaultCameraPosition(
    center,
    radius,
    aspect,
    projection,
    PERSPECTIVE_FOV,
  );
  camera.position.set(x, y, z);
  camera.lookAt(center[0], center[1], center[2]);
}

const MIN_POLAR = 0.01;
const MAX_POLAR = Math.PI - 0.01;

/** Rotate the camera around the controls target by the given angular deltas. */
function orbitCamera(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: OrbitControls,
  dAzimuth: number,
  dPolar: number,
): void {
  const offset = camera.position.clone().sub(controls.target);
  const spherical = new THREE.Spherical().setFromVector3(offset);
  spherical.theta += dAzimuth;
  spherical.phi = Math.min(
    MAX_POLAR,
    Math.max(MIN_POLAR, spherical.phi + dPolar),
  );
  spherical.makeSafe();
  offset.setFromSpherical(spherical);
  camera.position.copy(controls.target).add(offset);
  camera.lookAt(controls.target);
  controls.update();
}

/**
 * Zoom by moving the perspective camera along its view ray (or scaling the
 * orthographic zoom). `factor` < 1 zooms in, > 1 zooms out.
 */
function dollyCamera(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: OrbitControls,
  factor: number,
): void {
  if (camera instanceof THREE.OrthographicCamera) {
    camera.zoom = Math.max(0.01, camera.zoom / factor);
    camera.updateProjectionMatrix();
  } else {
    const offset = camera.position.clone().sub(controls.target);
    offset.multiplyScalar(factor);
    camera.position.copy(controls.target).add(offset);
  }
  controls.update();
}

/** Restore the default framing and clear any accumulated zoom/pan. */
function resetView(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  controls: OrbitControls,
  center: [number, number, number],
  radius: number,
  aspect: number,
): void {
  controls.target.set(center[0], center[1], center[2]);
  if (camera instanceof THREE.OrthographicCamera) {
    camera.zoom = 1;
    camera.updateProjectionMatrix();
  }
  frameCamera(camera, center, radius, aspect);
  controls.update();
}
