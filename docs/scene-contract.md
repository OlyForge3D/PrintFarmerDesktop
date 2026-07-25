# Scene DTO contract

`model:loadScene` now returns **scene DTO v2** (`sceneVersion: 2`).

- `positions` / `indices` / `bounds` / `faceColors` / `parts` remain the legacy flattened aggregate mesh for stats, thumbnails, and any older single-mesh code paths.
- `objects` is the authoritative renderer contract:
  - `id`: stable instance id
  - `sourceId`: stable source-object identity
  - `parentId` + `children`: explicit hierarchy
  - `transform.matrix`: local 4×4 affine matrix already laid out in the **row-major argument order that `THREE.Matrix4.set()` expects** (translation in entries 3/7/11, bottom row `[0, 0, 0, 1]`). For 3MF this is the transpose of the source `p' = p·R + T` row-vector transform.
  - `mesh`: local per-object geometry when the node is renderable; omitted/null for assembly-only nodes
  - `material.baseColor` / `material.faceColors`: per-object color payload
  - `plateId` / `buildItemIndex`: placement metadata
- `rootObjectIds` lists scene roots in display order.
- `plates` groups root objects by build plate.

Format mapping:

- STL / OBJ: one root object on `plate-0` with identity transform.
- 3MF: one root object per build item; component references become child objects with local transforms preserved.
- 3MF scenes are rejected once they exceed **5,000 mesh-bearing objects**, which keeps renderer-side `Group`/`BufferGeometry`/`Material`/`Mesh` allocation within a bounded desktop GPU budget.

## Renderer consumption

`src/renderer/library/partTreeModel.ts` is the single place the hierarchy is
interpreted for the UI. It flattens `plates` → `rootObjectIds` → `children` into
the row list the part tree renders and the keyboard walks, and it derives the
hidden-object sets that `ModelViewer` applies to the scene graph.

Because scene DTOs come from untrusted files, every walk is cycle-safe: an
object appears at most once per resolved tree, a repeated `children` reference
is rendered as a diagnostic row instead of recursing, and unknown ids are
dropped. Hiding a node hides its whole subtree; isolating a node hides
everything except that node, its descendants, and the ancestors it hangs from.

The tree is the accessible, non-canvas alternative to picking parts in the 3D
view: it is a WAI-ARIA `tree` with a single roving tab stop, arrow keys to move
and expand/collapse, <kbd>Space</kbd> to hide or show the focused node, and
<kbd>I</kbd> to isolate it.
