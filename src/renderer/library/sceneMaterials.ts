import type { SceneMesh, SceneObject } from '../viewer/types';

/** Colour shown for objects the sidecar gave no base colour, matching the
 * viewer's own fallback in `sceneGraph.createObjectMaterial`. */
export const DEFAULT_BASE_COLOR: readonly [number, number, number] = [
  185, 192, 204,
];

export interface SceneMaterialGroup {
  /** Stable key derived from the colour, safe to use as a React key. */
  readonly id: string;
  /** `#rrggbb`, for a swatch and for naming the group when nothing better
   * exists. */
  readonly hex: string;
  readonly color: readonly [number, number, number];
  /** Objects painted with this colour. */
  readonly objects: number;
  readonly triangles: number;
  /** True when the colour is the viewer's fallback rather than authored. */
  readonly isDefault: boolean;
  /** Object names carrying this colour, in scene order, deduplicated. */
  readonly objectNames: readonly string[];
}

export interface SceneMaterialSummary {
  readonly groups: readonly SceneMaterialGroup[];
  /**
   * Triangles whose colour comes from a per-face palette rather than the
   * object's base colour. These cannot be grouped into a single swatch, so they
   * are reported separately instead of being silently folded into the base
   * colour they do not actually use.
   */
  readonly perFaceTriangles: number;
}

function clampChannel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(255, Math.max(0, Math.round(value)));
}

/** `#rrggbb` for an RGB byte triple. */
export function toHex(color: readonly [number, number, number]): string {
  const [r, g, b] = color;
  const channels = [clampChannel(r), clampChannel(g), clampChannel(b)];
  return `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

function baseColorOf(
  object: SceneObject,
): readonly [number, number, number] | null {
  const raw = object.material.baseColor;
  if (!raw) return null;
  const [r, g, b] = raw;
  if (r === undefined || g === undefined || b === undefined) return null;
  return [clampChannel(r), clampChannel(g), clampChannel(b)];
}

/**
 * Group a scene's objects by the colour they are drawn in (pure, GPU-free).
 *
 * Objects without an authored base colour are collected under the viewer's own
 * fallback rather than dropped, so the counts always add up to the objects the
 * user can actually see. Groups are ordered by triangle count so the material
 * dominating the model appears first.
 */
export function summarizeSceneMaterials(mesh: SceneMesh): SceneMaterialSummary {
  const byColor = new Map<
    string,
    {
      color: readonly [number, number, number];
      objects: number;
      triangles: number;
      isDefault: boolean;
      objectNames: string[];
      seenNames: Set<string>;
      order: number;
    }
  >();
  let perFaceTriangles = 0;
  let order = 0;

  for (const object of mesh.objects) {
    if (!object.mesh) continue;
    const triangles = Math.floor(object.mesh.indices.length / 3);
    const faceColors = object.material.faceColors;
    if (faceColors && faceColors.length > 0) {
      perFaceTriangles += triangles;
      continue;
    }
    const authored = baseColorOf(object);
    const color = authored ?? DEFAULT_BASE_COLOR;
    const hex = toHex(color);
    let group = byColor.get(hex);
    if (!group) {
      group = {
        color,
        objects: 0,
        triangles: 0,
        isDefault: authored === null,
        objectNames: [],
        seenNames: new Set<string>(),
        order,
      };
      order += 1;
      byColor.set(hex, group);
    }
    // A colour shared by an authored and an unauthored object is still
    // authored somewhere, so only an entirely unauthored group is "default".
    if (authored !== null) group.isDefault = false;
    group.objects += 1;
    group.triangles += triangles;
    if (object.name && !group.seenNames.has(object.name)) {
      group.seenNames.add(object.name);
      group.objectNames.push(object.name);
    }
  }

  const ranked = [...byColor.entries()]
    .map(([hex, group]) => ({ hex, ...group }))
    // Heaviest material first; first-seen order breaks ties so the result is
    // deterministic rather than dependent on Map iteration for equal counts.
    .sort((a, b) => b.triangles - a.triangles || a.order - b.order);

  const groups: SceneMaterialGroup[] = ranked.map((group) => ({
    id: group.hex,
    hex: group.hex,
    color: group.color,
    objects: group.objects,
    triangles: group.triangles,
    isDefault: group.isDefault,
    objectNames: group.objectNames,
  }));

  return { groups, perFaceTriangles };
}
