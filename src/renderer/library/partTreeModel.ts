/**
 * Pure, GPU-free helpers behind the viewer's part tree.
 *
 * The sidecar's scene contract (see `viewer/types`) is a flat `objects` array
 * wired together by `parentId`/`children` plus a plate grouping. Every piece of
 * navigation and visibility math the tree needs is derived here so it can be
 * unit-tested without React or WebGL, and so the component stays a thin render
 * layer over an already-resolved row list.
 *
 * Scene graphs arrive from untrusted files, so every walk in this module is
 * cycle-safe: an object may appear at most once per resolved tree.
 */
import type { SceneObject, ScenePlate } from '../viewer/types';

/** A single keyboard-navigable line in the flattened tree. */
export interface PartTreeRow {
  /** Stable DOM/roving-tabindex key. Plate group ids are prefixed. */
  readonly key: string;
  readonly kind: 'plate' | 'object';
  /** Scene object id, or `null` for a plate group heading. */
  readonly objectId: string | null;
  /** Plate id for a plate heading row, or `null` for object rows. */
  readonly plateId: string | null;
  /** Root object ids a plate heading toggles; empty for object rows. */
  readonly plateRootObjectIds: readonly string[];
  readonly name: string;
  /** 1-based ARIA level (`aria-level`). */
  readonly level: number;
  /** 1-based index within the row's sibling set (`aria-posinset`). */
  readonly positionInSet: number;
  /** Size of the row's sibling set (`aria-setsize`). */
  readonly setSize: number;
  readonly hasChildren: boolean;
  /** Number of resolvable children (scene objects, or plate roots). */
  readonly childCount: number;
  readonly expanded: boolean;
  /** Row is hidden because it, or one of its ancestors, is hidden. */
  readonly hidden: boolean;
  /** An ancestor is hidden, so this row cannot be shown on its own. */
  readonly ancestorHidden: boolean;
  /** Triangle count for leaf meshes; `null` for group/plate rows. */
  readonly triangles: number | null;
  /** Key of the parent row, or `null` at the top level. */
  readonly parentKey: string | null;
  /**
   * The object id was reached twice (a cycle or a duplicated child reference).
   * The row is rendered as a diagnostic and has no children.
   */
  readonly invalid: boolean;
}

export interface FlattenPartTreeOptions {
  readonly objects: readonly SceneObject[];
  readonly rootObjectIds: readonly string[];
  readonly plates: readonly ScenePlate[];
  readonly hidden: ReadonlySet<string>;
  readonly collapsed: ReadonlySet<string>;
}

/** DOM/row key for a plate group heading. */
export function plateRowKey(plateId: string): string {
  return `plate:${plateId}`;
}

/** DOM/row key for a scene object at a given tree path. */
export function objectRowKey(
  parentKey: string | null,
  objectId: string,
): string {
  return parentKey === null ? `object:${objectId}` : `${parentKey}/${objectId}`;
}

function indexObjects(
  objects: readonly SceneObject[],
): ReadonlyMap<string, SceneObject> {
  return new Map(objects.map((object) => [object.id, object]));
}

/**
 * Flatten the scene graph into the visible row order the tree renders and the
 * keyboard walks. Collapsed subtrees contribute their heading row only.
 */
export function flattenPartTree({
  objects,
  rootObjectIds,
  plates,
  hidden,
  collapsed,
}: FlattenPartTreeOptions): readonly PartTreeRow[] {
  const byId = indexObjects(objects);
  const rows: PartTreeRow[] = [];

  const pushObject = (
    objectId: string,
    parentKey: string | null,
    level: number,
    positionInSet: number,
    setSize: number,
    ancestorHidden: boolean,
    seen: ReadonlySet<string>,
  ): void => {
    const object = byId.get(objectId);
    if (!object) return;
    const key = objectRowKey(parentKey, objectId);

    if (seen.has(objectId)) {
      rows.push({
        key,
        kind: 'object',
        objectId,
        plateId: null,
        plateRootObjectIds: [],
        name: object.name,
        level,
        positionInSet,
        setSize,
        hasChildren: false,
        childCount: 0,
        expanded: false,
        hidden: true,
        ancestorHidden,
        triangles: null,
        parentKey,
        invalid: true,
      });
      return;
    }

    const children = object.children.filter((childId) => byId.has(childId));
    const directlyHidden = hidden.has(objectId);
    const effectivelyHidden = ancestorHidden || directlyHidden;
    const expanded = children.length > 0 && !collapsed.has(key);

    rows.push({
      key,
      kind: 'object',
      objectId,
      plateId: null,
      plateRootObjectIds: [],
      name: object.name,
      level,
      positionInSet,
      setSize,
      hasChildren: children.length > 0,
      childCount: children.length,
      expanded,
      hidden: effectivelyHidden,
      ancestorHidden,
      triangles: object.mesh
        ? Math.floor(object.mesh.indices.length / 3)
        : null,
      parentKey,
      invalid: false,
    });

    if (!expanded) return;
    const nextSeen = new Set(seen).add(objectId);
    children.forEach((childId, index) => {
      pushObject(
        childId,
        key,
        level + 1,
        index + 1,
        children.length,
        effectivelyHidden,
        nextSeen,
      );
    });
  };

  if (plates.length > 0) {
    plates.forEach((plate, plateIndex) => {
      const key = plateRowKey(plate.id);
      const roots = plate.rootObjectIds.filter((id) => byId.has(id));
      const expanded = roots.length > 0 && !collapsed.has(key);
      rows.push({
        key,
        kind: 'plate',
        objectId: null,
        plateId: plate.id,
        plateRootObjectIds: roots,
        name: plate.name,
        level: 1,
        positionInSet: plateIndex + 1,
        setSize: plates.length,
        hasChildren: roots.length > 0,
        childCount: roots.length,
        expanded,
        hidden: roots.length > 0 && roots.every((id) => hidden.has(id)),
        ancestorHidden: false,
        triangles: null,
        parentKey: null,
        invalid: false,
      });
      if (!expanded) return;
      roots.forEach((rootId, index) => {
        pushObject(rootId, key, 2, index + 1, roots.length, false, new Set());
      });
    });
    return rows;
  }

  const roots = rootObjectIds.filter((id) => byId.has(id));
  roots.forEach((rootId, index) => {
    pushObject(rootId, null, 1, index + 1, roots.length, false, new Set());
  });
  return rows;
}

/** Every object id reachable from `objectId`, including itself. Cycle-safe. */
export function subtreeObjectIds(
  objects: readonly SceneObject[],
  objectId: string,
): ReadonlySet<string> {
  const byId = indexObjects(objects);
  const collected = new Set<string>();
  const stack: string[] = [objectId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || collected.has(current)) continue;
    const object = byId.get(current);
    if (!object) continue;
    collected.add(current);
    stack.push(...object.children);
  }
  return collected;
}

/** Every ancestor of `objectId`, nearest first. Cycle-safe. */
export function ancestorObjectIds(
  objects: readonly SceneObject[],
  objectId: string,
): readonly string[] {
  const byId = indexObjects(objects);
  const ancestors: string[] = [];
  const seen = new Set<string>([objectId]);
  let parentId = byId.get(objectId)?.parentId ?? null;
  while (parentId && !seen.has(parentId) && byId.has(parentId)) {
    ancestors.push(parentId);
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId ?? null;
  }
  return ancestors;
}

/**
 * The hidden set that isolates `objectId`: everything except the object, its
 * descendants, and the ancestors it hangs from (an ancestor stays visible
 * because hiding it would hide the isolated subtree with it).
 */
export function isolateHiddenObjectIds(
  objects: readonly SceneObject[],
  objectId: string,
): ReadonlySet<string> {
  const keep = new Set(subtreeObjectIds(objects, objectId));
  if (keep.size === 0) return new Set();
  for (const ancestorId of ancestorObjectIds(objects, objectId)) {
    keep.add(ancestorId);
  }
  const hidden = new Set<string>();
  for (const object of objects) {
    if (!keep.has(object.id)) {
      hidden.add(object.id);
    }
  }
  return hidden;
}

/** True when `objectId`, or any ancestor of it, is in `hidden`. Cycle-safe. */
export function isObjectHidden(
  objects: readonly SceneObject[],
  objectId: string,
  hidden: ReadonlySet<string>,
): boolean {
  if (hidden.size === 0) return false;
  if (hidden.has(objectId)) return true;
  return ancestorObjectIds(objects, objectId).some((id) => hidden.has(id));
}

export type PartTreeKeyAction =
  | { readonly type: 'move'; readonly key: string }
  | { readonly type: 'expand'; readonly key: string }
  | { readonly type: 'collapse'; readonly key: string }
  | { readonly type: 'toggleVisibility'; readonly key: string }
  | { readonly type: 'isolate'; readonly key: string };

/**
 * Map an ARIA tree keystroke to an action, following the WAI-ARIA tree view
 * pattern: Up/Down walk the flattened rows, Right expands then descends, Left
 * collapses then ascends, Home/End jump to the ends. Space toggles the focused
 * row's visibility and `i` isolates it.
 *
 * Returns `null` when the key is not handled, so the caller leaves the event
 * alone (browser find-as-you-type, Tab, etc. keep working).
 */
export function partTreeKeyAction(
  key: string,
  rows: readonly PartTreeRow[],
  activeKey: string,
): PartTreeKeyAction | null {
  const index = rows.findIndex((row) => row.key === activeKey);
  if (index < 0) return null;
  const row = rows[index];
  if (!row) return null;

  switch (key) {
    case 'ArrowDown': {
      const next = rows[index + 1];
      return next ? { type: 'move', key: next.key } : null;
    }
    case 'ArrowUp': {
      const previous = rows[index - 1];
      return previous ? { type: 'move', key: previous.key } : null;
    }
    case 'Home': {
      const first = rows[0];
      return first ? { type: 'move', key: first.key } : null;
    }
    case 'End': {
      const last = rows[rows.length - 1];
      return last ? { type: 'move', key: last.key } : null;
    }
    case 'ArrowRight': {
      if (row.hasChildren && !row.expanded) {
        return { type: 'expand', key: row.key };
      }
      if (row.hasChildren) {
        const child = rows[index + 1];
        return child?.parentKey === row.key
          ? { type: 'move', key: child.key }
          : null;
      }
      return null;
    }
    case 'ArrowLeft': {
      if (row.hasChildren && row.expanded) {
        return { type: 'collapse', key: row.key };
      }
      return row.parentKey ? { type: 'move', key: row.parentKey } : null;
    }
    case ' ':
    case 'Spacebar':
      return { type: 'toggleVisibility', key: row.key };
    case 'i':
    case 'I':
      return row.objectId ? { type: 'isolate', key: row.key } : null;
    default:
      return null;
  }
}
