import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SceneMesh } from '../src/renderer/viewer/types';
// Safe to import statically despite the `three` mock below: `lod.ts` is pure
// and GPU-free, with no runtime dependency on three.js.
import {
  LOD_MIN_TRIANGLES,
  simplifyMesh,
  triangleCount,
} from '../src/renderer/viewer/lod';
// Type-only: the runtime import is dynamic so the `three` mock can be hoisted
// into place first, but the level assertions still need the real types.
import type * as ThreeNs from 'three';

class MockResizeObserver {
  observe(): void {}
  disconnect(): void {}
}

function simpleMesh(id: string): SceneMesh {
  return {
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    sourceFormat: 'stl',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [
      {
        id,
        sourceId: `${id}-source`,
        name: id,
        parentId: null,
        children: [],
        transform: {
          matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
        },
        mesh: {
          positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
          indices: [0, 1, 2],
          bounds: { min: [0, 0, 0], max: [1, 1, 0] },
        },
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
    ],
    rootObjectIds: [id],
    plates: [{ id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: [id] }],
  };
}

/** Captured across a `loadHarness()` call so tests can drive the render loop. */
const renderers: MockWebGLRendererLike[] = [];
const controls: MockOrbitControlsLike[] = [];

interface MockWebGLRendererLike {
  domElement: HTMLCanvasElement;
  render: ReturnType<typeof vi.fn>;
}

interface MockOrbitControlsLike {
  dispatchEvent(event: { type: 'change' }): void;
  addEventListener(type: 'change', listener: () => void): void;
  update(): boolean;
}

async function loadHarness() {
  renderers.length = 0;
  controls.length = 0;

  vi.doMock('three', async (importOriginal) => {
    const actual = await importOriginal<typeof import('three')>();

    class MockWebGLRenderer {
      domElement = document.createElement('canvas');
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      render = vi.fn();
      dispose = vi.fn();

      constructor() {
        renderers.push(this);
      }
    }

    return {
      ...actual,
      WebGLRenderer: MockWebGLRenderer,
    };
  });

  vi.doMock('three/examples/jsm/controls/OrbitControls.js', async () => {
    const THREE = await import('three');
    return {
      // Extending EventDispatcher gives the mock the real add/removeEventListener
      // and dispatchEvent, so a test can fire the `change` event the viewer's
      // on-demand render loop actually listens for.
      OrbitControls: class extends THREE.EventDispatcher<{
        change: { type: 'change' };
      }> {
        object: unknown;
        domElement: HTMLElement;
        enableDamping = false;
        target = new THREE.Vector3();
        // The real controls decide whether to fire `change` by comparing the
        // camera pose against the last one they saw, and stay silent when
        // nothing moved. Modelling that is what makes these tests able to tell
        // "the viewer repainted" from "the mock announced something": a mock
        // that never fired would report every camera path as broken, and one
        // that always fired would hide a missing invalidation. Deliberately
        // omitted is the controls' own `zoomChanged` flag, because nothing in
        // the viewer drives zoom through the controls - which is precisely the
        // gap an external write to `camera.zoom` falls through.
        lastPosition = new THREE.Vector3(NaN, NaN, NaN);
        lastQuaternion = new THREE.Quaternion(NaN, NaN, NaN, NaN);

        constructor(object: unknown, domElement: HTMLElement) {
          super();
          this.object = object;
          this.domElement = domElement;
          controls.push(this);
        }

        update(): boolean {
          const camera = this.object as ThreeNs.Camera;
          const moved =
            !camera.position.equals(this.lastPosition) ||
            !camera.quaternion.equals(this.lastQuaternion);
          this.lastPosition.copy(camera.position);
          this.lastQuaternion.copy(camera.quaternion);
          if (!moved) return false;
          this.dispatchEvent({ type: 'change' });
          return true;
        }

        dispose(): void {}
      },
    };
  });

  const THREE = await import('three');
  const { ModelViewer } = await import('../src/renderer/viewer/ModelViewer.js');
  return {
    THREE,
    ModelViewer,
    lastRenderer: (): MockWebGLRendererLike => renderers[renderers.length - 1]!,
    lastControls: (): MockOrbitControlsLike => controls[controls.length - 1]!,
  };
}

describe('<ModelViewer />', () => {
  /** Callbacks queued by requestAnimationFrame, drained by `runFrame`. */
  let pendingFrames: FrameRequestCallback[] = [];

  /** Run exactly one animation frame of the viewer's render loop. */
  function runFrame(): void {
    const queued = pendingFrames;
    pendingFrames = [];
    for (const callback of queued) callback(0);
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    pendingFrames = [];
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        pendingFrames.push(callback);
        return pendingFrames.length;
      }),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('disposes the scene graph when the viewer unmounts', async () => {
    const { THREE, ModelViewer } = await loadHarness();
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const mesh = simpleMesh('mesh-a');

    const { rerender, unmount } = render(<ModelViewer mesh={mesh} />);

    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    rerender(<ModelViewer mesh={mesh} />);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    unmount();

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the previous scene graph when the mesh prop changes', async () => {
    const { THREE, ModelViewer } = await loadHarness();
    const geometryDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const materialDispose = vi.spyOn(THREE.Material.prototype, 'dispose');
    const meshA = simpleMesh('mesh-a');

    const { rerender, unmount } = render(<ModelViewer mesh={meshA} />);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    rerender(<ModelViewer mesh={meshA} />);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    rerender(<ModelViewer mesh={simpleMesh('mesh-b')} />);

    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);

    unmount();
    expect(geometryDispose).toHaveBeenCalledTimes(2);
    expect(materialDispose).toHaveBeenCalledTimes(2);
  });

  describe('on-demand rendering', () => {
    /**
     * Run frames until the viewer stops drawing, then clear the spy. Mount
     * effects each request a frame, so the count immediately after render is an
     * implementation detail; what matters is that it reaches a resting state.
     */
    function settle(renderer: MockWebGLRendererLike): void {
      for (let i = 0; i < 10; i += 1) runFrame();
      expect(renderer.render.mock.calls.length).toBeGreaterThan(0);
      renderer.render.mockClear();
    }

    it('draws on mount', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();

      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);

      expect(lastRenderer().render).toHaveBeenCalled();
      unmount();
    });

    it('stops drawing once the scene is still', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
      const renderer = lastRenderer();
      settle(renderer);

      // The unconditional loop this replaced drew on every one of these.
      for (let i = 0; i < 20; i += 1) runFrame();

      expect(renderer.render).not.toHaveBeenCalled();
      unmount();
    });

    it('keeps requesting frames while idle, so it can resume instantly', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
      settle(lastRenderer());

      // Skipping the draw must not skip scheduling: a loop that stopped
      // queueing frames would never notice the next camera change.
      for (let i = 0; i < 5; i += 1) {
        expect(pendingFrames).toHaveLength(1);
        runFrame();
      }

      unmount();
    });

    it('draws again when the controls report a camera change', async () => {
      const { ModelViewer, lastRenderer, lastControls } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
      const renderer = lastRenderer();
      settle(renderer);

      lastControls().dispatchEvent({ type: 'change' });
      runFrame();

      expect(renderer.render).toHaveBeenCalledTimes(1);
      // One change buys exactly one frame, not a resumed continuous loop.
      runFrame();
      expect(renderer.render).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('reports movement to the viewer only when the camera actually moved', async () => {
      const { ModelViewer, lastRenderer, lastControls } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
      const renderer = lastRenderer();
      const camera = renderer.render.mock.calls[0]?.[1] as
        ThreeNs.Camera | undefined;
      if (!camera) throw new Error('the viewer never drew a first frame');
      const controls = lastControls();
      settle(renderer);

      const changes: string[] = [];
      controls.addEventListener('change', () => changes.push('change'));

      // The stub this double replaced returned `false` unconditionally and
      // never dispatched. Every keyboard test tolerates that stub, because
      // `requestRender` fires for a handled key whether or not the controls
      // say anything - so those tests would keep passing against a double that
      // reports nothing at all, and the camera cases below would no longer be
      // controls. Asserting the discrimination here is what stops the harness
      // regressing to that fiction unnoticed.
      expect(controls.update()).toBe(false);
      expect(changes).toEqual([]);

      camera.position.x += 1;

      expect(controls.update()).toBe(true);
      expect(changes).toEqual(['change']);

      // Settles again rather than latching, matching the real controls. A
      // double that stayed `true` would hide any missing invalidation.
      expect(controls.update()).toBe(false);
      expect(changes).toEqual(['change']);
      unmount();
    });

    it('draws again when the wireframe toggle changes', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();
      const mesh = simpleMesh('m');
      const { rerender, unmount } = render(<ModelViewer mesh={mesh} />);
      const renderer = lastRenderer();
      settle(renderer);

      rerender(<ModelViewer mesh={mesh} wireframe />);
      runFrame();

      expect(renderer.render).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('draws again when the hidden set changes', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();
      const mesh = simpleMesh('m');
      const { rerender, unmount } = render(
        <ModelViewer mesh={mesh} hiddenObjects={new Set()} />,
      );
      const renderer = lastRenderer();
      settle(renderer);

      rerender(<ModelViewer mesh={mesh} hiddenObjects={new Set(['m'])} />);
      runFrame();

      expect(renderer.render).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('draws again when the view is reset', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();
      const mesh = simpleMesh('m');
      const { rerender, unmount } = render(
        <ModelViewer mesh={mesh} resetToken={0} />,
      );
      const renderer = lastRenderer();
      settle(renderer);

      rerender(<ModelViewer mesh={mesh} resetToken={1} />);
      runFrame();

      expect(renderer.render).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('redraws after the GPU context is restored', async () => {
      const { ModelViewer, lastRenderer } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
      const renderer = lastRenderer();
      settle(renderer);

      // A restored context comes back with an empty drawing buffer, so a
      // viewer that only drew on camera changes would stay blank.
      renderer.domElement.dispatchEvent(new Event('webglcontextrestored'));
      runFrame();

      expect(renderer.render).toHaveBeenCalledTimes(1);
      unmount();
    });

    it('stops drawing after unmount', async () => {
      const { ModelViewer, lastRenderer, lastControls } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
      const renderer = lastRenderer();
      const orbit = lastControls();
      settle(renderer);

      unmount();
      orbit.dispatchEvent({ type: 'change' });
      runFrame();

      expect(renderer.render).not.toHaveBeenCalled();
    });

    describe('keyboard camera actions', () => {
      /**
       * Draw one frame, hand back the camera the viewer is actually using, then
       * settle. Tests need the camera to show that a key was acted on at all,
       * separately from whether the screen was repainted - those are the two
       * halves this bug came apart along.
       */
      function cameraAfterFirstDraw(
        renderer: MockWebGLRendererLike,
      ): ThreeNs.Camera {
        runFrame();
        const camera = renderer.render.mock.calls[0]?.[1] as
          ThreeNs.Camera | undefined;
        if (!camera) throw new Error('the viewer never drew a first frame');
        settle(renderer);
        return camera;
      }

      function pressKey(key: string): void {
        fireEvent.keyDown(screen.getByRole('application'), { key });
      }

      it('redraws when the camera is orbited from the keyboard', async () => {
        const { ModelViewer, lastRenderer } = await loadHarness();
        const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
        const renderer = lastRenderer();
        settle(renderer);

        pressKey('ArrowLeft');
        runFrame();

        // Control. Orbiting moves the camera pose, which the controls do
        // observe, so this repaints through `change` on its own. It passing
        // while the orthographic cases below fail is what shows the harness
        // reports real movement rather than nothing at all.
        expect(renderer.render).toHaveBeenCalledTimes(1);
        unmount();
      });

      it('redraws when a perspective camera is zoomed from the keyboard', async () => {
        const { ModelViewer, lastRenderer } = await loadHarness();
        const { unmount } = render(
          <ModelViewer mesh={simpleMesh('m')} projection="perspective" />,
        );
        const renderer = lastRenderer();
        const camera = cameraAfterFirstDraw(renderer);
        const pose = camera.position.clone();

        pressKey('+');
        runFrame();

        // Control. Same key and same handler as the orthographic case; the only
        // difference is that a perspective dolly moves the camera, so the
        // controls see it. This is why the bug was projection-specific.
        expect(camera.position.equals(pose)).toBe(false);
        expect(renderer.render).toHaveBeenCalledTimes(1);
        unmount();
      });

      it('redraws when an orthographic camera is zoomed from the keyboard', async () => {
        const { ModelViewer, lastRenderer } = await loadHarness();
        const { unmount } = render(
          <ModelViewer mesh={simpleMesh('m')} projection="orthographic" />,
        );
        const renderer = lastRenderer();
        const camera = cameraAfterFirstDraw(
          renderer,
        ) as ThreeNs.OrthographicCamera;
        const pose = camera.position.clone();

        pressKey('+');
        runFrame();

        // An orthographic zoom writes `camera.zoom` and leaves the pose alone,
        // so the controls have nothing to report. Asserting the zoom changed is
        // not enough on its own - that was already true while the viewport sat
        // stale, which is exactly how this shipped.
        expect(camera.zoom).toBeGreaterThan(1);
        expect(camera.position.equals(pose)).toBe(true);
        expect(renderer.render).toHaveBeenCalledTimes(1);
        unmount();
      });

      it('redraws when the view is reset from the keyboard after an orthographic zoom', async () => {
        const { ModelViewer, lastRenderer } = await loadHarness();
        const { unmount } = render(
          <ModelViewer mesh={simpleMesh('m')} projection="orthographic" />,
        );
        const renderer = lastRenderer();
        const camera = cameraAfterFirstDraw(
          renderer,
        ) as ThreeNs.OrthographicCamera;

        pressKey('+');
        runFrame();
        renderer.render.mockClear();

        pressKey('r');
        runFrame();

        // Reset restores zoom to 1, but framing puts an already-default camera
        // back on the pose it was already on, so this path is silent for the
        // same reason the zoom is. Repairing only the zoom would leave R
        // showing the zoomed image forever.
        expect(camera.zoom).toBe(1);
        expect(renderer.render).toHaveBeenCalledTimes(1);
        unmount();
      });

      it('leaves the viewport alone for keys it does not handle', async () => {
        const { ModelViewer, lastRenderer } = await loadHarness();
        const { unmount } = render(<ModelViewer mesh={simpleMesh('m')} />);
        const renderer = lastRenderer();
        settle(renderer);

        pressKey('Tab');
        pressKey('a');
        pressKey('Escape');
        runFrame();

        // `requestRender` sits below the `viewerKeyAction` guard on purpose:
        // above it, every keystroke reaching the container buys a frame, which
        // is the on-demand gate #88 set out to preserve. Every other key press
        // in this file is a handled one, so without a negative case the call
        // could move above the guard and no test would change colour.
        expect(renderer.render).not.toHaveBeenCalled();
        unmount();
      });
    });
  });

  describe('reduced-detail note', () => {
    it('stays hidden for a scene that keeps full detail', async () => {
      const { ModelViewer } = await loadHarness();
      const { container, unmount } = render(
        <ModelViewer mesh={simpleMesh('m')} />,
      );

      expect(container.querySelector('.viewer-lod-note')).toBeNull();
      unmount();
    });

    it('tells the user which parts were simplified', async () => {
      const { ModelViewer } = await loadHarness();
      const { container, unmount } = render(<ModelViewer mesh={heavyMesh()} />);

      expect(container.querySelector('.viewer-lod-note')?.textContent).toBe(
        '1 large part is drawn at reduced detail when zoomed out.',
      );
      unmount();
    });

    it('counts only the parts over the floor, not every part in a heavy scene', async () => {
      // The note names "large parts". A scene qualifying for LOD used to give
      // every object with geometry a proxy, so a modest part sitting well under
      // the per-object floor was counted and described to the user as large.
      const { ModelViewer } = await loadHarness();
      const mesh = heavyMeshWithModestPart();
      const modest = mesh.objects.find((object) => object.id === 'modest')!;
      expect(triangleCount(modest.mesh!)).toBeLessThan(LOD_MIN_TRIANGLES);
      expect(simplifyMesh(modest.mesh!)).not.toBeNull();

      const { container, unmount } = render(<ModelViewer mesh={mesh} />);

      expect(container.querySelector('.viewer-lod-note')?.textContent).toBe(
        '1 large part is drawn at reduced detail when zoomed out.',
      );
      unmount();
    });

    it('clears the note when a lighter mesh replaces the heavy one', async () => {
      const { ModelViewer } = await loadHarness();
      const { container, rerender, unmount } = render(
        <ModelViewer mesh={heavyMesh()} />,
      );
      expect(container.querySelector('.viewer-lod-note')).not.toBeNull();

      rerender(<ModelViewer mesh={simpleMesh('light')} />);

      expect(container.querySelector('.viewer-lod-note')).toBeNull();
      unmount();
    });
  });

  describe('detail level selection', () => {
    /** The LOD node and its two levels out of the scene actually drawn. */
    function levelsOfLastDraw(
      THREE: typeof ThreeNs,
      renderer: MockWebGLRendererLike,
    ): { near: ThreeNs.Object3D; far: ThreeNs.Object3D } {
      const calls = renderer.render.mock.calls;
      const scene = calls[calls.length - 1]![0] as ThreeNs.Object3D;
      let lod: ThreeNs.LOD | null = null;
      scene.traverse((node: ThreeNs.Object3D) => {
        if (node instanceof THREE.LOD) lod = node;
      });
      if (!lod) throw new Error('no LOD node in the rendered scene');
      const levels = (lod as ThreeNs.LOD).levels;
      return { near: levels[0]!.object, far: levels[1]!.object };
    }

    it('draws the full-detail mesh at the framing the viewer opens with', async () => {
      // The defect this guards: the proxy used to be the active level from the
      // first frame, so a large model never showed its real geometry until the
      // user zoomed in.
      const { THREE, ModelViewer, lastRenderer } = await loadHarness();
      const { unmount } = render(<ModelViewer mesh={heavyMesh()} />);
      const renderer = lastRenderer();
      runFrame();

      const { near, far } = levelsOfLastDraw(THREE, renderer);

      expect(near.visible).toBe(true);
      expect(far.visible).toBe(false);
      unmount();
    });

    it('switches to the proxy once the camera pulls far enough out', async () => {
      const { THREE, ModelViewer, lastRenderer, lastControls } =
        await loadHarness();
      const { unmount } = render(<ModelViewer mesh={heavyMesh()} />);
      const renderer = lastRenderer();
      runFrame();
      const camera = renderer.render.mock.calls[0]![1] as ThreeNs.Camera;

      camera.position.set(400, 400, 400);
      camera.updateMatrixWorld(true);
      // The same event a drag or a dolly fires, which is what flags the frame.
      lastControls().dispatchEvent({ type: 'change' });
      runFrame();

      const { near, far } = levelsOfLastDraw(THREE, renderer);

      expect(near.visible).toBe(false);
      expect(far.visible).toBe(true);
      unmount();
    });
  });
});

/** Above both LOD thresholds, so exactly one object gets a proxy. */
function gridGeometry(steps: number): {
  positions: number[];
  indices: number[];
  bounds: { min: [number, number, number]; max: [number, number, number] };
} {
  const positions: number[] = [];
  const indices: number[] = [];
  const step = 1 / steps;
  for (let y = 0; y <= steps; y += 1) {
    for (let x = 0; x <= steps; x += 1) {
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
  return {
    positions,
    indices,
    bounds: { min: [0, 0, -step], max: [1, 1, step] },
  };
}

function heavyMesh(): SceneMesh {
  const dense = gridGeometry(420);
  const base = simpleMesh('dense');
  return {
    ...base,
    objects: base.objects.map((object) => ({ ...object, mesh: dense })),
  };
}

/**
 * One object over the per-object floor and one well under it, both compressible.
 *
 * `heavyMesh()` carries a single object, so its "1 large part" note is 1 no
 * matter what the policy does. Only a second, sub-floor object can show whether
 * the count describes large parts or merely all of them.
 */
function heavyMeshWithModestPart(): SceneMesh {
  const heavy = heavyMesh();
  const modest = gridGeometry(60);
  const [dense] = heavy.objects;
  return {
    ...heavy,
    objects: [
      dense!,
      {
        ...dense!,
        id: 'modest',
        sourceId: 'modest-source',
        name: 'modest',
        mesh: modest,
      },
    ],
    rootObjectIds: ['dense', 'modest'],
    plates: [
      {
        id: 'plate-0',
        name: 'Plate 1',
        index: 0,
        rootObjectIds: ['dense', 'modest'],
      },
    ],
  };
}
