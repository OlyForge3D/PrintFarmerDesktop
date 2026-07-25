import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SceneMesh } from '../src/renderer/viewer/types';

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

        constructor(object: unknown, domElement: HTMLElement) {
          super();
          this.object = object;
          this.domElement = domElement;
          controls.push(this);
        }

        update(): boolean {
          return false;
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
});

/** Above both LOD thresholds, so exactly one object gets a proxy. */
function heavyMesh(): SceneMesh {
  const steps = 420;
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

  const base = simpleMesh('dense');
  return {
    ...base,
    objects: base.objects.map((object) => ({
      ...object,
      mesh: {
        positions,
        indices,
        bounds: { min: [0, 0, -step], max: [1, 1, step] },
      },
    })),
  };
}
