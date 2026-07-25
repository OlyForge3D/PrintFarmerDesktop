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

import { isObjectHidden } from '../library/partTreeModel';
import type { SceneObject, ScenePlate } from './types';

/** Sentinel selection meaning "no plate filter". */
export const ALL_PLATES = 'all';

/**
 * Objects to hide so that only `plateId` remains on screen.
 *
 * Hiding a plate's root objects is enough: both the scene graph and the part
 * tree resolve effective visibility through ancestors, so descendants follow.
 */
export function plateHiddenObjectIds(
  plates: readonly ScenePlate[],
  plateId: string,
): ReadonlySet<string> {
  const hidden = new Set<string>();
  if (plateId === ALL_PLATES) return hidden;
  for (const plate of plates) {
    if (plate.id === plateId) continue;
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
  objects: readonly SceneObject[],
  hidden: ReadonlySet<string>,
): PlateVisibility {
  let hiddenCount = 0;
  for (const member of members) {
    if (isObjectHidden(objects, member.id, hidden)) hiddenCount += 1;
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
 * Derive the selected plate from the hidden set.
 *
 * Returns {@link ALL_PLATES} when nothing is filtered out, a plate id when
 * exactly one populated plate is fully visible and every other populated plate
 * is fully hidden, and `null` when the visibility state does not correspond to
 * any single plate (a partially hidden plate, several plates visible, or
 * everything hidden).
 *
 * Plates that carry no objects cannot be distinguished from each other, so they
 * are ignored rather than being reported as the active plate.
 */
export function activePlateId(
  plates: readonly ScenePlate[],
  objects: readonly SceneObject[],
  hidden: ReadonlySet<string>,
): string | null {
  const byPlate = membersByPlate(objects);
  const populated = plates
    .map((plate) => ({ plate, members: byPlate.get(plate.id) ?? [] }))
    .filter((entry) => entry.members.length > 0);
  if (populated.length === 0) return ALL_PLATES;

  const visibility = populated.map((entry) =>
    plateVisibility(entry.members, objects, hidden),
  );
  if (visibility.some((state) => state === 'mixed')) return null;
  if (visibility.every((state) => state === 'visible')) return ALL_PLATES;

  const visible = visibility.reduce(
    (count, state) => (state === 'visible' ? count + 1 : count),
    0,
  );
  if (visible !== 1) return null;
  return populated[visibility.indexOf('visible')]?.plate.id ?? null;
}
