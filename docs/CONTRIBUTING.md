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

| Command                | Purpose                              |
| ---------------------- | ------------------------------------ |
| `npm run dev`          | Launch the app with hot reload       |
| `npm run typecheck`    | Strict TypeScript check (no emit)    |
| `npm run lint`         | ESLint (type-aware)                  |
| `npm run format`       | Prettier check (`format:write` fixes)|
| `npm run test`         | Vitest unit/component tests          |
| `npm run make`         | Build platform installers            |

Rust sidecar (run from `native/`):

| Command                          | Purpose                    |
| -------------------------------- | -------------------------- |
| `cargo build`                    | Build the sidecar          |
| `cargo test`                     | Run sidecar tests          |
| `cargo clippy -- -D warnings`    | Lint with warnings denied  |
| `cargo fmt --check`              | Formatting check           |

## Conventions

- The renderer receives only the explicit, Zod-validated IPC channels declared
  in `src/shared/ipc.ts`. Do not expose Node, `ipcRenderer`, or filesystem
  primitives to renderer code.
- Any product change must run the unit tests that cover it; if none exist, add
  them.
- Source models are read-only. Never move, rename, modify, or upload a user's
  files without an explicit user action.
- Never commit credentials or signing material (see `.gitignore`).
