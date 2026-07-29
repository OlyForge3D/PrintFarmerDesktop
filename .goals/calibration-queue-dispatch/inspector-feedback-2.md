# Inspector Feedback — Iteration 2

## Verdict: FAIL

The renderer is no longer absent: the five components are imported **and**
rendered under reachable conditions, and several behaviours are genuinely and
correctly tested (focus trap, Escape+restore, Unknown→Starting, append-only
observations, asset-manifest magic/size/checksum guards). Iteration 1's "zero
renderer files" failure is fixed.

But this iteration reproduces the repository's chronic failure mode in a
subtler form: **UI code that exists but is fed hardcoded `null`, guarded by
tests that assert absence rather than presence, and a reconciliation path that
no test exercises at all.** Four criteria measure materially less than they
assert. One mutation (gap→refetch) produced **zero** test failures.

Judged against `goal.md`'s numbering (the Builder's report renumbered them and
is ignored per instruction).

---

## Acceptance Criteria — goal.md numbering

| # | Criterion (abbrev.) | Verdict | Evidence |
|---|---------------------|---------|----------|
| 1 | Dead routes removed, real routes, no dead constant | ✅ PASS | `src/main/calibrationHttp.ts:786` uses `ROUTES.jobQueueChanges`, `:808` uses `ROUTES.jobQueueSubscriptionResources` — the two constants iter-1 flagged as dead are now live. Search for `calibration-projects/.*(queue\|generation)` in `calibrationHttp.ts` returns empty. |
| 2 | Shared IPC strict Zod, string ETags, additive | ✅ PASS | Contracts present in `src/shared/ipc.ts` (unchanged from iter 1; ETags `z.string()`). |
| 3 | `CalibrationGetQueueState` real vs `GET /api/job-queue/{id}` | ✅ PASS | `calibrationHttp.ts` `getQueueJob`; consumed in workflow `useEffect` `CalibrationStepWorkflow.tsx:299-306`. |
| 4 | Generation Idempotency-Key+baseRevision, stages+failures surfaced, replay | ✅ PASS | Transport verified iter 1. Renderer surfaces free-form `status`/`currentStep`/`problems` verbatim: `CalibrationOrchestrationProgress.tsx:33-55` default-returns the raw string; tests `calibration.workspace.test.tsx:1871` (Running/TemperatureSensing) and `:1925` (QuantumEntangled/NeuralCalibrationPass) pass. |
| 5 | Queue creation `POST /api/job-queue`, jobKind FilamentCalibration | ✅ PASS | Transport verified iter 1 (jobKind-casing mutation isolated). |
| 6 | Bed-clear 3 preconditions + status map + **412 refetches ETags before re-present** | ⚠️ PARTIAL → FAIL | Transport 3-precondition + status mapping PASS (iter 1). **Renderer 412 clause NOT wired:** `handleBedClearConfirm` (`CalibrationStepWorkflow.tsx:462-465`) collapses a `revisionConflict` to the string `'Revision conflict.'` and never refetches current ETags before the dialog can be presented again. The transport returns the current ETags on 412; the renderer discards them. |
| 7 | Ack never reused (reorder/replace/cancel/new); not offered offline/unauth/expired/stale/non-Klipper | ❌ FAIL | Reachable guards are only **offline** (`CalibrationQueueDispatchPanel.tsx:315-319`) and **cancelled** (`isJobInvalidated`, `:112-114`). Unauthorized, expired, stale-telemetry, reordered/replaced, and non-Klipper are **never computed**: `blockedReason` is hardcoded `null` (`CalibrationStepWorkflow.tsx:1159`) and the dialog's expiry guard keys off `acknowledgementExpiresAt`, which is hardcoded `null` (`:505`). The expiry guard therefore can never fire in the real UI. |
| 8 | Converge via REST; gap→refetch; redacted printer envelopes not mistaken for job state | ❌ FAIL (unverified) | **Mutation 7 produced ZERO failures.** Deleting `onGapDetected()` in the production hook `useQueueReconciliation` (`CalibrationQueueDispatchPanel.tsx:161-163`) failed no test. `pollCalibrationQueueChanges` is mocked to `error` in every workspace test (`calibration.workspace.test.tsx:532-540`), so the hook's success/gap/redaction path is never executed. The only "gap detection" test is a **local reimplementation** `detectGaps` in `calibration.queue-dispatch.test.ts:1250-1272` that never touches production code. The redaction guard (`evt.jobId === jobId`, `:168`) exists but is untested. |
| 9 | Unknown outcome stays "Starting", no blind-retry | ✅ PASS | Mutation 4 (Unknown→verbatim) and Mutation 5 (inject retry button) **each** failed exactly `calibration.workspace.test.tsx:1838`. Both the label mapping and the no-retry assertion are real. |
| 10 | Typed blocked reasons surfaced (stale telem., firmware/config, material, maintenance, missing gcode, permission) | ❌ FAIL | `blockedReason={null}` is the **only** wiring (`CalibrationStepWorkflow.tsx:1159`). `BlockedReasonDisplay`/`BlockedReasonMessage` exist but are never fed a non-null reason in reachable UI. The criterion-10 test (`:1856-1868`) asserts the blocked alert is **absent** and its own comment defers to "unit tests" that do not exist (the panel has no standalone test file; it is only mounted via the workspace, where the prop is null). Nothing computes any blocked reason. |
| 11 | Renderer shows immutable provenance + stale/changed context blocks replay/start | ⚠️ PARTIAL → FAIL | `CalibrationProvenance` is rendered (`CalibrationStepWorkflow.tsx:1166`, `ProjectOverview.tsx:638`); job-id display verified `:1978`. But `handoffProvenance` is built with `machineProfileSha256`, `processProfileSha256`, `filamentProfileSha256`, `printerConfigSnapshotSha256`, `requiredGcodeDialect`, `requiredFirmwareFamily` all hardcoded `null` (`:404-417`) — several required provenance fields are never shown. The "stale/changed context blocks replay/start and requires regeneration or rebase" behaviour is not implemented. |
| 12 | Bed-clear dialog shows job/printer/revision/material/nozzle/test/expiry + a11y focus mgmt + **live-region announcements** | ❌ FAIL | Focus management is REAL and verified (Mutations 1–3 below). But the dialog shows only Job ID + queue revision to a real user: `material`, `nozzle`, `generatedTestName`, `acknowledgementExpiresAt`, `assignedPrinterName` are hardcoded `null` in the wiring (`CalibrationStepWorkflow.tsx:500-505`). **Live-region announcements never fire:** `expiryAnnouncement` is gated on `secondsLeft` derived from the always-null expiry, so it is always `null`. The test named "countdown announces via aria-live assertive region when expiry is near" (`:2142`) asserts the region's `textContent` `.toBe('')` (`:2180`) — it verifies an empty `aria-live` element exists, **not** that any announcement occurs. Those are different claims; only element-presence is proven. |
| 13 | Lifecycle reconciles 8 statuses; append-only observations (result/confidence/retest/notes/photos); failure/cancel preserve+offer new attempt; never complete from queue completion alone | ⚠️ PARTIAL | Append-only is real (Mutation 6 + `:1996`). But observations live only in local component state (`setPrintObservations`), never persisted via IPC; the test exercises only result+confidence, not notes/photos/retest; and "failure/cancel preserve history and offer a new attempt" and "never marked complete from queue completion alone" are not demonstrated by any test. |
| 14 | Asset manifest: schema, validation, provenance/checksum **displayed and stored with the attempt**, allowlisted nav, per-method disable, review-gated | ⚠️ PARTIAL | Validation is strong and mutation-tested (Mutation 8 isolates the magic-byte guard; size/checksum/geometry/method-disable tests present). Manifest JSON ships (`assets/calibration-asset-manifest.json`). **Not demonstrated:** checksum/provenance actually *stored with the attempt*, and manifest URLs opening *only* through the allowlisted external-navigation channel — no test exercises either wiring. |
| 15 | Only named validated commands in IPC/preload; main owns streaming/redaction; renderer-boundary test proves it | ✅ PASS | `calibration.renderer-boundary.test.ts` asserts serialized IPC responses never contain the forbidden path/shell/G-code primitives and that reason codes are enum literals. (Scope caveat: the file's own header, `:32-35`, states it tests the IPC-schema parse, not the preload bridge or components — acceptable for the boundary claim.) |
| 16 | Automated coverage breadth (reconciliation/gap, blocked reasons, expiry, reorder/new-job/stale/material, a11y announcements, etc.) | ❌ FAIL | Multiple named coverage items are hollow or absent: gap tests are a local reimplementation (crit 8); blocked-reason surfacing has no positive test (crit 10); the live-region test asserts empty content (crit 12); reorder/new-job/expired-ack/stale-firmware-config-telemetry/material-mismatch are unreachable because `blockedReason` and `acknowledgementExpiresAt` are always null. |
| 17 | Existing tests green + all TS/Rust gates pass | ✅ PASS | See Quality Gates below. 1422 JS tests; all provenance/target-profiles/format/cargo gates green. |
| 18 | Committed w/ trailers, pushed, one non-draft PR base `development`, body states no live server, not merged | ⏳ PENDING | No PR exists yet (mid-loop). Deferred to the final orchestration step; not counted against the Builder now. |

**Tally:** PASS 1,2,3,4,5,9,15,17 · FAIL 7,8,10,12,16 · PARTIAL→FAIL 6,11 · PARTIAL 13,14 · PENDING 18.

---

## Reachability — per component (Check B)

Every component is imported, **rendered under a reachable condition**, and
mounted by a test. No orphans remain (the iter-1-turn-1 defect is gone).

| Component | Import | Render site (condition) | Test that mounts it |
|-----------|--------|-------------------------|---------------------|
| `CalibrationOrchestrationProgress` | `CalibrationStepWorkflow.tsx:31` | `:1141-1147` when `orchId !== null` (set by **Generate** button → `handleGenerate` `:332`) | `:1871`, `:1925` |
| `CalibrationQueueDispatchPanel` | `:32` | `:1150-1162` when `queueJobId !== null` (set on mount `useEffect` `:304` and **Start print** `:392`) | `:1823`, `:1838`, `:1856` |
| `CalibrationProvenance` | `:38` / `ProjectOverview.tsx:17` | `:1165-1167` when `handoffProvenance !== null`; `ProjectOverview.tsx:638` | `:1978` |
| `CalibrationPrintLifecycle` | `:37` | `:1170-1182` when `queueJobId !== null && printStatus !== null` | `:1996` |
| `CalibrationBedClearDialog` | `:34-36` | `:1185-1195` when `bedClearDialogJob !== null`; opened by **Confirm bed clear** button `:1101` | `:2054-2183` |

Caveat: reachable ≠ complete. Several rendered components receive hardcoded
`null` props (crit 6/7/10/11/12), so the *component* is reachable but the
*criterion behaviour* is not.

---

## Mutation Testing (Check C)

Each mutation applied, the affected file run, failures recorded by name, then
reverted. Working tree confirmed clean afterward (`git diff` empty).

| # | Mutation | Expected | Observed | Isolated? |
|---|----------|----------|----------|-----------|
| 1 | Remove wrap-to-first in Tab handler (`CalibrationBedClearDialog.tsx:130`) | Only "Tab from last…wraps to first" fails | **1 failed:** `…Tab from last focusable element wraps focus to first focusable`; 32 passed | ✅ |
| 2 | Remove Escape handler (`:103-107`) | Escape close+restore fails | **1 failed:** `…Escape closes dialog and restores focus to trigger button`; 32 passed | ✅ |
| 3 | Remove focus restoration, keep Escape (`:290-293`) | Only restore assertion fails | **1 failed:** the same Escape test — so it genuinely asserts **restoration**, not just closure; 32 passed | ✅ |
| 4 | `Unknown`→verbatim (`CalibrationQueueDispatchPanel.tsx:99`) | Crit-9 test fails | **1 failed:** `…Unknown dispatch outcome renders as "Starting"…`; 32 passed | ✅ |
| 5 | Inject retry button into Unknown branch (`:402-411`) | Crit-9 no-retry assertion fails | **1 failed:** same crit-9 test — the "no retry button" assertion is real; 32 passed | ✅ |
| 6 | Append-only path drops prior entry (`CalibrationStepWorkflow.tsx:486`) | Crit-13 append-only fails | **1 failed:** `…append-only observations (criterion 13)`; 32 passed | ✅ |
| 7 | Break gap→refetch in `useQueueReconciliation` (`CalibrationQueueDispatchPanel.tsx:161-163`) | A gap-detection test fails | **0 failed** — workspace + queue-dispatch: 108 passed. **No test exercises the production reconciliation path.** | ❌ UNVERIFIED |
| 8 | Weaken STL magic guard `>=84`→`>=10` (`calibrationAssetManifest.ts:104`) | Only magic-byte test fails | **1 failed:** `…badMagicBytes for random bytes with .stl extension`; checksum & size tests green (17 passed) | ✅ |

**Mutation 7 is decisive:** per the iteration rules, a mutation that produces
no failure means the criterion is unverified → criterion 8 is downgraded to
FAIL. The gap/redaction logic that *is* tested is a copy living inside the test
file, not the shipped code.

All other mutations isolated cleanly — where the tests exist, they fail for the
reason they name and do not trip neighbouring guards.

---

## Accessibility, judged not assumed (Check D)

- `openBedClearDialog` (`calibration.workspace.test.tsx:2036`) drives the **real
  workspace**: it mounts the workspace, waits for the enabled "Confirm bed
  clear" trigger, focuses it, clicks, and resolves the real `role="dialog"`.
  The dialog is reached through the real component tree, not constructed in
  isolation. Confirmed.
- Focus management (initial focus, Tab/Shift+Tab wrap, Escape, restore-to-
  trigger, `role="dialog"`/`aria-modal`) is **real and mutation-verified**
  (Mutations 1–3). This half of criterion 12 is satisfied.
- **Live-region announcements are not satisfied.** The test asserts an
  `aria-live` element *exists* and is *empty* (`:2176-2180`), not that any
  announcement occurs. In the reachable wiring the announcement can never
  populate because `acknowledgementExpiresAt` is hardcoded `null`
  (`CalibrationStepWorkflow.tsx:505`). Element-presence ≠ announcement.

---

## Contract fidelity (Check E)

- **Orchestration `Status`/`CurrentStep` free-form:** ✅ `CalibrationOrchestrationProgress.tsx:33-55` returns unrecognised values verbatim (no fail-closed, no blanking); crit-4 verbatim test passes.
- **Redacted `Printer-{id}` envelopes never treated as job state:** guard exists (`evt.jobId === jobId`, `CalibrationQueueDispatchPanel.tsx:168`) — correct in code, but **untested** (see Mutation 7 / crit 8).
- **ETags echoed byte-identically as opaque base-64:** ✅ transport verified iter 1 (byte-identity mutation); renderer passes `rowVersion` through as a string without coercion.

---

## Quality Gates (Check F)

| Gate | Result |
|------|--------|
| `npm run typecheck` | ✅ exit 0 (requester-verified) |
| `npm run lint` | ✅ exit 0 (requester-verified) |
| `npm run test` | ✅ 1422 passed / 62 files (requester-verified) |
| `npm run format` (`prettier --check`) | ✅ all files conform |
| `npm run check:provenance` | ✅ source v1.3.2 (057d6117…) |
| `npm run verify:target-profiles` | ✅ 82 files pinned |
| `cargo fmt --check` | ✅ exit 0 |
| `cargo clippy … -D warnings` | ✅ exit 0 |
| `cargo test` (default) | ✅ 76 passed / 1 ignored |
| `cargo test --features sqlite` | ✅ 76 passed / 1 ignored |
| `npm run test:e2e` | ⏭️ **NOT RUN** — sidecar binary unavailable in this environment. Not a Builder failure; not counted as passed. |

Gates are green — but green gates do not rescue criteria whose behaviour is
fed null or whose tests assert absence.

---

## What Must Be Fixed (prioritised, concrete)

1. **Criterion 8 — make reconciliation real and tested.** Add a workspace (or
   dedicated panel) test that mounts `CalibrationQueueDispatchPanel`, resolves
   `pollCalibrationQueueChanges` to `{status:'ok', gapDetected:true, events:[…],
   nextSequence:N}`, and asserts `getCalibrationQueueState` is refetched. Add a
   second case with a **redacted** envelope (`jobId:null`) and assert local
   state is NOT mutated. Deleting `onGapDetected()` must fail a test. Delete or
   fold the `detectGaps` reimplementation in `calibration.queue-dispatch.test.ts`
   into a test that imports the real logic.

2. **Criterion 10 — feed and test blocked reasons.** Compute a
   `CalibrationBlockedReason | null` in `CalibrationStepWorkflow` from real
   signals (stale telemetry, firmware/config change, material/nozzle mismatch,
   maintenance/busy, missing G-code, permission) and pass it instead of the
   literal `null` at `:1159`. Add a test that supplies each reason and asserts
   the typed message renders (positive assertion, not absence).

3. **Criterion 12 — populate the dialog and prove announcements.** Wire
   `material`, `nozzle`, `generatedTestName`, `acknowledgementExpiresAt`,
   `assignedPrinterName` from real job/attempt data instead of `null`
   (`:500-505`). Then write a live-region test that sets an expiry ~15 s out,
   advances fake timers, and asserts the `aria-live` region's `textContent`
   contains the countdown announcement — not `''`.

4. **Criterion 7 — extend and test acknowledgement guards.** Add expired /
   unauthorized / stale / non-Klipper / reordered guard paths (they depend on
   fixes 2–3) and cover reorder/new-job/expired-ack cases.

5. **Criterion 6 — wire the 412 refetch.** On `revisionConflict`, refetch the
   current job ETags (already returned by the transport) and re-seed the dialog
   before it can be presented again; assert it in a test.

6. **Criteria 11, 13, 14 — close the partials.** Populate the null provenance
   hashes and implement stale-context blocking (11); persist observations and
   cover notes/photos/retest + failure/cancel-preserves-history +
   no-auto-complete (13); demonstrate checksum-stored-with-attempt and
   allowlisted manifest navigation (14).

7. **Criterion 16** falls out of 1–6: every fix above must land with a test
   that fails when the behaviour is removed.

---

## Summary

Real, verified work this round: five components wired and reachable; focus
management; Unknown→Starting; append-only; asset-manifest validation guards;
all quality gates. That is genuine progress over iteration 1.

It fails because four criteria (7, 8, 10, 12) and the coverage criterion (16)
present UI that is reachable but inert — components fed hardcoded `null`, a
reconciliation path no test runs (Mutation 7 = zero failures), and an
accessibility announcement test that asserts an empty element. This is exactly
the "claims more than it measures" pattern the goal forbids. Not ready for the
PR.
