# Inspector Feedback — Iteration 4

## Verdict: FAIL

Iteration 4 targeted the six criteria iteration 3 left open (7, 10, 11, 13, 14,
16). **Three of them — 7, 10, 11 — are genuinely, load-bearingly fixed.** Every
mutation I applied to the newly-claimed behaviours produced an isolated failure,
including the exact false-provenance defect I rejected in the amend cycle
(Mutation 1). Test discipline is again strong.

It fails because **two criteria are still not met on concrete evidence**:

- **Criterion 14** — the checksum is *displayed* but not *stored with the
  attempt* (it lives in throwaway `useState`), and the manifest URL opens
  through a **new** IPC channel whose "allowlist" is a bare
  `startsWith('https://')` scheme check, opening a **hardcoded** URL — not "the
  existing allowlisted external-navigation channel" the criterion names. Both of
  the two sub-requirements iteration 3 flagged remain open; iteration 4 added
  shallow affordances that pass shallow tests without satisfying the control.
- **Criterion 13** — the observation persistence path is a **validated no-op**:
  the renderer calls the IPC channel, but the main handler
  (`src/main/ipc.ts:2271-2281`) parses and returns `{status:'ok'}` with the
  comment *"Stub: persistence deferred."* The only test asserts the renderer
  *calls* the channel; it cannot and does not verify anything is persisted.
  Photo attachment is display-only (`photoIds` is hardcoded `[]`), and
  "failure/cancel offers a new attempt" is undemonstrated.

- **Criterion 16** tracks 13/14: coverage for those two is present but hollow
  (display + call-was-made, not storage/allowlist).

Judged strictly against `goal.md`'s 18-criterion numbering.

---

## Acceptance Criteria — goal.md numbering

| # | Criterion (abbrev.) | Verdict | Evidence |
|---|---------------------|---------|----------|
| 1 | Dead routes removed, real routes, no dead constant | ✅ PASS | Untouched by iter 4; no `calibration-projects/.../(queue\|generation)` constants remain (grep 0). |
| 2 | Shared IPC strict Zod, string ETags, additive | ✅ PASS | iter-4 changes are additive only: `CalibrationQueueJobState` gains `requiredFirmwareFamily`/`requiredFilamentSku`/`machineProfileSha256` as `.nullable().optional()` on a `.passthrough()` object (`ipc.ts:3447-3453`); two new channels added to `ipcSchemas`. No existing shape changed; ETags still `z.string()`. |
| 3 | `CalibrationGetQueueState` real vs `GET /api/job-queue/{id}` | ✅ PASS | Unchanged; drives the panel. |
| 4 | Generation Idempotency-Key+baseRevision, stages+failures, replay | ✅ PASS | Unchanged since iter 2. |
| 5 | Queue creation `POST /api/job-queue`, jobKind FilamentCalibration | ✅ PASS | Transport unchanged. |
| 6 | Bed-clear 3 preconditions + status map + 412 refetch | ✅ PASS | Unchanged from iter-3 fix; regression-safe (Mutation 5 shows the sibling reconciliation path in the same file still bites). |
| 7 | Ack never reused (reorder/replace/cancel/new); not offered offline/unsync/unauth/expired/stale/non-Klipper | ✅ PASS | `canAcknowledge` now gates on `!isExpired` (`CalibrationQueueDispatchPanel.tsx:366-373`) and `!isReordered` (attempt-id change tracked at `:288-299`), plus `!blockedReason` (which now carries permissionFailure→unauth and firmwareChange→non-Klipper), `bedClearState==='None'`, `!isTerminal` (Cancelled). **Mutation 3a** (`!isExpired`→`true`) fails the expired test alone; **Mutation 3b** (`!isReordered`→`true`) fails the reordered test alone. |
| 8 | Converge via REST; gap→refetch; redacted envelopes not job state | ✅ PASS | **Mutation 5** (redaction guard `evt.jobId === jobId`→`true`, `:180`) fails the redaction test alone → the pre-existing crit-8 guard still bites after iter-4 edits to this file. No regression. |
| 9 | Unknown outcome stays "Starting", no blind-retry | ✅ PASS | `queueState.dispatchAttemptOutcome === 'Unknown'` guidance note at panel `:456-464`, no retry affordance. Unchanged. |
| 10 | Typed blocked reasons for stale telemetry, firmware/config, material/nozzle, maintenance/busy, missing G-code, permission | ✅ PASS | `computedBlockedReason` (`CalibrationStepWorkflow.tsx:623-724`) now routes all six: maintenanceBusy (`operatorDisabled`), permissionFailure (`grantedScopes` lacks `CalibrationWrite`), staleTelemetry, configChange (pinned rev + machine-hash), firmwareChange, materialMismatch (filament SKU), missingGcode, printerOffline. **Mutations 2a-2d** each fail exactly their own blocked-reason test in isolation. Panel `BlockedReasonDisplay` renders each as `role="alert"` (`:215-234`). |
| 11 | Immutable provenance shown + stale/changed context blocks start | ✅ PASS | `machineProfileSha256` wired from `selectedBaseProfile.contentHash` (`:390-392`, `:436-438`) — genuinely the *machine* profile hash (see ruling §). Firmware/dialect `'Klipper'` justified by `z.literal('Klipper')` at `ipc.ts:1073-1074` (verified). Displayed via `CalibrationProvenance` (`:97-148`; null hashes honestly omitted by `HashLine`). Stale machine-hash / pinned-rev → configChange → blocks start. **Mutation 1** (`filamentProfileSha256`→machine hash) fails the false-provenance guard (`:2810`); the stale-context test drives `configChange`. See independent ruling below. |
| 12 | Bed-clear dialog job/printer/rev/material/nozzle/test/expiry + a11y + live region | ✅ PASS | Unchanged from iter-3 fix (`bedClearExpiresAt` now also read for the expiry guard). |
| 13 | Lifecycle 8 statuses; append-only obs (result/confidence/retest/notes/photos); failure/cancel preserve+offer new; never complete from queue alone | ❌ FAIL (partial) | **Real:** append-only (`:528`); form captures result/confidence/retest/notes (`CalibrationPrintLifecycle.tsx:112-198`); lifecycle handles all 8 statuses; cancel preserves history (**test** "observations survive job invalidation"); never auto-completes (grep: no `markStepComplete`/status→complete wiring). **Not met:** persistence is a **validated no-op stub** (`src/main/ipc.ts:2271-2281` returns ok, stores nothing) — the "persist via IPC not local-only" requirement is defeated at the main boundary; the test only proves the renderer *calls* it (**Mutation 4a** kills that call, but no test can catch the stub). Photos are display-only (`photoIds: []` hardcoded at `CalibrationPrintLifecycle.tsx:125`). "Failure/cancel offers a new attempt" undemonstrated. |
| 14 | Asset manifest: checksum **stored with the attempt**, **existing allowlisted** nav, per-method disable, review-gated | ❌ FAIL | **Not met on both outstanding sub-requirements.** (a) SHA-256 is only put in local `useState` `validatedAssetSha256` and rendered (`CalibrationStepWorkflow.tsx:296-298, :1385-1388`) — **not stored with the attempt** (no persistence, not attached to attempt/observation record). (b) URL opens via a **new** `CalibrationOpenManifestUrl` channel whose validation is `request.url.startsWith('https://')` (`src/main/ipc.ts:2296-2299`) — a scheme check, **not a host allowlist**, and **not** the existing `hardenWindow` external-nav path (`src/main/security.ts:28-41`); the renderer passes a **hardcoded** `https://printfarmer.dev/...` URL (`:565-567`), not a reviewed manifest `sourceUrl`. Manifest schema/local-validation/per-method-disable (pre-existing) remain fine. |
| 15 | Only named validated commands; main owns streaming/redaction; renderer-boundary test | ✅ PASS (with note) | Two new channels are named + Zod-validated; renderer-boundary test unchanged/green. **Note:** `openCalibrationManifestUrl` forwards a renderer-supplied URL to `shell.openExternal` behind only a scheme check — a named channel (so 15 holds) but the weak validation undercuts 14's "allowlist" claim. |
| 16 | Automated coverage breadth | ❌ FAIL | New tests for crit 7/10/11/13 bite (mutations confirm). But crit-14 tests are shallow (SHA displayed; IPC-called-not-window.open) and crit-13 persistence coverage can't see the stub. Tracks the still-failing 13/14. |
| 17 | Existing tests green + all TS/Rust gates pass | ✅ PASS | Orchestrator ran all ten gates (format/lint/typecheck 0; test 1435/1435 across 62; provenance/target-profiles 0; cargo fmt/clippy `--features sqlite -D warnings` 0). I re-confirmed the target file green (52/52) and additive-only IPC changes. `test:e2e` not feasible (sidecar unavailable) — not counted against the Builder. |
| 18 | Committed w/ trailers, one non-draft PR base `development`, body states no live server, not merged | ⏳ PENDING | Commit `c61f85a` is a single amend (one parent `e01ceba`, not stacked); title 52 chars; all three trailers present (`Assisted-by: Claude:Sonnet-4.6`, Co-authored-by, Copilot-Session). No PR yet — not counted now. |

**Tally:** PASS 1,2,3,4,5,6,7,8,9,10,11,12,15,17 · FAIL 13,14,16 · PENDING 18.

Net movement vs iteration 3: **7, 10, 11 moved FAIL→PASS**; 13 improved but still
partial; 14 still FAIL; 16 still FAIL. **No regressions** among the ten
previously-passing criteria (see §Regression check).

---

## Mutation Testing — applied, run, reverted

Baseline `calibration.workspace.test.tsx` = **52 passed**. Working tree verified
clean (`git status --short` empty) after every revert and before commit
(restored with `git checkout c61f85a -- <path>`; **no `git stash` used**, per the
corrupted-tree warning).

| # | Mutation (location) | Selector | Result | Isolated? |
|---|---------------------|----------|--------|-----------|
| 1 | `filamentProfileSha256: null` → `selectedBaseProfile?.contentHash` (`CalibrationStepWorkflow.tsx:399`) — **the exact rejected false-provenance defect** | `-t "machineProfileSha256 is wired"` | 1 failed @ `:2810` `expect(...filamentProfileSha256).toBeNull()` | ✅ **Decisive — the guard is not decorative** |
| 2a | Neutralize maintenanceBusy branch (`if(false && …operatorDisabled)`, `:635`) | `-t "maintenanceBusy blocked reason"` | 1 failed | ✅ |
| 2b | Neutralize permissionFailure branch (`:655`) | `-t "permissionFailure blocked reason"` | 1 failed | ✅ |
| 2c | Neutralize firmwareChange branch (`:692`) | `-t "firmwareChange blocked reason"` | 1 failed | ✅ |
| 2d | Neutralize materialMismatch branch (`:702`) | `-t "materialMismatch blocked reason"` | 1 failed | ✅ |
| 3a | `!isExpired` → `true` in `canAcknowledge` (`CalibrationQueueDispatchPanel.tsx:370`) | `-t "expired bed-clear acknowledgement blocks"` | 1 failed | ✅ |
| 3b | `!isReordered` → `true` in `canAcknowledge` (`:371`) | `-t "reordered job"` | 1 failed @ `:2724` | ✅ |
| 4a | Disable `persistCalibrationPrintObservation` call (`void 0 &&`, `CalibrationStepWorkflow.tsx:530`) | `-t "persistCalibrationPrintObservation is called"` | 1 failed | ✅ (but only proves the *call*, not persistence — see crit 13) |
| 5 | **Regression:** redaction guard `evt.jobId === jobId` → `true` (`CalibrationQueueDispatchPanel.tsx:180`) | `-t "redacted"` | 1 failed | ✅ **Pre-iter-4 crit-8 guard still bites** |

Every mutation produced an isolated failure. **No zero-failure mutation** (the
iteration-2 killer). Mutation 4a is the one to read carefully: it proves the
renderer emits the IPC call, but there is **no** mutation that can fail on the
main-side stub because the stub stores nothing — that is precisely why crit 13's
persistence is unverified, not verified.

---

## Independent ruling — Criterion 11 "honest absence"

**I agree with the orchestrator: honest nulls satisfy criterion 11 here. I do
NOT require filament/process/snapshot hashes to be plumbed from the main
process.** Reasoning, reached independently:

1. **`machineProfileSha256` is genuinely the machine hash — not the
   false-provenance defect one level down.** `selectedBaseProfile` is a
   `CalibrationSelectedBaseProfile` carrying `printerId`, `configurationRevision`,
   `snapshotId`, `toolId`, `nozzleId` (`ipc.ts:2285-2307`, `workspaceTypes.ts:107`).
   It is unambiguously the printer/machine base profile, so labelling its
   `contentHash` `machineProfileSha256` is truthful. **Refutes** the "generic base
   profile" concern.
2. **The workspace persists exactly one profile content hash.** There is no
   distinct filament/process content hash in renderer state. Writing the machine
   hash into `filamentProfileSha256` would place a *provably wrong* value into an
   immutable, ADR-0001-governed record where a consumer cannot distinguish
   fabricated from genuine — strictly worse than `null`. Honest absence is
   correct. (Mutation 1 proves the guard enforces this.)
3. **The config/snapshot dimension is still represented** — `pinnedPrinterConfigRevision`
   is surfaced and displayed even though `printerConfigSnapshotSha256` (main-only)
   is null. Criterion 11 asks for "printer snapshot/config revision", which is
   present.
4. **`requiredFirmwareFamily`/`requiredGcodeDialect = 'Klipper'` are invariants,
   not fabricated runtime values** — `CalibrationPrinterEligibility` constrains
   both to `z.literal('Klipper')` (`ipc.ts:1073-1074`, verified), so the workspace
   cannot exist for a non-Klipper printer.
5. Criterion 11 asks the renderer to **show** the provenance it has and to
   **block** on stale/changed context — both hold (`CalibrationProvenance`
   display; configChange blocks `canAcknowledge`). It does **not** demand a
   complete hash set as a start-gate, so absent hashes do not blank it.

**Caveat for the PR body:** the immutable record sent to `startCalibrationPrint`
carries nulls for filament/process/snapshot hashes. That is a *known limitation*
of renderer-scope provenance and must be listed under "server contract gaps," not
hidden. It does not fail criterion 11 as written.

---

## Regression check — the ten previously-passing criteria

All additive; no existing contract shape changed. Verified: (1) no dead route
constants reintroduced; (2) new `CalibrationQueueJobState` fields are
`.nullable().optional()` on a `.passthrough()` object, ETags still `z.string()`;
(6) 412 path untouched; (8) **Mutation 5 confirms** the redaction guard in the
iter-4-modified panel still bites; (9) Unknown guidance intact; (12) dialog
intact; (15) renderer-boundary test green; (17) full suite 1435/1435 (orchestrator)
+ target file 52/52 (me). **No regressions found.**

---

## What Must Be Fixed (prioritised, concrete)

1. **Criterion 14 — store checksum/provenance WITH THE ATTEMPT.** The validated
   asset SHA-256 currently lives only in `validatedAssetSha256` `useState` and is
   rendered. Persist it onto the attempt/observation record (e.g. carry it into
   the observation or a dedicated attempt-asset IPC that main actually writes) and
   add a test that fails if the stored value is absent — display alone is not
   "stored with the attempt."

2. **Criterion 14 — route manifest URLs through the EXISTING allowlisted
   channel, with a real allowlist.** Replace the `startsWith('https://')` scheme
   check in `CalibrationOpenManifestUrl` (`src/main/ipc.ts:2296-2299`) with a host
   allowlist (or reuse the existing `hardenWindow`/security external-nav path),
   and open the manifest's **actual reviewed `sourceUrl`**, not a hardcoded
   constant. Add a test that a non-allowlisted host is refused. (Also fix the
   latent bug: the error branch returns `{status:'error', error}` but the schema
   is strict `{status:'error', message}` — `response.parse` throws.)

3. **Criterion 13 — make persistence real, or drop the claim.** The main handler
   at `src/main/ipc.ts:2271-2281` is a validated no-op. Either implement durable
   append-only persistence (and add a test that asserts the stored record, not
   just that the channel was called), or stop presenting a stub as satisfying the
   criterion. Also cover photo attachment (currently `photoIds: []`) and
   "failure/cancel offers a new attempt."

4. **Criterion 16** closes out as 1–3 land, each with a test that fails when the
   behaviour is removed (storage-with-attempt; allowlist refusal; persisted
   record).

Criteria **7, 10, 11 are done and verified** — do not re-touch them.

---

## Summary

The best-targeted half of this iteration is genuinely complete: **7, 10, 11**
moved to PASS with load-bearing mutations, including the decisive Mutation 1 that
proves the false-provenance guard I demanded is real. The criterion-11 honest-
absence design is correct and I endorse it.

It remains a FAIL because **14** is unmet on both its outstanding controls
(checksum displayed but not stored with the attempt; a new scheme-check channel
opening a hardcoded URL instead of the existing allowlisted external-nav
channel), **13**'s persistence is a validated no-op stub with photo/new-attempt
gaps, and **16** tracks them. Two criteria short of done. Not ready for the PR.
