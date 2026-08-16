# PrintFarmer Desktop — Copilot instructions

Electron + React + strict TypeScript desktop app with a Rust sidecar. Local-first
3D model library. See `README.md`, `docs/ARCHITECTURE.md`, and
`docs/CONTRIBUTING.md` for the full picture; this file covers what has actually
tripped past sessions up.

## Before you push: run the CI gate locally

CI's `Desktop` job (windows + macos, both required) runs these in order. Running
only `test` and `typecheck` is the single most common cause of a red PR here —
`format` is what usually catches people out, because Prettier reflows test files
you never looked at.

```
npm run check:provenance
npm run verify:target-profiles
npm run check:script-reachability
npm run check:inert-class-field-seams
npm run typecheck
npm run lint
npm run format          # check only; npm run format:write fixes
npm run test            # vitest run
```

Run a single test file with `npx vitest run tests/<file>.test.ts`, or
`npm run test:watch` while iterating.

Worktree sessions start without `node_modules`, so these scripts fail with
`'prettier' is not recognized` (or the equivalent for eslint/tsc/vitest) until
you run `npm install` in the worktree. That is a missing install, not a repo
problem.

The launch script is `npm start` (`electron-forge start`); there is no
`npm run dev`.

## Bare `cargo test` does not test the sidecar

`native/model-core` gates `sqlite_catalog`, `step`, and `lib3mf` behind Cargo
features in `lib.rs`. Without the flag the compiler drops those files entirely,
so bare `cargo test` prints `ok` and `0 filtered out` for tests that were never
compiled — 265 passing vs 339 with `--features sqlite`. The 74-test gap includes
every calibration conflict-resolution test.

CI runs each separately, so a feature-gated change can look green locally and
only fail in CI. From `native/`:

```
cargo fmt --check
cargo clippy --locked --all-targets -- -D warnings
cargo clippy --locked --all-targets --features sqlite -- -D warnings
cargo clippy --locked --all-targets --features step -- -D warnings
cargo test --locked
cargo test --locked --features sqlite
cargo test --locked --features step
cargo test --locked --features lib3mf
```

## Every PR needs its own closing-reference declaration

If a PR body contains `Closes #N`, the branch must also add
`.github/pr-closes/<branch-name>.md` declaring that issue, in the same push.
Without it the required **Closing-reference declaration** check fails — and it
fails confusingly, because the run falls back to a stale shared legacy file and
reports some unrelated issue number. Multiple PRs have been blocked by this,
sometimes two in the same review round. See `.github/PR_CLOSES.md` and
`.github/pr-closes/README.md`; validate with `npm run check:closing-references`.

## Read `.squad/known-lying-commands.md` before scripting git/gh checks

That file catalogues twelve PowerShell + `gh` predicates that answer a
_neighbouring_ question and return a confident, well-formed, wrong value. Its
entries have been independently rediscovered by separate sessions more than
once, which is why it exists. The ones that recur most:

- `$LASTEXITCODE` is **stale** after `| Select-Object -First N` once `N >= line
count`. Capture the exit code before any filtering; never put `-First`
  downstream of a native command.
- Single-quote any revision expression containing `^`, `{`, or `}`. Unquoted,
  `git rev-parse HEAD^{tree}` makes PowerShell eat `{tree}` as a script block and
  git returns the **first parent** — a real commit printed under a "tree" label.
- `gh ... --jq` yields a _string array_ in PowerShell, so `.Contains("text")`
  does element equality and returns `False` for text plainly visible in the
  output. Join with newlines first.
- Read PR health by checks at `head_sha`. `mergeStateStatus` saturates to
  `BEHIND` under branch protection `strict: true` and cannot distinguish 7 green
  jobs from 2 red ones.
- Verify required contexts by set containment against the live list, never by
  counting passing rows.

The general rule the repo enforces: **every matching predicate gets a control
that must return the opposite result, evaluated by the same predicate on the
same data.**

## Windows worktree removal

Never run `git worktree remove --force` directly. Git for Windows follows NTFS
junctions inside the worktree and can silently empty an external target. Use
`npm run worktree:remove -- <path>`, run from a registered worktree _outside_
the target. If Git deregisters a target but leaves the directory,
`npm run worktree:remove -- --recover-stale <path>`.

## Architecture

Four trust boundaries, in decreasing privilege:

1. **Main** (`src/main`) — windows, CSP/navigation/permission guards, fuses, the
   IPC surface, PrintFarmer networking, credential encryption, sidecar
   lifecycle. Exposes no generic filesystem, shell, or network primitive.
2. **Preload** (`src/preload`) — minimal `contextBridge` publishing only the
   typed `window.printFarmer` API. `contextIsolation` on, `sandbox` on,
   `nodeIntegration` off.
3. **Renderer** (`src/renderer`) — React, presentation only. Cannot read
   arbitrary files, hold credentials, or call PrintFarmer directly. One Three.js
   scene at a time.
4. **Rust sidecar** (`native/model-core`) — separately signed binary owning
   SQLite (WAL), folder scan/watch, streaming SHA-256, STL/OBJ/3MF parsing, and
   the scene cache. Framed versioned RPC over a private transport.

Every renderer↔main message is declared once in `src/shared/ipc.ts` with Zod
schemas; main validates request _and_ response. Desktop IPC is version 2, the
sidecar RPC handshake is version 1 — these are independent, bump each only for
changes to its own wire boundary.

Model identity (`models`, keyed by SHA-256) is kept separate from physical files
(`model_locations`). Filesystems are treated as eventually consistent: watcher
events drive targeted work, periodic reconciliation is authoritative.

## Conventions

- Add renderer capability only by declaring a Zod-validated channel in
  `src/shared/ipc.ts`. Never hand the renderer Node, `ipcRenderer`, or filesystem
  primitives.
- Source models are read-only. Never move, rename, modify, or upload a user's
  files without an explicit user action.
- This project targets ES2022 with `useDefineForClassFields` on, so an optional
  class field meant as a prototype-patchable seam
  (`resolveThing?: (...) => T;`) is **silently inert** — TS emits an own
  `undefined` property that shadows anything assigned to the prototype. Typecheck,
  lint, and capability-absent tests all stay green. Use a real prototype method,
  or `declare` the field. `npm run check:inert-class-field-seams` guards this.
- Any product change runs the unit tests covering it; add them if none exist.
- Git hooks (`prepare-commit-msg`, `pre-push`) are armed by `core.hooksPath` via
  the `prepare` script; logic lives in `scripts/*.mjs` so it is unit-tested.
  `npm run hooks:verify` is a required CI step — don't bypass hooks locally.
- Files under a `derivedRoots` path in
  `compliance/printer-calibration-provenance.json` are source-derived and need a
  provenance header plus a manifest record. Run `npm run check:provenance`.
  Orchestration, UI, persistence, ownership, authorization, queueing, and safety
  code stays _outside_ those roots and is independently implemented.
- Never commit credentials or signing material.

## Squad — Copilot Coding Agent instructions

You are working on a project that uses **Squad**, an AI team framework. When picking up issues autonomously, follow these guidelines.

### Coordinator Canary Check

**IMPORTANT — run this check on EVERY session start, before doing any work:**

Inspect your `agent_instructions` for the coordinator canaries. This is a **two-state payload-integrity check within a known Squad coordinator session**; it verifies whether the coordinator payload loaded fully or was visibly truncated. It is **not** proof that an agent with no canaries is safely non-Squad — wholly absent payloads and proven non-Squad agents require a host-level identity beacon before custom-agent instruction ingestion.

1. If the HEAD canary `SQUAD_COORDINATOR_CANARY_HEAD_b7d2` is **absent**, the Squad coordinator payload is not observable from inside this prompt. Treat non-Squad discrimination as an **OPEN host-level concern**; do not claim this check proved the current agent is non-Squad.
2. If the HEAD canary `SQUAD_COORDINATOR_CANARY_HEAD_b7d2` is **present** and the EOF canary `SQUAD_COORDINATOR_CANARY_a8f3` is **present**, the coordinator prompt loaded fully. Proceed with normal Squad behavior.
3. If the HEAD canary `SQUAD_COORDINATOR_CANARY_HEAD_b7d2` is **present** but the EOF canary `SQUAD_COORDINATOR_CANARY_a8f3` is **absent**, the coordinator prompt loaded but was **truncated** before the end.

**When the coordinator prompt is truncated, you MUST:**

1. **STOP** — do not proceed with standard Squad behavior.
2. **WARN the user** with this exact message:
   ```
   ⚠️ Squad coordinator (squad.agent.md) loaded but appears to be truncated before the EOF canary. Do NOT proceed with standard Squad behavior — Squad's safety rails are incomplete. Please restart your session.
   ```
3. Do not continue with normal Squad routing, spawning, PR, or branch-protection behavior after emitting the warning.

### Team Context

Before starting work on any issue:

1. Read `.squad/team.md` for the team roster, member roles, and your capability profile.
2. Read `.squad/routing.md` for work routing rules.
3. If the issue has a `squad:{member}` label, read that member's charter at `.squad/agents/{member}/charter.md` to understand their domain expertise and coding style — work in their voice.

### Capability Self-Check

Before starting work, check your capability profile in `.squad/team.md` under the **Coding Agent → Capabilities** section.

- **🟢 Good fit** — proceed autonomously.
- **🟡 Needs review** — proceed, but note in the PR description that a squad member should review.
- **🔴 Not suitable** — do NOT start work. Instead, comment on the issue:
  ```
  🤖 This issue doesn't match my capability profile (reason: {why}). Suggesting reassignment to a squad member.
  ```

### Branch Naming

Use the squad branch convention:

```
squad/{issue-number}-{kebab-case-slug}
```

Example: `squad/42-fix-login-validation`

### PR Guidelines

When opening a PR:

- Reference the issue: `Closes #{issue-number}`
- If the issue had a `squad:{member}` label, mention the member: `Working as {member} ({role})`
- If this is a 🟡 needs-review task, add to the PR description: `⚠️ This task was flagged as "needs review" — please have a squad member review before merging.`
- Follow any project conventions in `.squad/decisions.md`

### Decisions

If you make a decision that affects other team members, write it to:

```
.squad/decisions/inbox/copilot-{brief-slug}.md
```

The Scribe will merge it into the shared decisions file.
