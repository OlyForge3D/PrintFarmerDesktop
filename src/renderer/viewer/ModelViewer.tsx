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
  fitPerspectiveDistance,
  toBufferGeometry,
} from './geometry';
import type { SceneMesh } from './types';

export type Projection = 'perspective' | 'orthographic';

export interface ModelViewerProps {
  mesh: SceneMesh;
  wireframe?: boolean;
  projection?: Projection;
  background?: string;
  className?: string;
}

const PERSPECTIVE_FOV = 45;

export function ModelViewer({
  mesh,
  wireframe = false,
  projection = 'perspective',
  background = '#14151a',
  className,
}: ModelViewerProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const materialRef = useRef<THREE.MeshStandardMaterial | null>(null);
  const wireframeRef = useRef(wireframe);
  wireframeRef.current = wireframe;
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

    const geometry = toBufferGeometry(mesh);
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
    const initialAspect = aspectOf(container);

    const camera = createCamera(projection, initialAspect, radius);
    frameCamera(camera, center, radius, initialAspect);

    const controls = new OrbitControls(camera, renderer.domElement);
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

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      renderer.domElement.removeEventListener(
        'webglcontextlost',
        onContextLost,
      );
      renderer.domElement.removeEventListener(
        'webglcontextrestored',
        onContextRestored,
      );
      controls.dispose();
      geometry.dispose();
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

  return (
    <div
      ref={containerRef}
      className={className}
      role="img"
      aria-label="3D model preview"
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
  camera: THREE.Camera,
  center: [number, number, number],
  radius: number,
  aspect: number,
): void {
  const distance =
    camera instanceof THREE.PerspectiveCamera
      ? fitPerspectiveDistance(PERSPECTIVE_FOV, aspect, radius)
      : radius * 4;
  camera.position.set(
    center[0] + distance,
    center[1] + distance,
    center[2] + distance,
  );
  camera.lookAt(center[0], center[1], center[2]);
}
