# Goal: Calibration generation, queue state, and bed-clear actions

## User Request

Implement OlyForge3D/PrintFarmerDesktop issue #54 completely on the current
worktree branch, which is based on the default branch `development`. Never
write, merge, or retarget anything to `main`; release-only `main` is out of
bounds. Treat the issue body as the product contract, but treat the **verified
PrintFarmer server contract** in `server-contract.md` (sibling file in this
directory) as authoritative wherever the two disagree. Deliver a focused
non-draft pull request targeting `development` with `Closes #54`, and do not
merge it.

## Refined Goal

Integrate the native PrintFarmer Desktop (PFD) Printer Calibration workspace
with PrintFarmer's shipped deterministic generation orchestration, promoted
G-code, primary print queue, atomic dispatch claim, and exact-job bed-clear
acknowledgement contracts.

PFD orchestrates only typed backend operations. It never generates arbitrary
G-code, never downloads and re-uploads generated G-code, never submits a
generic slicer job, never accepts a renderer-supplied command or URL, and never
talks to a printer from the renderer.

The current code is an explicit stub: `CalibrationGetQueueState` unconditionally
returns `workerUnavailable`, and `acknowledgeBedClear` posts to a route that
does not exist on the server while collapsing every status code into `ok` or
`error`. This goal replaces that stub with a real, REST-authoritative
integration.

### Authoritative contract corrections (verified against shipped server code)

These are the load-bearing differences between issue #54's prose and what
PrintFarmer actually shipped. `server-contract.md` cites each one to a file in
`OlyForge3D/PrintFarmer` at SHA `167a3b134a678a0d9a8c10371da8333d03ddc636`.
Implement the shipped behaviour, not the prose.

1. **Two routes the desktop calls today do not exist server-side and must be
   removed.**
   - `GET /api/calibration-projects/{projectId}/queue` — does not exist.
   - `POST|GET /api/calibration-projects/{projectId}/generation` — does not
     exist.
2. **Generation is per-attempt, not per-project.** The real route is
   `POST /api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job`
   with `{ method, definitionVersion, options, baseRevision }`. Status codes
   202 / 200 / 409 / 412 / 422 / 503; the success body is a
   `CalibrationOrchestrationStatusDto`.
3. **Orchestration status is polled by orchestration id**, at
   `GET /api/calibration-orchestrations/{id}`. `Status` and `CurrentStep` are
   free-form strings defined by the saga implementation, **not** enums — the
   desktop must render them without exhaustively switching, and must not fail
   closed on an unrecognised value.
4. **Queue state comes from the primary queue API**, not a calibration route:
   `GET /api/job-queue/{id}`, `GET /api/job-queue/changes?afterSequence=&limit=`
   (cursor/gap reconciliation), and `GET /api/job-queue/subscription-resources`.
5. **Queue creation is `POST /api/job-queue`** with `jobKind:
   "FilamentCalibration"`, an exact `assignedPrinterId`, `copies: 1`, a promoted
   `gcodeFileId`, and the full immutable provenance/hash set. 201 with
   `Location` + `ETag` + `X-Dispatch-State-ETag` + `Idempotency-Replayed: false`
   on first insert; 200 with `Idempotency-Replayed: true` on exact replay; 409
   `idempotency_payload_mismatch` on a changed payload.
6. **Bed-clear acknowledgement requires THREE preconditions, not one.** Issue
   #54's prose shows only `If-Match`. The shipped endpoint reads
   `Idempotency-Key`, `If-Match` (job rowVersion) **and**
   `X-Dispatch-State-If-Match` (dispatch-state rowVersion) directly from
   `Request.Headers`. Any one missing returns **428 `precondition_required`**.
   The body is `{ printerId, idempotencyKey?, expectedPrinterConfigRevision? }`.
7. **The full acknowledgement status set is wider than the prose.** Handle
   202, 200, 400, 403, 404 `job_not_found`, 409 (`wrong_job`, `printer_busy`,
   `job_not_dispatchable`, `idempotency_payload_mismatch`), 412
   `dispatch_revision_conflict` (whose body carries the **current** ETags for
   retry), 422 (`calibration_job_incompatible`, `filament_check_failed`), 428
   `precondition_required`, and 503 `printer_offline_or_stale`.
8. **ETags are opaque base-64 row versions.** Send them back byte-identical to
   how they were received. Do not parse, re-encode, or coerce them to integers —
   the existing `baseRevision: number` shape in the shared IPC schema cannot
   represent them.
9. **There is no `Retry-After` on 503 and no `Idempotency-Replayed` on the
   acknowledgement endpoint.** Do not depend on either.
10. **SignalR is a hint only.** Hub `/hubs/printers`; call
    `SubscribeToQueueJobAsync(jobId)` to receive full `queueevent` envelopes.
    The `Printer-{id}` group receives **redacted** envelopes with `jobId`,
    `bedClearState`, and every sensitive field nulled — never treat those as job
    state. Envelope `schemaVersion` is `"3"`; use the monotonic `sequence` for
    gap detection and refetch REST on any gap.
11. **`bedClearState` values seen by clients are `None | Acknowledged |
    Consumed | Invalidated`.** The internal `BedClearCommandStatus`
    (`Pending/Claimed/...`) is never exposed and must not appear in desktop code.
12. **Job status literals are `Queued | Assigned | Starting | Printing | Paused
    | Completed | Failed | Cancelled`;** dispatch outcome literals are
    `InProgress | Accepted | Rejected | FailedBeforeStart | Unknown`; priority is
    `Low | Normal | High | Urgent`.

## Acceptance Criteria

- [ ] The two non-existent routes (`/calibration-projects/{id}/queue` and
  `/calibration-projects/{id}/generation`) are removed from `calibrationHttp.ts`
  and replaced by the real shipped routes listed above. No dead route constant
  remains.
- [ ] Shared IPC (`src/shared/ipc.ts`) gains strict, additive Zod contracts for:
  generation start (per attempt, with method options), orchestration status with
  durable stages and non-exhaustive string status, queue job state, dispatch
  state and dispatch result, exact-job bed-clear acknowledgement with the full
  status set, typed blocked reasons, and immutable provenance. Existing
  contracts stay backward compatible; opaque ETags are represented as strings,
  never numbers.
- [ ] `CalibrationGetQueueState` is implemented for real against
  `GET /api/job-queue/{id}` and no longer returns a hardcoded
  `workerUnavailable`.
- [ ] A generation request sends `Idempotency-Key` plus `baseRevision`, is
  resumable, and every durable orchestration stage — model accepted, slicing
  queued/claimed/progress, artifact validated, promoted `GcodeFile`, queue job
  created — plus every structured failure is surfaced to the renderer. Exact
  replay resolves to the original operation rather than a duplicate.
- [ ] Queue creation uses `POST /api/job-queue` with `jobKind =
  FilamentCalibration`, never an analytics route, never a client-supplied G-code
  body, and never an auto-selected printer. Idempotent replay resolves to the
  original job rather than displaying a duplicate.
- [ ] Bed-clear acknowledgement invokes only
  `POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start`, sends all three
  required preconditions, and maps 202/200/400/403/404/409/412/422/428/503 to
  distinct, actionable typed states. A 412 refetches current ETags before the
  dialog can be presented again.
- [ ] An acknowledgement is never reused for a reordered, replaced, cancelled or
  new job, and is never consumed on a rejected or stale request. Acknowledgement
  is not offered when offline, unsynchronized, unauthorized, expired, stale, or
  when the assigned printer no longer explicitly reports Klipper.
- [ ] Queue and dispatch state converge through REST across restart and
  reconnect. SignalR only accelerates display; a sequence gap or uncertain state
  triggers a REST refetch. Redacted printer-group envelopes are never mistaken
  for job state.
- [ ] An accepted-but-unconfirmed start (`Unknown` outcome) remains `Starting`
  with reconciliation guidance and no blind-retry affordance in the UI.
- [ ] Typed blocked reasons are surfaced for stale telemetry, changed
  firmware/configuration, material/nozzle mismatch, maintenance/busy state,
  missing G-code, and permission failure.
- [ ] The renderer shows immutable provenance: upstream-Orca version, Klipper
  dialect, printer snapshot/config revision, and profile/model/specification/
  G-code hashes, plus queued job identity. A stale or changed context blocks
  replay/start and requires explicit regeneration or rebase.
- [ ] The exact-job bed-clear safety dialog shows the exact queued job, assigned
  printer, current queue revision, material/nozzle, generated test, and
  acknowledgement expiry, and is keyboard- and screen-reader-accessible with
  focus management and live-region announcements.
- [ ] Print lifecycle reconciles `Queued`, `Assigned`, `Starting`, `Printing`,
  `Paused`, `Completed`, `Failed`, `Cancelled` from authoritative REST.
  Completion guides append-only observations, selected result, confidence,
  retest decision, notes and photos. Failure or cancellation preserves prior
  attempt/generation history and offers a new attempt rather than mutating
  evidence. A step is never marked complete from queue completion alone.
- [ ] A versioned, reviewed external calibration asset manifest ships with
  source URL, author, declared license/attribution, expected filename/type/
  checksum where stable, supported method, and validation rules. Manifest URLs
  open only through the existing allowlisted external-navigation channel. Users
  select files themselves; no third-party model is bundled. Extension, magic/
  container structure, size, geometry and method-specific bounds are validated
  locally before authenticated upload. Provenance/checksum is displayed and
  stored with the attempt. Any method whose asset manifest or validation fixture
  has not passed review stays disabled with a concrete reason.
- [ ] Only named, validated generation/status/acknowledgement/result commands
  are added to shared IPC and preload. Main owns authenticated streaming,
  cancellation, retries and error mapping. Secrets, local paths and raw backend
  error payloads are redacted from renderer and logs. No generic network,
  filesystem, shell, printer, slicer or G-code primitive reaches the renderer,
  and a renderer-boundary test proves it.
- [ ] Automated coverage includes: asset manifest/link/file validation and
  provenance; generation idempotency, restart/reconnect and every durable stage
  and failure; remote DTO additive compatibility and capability/permission
  gating; REST-authoritative queue reconciliation with event progress and gap
  tests; bed-clear dialog headers, idempotent replay and every status code;
  reorder/new-job/expired-acknowledgement/stale firmware-config-telemetry and
  material-mismatch cases; uncertain start remaining `Starting` with no blind
  retry; completion/failure/cancel producing append-only history; keyboard/focus/
  announcement tests for the safety and progress dialogs; and renderer-boundary
  denial of arbitrary G-code, network and printer commands.
- [ ] Existing Library, viewer, retarget, server-profile, sync and calibration
  tests remain green, and all relevant TypeScript and Rust typecheck / build /
  lint / format / test / provenance gates pass.
- [ ] The work is committed on the current branch with the required trailers,
  pushed, and represented by exactly one focused non-draft PR whose base is
  `development` and whose body contains `Closes #54`. The PR body **explicitly
  states that no live PrintFarmer server and no Klipper hardware were available**,
  so all evidence is fixture- and mock-based, and it lists any server contract
  gaps found. The PR is not merged.

## Scope Boundaries

**In scope:**

- Generation orchestration, queue creation, queue/dispatch reconciliation,
  exact-job bed-clear acknowledgement, print lifecycle and result entry.
- The external calibration asset manifest: schema, local validation, provenance
  display and storage, allowlisted external navigation, and per-method disable
  with a concrete reason.
- Shared IPC contracts, preload commands, main-process handlers and transport.
- Full renderer work: orchestration stages, queue/dispatch panel, bed-clear
  safety dialog, provenance display, blocked reasons, and post-print result
  entry.
- Removing the two dead routes and the `workerUnavailable` stub.
- Fixture- and mock-based automated tests for everything above.

**Out of scope:**

- Any change to PrintFarmer server repositories or APIs.
- Bundling any third-party calibration model.
- A second printer database, a separate calibration runtime, or a local web
  service.
- Live-server or Klipper hardware validation, and any claim of it. Manual
  hardware acceptance belongs to #57.
- Merging the PR.
- Any write, merge, retarget, or PR base involving `main`.
- Issue #57 release-hardening work beyond what #54 explicitly requires.

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
- `cargo clippy --manifest-path native/model-core/Cargo.toml --all-targets --features sqlite -- -D warnings`
- `cargo test --manifest-path native/model-core/Cargo.toml`
- `cargo test --manifest-path native/model-core/Cargo.toml --features sqlite`

**Commit convention:**

- Conventional commits.
- Builder iteration title: `type(scope): [B] description` (imperative, ≤72
  characters).
- Inspector iteration title: `chore(scope): [I] description` (≤72 characters).
- Builder trailer required: `Assisted-by: Claude:Sonnet-4.6`.
- Inspector trailer required: `Assisted-by: Claude:Haiku-4.5`.
- Every commit must also include:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`.
- Every commit must also include:
  `Copilot-Session: af9c7b76-f239-46b4-ac76-33d812f0c783`.

**Guidelines:**

- `docs/CONTRIBUTING.md`
- `docs/ARCHITECTURE.md`
- `docs/adr/0001-printer-calibration-source-provenance.md`
- `compliance/printer-calibration-provenance.json`
- `.github/CODEOWNERS`
- `.github/workflows/ci.yml`
- `.squad/skills/testing/SKILL.md`
- `.squad/skills/test-discipline/SKILL.md`

**Rules:**

- `server-contract.md` in this directory is the authoritative API reference.
  Where issue #54's prose disagrees with it, the contract wins; record every
  such divergence in the PR body.
- Electron renderer isolation is mandatory: expose only explicit, Zod-validated
  channels in `src/shared/ipc.ts`; no filesystem, shell, network, credential,
  slicer, or G-code primitive reaches renderer code.
- Main validates every renderer request, sidecar RPC is typed, and the renderer
  remains presentation-only.
- Add tests for every product behaviour change and preserve user source model
  immutability.
- Never commit credentials or signing material.
- Any source-derived calibration logic must use the exact approved source
  revision and roots recorded by ADR 0001 and pass `npm run check:provenance`.
- A test must fail for the reason it names. Size fixtures to the named constant
  they exercise and assert the specific violated control, so a test cannot pass
  by tripping a neighbouring guard.
- Work only in the current worktree branch based on `development`; `main` is
  release-only and prohibited.
