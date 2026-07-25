/**
 * Pure, GPU-free helpers behind the viewer's part tree.
 *
 * The sidecar's scene contract (see `viewer/types`) is a flat `objects` array
 * wired together by `parentId`/`children` plus a plate grouping. Every piece of
 * navigation and visibility math the tree needs is derived here so it can be
 * unit-tested without React or WebGL, and so the component stays a thin render
 * layer over an already-resolved row list.
 *
 * Scene graphs arrive from untrusted files, so the flatten is hostile-shape
 * safe: an object id yields at most **one** rendered row across the whole tree
 * (later references degrade to uniquely-keyed diagnostic rows), the walk is
 * iterative rather than recursive, and a global row budget bounds the output.
 * Together these keep a duplicated child, a diamond DAG, or a 5,000-deep chain
 * linear and crash-free.
 */
import type { SceneObject, ScenePlate } from '../viewer/types';

/**
 * Hard ceiling on emitted rows. A scene that would exceed it is truncated with
 * a trailing `notice` row rather than locking up the renderer.
 */
export const MAX_PART_TREE_ROWS = 20_000;

/** A single keyboard-navigable line in the flattened tree. */
export interface PartTreeRow {
  /**
   * Stable DOM/roving-tabindex key, unique across the whole row list no matter
   * how the scene graph is shaped. Plate group ids are prefixed; a repeated
   * path is disambiguated with a `#n` suffix.
   */
  readonly key: string;
  /** `notice` rows are renderer diagnostics, not scene content. */
  readonly kind: 'plate' | 'object' | 'notice';
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
   * The object id was already rendered elsewhere in the tree (a cycle, a
   * duplicated child reference, or the same object on two plates). The row is
   * rendered as a read-only diagnostic and has no children.
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

/** True when a row represents real, interactive scene content. */
export function isFocusableRow(row: PartTreeRow): boolean {
  return !row.invalid && row.kind !== 'notice';
}

interface ObjectFrame {
  readonly objectId: string;
  readonly parentKey: string | null;
  readonly level: number;
  readonly positionInSet: number;
  readonly setSize: number;
  readonly ancestorHidden: boolean;
}

/**
 * Flatten the scene graph into the visible row order the tree renders and the
 * keyboard walks. Collapsed subtrees contribute their heading row only.
 *
 * Hostile-shape guarantees, all of which the part tree's single-roving-tab-stop
 * invariant depends on:
 *
 * - **One row per object.** `resolved` is global to the whole flatten, not to
 *   the current path, so a duplicated child, a multi-parent reference and the
 *   same object listed on two plates each render once and then degrade to a
 *   diagnostic row. This is what keeps a diamond DAG linear instead of
 *   exponential.
 * - **Unique keys.** Every key is issued through `claimKey`, so no two rows can
 *   ever collide even when the same path repeats.
 * - **No recursion.** The walk uses an explicit stack, so depth is bounded by
 *   the heap rather than the call stack.
 * - **Bounded output.** `MAX_PART_TREE_ROWS` truncates with a notice row.
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
  const usedKeys = new Set<string>();
  const keyProbe = new Map<string, number>();
  const resolved = new Set<string>();
  let truncated = false;

  // Suffix collisions rather than trusting the path to be unique. `keyProbe`
  // remembers where the last probe for a base stopped so repeated collisions
  // stay amortized O(1) instead of rescanning from 2 every time.
  const claimKey = (base: string): string => {
    if (!usedKeys.has(base)) {
      usedKeys.add(base);
      return base;
    }
    let n = keyProbe.get(base) ?? 2;
    while (usedKeys.has(`${base}#${n}`)) n += 1;
    const key = `${base}#${n}`;
    keyProbe.set(base, n + 1);
    usedKeys.add(key);
    return key;
  };

  const atCapacity = (): boolean => {
    if (rows.length < MAX_PART_TREE_ROWS) return false;
    if (!truncated) {
      truncated = true;
      rows.push({
        key: claimKey('notice:truncated'),
        kind: 'notice',
        objectId: null,
        plateId: null,
        plateRootObjectIds: [],
        name: `Scene too large to list in full; stopped after ${MAX_PART_TREE_ROWS.toLocaleString()} rows.`,
        level: 1,
        positionInSet: 1,
        setSize: 1,
        hasChildren: false,
        childCount: 0,
        expanded: false,
        hidden: false,
        ancestorHidden: false,
        triangles: null,
        parentKey: null,
        invalid: false,
      });
    }
    return true;
  };

  const walk = (seeds: readonly ObjectFrame[]): void => {
    const stack = seeds.slice().reverse();
    while (stack.length > 0) {
      if (atCapacity()) return;
      const frame = stack.pop();
      if (!frame) continue;
      const object = byId.get(frame.objectId);
      if (!object) continue;
      const base = objectRowKey(frame.parentKey, frame.objectId);

      if (resolved.has(frame.objectId)) {
        rows.push({
          key: claimKey(base),
          kind: 'object',
          objectId: frame.objectId,
          plateId: null,
          plateRootObjectIds: [],
          name: object.name,
          level: frame.level,
          positionInSet: frame.positionInSet,
          setSize: frame.setSize,
          hasChildren: false,
          childCount: 0,
          expanded: false,
          hidden: true,
          ancestorHidden: frame.ancestorHidden,
          triangles: null,
          parentKey: frame.parentKey,
          invalid: true,
        });
        continue;
      }
      resolved.add(frame.objectId);

      const key = claimKey(base);
      const children = object.children.filter((childId) => byId.has(childId));
      const effectivelyHidden =
        frame.ancestorHidden || hidden.has(frame.objectId);
      const expanded = children.length > 0 && !collapsed.has(key);

      rows.push({
        key,
        kind: 'object',
        objectId: frame.objectId,
        plateId: null,
        plateRootObjectIds: [],
        name: object.name,
        level: frame.level,
        positionInSet: frame.positionInSet,
        setSize: frame.setSize,
        hasChildren: children.length > 0,
        childCount: children.length,
        expanded,
        hidden: effectivelyHidden,
        ancestorHidden: frame.ancestorHidden,
        triangles: object.mesh
          ? Math.floor(object.mesh.indices.length / 3)
          : null,
        parentKey: frame.parentKey,
        invalid: false,
      });

      if (!expanded) continue;
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const childId = children[index];
        if (childId === undefined) continue;
        stack.push({
          objectId: childId,
          parentKey: key,
          level: frame.level + 1,
          positionInSet: index + 1,
          setSize: children.length,
          ancestorHidden: effectivelyHidden,
        });
      }
    }
  };

  if (plates.length > 0) {
    for (const [plateIndex, plate] of plates.entries()) {
      if (atCapacity()) return rows;
      const key = claimKey(plateRowKey(plate.id));
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
      if (!expanded) continue;
      walk(
        roots.map((rootId, index) => ({
          objectId: rootId,
          parentKey: key,
          level: 2,
          positionInSet: index + 1,
          setSize: roots.length,
          ancestorHidden: false,
        })),
      );
    }
    return rows;
  }

  const roots = rootObjectIds.filter((id) => byId.has(id));
  walk(
    roots.map((rootId, index) => ({
      objectId: rootId,
      parentKey: null,
      level: 1,
      positionInSet: index + 1,
      setSize: roots.length,
      ancestorHidden: false,
    })),
  );
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
 *
 * Navigation walks only focusable rows: diagnostic and notice rows are
 * `aria-disabled` read-outs, so arrowing past them skips them rather than
 * parking the roving tab stop on a row that cannot act.
 */
export function partTreeKeyAction(
  key: string,
  rows: readonly PartTreeRow[],
  activeKey: string,
): PartTreeKeyAction | null {
  const nav = rows.filter(isFocusableRow);
  const index = nav.findIndex((row) => row.key === activeKey);
  if (index < 0) return null;
  const row = nav[index];
  if (!row) return null;

  switch (key) {
    case 'ArrowDown': {
      const next = nav[index + 1];
      return next ? { type: 'move', key: next.key } : null;
    }
    case 'ArrowUp': {
      const previous = nav[index - 1];
      return previous ? { type: 'move', key: previous.key } : null;
    }
    case 'Home': {
      const first = nav[0];
      return first ? { type: 'move', key: first.key } : null;
    }
    case 'End': {
      const last = nav[nav.length - 1];
      return last ? { type: 'move', key: last.key } : null;
    }
    case 'ArrowRight': {
      if (row.hasChildren && !row.expanded) {
        return { type: 'expand', key: row.key };
      }
      if (row.hasChildren) {
        const child = nav[index + 1];
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
