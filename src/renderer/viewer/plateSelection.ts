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

import type { ScenePlate } from './types';

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

function plateVisibility(
  plate: ScenePlate,
  hidden: ReadonlySet<string>,
): PlateVisibility {
  let hiddenCount = 0;
  for (const objectId of plate.rootObjectIds) {
    if (hidden.has(objectId)) hiddenCount += 1;
  }
  if (hiddenCount === 0) return 'visible';
  if (hiddenCount === plate.rootObjectIds.length) return 'hidden';
  return 'mixed';
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
 * Empty plates carry no geometry and so cannot be distinguished from each
 * other; they are ignored rather than being reported as the active plate.
 */
export function activePlateId(
  plates: readonly ScenePlate[],
  hidden: ReadonlySet<string>,
): string | null {
  const populated = plates.filter((plate) => plate.rootObjectIds.length > 0);
  if (populated.length === 0) return ALL_PLATES;

  const visibility = populated.map((plate) => plateVisibility(plate, hidden));
  if (visibility.some((state) => state === 'mixed')) return null;
  if (visibility.every((state) => state === 'visible')) return ALL_PLATES;

  const visible = visibility.reduce(
    (count, state) => (state === 'visible' ? count + 1 : count),
    0,
  );
  if (visible !== 1) return null;
  const index = visibility.indexOf('visible');
  return populated[index]?.id ?? null;
}
