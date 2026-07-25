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

### Plates

Object ids embed the plate they belong to (`plate-{p}/item-{n}/object-{id}`), so
plate membership is fixed at parse time and cannot drift from the scene graph.

Plate membership comes from `Metadata/model_settings.config`, the vendor part
Bambu Studio and OrcaSlicer write. Its `<plate>` blocks map `(object_id,
instance_id)` pairs to plates, where `instance_id` counts a given object's build
items in document order — the same order the flatten walks, which is what links
the two files.

That part is advisory, so every failure mode (absent, oversized, unreadable,
malformed XML, or present but declaring no plates) degrades to the single
implicit plate the parser has always emitted. STL, OBJ, and plain 3MF are
therefore unchanged: one plate named `Plate 1`, ids still prefixed `plate-0/`.

Two further rules keep the plate list honest:

- At most **1,000** declared plates are recorded. That matches the vendor-metadata
  cap and the scene-DTO `plates` limit the IPC layer enforces, which would
  otherwise reject the entire scene rather than just the surplus plates.
- Declared plates that receive no build item are dropped and the survivors are
  renumbered from 0, so the plate selector never offers an entry with nothing on
  it.

## Renderer consumption

`src/renderer/library/partTreeModel.ts` is the single place the hierarchy is
interpreted for the UI. It flattens `plates` → `rootObjectIds` → `children` into
the row list the part tree renders and the keyboard walks, and it derives the
hidden-object sets that `ModelViewer` applies to the scene graph.

Because scene DTOs come from untrusted files, the flatten is hostile-shape safe.
An object id yields **at most one** rendered row across the whole tree, so a
repeated `children` entry, an object referenced by two parents, and the same
object listed on two plates all render once and then degrade to a uniquely-keyed
diagnostic row. Row keys are therefore unique for any graph shape, which is what
lets the tree keep a single roving tab stop. The walk is iterative rather than
recursive, so a deep chain cannot overflow the stack, and a global row budget of
20,000 rows — four times the 5,000-object sidecar cap above, so it cannot reach
a legitimate scene — truncates with a notice row rather than locking up the
renderer. Pending work is clamped against that same budget, so a node with a
huge child list cannot balloon the queue past the rows that could ever be
emitted. Unknown ids are dropped. Hiding a node hides its whole subtree;
isolating a node hides everything except that node, its descendants, and the
ancestors it hangs from.

The tree is the accessible, non-canvas alternative to picking parts in the 3D
view: it is a WAI-ARIA `tree` with a single roving tab stop, arrow keys to move
and expand/collapse, <kbd>Space</kbd> to hide or show the focused node, and
<kbd>I</kbd> to isolate it.

`src/renderer/viewer/plateSelection.ts` layers the plate selector on the same
hidden-object set: selecting a plate hides the other plates' root objects, and
the checked radio is _derived_ from the hidden set rather than stored alongside
it. That keeps one source of truth, so a part-tree toggle can never leave the
selector claiming a plate that is not what is on screen — a visibility state
that matches no single plate reports as "Custom" instead. Only visibility
changes, so geometry, colors, and materials survive a plate switch untouched.
The selector is omitted entirely for single-plate scenes.
