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
| `npm run report:design-baseline`         | Write an observational full-source design report   |
| `npm run test`                           | Vitest unit/component tests                        |
| `npm run make`                           | Build platform installers                          |
| `npm run verify:target-profiles`         | Verify the pinned printer-profile snapshot         |
| `npm run worktree:remove -- <path>`      | Safely force-remove a linked worktree              |

Repository reachability tests use Git's tracked-file index, not transient
untracked test directories. Stage new source and skill documents before running
`tests/skillReferenceReachability.test.ts`; tracked references are still checked
against the working tree, so deleted sources and unreadable skill documents fail.
Create disposable fixtures under the OS temporary directory, not the checkout.
Real Git/npm release-transaction tests have a scoped 30-second budget for hosted
Windows subprocess latency; pure validation retains the 5-second default.
Repository-wide guard assertions should reuse one report when they inspect the
same immutable tracked corpus, rather than repeating an expensive full scan
inside each assertion. Keep small synthetic positive/negative controls separate.
Git fixture commands that snapshot or delete repositories must finish automatic
maintenance first: command-scoped `maintenance.autoDetach=false` and
`gc.autoDetach=false` keep object-store lock files from changing after a
synchronous Git parent exits. Do not copy a live repository assuming that the
parent process's exit also joined detached maintenance.

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

- The vendored regex engine has two local corrections: bare JSDoc `<img>`
  references are not treated as missing-source images (unless the file also
  contains a closing `</img>` tag, when the detector conservatively reports
  them), and spinning `rounded-full`
  loading-ring classes are not treated as rounded-card accent borders. Real
  missing-image and rounded-card checks still apply. These affect changed-file
  scans once the detector change reaches the trusted base.
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

### Full-source observational baseline

Run `npm run report:design-baseline` to write
`reports/design-baseline.json`, or pass `-- --output <path>` to choose another
output. It scans the same tracked renderer extensions and root `index.html`
selected by `--all`, using the checked-out detector and manifest. It records
the inspected HEAD, input hashes, modified or untracked inputs, Node version,
detector provenance, effective configuration, exact selected/scanned/ignored
files, per-file parsed design-policy status, and concrete blocking and advisory
findings. Identical inputs, Node version, and checkout state yield the same
report; source-byte hashes can differ across line-ending configurations.

This report is observed debt, **not** approval, a WCAG or design certification,
or a regression gate. Findings do not cause this reporting command to fail;
scanner/configuration errors do. Existing inline and shared-config suppressions
are honored and configured file exclusions are listed. For reproducibility,
the command rejects `.impeccable/config.local.json`; temporarily relocate it
outside the worktree before running. The report's static findings include
stylesheets whether or not they are reachable: the singular
`CalibrationConflictDialog.css` is classified separately using a literal
reference search, which does not prove whether it can be loaded dynamically.
The report records whether optional static HTML parser dependencies are
available. Without them the detector falls back to regex-only HTML analysis;
static DOM and linked-stylesheet analysis are excluded.

The report excludes untracked files, renderer plain TypeScript and assets,
main/preload UI logic, OS/native dialogs and menus, installer UI, and runtime
states including the rendered DOM, interactions, accessibility tree, pixels,
zoom and DPI. It neither proves every supported rule detects every occurrence
nor replaces human review. The detector's general static rules are distinct
from parsed design-system allowlists. In this baseline `DESIGN.md` has no
frontmatter recognized by the detector, so its prose palette and fonts are not
machine-enforced allowlists; inspect each report's policy status rather than
assuming that remains true.

The separate PR/merge-group changed-file CI gate remains unchanged: it uses the
trusted base's detector and blocks on non-advisory findings in changed targets.
The baseline report uses working-tree inputs, whose hashes and differences
from HEAD must be considered when interpreting its commit field.

### Full-source count ratchet

`Design full-source ratchet` is separate from the existing changed-file gate.
It counts **all unsuppressed blocking and advisory findings together** against
the total in the trusted base's `reports/design-baseline.json`, and reports
both severities. Equal or lower totals pass; an increase fails. This is not a
per-rule, per-file or per-occurrence ratchet: replacing one finding with
another, including a change in severity, passes at the same total. Unrelated
changes do not fail solely because existing findings remain.

The PR workflow uses `pull_request_target` so its definition comes from the
default branch; merge-queue scans use `merge_group`. It checks out base-owned
tooling, fetches the PR ref as Git objects without checking it out, and reads
source directly from the target commit's blobs. A read-only token is passed to
the fetch step only, not the scanner. The scan uses the base's policy, config,
and approved inline suppressions; it does not install or run target code. New
PR-supplied suppressions, detector edits, or allowance increases cannot hide
findings in this scan. Existing line suppressions apply only when their
associated source and directive lines are unchanged; whole-file suppressions
remain in effect. The changed-file gate still follows its own existing
suppression behavior.

The checked-in report was regenerated from clean inputs at the landed
development commit after the initial bootstrap's squash merge stranded its
feature-branch anchor. Its allowance remains zero. Before accepting it, the
ratchet checks selected source hashes against the inspected commit and scanner
hashes against the trusted base, validates the detector manifest and report
counts, and requires the recorded Node version, regex-only HTML capability,
config and absent design-system allowlists. Missing or incompatible inputs fail
closed. The initial workflow and report must first land through an explicitly
reviewed bootstrap; a `pull_request_target` workflow absent from the default
branch cannot run on its introducing PR. Require its status only after it exists
on the protected default branch and its PR-head and merge-queue check reporting
have been verified live. This implementation fails closed for PRs or queues
targeting a non-default branch rather than trusting an unprotected feature
branch's tooling; extend its trust policy deliberately before requiring it
there. Use repository rules that protect the workflow and
prohibit bypasses. No PR-controlled fallback is provided.

The allowance does not shrink automatically. To propose a lower ceiling, first
commit the source fixes, use the same Node version and unchanged trusted
scanner/config, and run `npm run report:design-baseline` with clean tracked
inputs. Review and commit the resulting report separately. The check validates
that a changed report's complete findings match the current scan, does not
increase the trusted allowance, and has clean source provenance; it becomes the
allowance only after the change is reviewed and merged. Changes to detector,
policy, Node version or
HTML capabilities require a separately reviewed migration and compatible
baseline; do not silently regenerate or increase the ceiling.

**Keep the inspected commit reachable after squash merges.** A report generated
after a feature-branch source commit records that branch-only SHA; squash merging
source and report together does not retain it in development's ancestry. Land
source fixes first, then create a separate report-only PR from the landed
development commit and generate the report before making any branch commits.
Use the report's recorded Node version and HTML capabilities, verify clean input
provenance and unchanged or lower findings, and leave scanner/config unchanged.
Squashing this report-only PR preserves its inspected commit as an ancestor.
Before accepting a baseline, verify its inspected SHA is an ancestor of the
destination branch, not merely of the PR head.

If an already-trusted baseline has a stranded anchor, the check intentionally
fails before examining a candidate repair: a PR cannot replace the policy used
to judge itself. Recovery therefore needs an explicitly reviewed, independently
authorized bootstrap to land a regenerated report from the existing development
commit. Do not skip the check, remove ancestry validation, increase the allowance,
or treat the repair PR as green against the broken base. Validate the repaired
commit as both trusted base and target with
`node scripts/design-ratchet.mjs . <repair-sha> <repair-sha> .`, then verify live
PR-head and merge-group reporting after recovery.

The ratchet covers only the static source surface described above. A zero
total is neither WCAG compliance nor visual approval, and same-count swaps can
hide newly introduced defects.

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
