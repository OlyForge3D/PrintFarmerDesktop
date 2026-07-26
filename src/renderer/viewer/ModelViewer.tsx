/**
 * WebGL model viewer. Owns a Three.js renderer, camera, lights, and orbit
 * controls, and renders a {@link SceneMesh} produced by the sidecar. Supports
 * perspective/orthographic projection, solid/wireframe display, automatic
 * framing, live resize, and graceful recovery from a lost GPU context.
 *
 * All non-visual math lives in `./geometry` so it can be unit-tested without a
 * GPU; this file is the thin GPU-bound shell around it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import {
  boundsCenter,
  boundsRadius,
  defaultCameraPosition,
  viewerKeyAction,
  type FramingLens,
} from './geometry';
import type { SceneMesh } from './types';
import { buildViewerSceneGraph, type ViewerSceneGraph } from './sceneGraph';

export type Projection = 'perspective' | 'orthographic';

export interface ModelViewerProps {
  mesh: SceneMesh;
  wireframe?: boolean;
  projection?: Projection;
  background?: string;
  hiddenObjects?: ReadonlySet<string>;
  className?: string;
  /**
   * Changing this value reframes the camera to its default fit. The App
   * increments it when the user activates "Reset view"; the value itself is not
   * interpreted, only its change is observed.
   */
  resetToken?: number;
}

export const PERSPECTIVE_FOV = 45;
export const ORTHO_FRUSTUM_MULTIPLIER = 1.2;
type ViewerMesh = THREE.Mesh<
  THREE.BufferGeometry,
  THREE.Material | THREE.Material[]
>;

export function ModelViewer({
  mesh,
  wireframe = false,
  projection = 'perspective',
  background = '#14151a',
  hiddenObjects,
  className,
  resetToken = 0,
}: ModelViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sceneGraphRef = useRef<ViewerSceneGraph | null>(null);
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
  const hiddenObjectsRef = useRef(hiddenObjects);
  hiddenObjectsRef.current = hiddenObjects;
  // Set whenever something other than the camera changes what the next frame
  // should look like, so the idle loop knows to draw once more.
  const renderPendingRef = useRef(true);
  const requestRender = useCallback((): void => {
    renderPendingRef.current = true;
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [lodCount, setLodCount] = useState(0);

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

    const sceneGraph = buildViewerSceneGraph(mesh, hiddenObjectsRef.current);
    sceneGraph.root.traverse((object) => {
      applyWireframe(object, wireframeRef.current);
    });
    sceneGraphRef.current = sceneGraph;
    setLodCount(sceneGraph.lodObjectIds.size);
    scene.add(sceneGraph.root);

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
    // OrbitControls fires `change` synchronously from update() whenever it
    // actually moved the camera - from a drag, from damping easing out, or from
    // the keyboard helpers below, which call update() themselves. Listening
    // here catches every one of those without each call site remembering to.
    controls.addEventListener('change', requestRender);
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
      requestRender();
    };
    resize();

    const observer = new ResizeObserver(resize);
    observer.observe(container);

    let frame = 0;
    let disposed = false;
    const animate = (): void => {
      if (disposed) return;
      frame = requestAnimationFrame(animate);
      // Damping keeps easing the camera for a while after the pointer stops, so
      // update() has to run every frame. It fires `change` when it moves the
      // camera, which is what flags the frame as needing a draw; a still scene
      // therefore costs nothing, which is what keeps a large mesh responsive.
      controls.update();
      if (!renderPendingRef.current) return;
      renderPendingRef.current = false;
      // Detail levels depend on where the camera ended up, so they are picked
      // for the frame about to be drawn rather than the one just finished.
      sceneGraph.updateLod(camera);
      renderer.render(scene, camera);
    };
    animate();

    const onContextLost = (event: Event): void => {
      event.preventDefault();
      setError('GPU context lost — attempting to recover…');
    };
    const onContextRestored = (): void => {
      setError(null);
      // The restored context starts with an empty drawing buffer, so the scene
      // has to be drawn again even though nothing about it changed.
      requestRender();
    };
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
      // Some of these change what the next frame looks like without moving the
      // camera, and the controls only ever report movement: an orthographic
      // zoom just writes `camera.zoom`, and a reset lands an already-default
      // camera back on the pose it was already on. Neither produces a `change`,
      // so the on-demand loop would sit still with a stale viewport. Asking for
      // the frame here covers every action instead of relying on each helper to
      // remember, and costs nothing when `change` fires too - both set the same
      // flag, which the loop clears after a single draw.
      requestRender();
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
      controls.removeEventListener('change', requestRender);
      controlsRef.current = null;
      cameraRef.current = null;
      sceneGraph.dispose();
      sceneGraphRef.current = null;
      setLodCount(0);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [mesh, projection, background, requestRender]);

  useEffect(() => {
    sceneGraphRef.current?.root.traverse((object) => {
      applyWireframe(object, wireframe);
    });
    requestRender();
  }, [wireframe, requestRender]);

  useEffect(() => {
    sceneGraphRef.current?.setHidden(hiddenObjects);
    requestRender();
  }, [hiddenObjects, requestRender]);

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
    requestRender();
  }, [resetToken, requestRender]);

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
      {lodCount > 0 && (
        <p className="viewer-lod-note">
          {lodCount === 1 ? '1 large part is' : `${lodCount} large parts are`}{' '}
          drawn at reduced detail when zoomed out.
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

function isViewerMesh(object: THREE.Object3D): object is ViewerMesh {
  return object instanceof THREE.Mesh;
}

function applyWireframe(object: THREE.Object3D, wireframe: boolean): void {
  if (!isViewerMesh(object)) return;
  const { material } = object;
  if (Array.isArray(material)) {
    material.forEach((entry) => {
      if (entry instanceof THREE.MeshStandardMaterial) {
        entry.wireframe = wireframe;
      }
    });
    return;
  }
  if (material instanceof THREE.MeshStandardMaterial) {
    material.wireframe = wireframe;
  }
}

/**
 * Build the camera for a projection. Exported so the tests can frame a scene
 * through the same code the viewer uses instead of reproducing it.
 */
export function createCamera(
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

/**
 * Size an orthographic frustum to the model. Exported so the tests can assert
 * against the frustum the viewer actually builds rather than rebuilding it:
 * a test that recomputes `radius * ORTHO_FRUSTUM_MULTIPLIER` itself pins the
 * constant while leaving this function free to change underneath it.
 *
 * The projection matrix is rebuilt here because this function is the thing that
 * invalidated it. Without that, `createCamera('orthographic', …)` returned a
 * camera whose `top` was `radius * ORTHO_FRUSTUM_MULTIPLIER` while its matrix
 * still held the `-1..1` placeholder from the constructor - measured at
 * radius 4, `top = 4.8` against a matrix half-height of `1`, so anything drawn
 * with it appeared at 0.208x the framed size. The viewer never saw it only
 * because `resize()` runs immediately afterwards and calls
 * `updateProjectionMatrix()` itself.
 */
export function applyOrthoFrustum(
  camera: THREE.OrthographicCamera,
  radius: number,
  aspect: number,
): void {
  const halfHeight = radius * ORTHO_FRUSTUM_MULTIPLIER;
  const halfWidth = halfHeight * aspect;
  camera.left = -halfWidth;
  camera.right = halfWidth;
  camera.top = halfHeight;
  camera.bottom = -halfHeight;
  camera.updateProjectionMatrix();
}

/**
 * Place a camera so it frames a model of `radius` at `center`. Exported so the
 * tests can frame through production rather than restating it.
 *
 * The framing distance comes from the camera's *own* lens, not from
 * `PERSPECTIVE_FOV` directly. Today those are identical - `createCamera` is the
 * only thing that builds a perspective camera and it uses the constant - so
 * this is a no-op for the viewer. It matters because "frame this camera" is the
 * contract: a camera framed from a FOV other than the one it is looking through
 * is mis-framed, and reading the constant instead of the lens is the same
 * duplicated-literal shape #86 exists to delete.
 *
 * Because the framing is read off the live lens, the projection matrix is
 * rebuilt to match it. A caller that sets `fov` and then frames would otherwise
 * get a correct position against a matrix still holding the old lens: measured
 * at 45 -> 22.5 degrees, the model draws at 0.4802x the intended size, and the
 * LOD policy disagrees with the picture because `lodCameraOf` reads `fov` live
 * while the renderer reads the matrix.
 *
 * On why `PERSPECTIVE_FOV` is nonetheless left unpinned, see
 * `fitPerspectiveDistance` - the framing distance is *not* FOV-free, and the
 * reason #86 AC4 still holds is measured there rather than assumed here.
 */
export function frameCamera(
  camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
  center: [number, number, number],
  radius: number,
  aspect: number,
): void {
  const lens: FramingLens =
    camera instanceof THREE.PerspectiveCamera
      ? { projection: 'perspective', verticalFovDeg: camera.fov }
      : { projection: 'orthographic' };
  const [x, y, z] = defaultCameraPosition(center, radius, aspect, lens);
  camera.position.set(x, y, z);
  camera.lookAt(center[0], center[1], center[2]);
  if (lens.projection === 'perspective') camera.updateProjectionMatrix();
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
