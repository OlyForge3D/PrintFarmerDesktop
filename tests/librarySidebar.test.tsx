import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import {
  LibrarySidebar,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  type LibraryCounts,
} from '../src/renderer/library/LibrarySidebar';

const STORAGE_KEY = 'printfarmer.library.sidebar.v1';

const counts: LibraryCounts = {
  all: 0,
  favorites: 0,
  stl: 0,
  threeMf: 0,
  obj: 0,
  step: 0,
  duplicates: 0,
  missing: 0,
};

function renderSidebar(
  overrides: Partial<Parameters<typeof LibrarySidebar>[0]> = {},
): ReturnType<typeof render> {
  return render(
    <LibrarySidebar
      query=""
      filter="all"
      counts={counts}
      scanningFolder={null}
      busy={false}
      sourceRoots={[]}
      onQueryChange={vi.fn()}
      onFilterChange={vi.fn()}
      onAddFolder={vi.fn()}
      collections={[{ id: 'c1', name: 'Bracket set', memberCount: 2 } as never]}
      selectedCollections={[]}
      onCollectionsChange={vi.fn()}
      tags={[{ id: 'red', name: 'Red' }]}
      selectedTags={[]}
      onTagsChange={vi.fn()}
      {...overrides}
    />,
  );
}

function storedPrefs(): unknown {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
}

// jsdom has no PointerEvent, so pointer coordinates would otherwise be dropped.
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 0;
  }
}

describe('LibrarySidebar', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('PointerEvent', TestPointerEvent);
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('lists Collections before Tags without Manage buttons', () => {
    renderSidebar();
    const groups = screen
      .getAllByRole('group')
      .map((group) => group.getAttribute('aria-label'));
    expect(groups).toEqual(['Collections filter', 'Tags filter']);
    expect(screen.queryByRole('button', { name: /manage/i })).toBeNull();
  });

  it('keeps contextual import but leaves cache management in Settings', () => {
    renderSidebar();
    expect(screen.getByRole('button', { name: 'Add folder' })).toBeEnabled();
    expect(
      screen.queryByRole('button', { name: /Thumbnail cache/ }),
    ).toBeNull();
  });

  it('collapses filter groups, keeps selections, and remembers the state', () => {
    const onTagsChange = vi.fn();
    const view = renderSidebar({ selectedTags: ['red'], onTagsChange });
    const tags = screen.getByRole('group', { name: 'Tags filter' });
    const toggle = within(tags).getByRole('button', { name: /Tags/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(tags).getByRole('checkbox', { name: 'Red' })).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(within(tags).queryByRole('checkbox', { name: 'Red' })).toBeNull();
    expect(toggle.textContent).toContain('1 selected');
    expect(onTagsChange).not.toHaveBeenCalled();
    const collections = screen.getByRole('group', {
      name: 'Collections filter',
    });
    expect(
      within(collections)
        .getByRole('button', { name: /Collections/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(storedPrefs()).toMatchObject({
      expanded: { collections: true, tags: false },
    });

    view.unmount();
    renderSidebar({ selectedTags: ['red'] });
    expect(
      within(screen.getByRole('group', { name: 'Tags filter' }))
        .getByRole('button', { name: /Tags/ })
        .getAttribute('aria-expanded'),
    ).toBe('false');
  });

  it('resizes by keyboard within bounds and persists the width', () => {
    const view = renderSidebar();
    const handle = screen.getByRole('separator', {
      name: 'Resize library sidebar',
    });
    const pane = handle.parentElement as HTMLElement;
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_DEFAULT_WIDTH),
    );
    expect(pane.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_DEFAULT_WIDTH + 10),
    );
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(pane.style.width).toBe(`${SIDEBAR_DEFAULT_WIDTH + 60}px`);
    fireEvent.keyDown(handle, { key: 'End' });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_MAX_WIDTH),
    );
    fireEvent.keyDown(handle, { key: 'Home' });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_MIN_WIDTH),
    );
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_MIN_WIDTH),
    );
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    expect(storedPrefs()).toMatchObject({ width: SIDEBAR_MIN_WIDTH + 50 });

    view.unmount();
    renderSidebar();
    expect(
      screen
        .getByRole('separator', { name: 'Resize library sidebar' })
        .getAttribute('aria-valuenow'),
    ).toBe(String(SIDEBAR_MIN_WIDTH + 50));
  });

  it('resizes by pointer drag, cancels on Escape, and resets on double-click', () => {
    renderSidebar();
    const handle = screen.getByRole('separator', {
      name: 'Resize library sidebar',
    });
    fireEvent.pointerDown(handle, { button: 0, clientX: 300, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 400, pointerId: 1 });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_DEFAULT_WIDTH + 100),
    );
    fireEvent.pointerUp(handle, { clientX: 400, pointerId: 1 });
    expect(storedPrefs()).toMatchObject({ width: SIDEBAR_DEFAULT_WIDTH + 100 });

    fireEvent.pointerDown(handle, { button: 0, clientX: 400, pointerId: 2 });
    fireEvent.pointerMove(handle, { clientX: 2000, pointerId: 2 });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_MAX_WIDTH),
    );
    fireEvent.keyDown(handle, { key: 'Escape' });
    fireEvent.pointerUp(handle, { clientX: 2000, pointerId: 2 });
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_DEFAULT_WIDTH + 100),
    );

    fireEvent.doubleClick(handle);
    expect(handle.getAttribute('aria-valuenow')).toBe(
      String(SIDEBAR_DEFAULT_WIDTH),
    );
  });

  it('caps the width so the model list keeps room in a narrow workspace', () => {
    const workspace = document.createElement('div');
    const inspector = document.createElement('aside');
    Object.defineProperty(workspace, 'clientWidth', { value: 800 });
    inspector.getBoundingClientRect = () => ({ width: 260 }) as DOMRect;
    document.body.append(workspace);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ width: 460 }));
    render(
      <LibrarySidebar
        query=""
        filter="all"
        counts={counts}
        scanningFolder={null}
        busy={false}
        sourceRoots={[]}
        onQueryChange={vi.fn()}
        onFilterChange={vi.fn()}
        onAddFolder={vi.fn()}
      />,
      { container: workspace },
    );
    workspace.append(inspector);
    fireEvent(window, new Event('resize'));
    const handle = screen.getByRole('separator', {
      name: 'Resize library sidebar',
    });
    // 800 workspace - 260 inspector - 320 minimum model list.
    expect(handle.getAttribute('aria-valuemax')).toBe('220');
    expect(handle.getAttribute('aria-valuenow')).toBe('220');
    expect(storedPrefs()).toMatchObject({ width: 460 });
    workspace.remove();
  });

  it('ignores malformed stored preferences', () => {
    localStorage.setItem(STORAGE_KEY, '{"width":"wide","expanded":7}');
    renderSidebar();
    expect(
      screen
        .getByRole('separator', { name: 'Resize library sidebar' })
        .getAttribute('aria-valuenow'),
    ).toBe(String(SIDEBAR_DEFAULT_WIDTH));
    expect(
      within(screen.getByRole('group', { name: 'Tags filter' }))
        .getByRole('button', { name: /Tags/ })
        .getAttribute('aria-expanded'),
    ).toBe('true');
  });
});
