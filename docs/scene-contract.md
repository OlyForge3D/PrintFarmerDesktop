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
