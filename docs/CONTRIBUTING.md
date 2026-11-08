# Contributing

## Prerequisites

- **Node.js 22.12+** and npm.
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
npm run build:sidecar
```

The sidecar command builds the release executable with SQLite and stages it
where the development app expects it. Run it in each fresh checkout/worktree
and again after native changes; `npm start` does not build the Rust sidecar.

## Everyday commands

Renderer/main/preload (run from the repo root):

| Command                                  | Purpose                                            |
| ---------------------------------------- | -------------------------------------------------- |
| `npm start`                              | Launch the app with hot reload                     |
| `npm run build:sidecar`                  | Build and stage the development sidecar            |
| `npm run typecheck`                      | Strict TypeScript check (no emit)                  |
| `npm run lint`                           | ESLint (type-aware)                                |
| `npm run format`                         | Prettier check (`format:write` fixes)              |
| `npm run check:inert-class-field-seams`  | Guards against #270-style inert prototype seams    |
| `npm run check:design-detector -- --all` | Scan the renderer for AI-slop design anti-patterns |
| `npm run test`                           | Vitest unit/component tests                        |
| `npm run make`                           | Build platform installers                          |
| `npm run verify:target-profiles`         | Verify the pinned printer-profile snapshot         |
| `npm run worktree:remove -- <path>`      | Safely force-remove a linked worktree              |

Rust sidecar (run from `native/`):

| Command                                         | Purpose                            |
| ----------------------------------------------- | ---------------------------------- |
| `cargo build`                                   | Build the sidecar                  |
| `cargo test`                                    | Run the default-feature tests only |
| `cargo test --features sqlite`                  | Add the SQLite catalog tests       |
| `cargo test --features step`                    | Add the STEP importer tests        |
| `cargo clippy -- -D warnings`                   | Lint with warnings denied          |
| `cargo clippy --features sqlite -- -D warnings` | Lint the SQLite catalog too        |
| `cargo fmt --check`                             | Formatting check                   |

`cargo test` on its own is **not** the sidecar suite. `sqlite_catalog` and `step`
are optional modules (`lib.rs`), so without their feature flags the compiler
drops those files and every test inside them. Measured on `model-core`:

```
cargo test --lib                   ->  265 passed; 0 filtered out
cargo test --lib --features step   ->  267 passed; 0 filtered out
cargo test --lib --features sqlite ->  339 passed; 0 filtered out
```

The 74-test difference includes every calibration conflict-resolution test. Note
`0 filtered out` on all three: the bare command does not skip those tests or
report them as filtered, because they were never compiled. It reports `ok` for a
suite that does not exist in that build, which is why it reads as a complete
pass. CI runs each feature separately (`ci.yml`), so this is a local-check
hazard: a change to a feature-gated module can look tested locally and only be
exercised in CI.

## macOS installer artwork

The drag-to-install DMG uses `assets/dmg/background.svg` as its editable source.
On macOS, run `npm run generate:dmg-background` to regenerate
the committed 680 x 460 PNG and its double-resolution `@2x` sibling. Appdmg
combines those into a Retina TIFF when building the installer. Use
`npm run generate:dmg-background -- --preview-dir /absolute/path` to also save a composed preview with icons and
labels; this is illustrative, not a Finder screenshot.

Keep the artwork's icon centers and dimensions aligned with the `MakerDMG`
configuration in `forge.config.ts`. The pale icon area preserves contrast for
Finder's labels. Use `title` for the mounted volume name, not `name`: setting
`name` disables Forge's version/architecture-qualified DMG filename. The
contents callback uses the packaged app path for both native and universal
builds; signing and notarization still run before the maker.

Do not override macOS makers with package-name `--targets` arguments: Forge
matches configured class instances by their short names (`dmg`, `zip`,
`squirrel`), and unmatched package names instantiate unconfigured makers.
Use `npm run make -- --skip-package --platform=darwin` after packaging, adding
`--arch=universal` for universal builds. Windows release steps select
`--targets=squirrel` or `--targets=zip` separately so the portable archive does
not rebuild a signed installer.

Run `npm run verify:dmg` on macOS after making the installers. It mounts each
built DMG read-only, checks the volume title, compares the embedded Retina TIFF
byte-for-byte with the committed PNG pair converted by `tiffutil`, and requires
a Finder layout. Both the release workflow and CI's macOS release-package job
run this assertion before accepting the artifacts.

## UI design checks

Changes to the renderer's markup and styles (the set is defined in
`scripts/design-surface.mjs`) are checked for generated-UI anti-patterns by a
vendored copy of the impeccable design skill's detector in `tools/impeccable-detector/` (Apache-2.0, pinned by
`manifest.json`):

- The `Design detector` workflow scans the files a pull request changes and
  fails on any non-advisory finding. It runs the detector and manifest from the
  base commit, not from the pull request, so a change to the detector only
  takes effect after it merges. Run it locally with
  `npm run check:design-detector -- --files <paths>` or `-- --all`.
- Copilot agents get the same findings in-context after each edit through
  `.github/hooks/impeccable.json`. Turn it off for yourself with
  `{ "hook": { "enabled": false } }` in the gitignored
  `.impeccable/config.local.json`, or set `IMPECCABLE_HOOK_DISABLED=1`.
  The hook runs code from the checked-out branch, the same trust you already
  extend to its git hooks and npm scripts. The opt-outs above are honored by
  that same branch code, so they are not a safeguard against an untrusted or
  fork branch: such a branch can edit the script, the manifest, or add its own
  manifest. Before pointing an agent at one, review every `.github/hooks/`
  manifest and the executables it references, disable repository hooks in the
  agent host outside the checkout, or don't run the agent on that checkout.
- Suppress a deliberate choice with an inline `impeccable-disable <rule> -- reason`
  comment or `detector.ignoreRules` / `ignoreFiles` in
  `.impeccable/config.json`. Both are visible in review.
- Squad pull requests that touch any `src/renderer/**` file (including `.ts`
  the detector cannot scan), root `index.html`, or the design gate's own files
  also need a `lambert` design review; see
  `.squad/skills/agent-collaboration/SKILL.md`.

- User-visible renderer changes include screenshots of the running app
  (`npm start`) taken at the head commit, in the pull request's
  `## Screenshots (UI changes)` section, or a stated reason there are none.
  Status, glyph, and secondary-detail conventions are in `DESIGN.md`.
- `tools/impeccable-detector/` is third-party code excluded from CodeQL by
  `.github/codeql/codeql-config.yml`; the upstream alerts that exclusion hides
  are tracked in #844.

The detector reads source, not rendered pixels, so it catches tells like
gradient text and purple palettes but not contrast, overflow, or density
problems. A green check is a floor, not a design review.

## Conventions

- The renderer receives only the explicit, Zod-validated IPC channels declared
  in `src/shared/ipc.ts`. Do not expose Node, `ipcRenderer`, or filesystem
  primitives to renderer code.
- Any product change must run the unit tests that cover it; if none exist, add
  them.
- This project targets ES2022 with `useDefineForClassFields` on, so a plain
  optional class field (`resolveThing?: (...) => T;`) meant as a
  prototype-patchable capability seam is silently inert: TypeScript emits an
  own `undefined` property on every instance, which shadows anything a caller
  later assigns to the prototype. Typecheck, lint, and any test that only
  exercises the capability-absent path stay green while the capability can
  never actually be observed. Use a real prototype method instead, or
  `declare` the field if something outside the class truly assigns it
  directly. `npm run check:inert-class-field-seams` guards this mechanically;
  see `.squad/skills/test-discipline/SKILL.md` for the counterfactual-test
  requirement this defect shape motivated, and issue #270 for the incident.
- Source models are read-only. Never move, rename, modify, or upload a user's
  files without an explicit user action.
- Never commit credentials or signing material (see `.gitignore`).
- On Windows, never run `git worktree remove --force` directly. Git for Windows
  2.53.0.windows.3 follows NTFS junctions inside the worktree and can silently
  empty an external target. Use `npm run worktree:remove -- <path>`; it unlinks
  reparse points without recursive traversal, verifies their targets remain,
  and refuses removal if the preflight cannot prove that state.
- Run removal from a registered worktree outside the target. Native filesystem
  identity checks refuse callers inside the target even through a junction or
  `subst` alias.
- If Git fails after preflight and deregisters the target while leaving its
  directory behind, use
  `npm run worktree:remove -- --recover-stale <path>`. Recovery requires the
  matching identity receipt written by the original removal, refuses registered,
  current, main, unresolved, or ambiguous paths, repeats the junction-safety
  checks, and then removes the stale tree without following links. It never
  treats an arbitrary unregistered directory as recoverable.

## Printer Calibration and licensing

PFD is licensed `AGPL-3.0-only` (see `LICENSE`, `THIRD_PARTY_NOTICES.md`, and
ADR 0001 at `docs/adr/0001-printer-calibration-source-provenance.md`).
Calibration models are resolved by the OrcaSlicer worker from its own
OrcaSlicer resources; PFD neither bundles nor transfers them, so the desktop
redistributes no third-party calibration content.

Two standing carve-outs apply to any future work that adapts upstream sources:

1. **Do not port OrcaSlicer's PA Pattern generator**
   (`CalibPressureAdvancePattern`, `src/libslic3r/calib.cpp`) — it is
   `GPL-3.0`, not AGPL, adapted from Andrew Ellis' generator (itself from
   Sineos' Marlin generator).
2. **Do not bundle anything from OrcaSlicer's `resources/handy_models/`** —
   3DBenchy, Stanford Bunny, Voron Cube, calicat, ksr_fdmtest_v4 all carry
   licences incompatible with `AGPL-3.0-only` or lack attribution.

If a future decision reintroduces bundled or adapted third-party source into
PFD's own distribution, revisit ADR 0001 and record the new premise before
any such source lands.

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
