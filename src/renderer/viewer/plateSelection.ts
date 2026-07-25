/**
 * Plate selection for multi-plate projects.
 *
 * Plate membership is geometry, not view state: the sidecar already assigns
 * every scene object to a plate, so "show plate 2" is expressed purely as a
 * hidden-object set. That keeps a single source of truth - the viewer, the part
 * tree, and this selector all read the same `hidden` set - so a manual toggle in
 * the part tree can never leave the selector claiming a plate that is not
 * actually the one on screen.
 *
 * Because only visibility changes, geometry, colors, and materials survive a
 * plate switch untouched.
 */

import { effectiveHiddenObjectIds } from '../library/partTreeModel';
import type { SceneObject, ScenePlate } from './types';

/**
 * What the hidden set currently represents.
 *
 * A discriminated union rather than a string with a magic "all" member: plate
 * ids come out of an untrusted file, so any sentinel string is a value some
 * plate could legitimately carry. A plate genuinely named `all` used to be
 * unselectable - asking to show it produced the empty hidden set, which shows
 * everything - and left two radios checked at once. That whole class is
 * unreachable here by construction.
 */
export type PlateSelection =
  | { readonly kind: 'all' }
  | { readonly kind: 'plate'; readonly plateId: string }
  | { readonly kind: 'custom' };

/** Show every plate. */
export const ALL_PLATES: PlateSelection = { kind: 'all' };

/** Visibility that is not any single plate. Never a user request. */
export const CUSTOM_PLATES: PlateSelection = { kind: 'custom' };

/**
 * Objects to hide so that only `selection` remains on screen.
 *
 * Hiding a plate's root objects is enough: both the scene graph and the part
 * tree resolve effective visibility through ancestors, so descendants follow.
 *
 * A `custom` selection is not something the user can ask for - it only ever
 * comes back out of {@link activePlateId} - so it is treated as "show
 * everything" rather than throwing.
 */
export function plateHiddenObjectIds(
  plates: readonly ScenePlate[],
  selection: PlateSelection,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (selection.kind !== 'plate') return hidden;
  for (const plate of plates) {
    if (plate.id === selection.plateId) continue;
    for (const objectId of plate.rootObjectIds) {
      hidden.add(objectId);
    }
  }
  return hidden;
}

type PlateVisibility = 'visible' | 'hidden' | 'mixed';

/**
 * Classify a plate by the *effective* visibility of every object on it.
 *
 * Root ids alone are not enough. Isolating a part keeps its ancestors visible,
 * so isolating one child of a plate root leaves that root visible while every
 * other plate's root is hidden - a set indistinguishable from "this plate is
 * selected" if only roots are consulted, even though a single part is drawn.
 */
function plateVisibility(
  members: readonly SceneObject[],
  effectiveHidden: ReadonlySet<string>,
): PlateVisibility {
  let hiddenCount = 0;
  for (const member of members) {
    if (effectiveHidden.has(member.id)) hiddenCount += 1;
  }
  if (hiddenCount === 0) return 'visible';
  if (hiddenCount === members.length) return 'hidden';
  return 'mixed';
}

function membersByPlate(
  objects: readonly SceneObject[],
): Map<string, SceneObject[]> {
  const byPlate = new Map<string, SceneObject[]>();
  for (const object of objects) {
    const members = byPlate.get(object.plateId);
    if (members) members.push(object);
    else byPlate.set(object.plateId, [object]);
  }
  return byPlate;
}

/**
 * Derive what the hidden set represents.
 *
 * `all` when nothing is filtered out, `plate` when exactly one populated plate
 * is fully visible and every other populated plate is fully hidden, and
 * `custom` when the visibility state does not correspond to any single plate
 * (a partially hidden plate, several plates visible, or everything hidden).
 *
 * Plates that carry no objects cannot be distinguished from each other, so they
 * are ignored rather than being reported as the active plate.
 *
 * Effective visibility is resolved for the whole scene in a single pass. Asking
 * per object instead is quadratic, because the per-object helper rebuilds the
 * scene index on every call, and the two states where that is cheap - nothing
 * hidden, and an object hidden outright - are exactly the two this feature is
 * never in.
 */
export function activePlateId(
  plates: readonly ScenePlate[],
  objects: readonly SceneObject[],
  hidden: ReadonlySet<string>,
): PlateSelection {
  const byPlate = membersByPlate(objects);
  const populated = plates
    .map((plate) => ({ plate, members: byPlate.get(plate.id) ?? [] }))
    .filter((entry) => entry.members.length > 0);
  if (populated.length === 0) return ALL_PLATES;

  const effectiveHidden = effectiveHiddenObjectIds(objects, hidden);
  const visibility = populated.map((entry) =>
    plateVisibility(entry.members, effectiveHidden),
  );
  if (visibility.some((state) => state === 'mixed')) return CUSTOM_PLATES;
  if (visibility.every((state) => state === 'visible')) return ALL_PLATES;

  const visible = visibility.reduce(
    (count, state) => (state === 'visible' ? count + 1 : count),
    0,
  );
  if (visible !== 1) return CUSTOM_PLATES;
  const plateId = populated[visibility.indexOf('visible')]?.plate.id;
  return plateId === undefined ? CUSTOM_PLATES : { kind: 'plate', plateId };
}
