# Contributing

## Prerequisites

- **Node.js 22+** and npm.
- **Rust (stable)** via [rustup](https://rustup.rs).
- **A C++ toolchain for the sidecar linker:**
  - **Windows:** Visual Studio 2022+ with the **Desktop development with C++**
    workload (this installs the MSVC toolset, the Windows 10/11 SDK, and
    `vcvarsall.bat`). Build the sidecar from a **Developer PowerShell/Command
    Prompt for VS**, or after running `vcvarsall.bat x64`, so the linker can
    find `msvcrt.lib` and the SDK libraries.
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`).

## Install

```
npm install
```

## Everyday commands

Renderer/main/preload (run from the repo root):

| Command                    | Purpose                               |
| -------------------------- | ------------------------------------- |
| `npm run dev`              | Launch the app with hot reload        |
| `npm run typecheck`        | Strict TypeScript check (no emit)     |
| `npm run lint`             | ESLint (type-aware)                   |
| `npm run format`           | Prettier check (`format:write` fixes) |
| `npm run check:provenance` | Calibration source/provenance gate    |
| `npm run test`             | Vitest unit/component tests           |
| `npm run make`             | Build platform installers             |

Rust sidecar (run from `native/`):

| Command                       | Purpose                   |
| ----------------------------- | ------------------------- |
| `cargo build`                 | Build the sidecar         |
| `cargo test`                  | Run sidecar tests         |
| `cargo clippy -- -D warnings` | Lint with warnings denied |
| `cargo fmt --check`           | Formatting check          |

## Conventions

- The renderer receives only the explicit, Zod-validated IPC channels declared
  in `src/shared/ipc.ts`. Do not expose Node, `ipcRenderer`, or filesystem
  primitives to renderer code.
- Any product change must run the unit tests that cover it; if none exist, add
  them.
- Source models are read-only. Never move, rename, modify, or upload a user's
  files without an explicit user action.
- Never commit credentials or signing material (see `.gitignore`).

## Printer Calibration source-derived contributions

PFD's `AGPL-3.0-only` adoption is approved and recorded in
`compliance/printer-calibration-provenance.json`. If that approval record is
removed or changed, CI rejects all source-derived files. Repository
administrators should require review from the compliance CODEOWNER (`@jpapiez`)
on the protected target branch.

Source-derived files must:

1. Use only the exact source revision pinned in the provenance manifest. Do not
   consult or copy older revisions, branches, forks, local history, static
   printer data, fixtures, or unverified assets.
2. Live below one of the manifest's `derivedRoots`. Native PFD orchestration,
   UI, persistence, printer ownership, authorization, queueing, and safety code
   stays outside those roots and must be independently implemented.
3. Add a `derivedFiles` record with the source path and Git blob, destination
   SHA-256, original attribution, modification summary, and reviewer decision.
   Ported tests are derived files and use the `ported-test` classification.
4. Begin with a notice in the source file using the applicable comment syntax:

   ```
   // PFD-SOURCE-DERIVED: printer-calibration
   // Source-Commit: <40-character pinned commit>
   // Source-Path: <path in the pinned source tree>
   // Source-Blob: <40-character Git blob>
   // SPDX-License-Identifier: AGPL-3.0-only
   // PFD-Original-Notice: <one exact manifest notice; repeat as needed>
   // PFD-Modified-At: <YYYY-MM-DD>
   // PFD-Modifications: <exact modification summary from the manifest>
   ```

5. Run `npm run check:provenance` and the independent PFD-specific tests for the
   changed architecture and behavior.

To advance the source pin, open a dedicated compliance PR. Verify the new
canonical tag, commit, tree, source archive SHA-256, license and package-metadata
blobs; audit every newly considered source file and asset; update the ADR,
manifest, checker pin, and failure fixtures together; and obtain an authorized
maintainer decision before any file uses the new revision. Never move an
existing tag or silently update a hash.
