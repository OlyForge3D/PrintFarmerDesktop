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

## Repository layout

```
src/main/       Electron main process (windows, IPC, PrintFarmer transport, sidecar supervision)
src/preload/    Minimal typed context bridge
src/renderer/   React application (library, viewer, organization, uploads)
src/shared/     Versioned IPC/API schemas and non-privileged shared types
native/         Rust Cargo workspace (model-core sidecar)
tests/          TypeScript/Rust tests, fixtures, and packaging smoke tests
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

## Releases (unsigned)

Builds are currently **unsigned**: there is no Windows code-signing certificate
and no Apple notarization credential configured, so `forge.config.ts` sets no
`certificateFile` or `osxNotarize`. Unsigned artifacts are fully functional; the
only difference is a first-launch OS trust prompt for end users.

Build the installers locally with `npm run make`, which produces (per platform):

```
Windows   out/make/squirrel.windows/x64/*.Setup.exe   unsigned installer
Windows   out/make/zip/win32/x64/*.zip                portable (unzip & run)
macOS     out/make/*.dmg  and  out/make/zip/darwin/*   unsigned disk image / zip
```

CI builds unsigned artifacts on every push (the "Package smoke" jobs), and
tagging a release (`v*`) runs `.github/workflows/release.yml`, which builds on
Windows + macOS and attaches the artifacts to a GitHub Release.

**End-user trust prompts (expected for unsigned builds):**

- **Windows / SmartScreen** — "Windows protected your PC / unknown publisher".
  Users click **More info → Run anyway**. The portable ZIP avoids the installer
  but the bundled `PrintFarmer Desktop.exe` still shows this on first run.
- **macOS / Gatekeeper** — "cannot be opened because the developer cannot be
  verified". Users **right-click → Open** once (or run
  `xattr -dr com.apple.quarantine "/Applications/PrintFarmer Desktop.app"`).

To ship without any prompt later, add a Windows code-signing certificate
(`MakerSquirrel({ certificateFile, certificatePassword })`) and Apple
notarization (`packagerConfig.osxSign` + `osxNotarize`); no other changes are
required.

## License

Proprietary — OlyForge3D. All rights reserved.
