import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SceneObject, ScenePlate } from '../viewer/types';
import {
  flattenPartTree,
  isFocusableRow,
  partTreeKeyAction,
  type PartTreeRow,
} from './partTreeModel';

export interface PartTreeProps {
  objects: readonly SceneObject[];
  rootObjectIds: readonly string[];
  plates: readonly ScenePlate[];
  hidden: ReadonlySet<string>;
  /** Object currently isolated in the viewer, if any. */
  isolatedObjectId?: string | null;
  onToggle: (id: string) => void;
  onToggleAll: (visible: boolean) => void;
  /** Show or hide every root object on a plate at once. */
  onTogglePlate?: (plateId: string, visible: boolean) => void;
  /** Isolate a single object, or pass `null` to leave isolation. */
  onIsolate?: (id: string | null) => void;
}

const HINT_ID = 'part-tree-keyboard-hint';

/**
 * Lists the scene graph shipped by the sidecar as a WAI-ARIA tree. Objects are
 * grouped by plate and nested by `parentId`, so the renderer exposes the
 * Rust-side hierarchy without reverse-engineering a flat triangle range table.
 *
 * The tree is a full non-canvas alternative to picking parts in the 3D view:
 * a single roving tab stop, arrow keys to walk and expand/collapse, Space to
 * hide or show the focused node, and `I` to isolate it. Row buttons are taken
 * out of the tab order (`tabIndex={-1}`) so keyboard users traverse rows rather
 * than tabbing through two actions per object.
 */
export function PartTree({
  objects,
  rootObjectIds,
  plates,
  hidden,
  isolatedObjectId = null,
  onToggle,
  onToggleAll,
  onTogglePlate,
  onIsolate,
}: PartTreeProps): React.JSX.Element | null {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const pendingFocusRef = useRef<string | null>(null);

  const rows = useMemo(
    () =>
      flattenPartTree({ objects, rootObjectIds, plates, hidden, collapsed }),
    [objects, rootObjectIds, plates, hidden, collapsed],
  );

  // The roving tab stop must land on a row that can actually take focus, so
  // diagnostic and notice rows are never candidates. This is what keeps
  // exactly one `tabIndex={0}` in the tree for any scene shape.
  const firstKey = rows.find(isFocusableRow)?.key ?? null;
  const currentKey =
    activeKey !== null &&
    rows.some((row) => row.key === activeKey && isFocusableRow(row))
      ? activeKey
      : firstKey;

  const invalidNames = rows
    .filter((row) => row.invalid)
    .map((row) => row.objectId ?? row.name)
    .join('|');
  useEffect(() => {
    if (invalidNames.length === 0) return;
    for (const id of invalidNames.split('|')) {
      console.warn(
        `[PartTree] Skipping cyclic or duplicated scene object reference for "${id}".`,
      );
    }
  }, [invalidNames]);

  // Focus follows keyboard navigation, but only after the row exists in the DOM
  // (expanding a node reveals its children in the same commit).
  useEffect(() => {
    const key = pendingFocusRef.current;
    if (key === null) return;
    pendingFocusRef.current = null;
    listRef.current
      ?.querySelector<HTMLLIElement>(`[data-row-key="${cssEscape(key)}"]`)
      ?.focus();
  });

  const setExpanded = useCallback((key: string, expanded: boolean): void => {
    setCollapsed((current) => {
      if (expanded === !current.has(key)) return current;
      const next = new Set(current);
      if (expanded) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

  // Collapsing by mouse can unmount the row that currently holds focus (its
  // ancestor is the node being collapsed), which would drop focus to the
  // document. Move the tab stop up to the node the user collapsed, but only
  // when focus was already inside the tree so a stray click never steals it.
  const onTwistyToggle = useCallback(
    (row: PartTreeRow): void => {
      const expanding = !row.expanded;
      setExpanded(row.key, expanding);
      if (expanding) return;
      const focusInside =
        listRef.current?.contains(document.activeElement) ?? false;
      if (!focusInside) return;
      setActiveKey(row.key);
      pendingFocusRef.current = row.key;
    },
    [setExpanded],
  );

  const toggleRowVisibility = useCallback(
    (row: PartTreeRow): void => {
      if (row.ancestorHidden || row.invalid) return;
      if (row.kind === 'plate') {
        if (row.plateId) onTogglePlate?.(row.plateId, row.hidden);
        return;
      }
      if (row.objectId) onToggle(row.objectId);
    },
    [onToggle, onTogglePlate],
  );

  const isolateRow = useCallback(
    (row: PartTreeRow): void => {
      if (!row.objectId || row.invalid) return;
      onIsolate?.(row.objectId === isolatedObjectId ? null : row.objectId);
    },
    [isolatedObjectId, onIsolate],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLUListElement>): void => {
      // Resolve the row from the DOM rather than from `activeKey`: focus can
      // move (mouse, programmatic) between renders, and the event target is
      // always the row the user is actually on.
      const target =
        event.target instanceof Element
          ? event.target.closest<HTMLElement>('[data-row-key]')
          : null;
      const originKey = target?.dataset.rowKey ?? currentKey;
      if (!originKey) return;
      const action = partTreeKeyAction(event.key, rows, originKey);
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      const row = rows.find((entry) => entry.key === action.key);
      switch (action.type) {
        case 'move':
          setActiveKey(action.key);
          pendingFocusRef.current = action.key;
          break;
        case 'expand':
          setActiveKey(action.key);
          setExpanded(action.key, true);
          break;
        case 'collapse':
          setActiveKey(action.key);
          setExpanded(action.key, false);
          break;
        case 'toggleVisibility':
          setActiveKey(action.key);
          if (row) toggleRowVisibility(row);
          break;
        case 'isolate':
          setActiveKey(action.key);
          if (row) isolateRow(row);
          break;
      }
    },
    [currentKey, isolateRow, rows, setExpanded, toggleRowVisibility],
  );

  if (objects.length === 0) {
    return null;
  }

  const allVisible = hidden.size === 0;
  const isolatedName = isolatedObjectId
    ? (objects.find((object) => object.id === isolatedObjectId)?.name ??
      isolatedObjectId)
    : null;

  return (
    <div className="part-tree">
      <div className="part-tree-header">
        <h2 className="viewer-tags-title">Objects</h2>
        <button
          type="button"
          className="part-tree-toggle-all"
          onClick={() => onToggleAll(!allVisible)}
        >
          {allVisible ? 'Hide all' : 'Show all'}
        </button>
      </div>
      {isolatedName !== null ? (
        <p className="part-tree-isolation" role="status">
          <span>
            Isolating <strong>{isolatedName}</strong>
          </span>
          <button
            type="button"
            className="part-tree-toggle-all"
            onClick={() => onIsolate?.(null)}
          >
            Exit isolation
          </button>
        </p>
      ) : null}
      <p className="part-tree-hint" id={HINT_ID}>
        Arrow keys move and expand, Space hides or shows, I isolates.
      </p>
      <ul
        ref={listRef}
        className="part-list"
        role="tree"
        aria-label="Scene objects"
        aria-describedby={HINT_ID}
        onKeyDown={onKeyDown}
      >
        {rows.map((row) => (
          <PartTreeItem
            key={row.key}
            row={row}
            active={row.key === currentKey}
            isolated={
              row.objectId !== null && row.objectId === isolatedObjectId
            }
            isolationSupported={onIsolate !== undefined}
            onActivate={setActiveKey}
            onTwistyToggle={onTwistyToggle}
            onToggleVisibility={toggleRowVisibility}
            onIsolate={isolateRow}
          />
        ))}
      </ul>
    </div>
  );
}

function PartTreeItem({
  row,
  active,
  isolated,
  isolationSupported,
  onActivate,
  onTwistyToggle,
  onToggleVisibility,
  onIsolate,
}: {
  row: PartTreeRow;
  active: boolean;
  isolated: boolean;
  isolationSupported: boolean;
  onActivate: (key: string) => void;
  onTwistyToggle: (row: PartTreeRow) => void;
  onToggleVisibility: (row: PartTreeRow) => void;
  onIsolate: (row: PartTreeRow) => void;
}): React.JSX.Element {
  if (row.kind === 'notice') {
    return (
      <li
        className="part-item part-item-invalid"
        role="treeitem"
        aria-level={row.level}
        aria-posinset={row.positionInSet}
        aria-setsize={row.setSize}
        aria-disabled="true"
        data-row-key={row.key}
        tabIndex={-1}
        style={indentStyle(row.level)}
      >
        <span className="part-row">
          <span aria-hidden="true">⚠</span>
          <span className="part-name">{row.name}</span>
        </span>
      </li>
    );
  }

  if (row.invalid) {
    return (
      <li
        className="part-item part-item-invalid"
        role="treeitem"
        aria-level={row.level}
        aria-posinset={row.positionInSet}
        aria-setsize={row.setSize}
        aria-disabled="true"
        data-row-key={row.key}
        tabIndex={-1}
        style={indentStyle(row.level)}
      >
        <span className="part-row">
          <span aria-hidden="true">⚠</span>
          <span className="part-name">Invalid scene node: {row.name}</span>
        </span>
      </li>
    );
  }

  const label = row.hidden ? `${row.name}, hidden` : row.name;
  const visibilityLabel = `${row.hidden ? 'Show' : 'Hide'} ${row.name}`;

  return (
    <li
      className={`part-item${row.hidden ? ' part-item-hidden' : ''}`}
      role="treeitem"
      aria-label={label}
      aria-level={row.level}
      aria-posinset={row.positionInSet}
      aria-setsize={row.setSize}
      {...(row.hasChildren ? { 'aria-expanded': row.expanded } : {})}
      data-row-key={row.key}
      tabIndex={active ? 0 : -1}
      onFocus={() => onActivate(row.key)}
      onClick={() => onActivate(row.key)}
      style={indentStyle(row.level)}
    >
      <span className="part-row">
        {row.hasChildren ? (
          <span
            className="part-twisty"
            aria-hidden="true"
            onClick={(event) => {
              event.stopPropagation();
              onTwistyToggle(row);
            }}
          >
            {row.expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span className="part-twisty" aria-hidden="true" />
        )}
        <span className="part-name">{row.name}</span>
        <span className="part-count">{describeRow(row)}</span>
        <button
          type="button"
          className="part-action"
          tabIndex={-1}
          aria-label={visibilityLabel}
          aria-pressed={!row.hidden}
          disabled={row.ancestorHidden}
          onClick={(event) => {
            event.stopPropagation();
            onActivate(row.key);
            onToggleVisibility(row);
          }}
        >
          <span aria-hidden="true">{row.hidden ? '◌' : '●'}</span>
        </button>
        {isolationSupported && row.objectId !== null ? (
          <button
            type="button"
            className="part-action"
            tabIndex={-1}
            aria-label={
              isolated ? `Exit isolation of ${row.name}` : `Isolate ${row.name}`
            }
            aria-pressed={isolated}
            onClick={(event) => {
              event.stopPropagation();
              onActivate(row.key);
              onIsolate(row);
            }}
          >
            <span aria-hidden="true">◎</span>
          </button>
        ) : null}
      </span>
    </li>
  );
}

function describeRow(row: PartTreeRow): string {
  if (row.triangles !== null) {
    return `${row.triangles.toLocaleString()}△`;
  }
  if (row.kind === 'plate') {
    const count = row.childCount;
    return `${count.toLocaleString()} object${count === 1 ? '' : 's'}`;
  }
  const count = row.childCount;
  return `${count.toLocaleString()} child${count === 1 ? '' : 'ren'}`;
}

function indentStyle(level: number): React.CSSProperties {
  return { paddingInlineStart: `${(level - 1) * 14}px` };
}

/**
 * Minimal CSS.escape shim: jsdom and older Electron builds expose it, but the
 * attribute selector below only ever needs quotes and backslashes neutralized.
 */
function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}
