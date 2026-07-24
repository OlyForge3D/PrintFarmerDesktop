import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

async function loadHarness() {
  vi.doMock('three', async (importOriginal) => {
    const actual = await importOriginal<typeof import('three')>();

    class MockWebGLRenderer {
      domElement = document.createElement('canvas');
      setPixelRatio = vi.fn();
      setSize = vi.fn();
      render = vi.fn();
      dispose = vi.fn();
    }

    return {
      ...actual,
      WebGLRenderer: MockWebGLRenderer,
    };
  });

  vi.doMock('../src/renderer/viewer/sceneGraph.js', () => ({
    buildViewerSceneGraph: vi.fn(),
  }));

  vi.doMock('three/examples/jsm/controls/OrbitControls.js', async () => {
    const THREE = await import('three');
    return {
      OrbitControls: class {
        object: unknown;
        domElement: HTMLElement;
        enableDamping = false;
        target = new THREE.Vector3();

        constructor(object: unknown, domElement: HTMLElement) {
          this.object = object;
          this.domElement = domElement;
        }

        update(): void {}

        dispose(): void {}
      },
    };
  });

  const THREE = await import('three');
  const { ModelViewer } = await import('../src/renderer/viewer/ModelViewer.js');
  const sceneGraphModule = await import('../src/renderer/viewer/sceneGraph.js');
  return {
    THREE,
    ModelViewer,
    buildViewerSceneGraph: vi.mocked(sceneGraphModule.buildViewerSceneGraph),
  };
}

describe('<ModelViewer />', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubGlobal('ResizeObserver', MockResizeObserver);
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  it('disposes the scene graph when the viewer unmounts', async () => {
    const { THREE, ModelViewer, buildViewerSceneGraph } = await loadHarness();
    const sceneGraph = {
      root: new THREE.Group(),
      setHidden: vi.fn(),
      dispose: vi.fn(),
    };
    buildViewerSceneGraph.mockReturnValue(sceneGraph);

    const { unmount } = render(<ModelViewer mesh={simpleMesh('mesh-a')} />);
    unmount();

    expect(sceneGraph.dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the previous scene graph when the mesh prop changes', async () => {
    const { THREE, ModelViewer, buildViewerSceneGraph } = await loadHarness();
    const firstSceneGraph = {
      root: new THREE.Group(),
      setHidden: vi.fn(),
      dispose: vi.fn(),
    };
    const secondSceneGraph = {
      root: new THREE.Group(),
      setHidden: vi.fn(),
      dispose: vi.fn(),
    };
    buildViewerSceneGraph
      .mockReturnValueOnce(firstSceneGraph)
      .mockReturnValueOnce(secondSceneGraph);

    const { rerender, unmount } = render(<ModelViewer mesh={simpleMesh('mesh-a')} />);
    rerender(<ModelViewer mesh={simpleMesh('mesh-b')} />);

    expect(firstSceneGraph.dispose).toHaveBeenCalledTimes(1);
    expect(secondSceneGraph.dispose).not.toHaveBeenCalled();

    unmount();
    expect(secondSceneGraph.dispose).toHaveBeenCalledTimes(1);
  });
});
