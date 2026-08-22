# Closing-reference declaration

This PR makes a calibration print reach a printer, and adds the coverage that
proves it: the dead "Start calibration print" button is removed, server refusal
codes are translated into operator wording with compile-time exhaustiveness, the
main process carries server unavailable reasons through to the renderer, and the
self-referential calibration fixtures are replaced with server-sourced snapshots
pinned by blob SHA plus a provenance guard.

No tracked issue in this repository covers it. The investigation did surface
four genuine server-side defects, but those live in `OlyForge3D/PrintFarmer` and
were filed there as #1848, #1849, #1850 and #1851 — a closing reference here
cannot and must not close an issue in another repository.

The empty block below is therefore a deliberate declaration that this PR closes
nothing, per `.github/pr-closes/README.md`.

```closes

```
