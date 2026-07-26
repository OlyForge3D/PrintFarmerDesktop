# Calibration transport and offline sync — verified summary

## Outcome

Issue #52 is implemented on `jpapiez-issue-52-calibration-transport` and
delivered in non-draft PR #129 against `development`.

## Acceptance criteria delivered

- Added 19 narrow, additive Zod IPC contracts for calibration availability,
  printer context, projects, drafts, immutable records, photos, profile
  revisions, sync/outbox/conflicts, online print actions, Orca profile surfaces,
  and legacy-v4 import surfaces.
- Added truthful Klipper firmware/dialect, upstream OrcaSlicer, negotiated
  version, JWT scope, and end-to-end capability gating with typed unavailable
  reasons.
- Added a fixed-route authenticated calibration HTTP client with pre/post
  identity fencing, one bounded 401 refresh, cancellation/timeouts/body limits,
  streaming, typed ProblemDetails mapping, idempotency, revisions, ETags, and
  opaque cursors.
- Added model-core schema-v12 persistence and typed RPC for profile-bound
  projections, drafts/photos, ordered outbox state, conflicts, cursors,
  tombstones, and printer freshness.
- Added operational main-process adapters and all IPC wiring through
  `ServerProfileService.getAuthenticatedContext()`,
  `CalibrationHttpClient`, `CalibrationSyncEngine`, and model-core.
- Added stable dependency-aware push, exact replay, explicit conflict stops,
  authoritative REST hydration, cursor-safe pull, tombstones, and online-action
  freshness gates. SignalR remains optional and non-authoritative.
- Preserved renderer privilege isolation: no generic network, URL, header,
  method, path, filesystem, shell, slicer, G-code, or credential primitive is
  exposed.
- Added 63 integration tests, bringing the suite to 968 passing tests, including
  two-device convergence, photo staging, cursor/tombstone handling, error
  mapping, identity fencing, replay, and privilege denial.

## Iteration history

1. **FAIL** — The initial foundation had comprehensive contracts, HTTP, engine,
   schemas, and tests, but the runtime services were not instantiated and IPC
   handlers returned placeholders.
2. **PASS** — The Builder wired the HTTP client, sync engine, sidecar repository
   and RPC, operational IPC handlers, and 63 integration tests. Independent
   inspection confirmed the issue contract.
3. **PASS** — Live CI exposed an unpushed Prettier fix and sqlite-feature Clippy
   dead code. The Builder removed unused conversions, used the remaining typed
   conversions in SQLite operations, corrected replay state from `settled` to
   `replayed`, and passed all exact CI-equivalent gates.

## Inspector issues resolved

- Replaced calibration IPC placeholders with operational service calls.
- Added real model-core SQLite migration execution, repository methods, and RPC
  dispatch.
- Added handler-to-client-to-engine-to-sidecar integration coverage.
- Corrected Windows/macOS formatting and sqlite-feature Clippy failures.
- Corrected the outbox replay semantic state.

## Recommendations

- Build issues #53–#56 only against these narrow typed surfaces; do not widen
  renderer privileges.
- Keep REST/change-feed reconciliation authoritative if SignalR hints are added.
- Preserve the exact CI sqlite-feature Clippy command in local pre-push
  validation.
