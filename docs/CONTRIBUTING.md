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

| Command                          | Purpose                                    |
| -------------------------------- | ------------------------------------------ |
| `npm run dev`                    | Launch the app with hot reload             |
| `npm run typecheck`              | Strict TypeScript check (no emit)          |
| `npm run lint`                   | ESLint (type-aware)                        |
| `npm run format`                 | Prettier check (`format:write` fixes)      |
| `npm run test`                   | Vitest unit/component tests                |
| `npm run make`                   | Build platform installers                  |
| `npm run verify:target-profiles` | Verify the pinned printer-profile snapshot |

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

## Pinned target-profile snapshots

Released builds bundle reviewed printer data from
[`Snapmaker/Orca_Presets`](https://github.com/Snapmaker/Orca_Presets) under
`resources/target-profiles/`. The app never downloads profiles at runtime.
Each bundle manifest records the exact upstream commit, selected paths,
per-file SHA-256 hashes, retrieval date, and provenance. The current upstream
repository has no top-level license file, so its manifest states that fact
without asserting license terms.

Updates are maintainer-only and require an explicit reviewed 40-character
commit plus retrieval date:

```text
npm run update:snapmaker-presets -- --ref <40-hex-commit> --retrieved-at YYYY-MM-DD
npm run verify:target-profiles
```

The updater accepts only the reviewed path allowlist in
`scripts/target-profile-tools.mjs`, validates U1 identity and the complete
inheritance closure, and rejects branches, tags, missing dependencies, unsafe
paths, changed license-file status, and unreachable extras. Adding or removing
a path therefore requires a code review of the allowlist as well as the
regenerated manifest and profile bytes.
