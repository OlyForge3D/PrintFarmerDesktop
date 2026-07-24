# STEP tessellation spike (#30)

## Goal

Evaluate whether the pure-Rust `truck` stack is sufficient to import STEP (`.step`/`.stp`) into `native/model-core` and tessellate it into the existing `SceneMesh` pipeline.

## What landed in this spike

- Added a feature-gated `step` path in `native/model-core`.
- Added optional `truck-stepio`, `truck-meshalgo`, `truck-topology`, and `truck-modeling` support in `Cargo.toml`.
- Added `ModelFormat::Step` (`.step` and `.stp`) and feature-gated `load_scene` dispatch.
- Implemented a `step` loader that:
  - parses STEP text with `truck-stepio`
  - extracts shell topology from `Table::shell`
  - tessellates each shell with `truck-meshalgo`
  - converts the result into `SceneMesh`
- Added two locally generated STEP fixtures plus a manifest-backed integration test corpus.

## Important blocker discovered

The published `truck-stepio = 0.3.0` crate available on crates.io is materially less capable than the upstream code referenced by the issue notes/examples:

- it **does expose** `Table::to_compressed_shell`
- it **does not expose** the assembly / product conversion helpers used by upstream examples (`step_assy`, solid conversion, shell-model conversion)

That means this spike can currently tessellate **raw shells** that appear directly in `Table::shell`, but it cannot faithfully reconstruct:

- STEP product structure / named parts
- assembly transforms
- manifold-solid helpers exposed only in newer upstream code

This is the main reason the result stays feature-gated and should **not** be promoted to default.

## Fixture corpus actually tested

I did **not** reach the full target corpus from the issue (single part + multi-body assembly + curved/filleted + large real-world file). I could only produce and validate a small in-house corpus:

1. `cube.step`
   - provenance: generated locally with `truck-modeling` sweep ops, exported with `truck-stepio`
   - shape: simple closed box
2. `cylinder.step`
   - provenance: generated locally with `truck-modeling` revolve/extrude ops, exported with `truck-stepio`
   - shape: simple analytic curved surface

Missing from this spike:

- multi-body / assembly fixtures
- externally authored real-world CAD fixtures
- filleted / trimmed-NURBS-heavy parts
- large production STEP files

## Results

Success rate on tested corpus: **2 / 2 fixtures (100%)**

### cube.step

- status: pass
- vertices: 8
- triangles: 12
- parts: 1
- bounds: `[-0.5, -0.5, -0.5]..[0.5, 0.5, 0.5]`
- measured tessellation/load time: ~8 ms in debug test run
- quality note: exact-looking box mesh, expected triangle count

### cylinder.step

- status: pass
- vertices: 771
- triangles: 1538
- parts: 1
- bounds: `[-0.49963003, -0.5, -0.5]..[0.49963003, 0.5, 0.5]`
- measured tessellation/load time: ~50 ms in debug test run
- quality note: curved surface tessellates successfully, but the default relative tolerance produces a fairly dense mesh for a trivial cylinder

## Quality / fidelity observations

- For simple shell-backed solids, the truck path works and cleanly feeds the existing `SceneMesh` pipeline.
- The tessellator produces usable triangle output for both planar and curved fixtures.
- The cylinder result suggests tessellation density will need policy/tuning before shipping broadly.
- Because the published crate only gives shell extraction, this spike cannot yet validate the hard cases that matter most for STEP in practice: assemblies, transforms, and richer real-world B-rep data.

## Performance observations

- Debug-build timings on the tiny corpus were acceptable:
  - cube: ~8 ms
  - cylinder: ~50 ms
- No release-build benchmarking was done in this spike.
- The simple relative tolerance (`diagonal * 0.001`) is conservative and likely over-tessellates some curved shapes.

## Recommendation

**No-go for promoting truck to the default STEP path today.**

Reasoning:

1. the crates.io `truck-stepio` release lacks the assembly/solid conversion surface needed for representative STEP support
2. the validated corpus is too small and too synthetic to justify default-on import
3. the current prototype does not prove fidelity on real-world CAD, which is the central risk called out in the issue

## Concrete next issue

Open a follow-up **OCCT-FFI evaluation issue** with this scope:

- tessellate a real STEP corpus (assembly, filleted part, large file, vendor-exported CAD)
- compare success/failure and mesh quality against this truck spike
- decide whether OCCT becomes the production importer, or whether a vendored/newer truck integration is still worth pursuing

If the team still wants to keep truck in play, a separate enabling task is needed first: vendor or upgrade to an upstream `truck-stepio`/related stack that exposes assembly + solid conversion APIs comparable to the upstream example code.
