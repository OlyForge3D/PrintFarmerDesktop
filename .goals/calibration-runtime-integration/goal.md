# Goal: Integrate Calibration Generation, Queue State, and Bed-Clear Actions (Issue #54)

## User Request

Implement issue #54 end-to-end on branch
`jpapiez-issue-54-integrate-calibration-generation-queue-s-4b5f90`, whose
verified initial SHA and `origin/development` SHA are both
`d20aa73bf888c9c1e0b346cbb794dba39f573b39` (parent
`8180f8fc8b2ceba4dc070b1670f855fc82538083`). Prerequisites #52, #53, #55, #56
are merged. PrintFarmer #899 and #900 are merged; #900 is PR #979 at
`167a3b134a678a0d9a8c10371da8333d03ddc636`.

Integrate the native PFD Printer Calibration workspace with PrintFarmer's
deterministic generation, promoted G-code, existing print queue, automatic
dispatch, and exact-job bed-clear/start contracts. PFD orchestrates only typed
backend operations; it never generates arbitrary G-code or talks directly to
printers from the renderer.

Issue: https://github.com/OlyForge3D/PrintFarmerDesktop/issues/54
Parent epic: #42
Blocks: #57

## Refined Goal

Implement the full end-to-end flow for PFD's Printer Calibration workspace:
inspect and exactly consume the actual PrintFarmer development API (PrintFarmer
PR #979 / `167a3b134a678a0d9a8c10371da8333d03ddc636`); implement typed durable
backend generation with stable idempotency, restart/reconnect REST
reconciliation, and structured durable stages; surface REST-authoritative
queue/dispatch state (SignalR is only a hint); implement exact-job
bed-clear/acknowledge with correct header protocol and every status mapping;
track the full print lifecycle with append-only observations; validate external
calibration asset manifests locally with fail-closed provenance; and harden the
IPC/security boundary so no generic network, filesystem, shell, printer, slicer,
or G-code primitive reaches the renderer. After an independent Inspector PASS,
the orchestration pushes one PR targeting `development` only, unclosed, with all
required citations.

## Acceptance Criteria

### External Calibration Assets and Provenance

- [ ] **A-01:** Every confirmed calibration method's asset manifest is versioned
  and reviewed; manifests contain source URL, author, declared license/attribution,
  expected filename, type, checksum (when stable), supported method, and validation
  rules.
- [ ] **A-02:** External manifest HTTPS URLs open only through PFD's allowlisted
  external-navigation channel; no manifest URL is opened via a generic network or
  shell primitive.
- [ ] **A-03:** Users download and select local files themselves; zero third-party
  calibration models are bundled in the repository or release artifact.
- [ ] **A-04:** Local validation before any authenticated upload checks: file
  extension, magic/container structure, file size, geometry bounds, and
  method-specific bounds; validation fails closed on any failure.
- [ ] **A-05:** Asset provenance (source URL, checksum, attribution, license) is
  displayed to the user and stored immutably with the calibration attempt record.
- [ ] **A-06:** Any unreviewed or unvalidated calibration method is disabled with
  a concrete, user-visible reason; no method becomes available until its asset
  manifest and validation fixture pass review.
- [ ] **A-07:** `npm run check:provenance` passes clean (no new or changed
  derived-root files without manifest records, source-path/blob, SPDX identifier,
  and reviewer decision).
- [ ] **A-08:** Asset/provenance unit tests cover: valid manifest accepted,
  invalid extension rejected, wrong magic rejected, size-exceeded rejected,
  geometry-out-of-bounds rejected, checksum mismatch rejected, disabled method
  with reason surfaced. Each rejection asserts the specific typed reason code, not
  merely that an error occurred.

### Typed Durable Backend Generation Operation

- [ ] **G-01:** Inspect the actual PrintFarmer API contract at PR #979
  (`167a3b134a678a0d9a8c10371da8333d03ddc636`); no endpoint paths, DTO shapes,
  or field names are guessed or invented.
- [ ] **G-02:** Before submitting generation, PFD fetches and revalidates: current
  printer context/configuration revision, physical toolhead/nozzle identity,
  filament product/spool identity, and upstream-Orca profile hashes.
- [ ] **G-03:** The canonical method/range/options/specification preview and any
  warnings are presented before POST.
- [ ] **G-04:** Generation is submitted as a typed `generate-job` POST with a
  stable operation/idempotency ID and the expected project revision; a changed
  context blocks generation and requires explicit regeneration/rebase.
- [ ] **G-05:** All durable orchestration stages are displayed: model accepted,
  slicing queued/claimed/progress, artifact validated, promoted `GcodeFile`,
  queue job created, or structured failure/recovery.
- [ ] **G-06:** After restart or reconnect, operation state is reconciled through
  REST; SignalR progress only accelerates display and is never authoritative.
- [ ] **G-07:** The UI displays the exact upstream-Orca version, Klipper dialect,
  printer snapshot/config revision, profile/model/specification/G-code hashes,
  and queued job identity. Stale or changed context blocks replay/start.
- [ ] **G-08:** PFD never downloads and re-uploads generated G-code, emits raw
  G-code, submits a generic slicer job, or accepts a renderer-supplied
  command/URL/path.
- [ ] **G-09:** Generation idempotency tests cover: stable idempotency ID produces
  same job on retry, project revision mismatch blocks generation, restart mid-stage
  recovers via REST without duplication, every durable stage surfaces correctly,
  and every structured failure variant maps to a typed reason.

### REST-Authoritative Queue and Dispatch State

- [ ] **Q-01:** Queue/job state, assignment, semantic priority, position, dispatch
  policy, printer readiness, compatibility gates, upload progress, start
  acceptance, print progress, and terminal result all derive from authoritative
  REST; SignalR is a hint only.
- [ ] **Q-02:** The calibration `PrintJob` returned by generation is used directly;
  PFD never creates a job through analytics routes.
- [ ] **Q-03:** Exact idempotent replays resolve to the original job; no duplicate
  is created or displayed.
- [ ] **Q-04:** On reconnect, SignalR event gap, or uncertain state, PFD polls/
  refetches REST and converges to authoritative state.
- [ ] **Q-05:** Typed blocked reasons are surfaced for: stale telemetry, changed
  firmware/configuration, material/nozzle mismatch, maintenance/busy state,
  missing G-code, and permission denied.
- [ ] **Q-06:** REST reconciliation tests cover: reconnect after disconnect
  converges state, event gap triggers refetch, SignalR-only update does not
  mutate authoritative state without REST confirmation, and every typed blocked
  reason is asserted by specific code.

### Exact-Job Bed-Clear Acknowledgement

- [ ] **B-01:** The bed-clear safety dialog displays the exact queued job, assigned
  printer, current queue revision, material/nozzle, generated test identifier, and
  bed-clear expiry.
- [ ] **B-02:** Only one endpoint is invoked for acknowledgement:
  `POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start` with:
  - `Idempotency-Key: <stable command UUID>` header
  - `If-Match: "<dispatch-state revision>"` header
  - Body: `{ "printerId": "<UUID>" }`
- [ ] **B-03:** Each HTTP status code is handled exactly:
  - `202`: exact job newly claimed/starting → display Starting state
  - `200`: replay or already starting → display Starting state (idempotent)
  - `409`: wrong job/printer, busy, or incompatible state → display typed reason,
    dialog dismissed without retry
  - `412`: stale dispatch revision → refetch authoritative state before presenting
    dialog again (acknowledgement unconsumed)
  - `503`: offline/stale telemetry → keep acknowledgement unconsumed, display
    actionable reason, no blind retry
- [ ] **B-04:** An accepted-but-unconfirmed start remains in `Starting` state with
  reconciliation guidance; no blind retry is offered or triggered automatically.
- [ ] **B-05:** A prior acknowledgement UUID is never reused for a reordered, new,
  or expired job; each dialog invocation generates a fresh stable UUID.
- [ ] **B-06:** Acknowledgement is withheld when: offline, unsynchronized,
  unauthorized, expired, stale, or the assigned printer no longer explicitly
  reports Klipper.
- [ ] **B-07:** Bed-clear acknowledgement tests cover: exact headers asserted for
  202/200/409/412/503; idempotent replay (same UUID, second call returns 200) does
  not show a duplicate; reordered job UUID is rejected before submission; expired
  acknowledgement is not reused; stale revision triggers refetch not retry;
  offline blocks dialog; uncertain start stays `Starting` with no auto-retry.

### Print Lifecycle and Result Entry

- [ ] **L-01:** All states are reconciled from authoritative REST: `Queued`,
  `Assigned`, `Starting`, `Printing`, `Paused`, `Completed`, `Failed`,
  `Cancelled`.
- [ ] **L-02:** Immutable links are kept among attempt, orchestration, model,
  slice, artifact, promoted G-code, and print job; these links are never mutated
  after creation.
- [ ] **L-03:** On completion, the user is guided to add append-only observations:
  selected result, confidence, retest decision, notes, and photos.
- [ ] **L-04:** On failed or cancelled print, the attempt/generation history is
  preserved intact; a new retry attempt/operation is offered rather than mutating
  prior evidence.
- [ ] **L-05:** Queue completion alone does not mark a calibration step complete;
  the method's result/verification contract must be satisfied.
- [ ] **L-06:** Stale firmware/config/telemetry, material/nozzle mismatch,
  maintenance/busy, missing G-code, or permission denied each block start with a
  specific actionable typed reason.
- [ ] **L-07:** Lifecycle tests cover: every state transition from authoritative
  REST; append-only history after completion/failure/cancel; link immutability;
  queue completion without result does not mark step complete; each blocker reason
  by specific code.

### IPC and Security Boundary

- [ ] **S-01:** Only named, validated generation/status/acknowledgement/result
  commands are added to `src/shared/ipc.ts`; all new channels have Zod schemas
  validated by main before use.
- [ ] **S-02:** The main process owns all authenticated streaming, cancellation,
  retries, and error mapping; the renderer never calls PrintFarmer directly.
- [ ] **S-03:** Secrets, local paths, and raw backend error payloads are redacted
  from renderer-facing IPC responses and from logs.
- [ ] **S-04:** No generic network, filesystem, shell, printer, slicer, or G-code
  primitive is exposed to the renderer.
- [ ] **S-05:** Renderer-boundary tests cover: renderer cannot trigger arbitrary
  network/filesystem/shell/printer/slicer/G-code call; IPC channels reject
  unvalidated input; secrets do not appear in renderer-visible payloads.

### Calibration Domain Reuse and No Duplication

- [ ] **D-01:** Existing calibration domain, workspace, transport, profile, import
  helpers, and conventions are reused without modification to their contracts.
- [ ] **D-02:** No duplicate state models, local printer DB/service, arbitrary
  G-code flow, or unrelated dependencies are introduced.
- [ ] **D-03:** `npm run typecheck` passes clean with no new type errors or
  suppressions.
- [ ] **D-04:** `npm run lint` passes clean with no new ESLint warnings or
  errors.
- [ ] **D-05:** `npm run format` passes clean (Prettier check, including all
  markdown files).
- [ ] **D-06:** `npm run test` passes clean; no existing tests are weakened,
  deleted, ignored, or had assertions loosened.
- [ ] **D-07:** When Playwright UI paths are covered, relevant Playwright tests
  pass clean.
- [ ] **D-08:** When native files in `native/` change: `cargo fmt --check`,
  `cargo clippy -D warnings`, `cargo test`, and applicable feature variants
  (`--features sqlite`, `--features lib3mf`) all pass clean.

### Delivery and Reporting

- [ ] **P-01:** After independent Inspector PASS (Inspector verdict is PASS with
  no open findings), the orchestration (not Builder independently) pushes the
  branch and opens exactly one PR targeting `development` only.
- [ ] **P-02:** PR body contains: citation of issue #54 URL, description of
  surfaces implemented, security invariants satisfied, exact test evidence
  (counts, names, commands run), `Closes #54`, and no claim of external approval.
- [ ] **P-03:** PR body reports: HEAD SHA, base provenance (`development` at
  `d20aa73bf888c9c1e0b346cbb794dba39f573b39`), diff stats, tests passed, PR
  state, CI status, and mergeability status.
- [ ] **P-04:** PR is left unmerged; Builder reports SHA/stats/CI/mergeability
  without claiming external approval or merging.
- [ ] **P-05:** All six required CI checks pass: Desktop (macos-latest,
  windows-latest), Sidecar (macos-latest, windows-latest), Package smoke
  (macos-latest, windows-latest). `mergeStateStatus` is `CLEAN`.

## Scope Boundaries

### In Scope

- Implementing issue #54 end-to-end on the current branch only.
- Inspecting and consuming the actual PrintFarmer API contract from PR #979
  (`167a3b134a678a0d9a8c10371da8333d03ddc636`).
- External calibration asset manifest validation, provenance, import,
  fail-closed local validation, and immutable provenance storage.
- Typed durable backend generation operation with stable idempotency, project
  revision, restart/reconnect REST reconciliation, immutable hashes/context, and
  structured durable stages/failures.
- REST-authoritative queue/dispatch state display; SignalR as hint only;
  reconnect/event-gap/uncertainty refetch and convergence.
- Exact-job bed-clear acknowledgement via `POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start`
  with correct `Idempotency-Key`, `If-Match`, and body `printerId`; all five
  status codes handled exactly.
- Full print lifecycle state reconciliation (Queued/Assigned/Starting/Printing/
  Paused/Completed/Failed/Cancelled) from REST.
- Append-only observations/results/confidence/retest/notes/photos; immutable
  attempt/generation/artifact/G-code/job links.
- Typed blockers for stale firmware/config/telemetry/material/nozzle and
  capability/permission/maintenance/busy/missing-G-code conditions.
- Named, validated shared IPC/preload commands only; main-process-owned
  authenticated I/O, retries, cancellation, streaming, redaction/error mapping.
- Comprehensive focused tests covering all areas listed in acceptance criteria.
- Running `npm run check:provenance`, `npm run typecheck`, `npm run lint`,
  `npm run format`, `npm run test`, relevant Playwright if UI paths are covered,
  and applicable native cargo commands when native files change.
- Opening one PR targeting `development` only after Inspector PASS, leaving it
  unmerged, citing issue #54 and `Closes #54`.

### Out of Scope — Explicitly Forbidden

- **No `main` branch targeting or merging**: PRs target `development` only;
  `main` is never touched.
- **No backend or PrintFarmer repo edits**: This PR modifies only the PFD
  repository; no commits are made to `OlyForge3D/PrintFarmer` or any other repo.
- **No generic privileged APIs**: No generic network, filesystem, shell, printer,
  slicer, or G-code primitive is exposed to the renderer.
- **No bundled third-party calibration assets**: Zero third-party models bundled
  in source or release; all assets are user-selected local files.
- **No local printer DB or local printer service**: PrintFarmer backend is
  authoritative; no local database or service is created to shadow it.
- **No arbitrary G-code flow**: PFD never generates, downloads, re-uploads, or
  emits raw G-code; it consumes only the promoted `GcodeFile` returned by the
  backend.
- **No unrelated dependencies or refactors**: Existing calibration domain helpers,
  workspace, transport, profile, import helpers, and conventions are reused
  as-is; no unrelated code is changed.
- **No blind retries**: Accepted-but-unconfirmed starts remain in `Starting` with
  reconciliation guidance; auto-retry is never triggered for uncertain state.
- **No stacking PRs or branching off unmerged branches**: This branch is off
  `origin/development` at the verified SHA.
- **No premature PR push**: Builder does not open or push the PR unless the
  orchestration directs it after Inspector PASS.
- **No guessing API contracts**: All endpoint paths, DTO shapes, field names, and
  status codes are read from the actual PrintFarmer PR #979 API; nothing is
  invented.
- **No provenance pin advances**: The existing source pin is used as-is; no new
  derived files are added without a manifest record, source-path/blob, SPDX
  identifier, and reviewer decision.
- **No weakening or skipping existing tests**: Tests are never skipped, deleted,
  ignored, or had assertions loosened; tolerances are never widened.

## Applicable Project Conventions

### Quality Gate Commands (run in order; all must pass)

```powershell
# From repo root:
npm run check:provenance
npm run typecheck
npm run lint
npm run format
npm run test

# Playwright (when UI paths are covered):
# npx playwright test <relevant-spec>

# From native/ (when native files change):
cargo fmt --manifest-path native/Cargo.toml --all -- --check
cargo clippy --manifest-path native/Cargo.toml -p model-core --all-targets -- -D warnings
cargo clippy --manifest-path native/Cargo.toml -p model-core --all-targets --features sqlite -- -D warnings
cargo test --manifest-path native/Cargo.toml -p model-core
cargo test --manifest-path native/Cargo.toml -p model-core --features sqlite
# If lib3mf path touched:
cargo build --manifest-path native/Cargo.toml -p model-core --features lib3mf
cargo test  --manifest-path native/Cargo.toml -p model-core --features lib3mf
```

All six CI checks must pass: Desktop (macos-latest, windows-latest), Sidecar
(macos-latest, windows-latest), Package smoke (macos-latest, windows-latest).
`mergeStateStatus` must be `CLEAN`.

### Commit Convention

**Builder commits** — subject ≤72 chars:

```
type(scope): [B] description
<blank line>
<why body>

Assisted-by: Claude:Sonnet-4.6
Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 8f0a4783-d5be-4a2e-b21a-634cbba71c30
```

**Inspector commits** — subject ≤72 chars:

```
chore(scope): [I] description
<blank line>
<why body>

Assisted-by: Claude:Haiku-4.5
Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
Copilot-Session: 8f0a4783-d5be-4a2e-b21a-634cbba71c30
```

### Guidelines and Rules

- `docs/CONTRIBUTING.md` — install, everyday commands, IPC contract rules,
  provenance requirements, source-derived file conventions, pinned target-profile
  snapshot rules.
- `docs/ARCHITECTURE.md` — process boundary, IPC contract, data model, PrintFarmer
  integration, Snapmaker U1 retargeting, security invariants.
- `docs/adr/0001-printer-calibration-source-provenance.md` — approved source
  boundary, explicit exclusions, enforcement rules, pin advancement process.
- `.squad/skills/testing/SKILL.md` — targeted validation, Rust feature variants,
  CI gate (six required checks), green CI is necessary not sufficient.
- `.squad/skills/test-discipline/SKILL.md` — never weaken a test; assert specific
  failure codes not merely presence of error; verify controls are reachable;
  build corpora from properties not spellings; mocks hide missing production code.
- `.squad/skills/git-workflow/SKILL.md` — never modify main checkout; branch off
  `origin/development`; never stack PRs; every PR must have `Closes #N` in body;
  merge one PR at a time; freeze branch while under review; `GH_TOKEN` lacks
  workflow scope — drop it before `gh push` calls.

### Key Rules Summary

- Renderer receives only Zod-validated IPC channels from `src/shared/ipc.ts`.
- Main process never exposes generic filesystem, shell, or network primitives.
- Source-derived files require manifest records with source-path/blob, SPDX
  identifier, modification summary, and reviewer decision; `check:provenance`
  enforces this offline.
- `npm run format` checks the whole repo including markdown; format before
  committing docs.
- Drop `GH_TOKEN` before every `gh` or `git push` call:
  `Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue`
- `git grep` uses basic regex; pass `-E` for alternation.
- Each PowerShell call is a fresh process; `cd` to worktree at start of every call.

### Branch and PR

- **Branch:** `jpapiez-issue-54-integrate-calibration-generation-queue-s-4b5f90`
- **Base:** `development` at `d20aa73bf888c9c1e0b346cbb794dba39f573b39`
- **PR target:** `development` only — never `main`
- **PR body must include:** Issue #54 URL, surfaces, security invariants, exact
  test evidence, `Closes #54`, SHA, base provenance, diff stats, CI status,
  mergeability; no claim of external approval.
- **PR is left unmerged** by Builder/Inspector; orchestration owns push+open
  after Inspector PASS.
