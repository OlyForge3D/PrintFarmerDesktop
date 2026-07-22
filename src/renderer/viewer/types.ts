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

export type ModelFormat = 'stl' | 'threeMf';

export interface Bounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
}

/** A named, selectable triangle range within a {@link SceneMesh}. */
export interface ScenePart {
  readonly name: string;
  readonly triangleStart: number;
  readonly triangleCount: number;
}

export interface SceneMesh {
  /** Flattened vertex positions; length is a multiple of three. */
  readonly positions: readonly number[];
  /** Triangle vertex indices; length is a multiple of three. */
  readonly indices: readonly number[];
  readonly bounds: Bounds;
  readonly sourceFormat: ModelFormat;
  /** One RGB (0–255) triple per triangle, or null/undefined when uncolored. */
  readonly faceColors?: readonly number[] | null | undefined;
  /** Named triangle ranges for the part tree; may be empty. */
  readonly parts?: readonly ScenePart[];
}
