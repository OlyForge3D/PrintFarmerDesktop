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
that matches no single plate reports as "Custom" instead. Deriving it resolves
_effective_ visibility for every object on a plate, not just its roots, because
isolating a part keeps its ancestors visible: a plate root left visible does not
by itself mean the whole plate is on screen. Only visibility changes, so
geometry, colors, and materials survive a plate switch untouched. The selector is
omitted entirely for single-plate scenes.

## Metadata surfaces

Two panels read the DTO without touching the GPU, so both are unit-testable in
isolation:

- `src/renderer/library/VendorPanel.tsx` renders the source attribution the
  sidecar extracts — title, designer, description, copyright, license, and the
  creation/modification timestamps. Dates are formatted for display but fall
  back to the raw string when unparseable, because the value comes straight out
  of an untrusted file and showing `Invalid Date` would hide what is actually
  written there.
- `src/renderer/library/sceneMaterials.ts` groups `material.baseColor` across
  objects into distinct swatches with part and triangle counts. Objects carrying
  `material.faceColors` are excluded from swatch groups and counted separately,
  because a per-face palette cannot be represented as one colour. A group is
  only reported as the viewer default when **every** member was unauthored, so a
  file that genuinely specifies grey is not mislabelled as having no material.

## Level of detail

Large scenes get a reduced-detail proxy so orbiting stays interactive.
`src/renderer/viewer/lod.ts` holds the whole policy and the decimation itself as
pure functions over the DTO — no `THREE` renderer state — and
`buildViewerSceneGraph` is the only place that turns the result into
`THREE.LOD` nodes.

- A scene qualifies only when the **scene total is ≥ 150,000 triangles _and_ at
  least one object is ≥ 20,000**. A scene made of ten thousand tiny objects is
  draw-call bound, not triangle bound, so decimating it would cost time and buy
  nothing.
- Decimation is **vertex clustering**: quantise every vertex to a fixed grid
  over the object's bounds, keep the first vertex that lands in each cell, and
  drop triangles that collapse to a degenerate. It is a single O(n) pass with no
  connectivity structure, and it is deterministic — the same mesh always yields
  a byte-identical proxy. Keeping a real input vertex rather than the cell
  average means every proxy vertex lies on the original surface, which is what
  makes reusing the source `bounds` sound.
- The proxy **shares the full-detail material instance**. A second material
  would make a wireframe toggle or colour change apply to only one level, so the
  object would visibly change as it crossed the switch distance. Only the proxy
  geometry is added to the disposal list.
- Objects with per-face colours are left at full detail. Welding destroys the
  triangle-per-vertex layout the colour attribute depends on, and the shared
  material would then demand a colour buffer the proxy cannot supply and draw
  black. The guard keys off the geometry's `color` attribute rather than the DTO
  field, so it tracks what the material will actually require.
- The switch is on **apparent size, not camera distance**. `updateLod(camera)`
  picks a level for every proxied object before each draw, comparing the
  object's world-space bounding sphere against the viewport half-height; the
  proxy takes over below **15% of half-height**. `THREE.LOD`'s own selection is
  switched off (`autoUpdate = false`) because it keys on
  `distance / camera.zoom`, and under an orthographic projection the camera
  never moves — `dollyCamera` only changes zoom — so distance describes nothing
  the user is doing. Working the same threshold through both projections gives
  screen coverages that differ by 2.4×, so no single distance constant serves
  both.
- Expressing the policy as screen coverage rather than as a multiple of the
  object's radius is a **correctness requirement, not a preference**. The first
  version used a fixed 3 radii, chosen without reference to `defaultCameraPosition`
  — which offsets on all three axes, so the true distance is `× √3` — and to
  `fitPerspectiveDistance`'s `padding = 1.15`. That put the default framing at
  ~6.2 radii, on the far side of the switch, so the proxy was the visible level
  from the moment a model loaded. Reading the live frustum means changing either
  function cannot silently decalibrate the policy again.
- Tests must assert **which level is visible**, not just that an LOD node exists.
  A full suite of shape-only assertions stayed green through the defect above.

`ModelViewer` draws on demand rather than every frame: it renders when the
controls dispatch `change` (which covers dragging, damping settling, and the
keyboard helpers uniformly), on resize, on context restore, and when a prop that
affects the image changes. A still scene costs no GPU time.
