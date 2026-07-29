# Inspector Feedback — Iteration 3

## Verdict: FAIL

Iteration 3 did exactly what it claimed for the four items it targeted, and it
did them **for real**: the gap-detection loop is now exercised through the
production path (not a test-file reimplementation), the bed-clear dialog shows
live data and genuinely announces its countdown, blocked reasons are computed
and positively asserted, and the 412 refetch is wired. **All nine mutations
this round produced the exact isolated failure they were meant to** — including
the decisive Mutation 1, which proves the `useCallback` fix is load-bearing and
not cosmetic. That is the best round of test discipline in this goal's history.

It fails because the goal is not finished. Criterion 8 (the headline defect from
iteration 2) is genuinely fixed, but the iteration-2 fix list also asked the
Builder to close criteria **7, 11, 13, 14** and the *full* enumerated set of
**10** — and iteration 3's diff never touches the provenance hashes, the
observation-persistence path, the asset-manifest storage/nav wiring, or the
broader acknowledgement guards. Those criteria remain in exactly the
reachable-but-inert / hardcoded-`null` state the last two inspectors flagged.
Six criteria still fail on concrete, auditable evidence.

Judged strictly against `goal.md`'s numbering.

---

## Acceptance Criteria — goal.md numbering

| # | Criterion (abbrev.) | Verdict | Evidence |
|---|---------------------|---------|----------|
| 1 | Dead routes removed, real routes, no dead constant | ✅ PASS | Unchanged since iter 2; `ROUTES.jobQueueChanges` / `jobQueueSubscriptionResources` live; no `calibration-projects/.../(queue\|generation)` constants. |
| 2 | Shared IPC strict Zod, string ETags, additive | ✅ PASS | iter-3 change is additive only: `ipc.ts:3433-3436` adds `assignedPrinterName` and `acknowledgementExpiresAt` as `.nullable().optional()`; existing shapes and `z.string()` ETags unchanged. Backward compatible. |
| 3 | `CalibrationGetQueueState` real vs `GET /api/job-queue/{id}` | ✅ PASS | Unchanged; `getCalibrationQueueState` drives the panel. |
| 4 | Generation Idempotency-Key+baseRevision, stages+failures surfaced, replay | ✅ PASS | Unchanged since iter 2; verbatim free-form status test still green. |
| 5 | Queue creation `POST /api/job-queue`, jobKind FilamentCalibration | ✅ PASS | Transport unchanged. |
| 6 | Bed-clear 3 preconditions + status map + **412 refetches ETags before re-present** | ✅ PASS (now) | Renderer 412 clause now wired: `CalibrationStepWorkflow.tsx:467-478` updates `rowVersion`/`dispatchStateRowVersion` from `res.jobRowVersion`/`res.dispatchStateRowVersion` then closes the dialog. Test `calibration.workspace.test.tsx:2409` re-opens and asserts the 2nd ack carries `CONFLICT_JOB==`/`CONFLICT_DISP==`. **Mutation 8** (reuse stale ETags) fails that test alone. |
| 7 | Ack never reused (reorder/replace/cancel/new); not offered offline/unsync/unauth/expired/stale/non-Klipper | ❌ FAIL | `canAcknowledge` (`CalibrationQueueDispatchPanel.tsx:333-337`) now gates on `offline`, `blockedReason`, `bedClearState==='None'`, `!terminal`. So offline/stale/config/missingGcode block via crit-10 wiring, and **cancelled** blocks via `isJobInvalidated`. But **unauthorized, expired, non-Klipper, reordered-vs-merely-cancelled, and material/nozzle-mismatch are never computed** — `computedBlockedReason` has no such branch (grep: 0 hits for `permissionFailure\|acknowledgementExpired\|jobReordered\|materialMismatch\|maintenanceBusy\|firmwareChange`), and `canAcknowledge` never inspects expiry. No test for reorder / new-job / expired-ack / unauthorized / non-Klipper exists (`workspace.test.tsx` grep: none). |
| 8 | Converge via REST; gap→refetch; redacted printer envelopes not mistaken for job state | ✅ PASS (now) | Reconciliation now runs through the production hook. Gap test `workspace.test.tsx:1926` mounts the workspace, defers the first `pollCalibrationQueueChanges`, clears the counter, fires `gapDetected:true`, and asserts ≥1 refetch of `getCalibrationQueueState`. Redaction test `:2011` delivers a `jobId:null`/`jobStatus:'Cancelled'` envelope and asserts state stays `Queued`. **Mutation 1** (drop `useCallback`) fails the gap test → fix is load-bearing. **Mutation 2** (comment `onGapDetected()` `:168`) → gap test only. **Mutation 3** (`evt.jobId===jobId`→`if(true)` `:174`) → redaction test only. `detectGaps` reimplementation deleted from `calibration.queue-dispatch.test.ts` (−69). |
| 9 | Unknown outcome stays "Starting", no blind-retry | ✅ PASS | Unchanged; test still green in the 39. |
| 10 | Typed blocked reasons for **stale telemetry, firmware/config change, material/nozzle mismatch, maintenance/busy, missing G-code, permission** | ❌ FAIL | `computedBlockedReason` (`CalibrationStepWorkflow.tsx:571-618`) computes only `printerOffline`, `staleTelemetry`, `configChange`, `missingGcode`. **Four of the six enumerated categories — firmware change, material/nozzle mismatch, maintenance/busy, permission failure — are never produced**, so they cannot surface in reachable UI (the `BlockedReasonDisplay` messages at panel `:211-219` exist but are unreachable for those codes). Mutations 4/5 prove the three wired reasons are real and independently asserted, but the criterion enumerates six. |
| 11 | Immutable provenance (Orca/Klipper/config-rev + profile/model/spec/G-code hashes) + stale/changed context blocks replay/start | ❌ FAIL | Still hardcoded `null`: `machineProfileSha256`, `processProfileSha256`, `filamentProfileSha256`, `printerConfigSnapshotSha256`, `requiredFirmwareFamily`, `requiredGcodeDialect` at `CalibrationStepWorkflow.tsx:385-390` and again `:409-410,420-423`. Iteration 3 did not touch this. "Stale/changed context blocks replay/start and requires regeneration or rebase" is still not implemented. |
| 12 | Bed-clear dialog shows job/printer/revision/material/nozzle/test/expiry + a11y + **live-region announcements** | ✅ PASS (now) | Dialog job assembled from live data: `CalibrationStepWorkflow.tsx:547-560` (material from `binding.filament`, nozzle from `selectedTool`, expiry from `bedClearExpiresAt` propagated via `onBedClearExpiryChange`). Test `:2382` advances the poll event carrying `bedClearExpiresAtUtc` and asserts the live region `textContent` matches `/expires in \d+ second/i`. **Mutation 6** (null material/nozzle) fails the material test alone; **Mutation 7** (freeze countdown) fails the aria-live test alone → it asserts announcement, not element existence. Focus mgmt unchanged/real. |
| 13 | Lifecycle 8 statuses; append-only observations (result/confidence/retest/notes/photos); failure/cancel preserve+offer new; never complete from queue alone | ❌ FAIL (partial) | Append-only is real: `handleAddObservation` `:505` uses `[...prev, newObs]`; **Mutation 9** (`prev.slice(0,-1)`) fails the append-only test alone (`workspace.test.tsx:2191`). But observations remain **local component state only** (`setPrintObservations`, no IPC persistence); notes/photos/retest are not covered; "failure/cancel preserve history and offer a new attempt" and "never marked complete from queue completion alone" are still demonstrated by no test. Unchanged from iter 2. |
| 14 | Asset manifest: schema/validation/provenance **stored with the attempt**, allowlisted nav, per-method disable, review-gated | ❌ FAIL (partial) | Untouched by iter 3. Validation guards remain strong, but checksum/provenance *stored with the attempt* and manifest URLs opening *only* through the allowlisted external-navigation channel are still not exercised by any test. |
| 15 | Only named validated commands in IPC/preload; main owns streaming/redaction; renderer-boundary test | ✅ PASS | `calibration.renderer-boundary.test.ts` unchanged and green. |
| 16 | Automated coverage breadth | ❌ FAIL | Materially improved — gap/redaction now real (crit 8), blocked-reason positive tests (partial set), live-region announcement, 412, material all bite. Still missing: reorder / new-job / expired-ack / stale-firmware-config-telemetry / material-mismatch cases; failure/cancel append-only history; notes/photos; the four uncomputed blocked reasons. Coverage tracks the still-failing criteria 7/10/11/13/14. |
| 17 | Existing tests green + all TS/Rust gates pass | ✅ PASS | All gates green this run (see Check F). 1422 JS tests / 62 files. |
| 18 | Committed w/ trailers, one non-draft PR base `development`, body states no live server, not merged | ⏳ PENDING | Mid-loop; no PR yet. Not counted against the Builder now. |

**Tally:** PASS 1,2,3,4,5,6,8,9,12,15,17 · FAIL 7,10,11,13,14,16 · PENDING 18.

Net movement vs iteration 2: **6, 8, 12 moved FAIL→PASS**; 10 improved but still
FAIL (half the enumerated reasons); 7, 11, 13, 14, 16 unchanged FAIL/partial. No
regressions among previously-passing criteria.

---

## Mutation Testing (Check C) — all nine applied, run, reverted

Working tree confirmed clean (`git status` empty) after every revert and before
commit. Baseline: `calibration.workspace.test.tsx` = 39 passed.

| # | Mutation (location) | Expected | Observed | Isolated? |
|---|---------------------|----------|----------|-----------|
| 1 | Remove `useCallback` wrapper on `onGapDetected`, restore inline arrow (`CalibrationQueueDispatchPanel.tsx:319-322`) | Gap test fails → fix is load-bearing | **1 failed:** `gap detection triggers getCalibrationQueueState refetch (criterion 8)` (assert `:1982`); 38 passed | ✅ **Decisive — fix is real, not cosmetic** |
| 2 | Comment out `onGapDetected()` call (`:168`) | Gap-refetch test fails, alone | **1 failed:** same gap test; 38 passed | ✅ |
| 3 | Replace `evt.jobId === jobId` guard with `if (true)` (`:174`) | Only redacted-envelope test fails | **1 failed:** `redacted Printer-group envelope (jobId:null) is NOT applied…` (`:2029`); 38 passed | ✅ |
| 4 | Revert `blockedReason={computedBlockedReason}` → `null` (`CalibrationStepWorkflow.tsx:1231`) | Blocked-reason tests fail (assert presence) | **3 failed:** staleTelemetry / configChange / printerOffline crit-10 tests; 36 passed | ✅ (assert presence, not absence) |
| 5 | Force `staleTelemetry` branch in `computedBlockedReason` → `return null` | Only staleTelemetry test fails | **1 failed:** `staleTelemetry blocked reason renders…` (`:1880`); 38 passed | ✅ (reasons independently asserted) |
| 6 | Null out `material` and `nozzle` in `bedClearDialogJob` | "dialog shows material and nozzle" fails | **1 failed:** `dialog shows material and nozzle from project binding` (`:2396`); 38 passed | ✅ |
| 7 | Freeze countdown (`useCountdown` never sets seconds, `CalibrationBedClearDialog.tsx:161`) | aria-live test fails on `textContent` | **1 failed:** `countdown announces via aria-live…` (`:2378`, `/expires in \d+ second/i`); 38 passed | ✅ (asserts announcement, not existence) |
| 8 | Break 412 refetch — reuse stale ETags (`CalibrationStepWorkflow.tsx:467-478`) | `revisionConflict` test fails | **1 failed:** `revisionConflict (412) closes dialog and updates ETags…` (`:2458`); 38 passed | ✅ |
| 9 | Append-only path drops prior entry (`prev.slice(0,-1)`, `CalibrationStepWorkflow.tsx:505`) | Criterion-13 append-only test fails | **1 failed:** append-only observations test (`:2191`); 38 passed | ✅ |

**Every mutation produced a failure, each isolated to the test(s) it names.** No
mutation produced zero failures (the iteration-2 killer, Mutation 7-of-8, is
resolved). No mutation tripped a neighbouring guard. The tests that exist now
bite for the reasons they name.

The decisive result is **Mutation 1**: with the inline arrow restored the gap
test fails, confirming the Builder's root-cause account — the per-render arrow
identity was restarting the reconciliation effect and cancelling the in-flight
deferred poll. The fix is genuinely load-bearing.

---

## Reimplementation-style tests (Check D)

- The `detectGaps` private reimplementation is **deleted** from
  `calibration.queue-dispatch.test.ts` (−69 lines). The gap and redaction paths
  are now driven through the real `useQueueReconciliation` hook via
  `renderWorkspace`/`openStepView`, with `pollCalibrationQueueChanges` resolved
  to real envelope shapes — not a local copy of the logic.
- Scanned the new `calibration.workspace.test.tsx` blocks (blocked reasons, gap,
  redaction, live region, material, 412). All assert against the rendered DOM or
  real mock-call arguments through the component tree. **No re-derivation of
  production behaviour in a test helper was found.** This class of defect is
  cleared.

---

## Contract fidelity (Check E)

- **Orchestration `Status`/`CurrentStep` free-form:** ✅ unchanged; rendered
  verbatim, never exhaustively switched or blanked.
- **Redacted `Printer-{id}` envelopes never treated as job state:** ✅ now
  **tested** — Mutation 3 proves the `evt.jobId === jobId` guard is load-bearing.
- **ETags echoed byte-identically as opaque base-64:** ✅ the 412 branch passes
  `res.jobRowVersion`/`res.dispatchStateRowVersion` through as strings (Mutation
  8 asserts byte-identical `CONFLICT_JOB==`); no numeric coercion; `ipc.ts` ETags
  remain `z.string()`.

---

## Quality Gates (Check F) — exact goal.md commands

| Gate | Result |
|------|--------|
| `npm run format` (`prettier --check .`) | ✅ all files conform |
| `npm run typecheck` (`tsc --noEmit`) | ✅ exit 0 |
| `npm run lint` (`eslint .`) | ✅ exit 0 |
| `npm run test` | ✅ 1422 passed / 62 files |
| `npm run check:provenance` | ✅ source v1.3.2 (057d6117…), 0 derived files |
| `npm run verify:target-profiles` | ✅ 82 files pinned to 0c2d1783… |
| `cargo fmt --check` | ✅ exit 0 |
| `cargo clippy … --features sqlite -- -D warnings` | ✅ exit 0 (Windows incremental-dir access note only; not a warning) |
| `cargo test` (default) | ✅ exit 0 |
| `cargo test --features sqlite` | ✅ exit 0 |
| `npm run test:e2e` | ⏭️ **NOT RUN** — sidecar binary unavailable in this environment. Not counted as passed; not a Builder failure. |

Gates are uniformly green — but green gates do not satisfy criteria whose
required data is still hardcoded `null` (11), whose enumerated reasons are never
computed (7, 10), or whose behaviour no test drives (13-persistence, 14).

---

## What Must Be Fixed (prioritised, concrete)

The four items iteration 3 targeted are done. What remains is the second half of
iteration 2's fix list, which this round did not attempt.

1. **Criterion 10 — compute the remaining four blocked reasons.** Add branches
   in `computedBlockedReason` (`CalibrationStepWorkflow.tsx:571-618`) for
   `firmwareChange`, `materialMismatch`, `maintenanceBusy`, and
   `permissionFailure` from real signals, and add a positive-assertion test per
   reason (mirroring the staleTelemetry/configChange pattern). Today four of the
   six enumerated codes can never render.

2. **Criterion 7 — extend and test the acknowledgement guards.** `canAcknowledge`
   must also block on **expired** (inspect the propagated expiry, not just show a
   countdown), **unauthorized/permission**, **non-Klipper** (assigned printer no
   longer reports Klipper), and **reordered/replaced/new** (distinct from merely
   `Cancelled`). Add tests for reorder / new-job / expired-ack / non-Klipper that
   fail when each guard is removed.

3. **Criterion 11 — populate the null provenance hashes and block stale context.**
   Wire `machineProfileSha256`, `processProfileSha256`, `filamentProfileSha256`,
   `printerConfigSnapshotSha256`, `requiredFirmwareFamily`, `requiredGcodeDialect`
   (`:385-390`, `:409-410`, `:420-423`) from real orchestration/binding data, and
   implement "stale or changed context blocks replay/start". Add a test that
   fails when a hash is nulled and one that proves replay/start is blocked on a
   changed context.

4. **Criterion 13 — persist observations and cover the rest.** Persist
   observations via IPC (not local state alone); add coverage for notes/photos/
   retest, for failure/cancel preserving prior history and offering a new attempt,
   and for "never complete from queue completion alone".

5. **Criterion 14 — demonstrate storage-with-attempt and allowlisted nav.** Add a
   test that a manifest checksum/provenance is stored with the attempt, and one
   that manifest URLs open only through the allowlisted external-navigation
   channel.

6. **Criterion 16** closes out as 1–5 land — each with a test that fails when the
   behaviour is removed.

---

## Summary

Real, verified progress: criteria **6, 8, 12** moved to PASS, the gap loop is
finally tested through production code, and **all nine mutations bit cleanly** —
including the decisive Mutation 1 confirming the `useCallback` fix is
load-bearing. The chronic "zero-failure mutation" and "reimplementation test"
defects are both resolved. Test discipline this round is exemplary.

It is still a FAIL because the goal is unfinished: criteria **7, 10, 11, 13, 14,
16** remain unmet on concrete evidence — six hardcoded-`null` provenance hashes,
four blocked-reason categories that are never computed, acknowledgement guards
that don't cover expired/unauthorized/non-Klipper/reordered, and observation/
manifest behaviours no test drives. Iteration 3 fixed what it aimed at and left
the rest of iteration 2's fix list untouched. Not ready for the PR.
