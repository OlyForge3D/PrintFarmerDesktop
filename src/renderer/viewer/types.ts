/**
 * Renderer-side mirror of the sidecar's `scene::SceneMesh`. The Rust parser
 * produces this normalized, format-agnostic mesh; the viewer and thumbnail
 * renderer consume it without ever knowing whether it came from STL or 3MF.
 *
 * Positions and indices are kept as flat arrays (the shape the RPC layer will
 * deliver): `positions` is `[x, y, z, x, y, z, ...]` and `indices` references
 * vertices in triples. `faceColors`, when present, is one `[r, g, b]` triple of
 * 0–255 bytes per triangle (currently only STL supplies per-facet colors).
 */

export type ModelFormat = 'stl' | 'threeMf' | 'obj';
export type SceneLoadStatus = 'complete' | 'partial' | 'unsupported';

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A named, selectable triangle range within a {@link SceneMesh}. */
export interface ScenePart {
  readonly name: string;
  readonly triangleStart: number;
  readonly triangleCount: number;
  readonly status?: SceneLoadStatus;
  readonly statusDetail?: string;
  readonly partNumber?: string;
  readonly materialLabel?: string;
}

export interface SceneTransform {
  /**
   * 4×4 local transform relative to the scene root or `parentId`, already laid
   * out in the row-major argument order that `THREE.Matrix4.set()` expects.
   */
  readonly matrix: readonly number[];
}

export interface SceneMaterial {
  readonly baseColor?: readonly [number, number, number] | null | undefined;
  readonly faceColors?: readonly number[] | null | undefined;
}

export interface SceneObjectMesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
  readonly bounds: Bounds;
}

export interface SceneObject {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly parentId?: string | null | undefined;
  readonly children: readonly string[];
  readonly transform: SceneTransform;
  readonly mesh?: SceneObjectMesh | null | undefined;
  readonly material: SceneMaterial;
  readonly plateId: string;
  readonly buildItemIndex?: number | null | undefined;
}

export interface ScenePlate {
  readonly id: string;
  readonly name: string;
  readonly index: number;
  readonly rootObjectIds: readonly string[];
}

export interface SceneMesh {
  readonly sceneVersion: 2;
  /** Flattened vertex positions; length is a multiple of three. */
  readonly positions: readonly number[];
  /** Triangle vertex indices; length is a multiple of three. */
  readonly indices: readonly number[];
  readonly bounds: Bounds;
  readonly sourceFormat: ModelFormat;
  /** One RGB (0–255) triple per triangle, or null/undefined when uncolored. */
  readonly faceColors?: readonly number[] | null | undefined;
  readonly status?: SceneLoadStatus;
  readonly statusMessages?: readonly string[];
  /** Named triangle ranges for the part tree; may be empty. */
  readonly parts?: readonly ScenePart[];
  /** Hierarchical object instances for the renderer-facing contract. */
  readonly objects: readonly SceneObject[];
  readonly rootObjectIds: readonly string[];
  readonly plates: readonly ScenePlate[];
}
