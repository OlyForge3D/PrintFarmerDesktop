# Goal: Calibration transport and offline sync

## User Request

Implement OlyForge3D/PrintFarmerDesktop issue #52 completely on a new branch from
the current default `development`. Never write, merge, or retarget anything to
`main`; release-only `main` is out of bounds. Treat the full issue body as the
authoritative contract. Deliver a focused non-draft pull request targeting
`development` with `Closes #52`, and do not merge it.

## Refined Goal

Build the complete typed Printer Calibration transport foundation for
PrintFarmerDesktop: additive shared IPC contracts, truthful capability gating,
a calibration-specific authenticated main-process HTTP boundary, durable
profile-bound native persistence, ordered idempotent offline synchronization,
explicit semantic conflict resolution, and narrow privilege-safe IPC/preload
commands. PrintFarmer remains authoritative for completed attempts, generated
profile revisions, and uploaded photos. Preserve all existing Library and
server-profile behavior, validate the implementation with focused and complete
relevant quality gates, then push and open one non-draft PR against
`development`.

## Acceptance Criteria

- [ ] Strict additive Zod shared IPC request/response schemas cover effective
  availability/permissions/limits, printer candidates and immutable context,
  projects/drafts/attempts/events/observations/photos/profile revisions,
  cursors/outbox/conflicts/resolutions, generation/promoted G-code/queue,
  exact-job bed-clear/start, local upstream-Orca profile operations, and legacy
  calibration backup v4 import surfaces.
- [ ] Remote DTOs are parsed additively while required safety fields remain
  strict. Availability requires negotiated API/schema versions, required JWT
  scopes, explicit Klipper firmware and Klipper G-code dialect, upstream
  OrcaSlicer identity, and all required E2E capability flags. Legacy or
  incomplete servers return a typed concrete unavailable reason without
  breaking Library behavior.
- [ ] A calibration-specific main-process authenticated HTTP client uses
  `ServerProfileService.getAuthenticatedContext()` and implements profile and
  identity fencing before and after every request, exactly one bounded 401
  refresh, cancellation, connect/overall timeouts, response/body limits,
  streaming upload/download, typed ProblemDetails errors, idempotency and
  operation IDs, ETags/If-Match/base revisions, opaque cursors, exact replay,
  and explicit fixed routes only.
- [ ] The renderer cannot control arbitrary URLs, paths, methods, headers, or
  receive credentials/unscoped API keys. Calibration is authorized only by JWT
  permissions. HTTP 428, 412, 409 changed-payload, 422, and 503 map to distinct
  actionable typed states.
- [ ] A versioned `model-core` migration plus typed repository/RPC supports
  profile-bound cached project summaries/aggregates, field-level drafts,
  immutable attempts/events/observations, staged photo bytes and upload state,
  generated-profile metadata/exact JSON cache, revisions/cursors/tombstones,
  ordered leased outbox operations with canonical request hashes/dependencies/
  retries, explicit conflicts/resolutions, and profile/server-incarnation
  fencing.
- [ ] Native persistence survives restart, migrates from every supported schema,
  bounds storage, deterministically cleans successfully uploaded staged photos,
  and retains unresolved/conflicted content. Cached completed attempts/profile
  revisions/uploaded photos never claim local authority over PrintFarmer.
- [ ] Synchronization validates selected profile identity/capabilities, pushes
  dependency-ready operations in stable order with idempotency keys and base
  revisions, accepts exact replay as success, stops and records typed conflicts,
  pulls opaque-cursor change pages to completion, hydrates authoritative REST
  aggregates and tombstones, and atomically commits cursors.
- [ ] Authenticated SignalR is only an optional hint. REST/change-feed
  reconciliation is authoritative after reconnect and event gaps.
- [ ] Offline editing, supported step reordering, and photo staging work.
  Generation, queue creation, bed-clear acknowledgement, and print start remain
  disabled until all mutations synchronize and printer context is freshly
  revalidated.
- [ ] Calibration conflict comparisons are accessible for project metadata and
  ordered steps, draft methods/settings/prerequisites/results, selected current
  observation/attempt, stale printer snapshots, and deletion versus local edits.
  Only semantically valid accept-server, keep-local-as-new-revision, and manual
  field merge resolutions are exposed.
- [ ] Append-only attempts/events/observations/photos/profile revisions
  deduplicate by stable IDs or hashes. Measurements, exact profile JSON,
  selected outcomes, and deletions are never silently merged; no
  last-write-wins path exists.
- [ ] Main/preload expose narrow named commands only; all IPC requests and remote
  responses are validated; response/file/photo/body limits and cancellation are
  enforced; logs remain secret-safe; existing allowlisted native file/link
  channels are reused.
- [ ] Automated coverage includes shared schema/additive compatibility;
  refresh/identity fencing/timeouts/cancellation/body limits/error mapping;
  sidecar migrations/restart/cleanup; ordered outbox lease/retry/replay/
  idempotency; cursor/tombstone/gap handling; SignalR hint versus REST authority;
  two-device divergent offline resolution convergence E2E; photo staging/
  retry/hash/conflict retention; and renderer generic privilege denial.
- [ ] Existing Library synchronization and server-profile tests remain
  compatible, and all focused plus full relevant TypeScript and Rust
  typecheck/build/lint/format/test/migration/provenance gates pass.
- [ ] The implementation is committed on a branch based on `development` with
  required Copilot trailers, pushed, and represented by exactly one focused,
  non-draft PR whose base is `development`, whose body contains `Closes #52`,
  and which is not merged. The final report states branch, commits, PR URL/head/
  base, CI and mergeability, validation evidence, key design decisions, and any
  blockers.

## Scope Boundaries

**In scope:**
- All transport, shared contract, capability gating, native persistence, sync,
  conflict, security, and validation foundations explicitly required by issue
  #52.
- Typed contract surfaces needed by downstream issues #53, #54, #55, and #56.
- Minimal renderer integration needed to expose typed availability/conflict
  state and prove privilege denial, without implementing downstream workspace
  UX.

**Out of scope:**
- Issue #53 Printer Calibration workspace UI.
- Issue #54 nine-stage workflow UI.
- Issue #55 generated profile UI.
- Issue #56 legacy import implementation beyond its typed contract surfaces.
- Merging the PR.
- Any write, merge, retarget, or PR base involving `main`.
- Changes to PrintFarmer server repositories or APIs.
- Source-derived calibration formulas/workbooks/catalog data not needed for this
  transport foundation.

## Applicable Project Conventions

**Quality gate commands:**
- `npm run check:provenance`
- `npm run typecheck`
- `npm run lint`
- `npm run format`
- `npm run test`
- `npm run test:e2e`
- `npm run verify:target-profiles`
- `cargo fmt --check --manifest-path native/model-core/Cargo.toml`
- `cargo clippy --manifest-path native/model-core/Cargo.toml -- -D warnings`
- `cargo test --manifest-path native/model-core/Cargo.toml`
- `cargo test --manifest-path native/model-core/Cargo.toml --features sqlite`

**Commit convention:**
- Conventional commits.
- Builder iteration title:
  `type(scope): [B] description` (imperative, at most 72 characters).
- Inspector iteration title:
  `chore(scope): [I] description` (imperative, at most 72 characters).
- Builder trailer required: `Assisted-by: Claude:Sonnet-4.6`.
- Inspector trailer required: `Assisted-by: Claude:Haiku-4.5`.
- Every commit must also include:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.
- Every commit must also include:
  `Copilot-Session: 5d3039cb-e962-4330-bf41-74cb6ad0bda9`.

**Guidelines:**
- `docs/CONTRIBUTING.md`
- `docs/ARCHITECTURE.md`
- `docs/adr/0001-printer-calibration-source-provenance.md`
- `compliance/printer-calibration-provenance.json`
- `.github/CODEOWNERS`
- `.github/workflows/ci.yml`

**Rules:**
- Electron renderer isolation is mandatory: expose only explicit,
  Zod-validated channels in `src/shared/ipc.ts`; no filesystem, shell, network,
  credential, slicer, or G-code primitive reaches renderer code.
- Main validates every renderer request, sidecar RPC is typed, and renderer
  remains presentation-only.
- Add tests for every product behavior change and preserve user source model
  immutability.
- Never commit credentials or signing material.
- Any source-derived calibration logic must use the exact approved source
  revision and roots recorded by ADR 0001 and pass
  `npm run check:provenance`.
- Work only in the current worktree branch based on `development`; `main` is
  release-only and prohibited.
