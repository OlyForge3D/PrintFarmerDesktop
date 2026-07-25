import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  PreviewWorkspace,
  type PreviewWorkspaceProps,
} from '../src/renderer/viewer/PreviewWorkspace';
import type { SceneMesh } from '../src/renderer/viewer/types';

// The workspace shell is the unit under test here; the GPU-bound viewer has its
// own suite (`viewer.modelViewer.test.tsx`) and cannot build a WebGL context in
// jsdom.
vi.mock('../src/renderer/viewer/ModelViewer', () => ({
  ModelViewer: () => <div data-testid="model-viewer" />,
}));

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function sceneMesh(): SceneMesh {
  return {
    sceneVersion: 2,
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    indices: [0, 1, 2],
    bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    sourceFormat: 'threeMf',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects: [
      {
        id: 'body',
        sourceId: 'object-1',
        name: 'Body',
        parentId: null,
        children: ['lid'],
        transform: { matrix: IDENTITY },
        mesh: null,
        material: {},
        plateId: 'plate-0',
        buildItemIndex: 0,
      },
      {
        id: 'lid',
        sourceId: 'object-2',
        name: 'Lid',
        parentId: 'body',
        children: [],
        transform: { matrix: IDENTITY },
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
    rootObjectIds: ['body'],
    plates: [
      { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
    ],
  };
}

/** A two-plate 3MF, the shape the sidecar emits for a Bambu/Orca project. */
function multiPlateSceneMesh(): SceneMesh {
  const base = sceneMesh();
  const second = {
    ...base.objects[0]!,
    id: 'spare',
    sourceId: 'object-3',
    children: [],
    plateId: 'plate-1',
    buildItemIndex: 1,
  };
  return {
    ...base,
    objects: [...base.objects, second],
    rootObjectIds: ['body', 'spare'],
    plates: [
      { id: 'plate-0', name: 'Plate 1', index: 0, rootObjectIds: ['body'] },
      { id: 'plate-1', name: 'Plate 2', index: 1, rootObjectIds: ['spare'] },
    ],
  };
}

function baseProps(): PreviewWorkspaceProps {
  return {
    name: 'widget.3mf',
    loading: false,
    error: null,
    mesh: null,
    vendorMetadata: null,
    wireframe: false,
    projection: 'perspective',
    resetToken: 0,
    hiddenObjects: new Set(),
    isolatedObject: null,
    onClose: vi.fn(),
    onRetry: vi.fn(),
    onToggleWireframe: vi.fn(),
    onToggleProjection: vi.fn(),
    onReset: vi.fn(),
    onToggleObject: vi.fn(),
    onToggleAllObjects: vi.fn(),
    onTogglePlate: vi.fn(),
    onSelectPlate: vi.fn(),
    onIsolateObject: vi.fn(),
  };
}

describe('<PreviewWorkspace />', () => {
  it('contains focus, cycles Tab, and closes on Escape', () => {
    const onClose = vi.fn();
    const props: PreviewWorkspaceProps = {
      name: 'widget.stl',
      loading: false,
      error: 'Could not parse model',
      mesh: null,
      vendorMetadata: null,
      wireframe: false,
      projection: 'perspective',
      resetToken: 0,
      hiddenObjects: new Set(),
      isolatedObject: null,
      onClose,
      onRetry: vi.fn(),
      onToggleWireframe: vi.fn(),
      onToggleProjection: vi.fn(),
      onReset: vi.fn(),
      onToggleObject: vi.fn(),
      onToggleAllObjects: vi.fn(),
      onTogglePlate: vi.fn(),
      onSelectPlate: vi.fn(),
      onIsolateObject: vi.fn(),
    };
    const { rerender } = render(
      <>
        <button type="button">Background action</button>
        <PreviewWorkspace {...props} />
      </>,
    );

    const back = screen.getByRole('button', { name: 'Back to library' });
    const close = screen.getByRole('button', { name: 'Close' });
    const background = screen.getByRole('button', {
      name: 'Background action',
    });
    expect(back).toHaveFocus();

    background.focus();
    expect(back).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(close).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(back).toHaveFocus();

    screen.getByRole('button', { name: 'Retry' }).focus();
    rerender(
      <>
        <button type="button">Background action</button>
        <PreviewWorkspace {...props} loading error={null} />
      </>,
    );
    expect(
      screen.getByRole('button', { name: 'Back to library' }),
    ).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('renders the scene tree and forwards isolation to the app', () => {
    const props = { ...baseProps(), mesh: sceneMesh() };
    render(<PreviewWorkspace {...props} />);

    const tree = screen.getByRole('tree', { name: 'Scene objects' });
    expect(within(tree).getAllByRole('treeitem')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Isolate Lid' }));
    expect(props.onIsolateObject).toHaveBeenCalledWith('lid');

    fireEvent.click(screen.getByRole('button', { name: 'Hide Lid' }));
    expect(props.onToggleObject).toHaveBeenCalledWith('lid');

    fireEvent.click(screen.getByRole('button', { name: 'Hide Plate 1' }));
    expect(props.onTogglePlate).toHaveBeenCalledWith('plate-0', false);
  });

  it('keeps the tree row actions out of the modal Tab cycle', () => {
    const props = { ...baseProps(), mesh: sceneMesh() };
    render(<PreviewWorkspace {...props} />);

    const back = screen.getByRole('button', { name: 'Back to library' });
    expect(back).toHaveFocus();

    // The tree exposes a single roving tab stop, so Shift+Tab off the first
    // control must land on the tree row rather than on a `tabindex="-1"`
    // hide/isolate button.
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('treeitem', { name: 'Plate 1' })).toHaveFocus();
  });

  it('omits the plate selector for a single-plate scene', () => {
    render(<PreviewWorkspace {...baseProps()} mesh={sceneMesh()} />);

    expect(screen.queryByRole('group', { name: 'Plate' })).toBeNull();
  });

  it('offers a plate selector and forwards the choice for a multi-plate scene', () => {
    const props = { ...baseProps(), mesh: multiPlateSceneMesh() };
    render(<PreviewWorkspace {...props} />);

    const selector = screen.getByRole('group', { name: 'Plate' });
    expect(
      within(selector)
        .getAllByRole('radio')
        .map((radio) => radio.getAttribute('value')),
    ).toEqual(['all', 'plate-0', 'plate-1']);

    fireEvent.click(within(selector).getByRole('radio', { name: 'Plate 2' }));
    expect(props.onSelectPlate).toHaveBeenCalledWith('plate-1');
  });
});
