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
  scanning/watching, streaming SHA-256 hashing, STL/3MF parsing via lib3mf, and
  a normalized scene cache.
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
