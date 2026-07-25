import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { MaterialsPanel } from '../src/renderer/library/MaterialsPanel';
import {
  DEFAULT_BASE_COLOR,
  summarizeSceneMaterials,
  toHex,
} from '../src/renderer/library/sceneMaterials';
import {
  formatMetadataDate,
  VendorPanel,
} from '../src/renderer/library/VendorPanel';
import type {
  SceneMaterial,
  SceneMesh,
  SceneObject,
} from '../src/renderer/viewer/types';
import type { VendorMetadata } from '../src/shared/ipc';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function object(
  id: string,
  triangles: number,
  material: SceneMaterial,
  name = id,
): SceneObject {
  return {
    id,
    sourceId: `${id}#source`,
    name,
    parentId: null,
    children: [],
    transform: { matrix: IDENTITY },
    mesh: {
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
      indices: Array.from({ length: triangles * 3 }, (_, i) => i % 3),
      bounds: { min: [0, 0, 0], max: [1, 1, 0] },
    },
    material,
    plateId: 'plate-0',
    buildItemIndex: 0,
  };
}

function scene(objects: readonly SceneObject[]): SceneMesh {
  return {
    sceneVersion: 2,
    positions: [],
    indices: [],
    bounds: { min: [0, 0, 0], max: [1, 1, 1] },
    sourceFormat: 'threeMf',
    faceColors: null,
    status: 'complete',
    statusMessages: [],
    parts: [],
    objects,
    rootObjectIds: objects.map((entry) => entry.id),
    plates: [],
  };
}

describe('toHex', () => {
  it('pads each channel to two digits', () => {
    expect(toHex([0, 8, 255])).toBe('#0008ff');
  });

  it('clamps and rounds out-of-range channels', () => {
    expect(toHex([-20, 127.6, 900])).toBe('#0080ff');
  });

  it('renders a non-finite channel as zero rather than NaN', () => {
    expect(toHex([Number.NaN, 0, 0])).toBe('#000000');
  });
});

describe('summarizeSceneMaterials', () => {
  it('groups objects sharing a colour', () => {
    const summary = summarizeSceneMaterials(
      scene([
        object('a', 10, { baseColor: [255, 0, 0] }),
        object('b', 5, { baseColor: [255, 0, 0] }),
        object('c', 3, { baseColor: [0, 0, 255] }),
      ]),
    );

    expect(summary.groups).toHaveLength(2);
    expect(summary.groups[0]).toMatchObject({
      hex: '#ff0000',
      objects: 2,
      triangles: 15,
      isDefault: false,
    });
    expect(summary.groups[1]).toMatchObject({ hex: '#0000ff', objects: 1 });
  });

  it('orders the heaviest material first', () => {
    const summary = summarizeSceneMaterials(
      scene([
        object('light', 1, { baseColor: [0, 255, 0] }),
        object('heavy', 100, { baseColor: [255, 0, 0] }),
      ]),
    );

    expect(summary.groups.map((group) => group.hex)).toEqual([
      '#ff0000',
      '#00ff00',
    ]);
  });

  it('breaks equal triangle counts by first appearance, not Map order', () => {
    const summary = summarizeSceneMaterials(
      scene([
        object('second-colour', 5, { baseColor: [0, 0, 255] }),
        object('first-colour', 5, { baseColor: [255, 0, 0] }),
      ]),
    );

    expect(summary.groups.map((group) => group.hex)).toEqual([
      '#0000ff',
      '#ff0000',
    ]);
  });

  it('collects unauthored objects under the viewer fallback', () => {
    const summary = summarizeSceneMaterials(
      scene([object('a', 4, {}), object('b', 2, { baseColor: null })]),
    );

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]).toMatchObject({
      hex: toHex(DEFAULT_BASE_COLOR),
      objects: 2,
      isDefault: true,
    });
  });

  it('does not call a group default when any member authored that colour', () => {
    // Otherwise a model that deliberately uses the fallback grey would be
    // reported as having no material information.
    const summary = summarizeSceneMaterials(
      scene([
        object('unauthored', 1, {}),
        object('authored', 1, { baseColor: [...DEFAULT_BASE_COLOR] }),
      ]),
    );

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.isDefault).toBe(false);
  });

  it('does not call a group default when the authored object comes first', () => {
    // The rule is "authored anywhere wins", which a last-object-wins assignment
    // also satisfies whenever the authored object happens to be last. Only the
    // reverse order distinguishes the two.
    const summary = summarizeSceneMaterials(
      scene([
        object('authored', 1, { baseColor: [...DEFAULT_BASE_COLOR] }),
        object('unauthored', 1, {}),
      ]),
    );

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.isDefault).toBe(false);
  });

  it('reports per-face triangles separately instead of folding them into a swatch', () => {
    const summary = summarizeSceneMaterials(
      scene([
        object('painted', 6, { faceColors: [255, 0, 0, 0, 255, 0] }),
        object('plain', 2, { baseColor: [1, 2, 3] }),
      ]),
    );

    expect(summary.perFaceTriangles).toBe(6);
    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.hex).toBe('#010203');
  });

  it('ignores an empty face-colour array', () => {
    const summary = summarizeSceneMaterials(
      scene([object('a', 3, { baseColor: [1, 2, 3], faceColors: [] })]),
    );

    expect(summary.perFaceTriangles).toBe(0);
    expect(summary.groups[0]?.triangles).toBe(3);
  });

  it('skips objects with no geometry', () => {
    const container: SceneObject = {
      ...object('container', 0, { baseColor: [9, 9, 9] }),
      mesh: null,
    };
    const summary = summarizeSceneMaterials(
      scene([container, object('leaf', 2, { baseColor: [1, 1, 1] })]),
    );

    expect(summary.groups).toHaveLength(1);
    expect(summary.groups[0]?.hex).toBe('#010101');
  });

  it('lists each object name once per colour', () => {
    const summary = summarizeSceneMaterials(
      scene([
        object('a', 1, { baseColor: [1, 1, 1] }, 'Body'),
        object('b', 1, { baseColor: [1, 1, 1] }, 'Body'),
        object('c', 1, { baseColor: [1, 1, 1] }, 'Lid'),
      ]),
    );

    expect(summary.groups[0]?.objectNames).toEqual(['Body', 'Lid']);
  });

  it('returns nothing for an empty scene', () => {
    expect(summarizeSceneMaterials(scene([]))).toEqual({
      groups: [],
      perFaceTriangles: 0,
    });
  });
});

describe('<MaterialsPanel />', () => {
  it('renders nothing when every object uses the fallback colour', () => {
    // A panel showing one row that says "default" is noise, not information.
    const { container } = render(
      <MaterialsPanel mesh={scene([object('a', 5, {})])} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing for a scene with no geometry', () => {
    const { container } = render(<MaterialsPanel mesh={scene([])} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('lists each authored colour with its part and triangle counts', () => {
    render(
      <MaterialsPanel
        mesh={scene([
          object('a', 10, { baseColor: [255, 0, 0] }),
          object('b', 1, { baseColor: [0, 0, 255] }),
        ])}
      />,
    );
    const items = within(
      screen.getByRole('list', { name: 'Materials' }),
    ).getAllByRole('listitem');

    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('#ff0000');
    expect(items[0]).toHaveTextContent('1 part · 10 triangles');
    expect(items[1]).toHaveTextContent('#0000ff');
    expect(items[1]).toHaveTextContent('1 part · 1 triangle');
  });

  it('labels the fallback group in words rather than as a colour code', () => {
    render(
      <MaterialsPanel
        mesh={scene([
          object('a', 5, {}),
          object('b', 5, { baseColor: [255, 0, 0] }),
        ])}
      />,
    );

    expect(screen.getByText('Default colour')).toBeInTheDocument();
  });

  it('reports per-face colouring as its own row', () => {
    render(
      <MaterialsPanel
        mesh={scene([object('a', 4, { faceColors: [1, 2, 3] })])}
      />,
    );

    expect(screen.getByText('Per-face colours')).toBeInTheDocument();
    expect(screen.getByText('4 triangles')).toBeInTheDocument();
  });

  it('gives the swatch no accessible name, since the colour is already text', () => {
    const { container } = render(
      <MaterialsPanel
        mesh={scene([object('a', 1, { baseColor: [1, 2, 3] })])}
      />,
    );
    const swatch = container.querySelector('.materials-swatch');

    expect(swatch).not.toBeNull();
    expect(swatch).toHaveAttribute('aria-hidden', 'true');
  });
});

function vendor(overrides: Partial<VendorMetadata> = {}): VendorMetadata {
  return {
    slicer: 'orcaSlicer',
    core: {},
    plates: [],
    thumbnails: [],
    ...overrides,
  };
}

describe('<VendorPanel /> attribution fields', () => {
  it('shows the description, copyright, and application it receives', () => {
    render(
      <VendorPanel
        metadata={vendor({
          core: {
            description: 'A benchy, but taller.',
            copyright: '© 2026 Someone',
            application: 'OrcaSlicer 2.1',
          },
        })}
      />,
    );

    expect(screen.getByText('A benchy, but taller.')).toBeInTheDocument();
    expect(screen.getByText('© 2026 Someone')).toBeInTheDocument();
    expect(screen.getByText('OrcaSlicer 2.1')).toBeInTheDocument();
  });

  it('formats ISO dates rather than printing the raw timestamp', () => {
    render(
      <VendorPanel
        metadata={vendor({ core: { creationDate: '2026-03-04T05:06:07Z' } })}
      />,
    );
    const value =
      screen.getByText('Created').parentElement?.querySelector('dd')
        ?.textContent ?? '';

    // "Not the raw string" is a consequence of formatting, not formatting: a
    // bare `value.slice(0, 10)` satisfies it too, and that is the first thing
    // anyone reaches for. Excluding the ISO *shape* kills that. The day is
    // deliberately not asserted — the value is UTC and renders in local time,
    // so the calendar day legitimately differs by timezone — and neither is a
    // Latin month name, which would pin CI to an English locale. Instead the
    // day is shown to reach the output by formatting two adjacent days, which
    // rules out a year- or month-only rendering without assuming a locale.
    expect(value).not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(value).toContain('2026');
    expect(formatMetadataDate('2026-03-04T05:06:07Z')).not.toBe(
      formatMetadataDate('2026-03-05T05:06:07Z'),
    );
  });

  it('shows an unparseable date verbatim instead of "Invalid Date"', () => {
    // The value comes straight out of the file, so it can be anything.
    render(
      <VendorPanel
        metadata={vendor({ core: { creationDate: 'last tuesday' } })}
      />,
    );

    expect(screen.getByText('last tuesday')).toBeInTheDocument();
  });

  it('still reports an empty payload as having no vendor metadata', () => {
    render(<VendorPanel metadata={vendor({ slicer: 'unknown' })} />);

    expect(
      screen.getByText('No slicer/vendor metadata in this file.'),
    ).toBeInTheDocument();
  });

  it('treats a description-only payload as vendor metadata worth showing', () => {
    // Before attribution fields were surfaced this fell through to the empty
    // note, hiding data the sidecar had already extracted.
    render(
      <VendorPanel
        metadata={vendor({
          slicer: 'unknown',
          core: { description: 'Notes.' },
        })}
      />,
    );

    expect(screen.getByText('Notes.')).toBeInTheDocument();
    expect(
      screen.queryByText('No slicer/vendor metadata in this file.'),
    ).toBeNull();
  });

  // One field standing in for eight only shows the gate can open, not that each
  // field opens it. Dropping any single field from the `hasCore` chain sends a
  // file carrying only that field to the empty note — the very regression this
  // panel change exists to fix — and every other case here would stay green.
  it.each([
    ['title', 'A title'],
    ['designer', 'A designer'],
    ['description', 'A description'],
    ['application', 'An application'],
    ['licenseTerms', 'A license'],
    ['copyright', 'A copyright'],
    ['creationDate', '2026-03-04T05:06:07Z'],
    ['modificationDate', '2026-03-05T05:06:07Z'],
  ] as const)('shows a payload carrying only %s', (field, value) => {
    render(
      <VendorPanel
        metadata={vendor({ slicer: 'unknown', core: { [field]: value } })}
      />,
    );

    expect(
      screen.queryByText('No slicer/vendor metadata in this file.'),
    ).toBeNull();
  });
});
