# PrintFarmer Desktop

A local-first desktop 3D model library for Windows and macOS, integrated with
[PrintFarmer](https://github.com/OlyForge3D/PrintFarmer).

PrintFarmer Desktop scans your existing STL/3MF folders in place, builds a fast
searchable visual library, groups exact duplicates, organizes models with tags
and collections, renders them in a rich 3D viewer, generates thumbnails, and
lets you select one or more models and upload them (with thumbnails) to a
PrintFarmer server.

## Status

Early development. See the implementation plan and the tracked work items.

## Architecture

- **Electron** shell with a hardened main/preload/renderer boundary.
- **React + strict TypeScript + Vite** renderer with a virtualized library grid.
- **Three.js (WebGL2)** for interactive viewing and deterministic thumbnails.
- **Rust sidecar** (`native/model-core`) that owns SQLite (WAL), folder
  scanning/watching, streaming SHA-256 hashing, pure-Rust STL/OBJ parsing, plus
  standard 3MF validation through an optional native `lib3mf` feature layered on
  top of the existing normalized scene cache and Production Extension parser.
- Backward-compatible integration with the .NET 10 PrintFarmer server for
  authentication, model/thumbnail upload, collections, and metadata sync.

Source models are never moved, modified, or uploaded without an explicit user
action.

The trust boundaries behind that claim, the adversaries they defend against, and
the accepted residual risks are documented in
[the threat model](./docs/security/THREAT_MODEL.md).

## Prepare an editable project for Snapmaker U1

PrintFarmer Desktop can create a **new review copy** of an editable Orca-family
3MF project for the Snapmaker U1. This workflow is available on Windows and
macOS from the selected model's inspector and 3D preview.

1. Catalog and select an editable `.3mf` created by OrcaSlicer or another
   Orca-compatible slicer export.
2. Choose **Prepare for Snapmaker U1**.
3. Explicitly select either a bundled U1 process profile or import an editable
   U1 reference project. Imported references are copied into a
   content-addressed local store; the renderer never receives their path.
4. Review preflight blockers, warnings, and proposed changes. Optionally enable
   per-plate object exclusion.
5. Build and validate a temporary review copy, then toggle between the source
   and U1 output scenes.
6. Use **Save As** to create a new `.3mf`. Existing files and the source are
   never overwritten.

The source must contain editable geometry, project settings, model settings,
one to four supported filament slots, valid object/tool routing, and valid OPC
relationships. Geometry-only 3MFs, G-code-only/pre-sliced archives, unsupported
Prusa/Cura projects, unsafe or malformed archives, dangling object references,
and incomplete/ambiguous settings are rejected with an actionable blocker.
Imported U1 references that contain local executable post-processing commands
are also rejected; remove those commands before importing the reference.
Unknown Orca-family producers are accepted with a warning and require careful
review.

Every output replaces machine identity, dimensions, limits, tools, and all
executable machine/filament G-code with values from the pinned bundled snapshot.
It applies the selected hash-bound process, maps compatible filament settings,
caps imported filament temperatures and volumetric flow at pinned material
values, and clamps all supported global/per-object speed, Z travel, and
acceleration overrides to independent pinned U1 ceilings;
optionally enables object exclusion; removes stale plate G-code, slice
metadata, custom per-layer G-code, digital signatures, and their obsolete OPC
links; rebuilds the package deterministically; and reopens and validates the
result. Geometry, build transforms, plate placement, tool routing, and unknown
non-slice parts are preserved. Raw paint metadata is preserved, but the app
reports it as **render-unverified**: inspect painted regions in Snapmaker Orca
before printing.

The workflow is local-only. Projects and imported profiles are not uploaded,
and the app performs no runtime profile download. Temporary review artifacts
use owner-bound, expiring tokens, are removed when the workflow/window closes,
and stale app-instance directories are removed on the next startup. The app
checks the source SHA-256 before preflight/build and after native validation;
cancel, failure, save, sidecar recovery, and app restart do not authorize a
source write.

### U1 profiles and provenance

Released builds contain a reviewed byte-for-byte snapshot from
[`Snapmaker/Orca_Presets`](https://github.com/Snapmaker/Orca_Presets), pinned to
commit `0c2d17834b7820339c1cf4326fda7db9da4a766a`. The package verifier checks the
manifest and every declared SHA-256 on Windows and macOS. Updates are
maintainer-only, require an exact 40-character commit and reviewed path
allowlist, and are documented in [the contributing guide](docs/CONTRIBUTING.md#pinned-target-profile-snapshots).

Imported references are useful when a reviewed project-specific U1 setup is
required. They must themselves be complete, editable U1 projects. The app
stores their exact bytes and expected SHA-256 and rejects missing, changed,
incomplete, or ambiguous references.

### Troubleshooting and current limits

- **Build is disabled:** select a target profile and resolve every preflight
  blocker.
- **Source changed:** refresh/rescan the catalog and retry only after confirming
  the source file is stable.
- **Destination exists/source conflict:** choose a new filename; Save As is
  intentionally non-overwriting.
- **Paint warning:** open the result in the accepted Snapmaker Orca version and
  inspect every painted region before slicing.
- **Profile unavailable/corrupt:** use a bundled profile or re-import the exact
  editable U1 reference.
- **Sidecar unavailable:** restart the app; unsaved temporary output is
  disposable and the source remains unchanged.

Phase one does not generate printer-ready G-code, send jobs to a printer,
control hardware, prove physical tool changes, repair unsupported slicer
projects, remap more than four material slots, or visually certify painted
regions. Snapmaker Orca and hardware acceptance remains a release gate recorded
in [the U1 acceptance checklist](docs/snapmaker-u1-release-acceptance.md).

## Printer Calibration

Printer Calibration is being developed as a native, first-class PFD workspace
based on upstream
[OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) calibration behavior and
its official
[calibration guide](https://github.com/OrcaSlicer/OrcaSlicer/wiki/calibration_guide).
It will use PrintFarmer printer instances and sanitized configuration snapshots
instead of a desktop-maintained printer catalog. PFD does not bundle third-party
calibration models or launch a separate calibration application.

## Repository layout

```
src/main/       Electron main process (windows, IPC, PrintFarmer transport, sidecar supervision)
src/preload/    Minimal typed context bridge
src/renderer/   React application (library, viewer, organization, uploads)
src/shared/     Versioned IPC/API schemas and non-privileged shared types
native/         Rust Cargo workspace (model-core sidecar)
tests/          TypeScript/Rust tests, fixtures, and packaging smoke tests
docs/security/  Threat model and security review records
```

## Development

Prerequisites: Node.js 22+, Rust (stable), and a supported platform toolchain.

```
npm install
npm run dev
```

### Optional native `lib3mf` validation

`native/model-core` now has a feature-gated `lib3mf` path:

```powershell
cd native/model-core
cargo build --features lib3mf
cargo test --features lib3mf
```

- **Current scope:** CI/dev builds only. `scripts/stage-sidecar.mjs` still stages
  only the sidecar executable; it does **not** stage `lib3mf.dll` /
  `lib3mf.dylib` / `lib3mf.so` into packaged app resources.
- **Release warning:** do **not** enable `--features lib3mf` for a production or
  packaged release build until `stage-sidecar.mjs` gains a real native-library
  staging step. Today there is no production DLL/shared-library shipping path for
  this feature.
- **Runtime behavior today:** when the native library is absent, the app now falls
  back to the internal pure-Rust parser and marks the scene as
  `SceneLoadStatus::Unsupported` with an explanatory status message instead of
  hard-failing 3MF loading.
- **Not verified here:** rebuilding the native `lib3mf` C/C++ library from source.
  `cl`, `cmake`, and `ninja` were not available in this session, so CI/source
  builds still need Visual Studio Build Tools with the Desktop C++ workload (or an
  equivalent native toolchain) to prove the full native rebuild path.

## Signed releases

Official `v*` tags build signed Windows artifacts and a signed, notarized
universal macOS app. The universal Rust sidecar is signed before the outer
Electron app. After both platform jobs verify their artifacts, CI publishes a
detached Ed25519-signed `latest.json` update manifest.

Build installers locally with `npm run make`, which remains unsigned unless
`PRINTFARMER_REQUIRE_SIGNING=1` and every platform credential is present:

```
Windows   out/make/squirrel.windows/x64/*Setup.exe
Windows   out/make/zip/win32/x64/*.zip
macOS     out/make/*.dmg  and  out/make/zip/darwin/universal/*.zip
```

Unsigned local and package-smoke builds remain fully functional but do not check
for in-app updates because they contain no production update public key. Tagged
release builds verify signed metadata, reject rollback, and hash the downloaded
installer or universal macOS ZIP before staging it. See
[Signed releases](./docs/RELEASES.md) for credential names, release ordering,
failure behavior, and interrupted-update recovery.

## License and source

PrintFarmer Desktop is licensed under
[GNU AGPL v3.0 only](./LICENSE) (`AGPL-3.0-only`). The complete source,
dependency locks, build scripts, attribution, and provenance records for each
official binary release are available from that release's matching Git tag in
this repository. See
[Corresponding Source](./docs/compliance/CORRESPONDING_SOURCE.md) and
[Third-Party Notices](./THIRD_PARTY_NOTICES.md) for the release and attribution
policy.
