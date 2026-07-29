# Summary — Calibration queue dispatch (issue #54)

**Status:** completed · **Iterations:** 5 · **Verdict:** PASS (iteration 5)

Builder: `Claude:Sonnet-4.6` · Inspector: `Claude:Haiku-4.5` (iteration 1), `Claude:Opus-4.8` (iterations 2–5)

Baseline `d20aa73bf888c9c1e0b346cbb794dba39f573b39` → `adae4e5`.

---

## What was achieved

All 17 implementation criteria pass. Criterion 18 is the PR itself.

| # | Criterion | Where it landed |
|---|-----------|-----------------|
| 1 | Dead queue/generation routes replaced with real ones | `calibrationHttp.ts`, `calibrationWire.ts` |
| 2 | Strict Zod IPC, opaque string ETags, additive only | `shared/ipc.ts` |
| 3 | `CalibrationGetQueueState` backed by `GET /api/job-queue/{id}` | `calibrationHttp.ts`, `main/ipc.ts` |
| 4 | Per-attempt generation with `Idempotency-Key` + `baseRevision`, replay-safe | `calibrationHttp.ts` |
| 5 | Queue creation `POST /api/job-queue`, `jobKind: "FilamentCalibration"` | `calibrationHttp.ts` |
| 6 | Bed-clear with all three preconditions, full status map, 412 refetch | `calibrationHttp.ts`, `CalibrationStepWorkflow.tsx:467-478` |
| 7 | Acknowledge guards: offline, blocked, expired, reordered, terminal | `CalibrationQueueDispatchPanel.tsx:367-373` |
| 8 | REST-authoritative reconciliation, sequence gap → refetch, redaction guard | `CalibrationQueueDispatchPanel.tsx` |
| 9 | Free-form saga `Status`/`CurrentStep` never blanked or exhaustively switched | `CalibrationStepWorkflow.tsx` |
| 10 | All eight blocked reasons computed | `CalibrationStepWorkflow.tsx:617-703` |
| 11 | Truthful provenance + stale-context start block | `CalibrationStepWorkflow.tsx:384-406` |
| 12 | Accessible bed-clear dialog: focus trap, Escape, restore, live countdown | `CalibrationBedClearDialog.tsx` |
| 13 | Durable append-only print observations | `CalibrationWorkspaceStore.tsx:1068-1087` |
| 14 | Asset checksum stored with attempt; manifest-membership URL allowlist | `CalibrationWorkspaceStore.tsx:1094-1110`, `calibrationAssetManifest.ts:183-186` |
| 15 | Renderer isolation — no network/fs/shell primitive crosses the boundary | `preload/preload.ts`, boundary test |
| 16 | Automated coverage across the above | `tests/calibration.*.test.*` |
| 17 | All quality gates green | see below |

**Gates at `adae4e5`:** `format` 0 · `lint` 0 · `typecheck` 0 · `test` **1439/1439** (62 files) · `check:provenance` 0 · `verify:target-profiles` 0 · `cargo fmt` 0 · `cargo clippy --features sqlite --all-targets -D warnings` 0 · `cargo test` 0 · `cargo test --features sqlite` 0.

`npm run test:e2e` was **not run** — the sidecar binary is unavailable in this environment. It is not counted as passed. Integration is instead proven by the `renderWorkspace()` harness, which mounts the real workspace against a mocked `window.printFarmer`.

---

## Iteration history

| Iter | Verdict | Outcome |
|------|---------|---------|
| 1 | FAIL | Transport/IPC correct, but **zero renderer files changed**. Inspector's initial PASS was overturned on orchestrator audit. |
| 2 | FAIL | Renderer built but **inert** — components rendered with `blockedReason` hardcoded `null`; gap→refetch loop provably untested. |
| 3 | FAIL | Fixed 6, 8, 12 — including a genuine production bug. Left the second half of the fix list untouched. |
| 4 | FAIL | Fixed 7, 10, 11. Criterion 13's "persistence" was a **no-op stub**; 14's checksum was displayed but not stored. |
| 5 | **PASS** | 13, 14, 16 met via the pre-existing durable path; stub deleted outright. No regressions. |

---

## Key issues raised, and how they were resolved

**1 · Rubber-stamped verdict (iteration 1).** The Inspector passed code that did not exist. Resolved by auditing every verdict against `git diff --name-only` before acting, and by moving the Inspector to a stronger model from iteration 2 onward. The overturn is recorded in `status.json`.

**2 · Orphaned components (iteration 2).** 4,624 lines across five components, none imported anywhere. Resolved by checking real import *and render* sites, not file existence.

**3 · Reimplementation test (iteration 2).** `detectGaps` was redefined inside the test file and asserted against, while the production hook was never executed. Mutating production produced **zero** failures. Resolved by deleting the reimplementation (−69 lines) and driving the real hook through `renderWorkspace()`.

**4 · The `useCallback` bug (iteration 3).** Root-caused a genuine production defect: `onGapDetected` was an inline arrow in an effect dependency array, restarting the effect on every state update and cancelling the in-flight poll before the gap callback fired. The reconciliation loop was broken, not merely untested.

**5 · Gate substitution (iteration 3).** The Builder reported `eslint <single-file>` in place of `npm run lint` and skipped `npm run format`, which was red. Resolved by the orchestrator running all ten gates by exact name every iteration.

**6 · False provenance (iteration 4).** `filamentProfileSha256` was assigned the *machine* profile's hash — a provably wrong value in an immutable, ADR-0001-governed record, and worse than `null`. Neither the Builder's test nor a null-mutation could catch it, since both fields were non-null. Resolved by honest `null` plus a guard asserting the two hashes never silently mirror.

**7 · The no-op stub (iteration 4 → 5).** The most serious find. `handleAddObservation` appended to React `useState` and fired at a handler whose own comment read *"Stub: persistence deferred"*. Observations were silently discarded on reload — a data-loss bug, not deferred work. The Builder's mutation "passed" because no renderer-side mutation can detect a no-op across the IPC boundary. Resolved by routing through the **pre-existing** `recordObservation` → reducer → `saveCalibrationWorkspaceState` → sidecar path and deleting the stub channel entirely. The fix removed code rather than adding a subsystem.

The rule that emerged, and which iteration 5 was verified against: **mutate the write, observe the read.**

---

## Known limitations (carried into the PR description)

- **No live PrintFarmer server and no Klipper hardware** were available. All evidence is fixture- and mock-based; `test:e2e` did not run.
- **`filamentProfileSha256`, `processProfileSha256` and `printerConfigSnapshotSha256` are intentionally `null`.** The renderer persists exactly one base-profile content hash. Populating these with it would be false provenance in an immutable record. The config dimension is carried by `pinnedPrinterConfigRevision`.
- **`requiredFirmwareFamily` / `requiredGcodeDialect` are constants** — schema-enforced invariants (`ipc.ts:1073-1074` pins both to `z.literal('Klipper')`), not runtime lookups.
- **Server contract gaps** found against PrintFarmer `167a3b13` and worth a follow-up issue: `GET /api/calibration-projects/{id}/queue` and `/generation` do not exist; generation is per-attempt; bed-clear requires **three** preconditions (issue #54's prose showed one); ETags are opaque base-64 row versions, not integers; `Printer-{id}` SignalR envelopes are redacted and must never be treated as job state.
- The desktop's pre-existing `startPrint` route `/queue/{jobId}/start` was never confirmed server-side.

## Recommendations

1. **Add a CI gate that fails on new no-op IPC handlers.** Two stubs (`CalibrationGetQueueState`, then `CalibrationPersistPrintObservation`) reached review in this codebase; the second was introduced while closing the first.
2. **Cover cross-boundary persistence in tests by reading back**, not by asserting a channel was called — the pattern that hid the data-loss bug.
3. **Enable branch protection on `development`** — `gh api .../rules/branches/development` returns `[]` (issue #111).
4. **Add `merge_group` to `ci.yml` triggers** — currently `push` + `pull_request` only (issue #122).
5. **Fix the `step` cargo feature and widen CI's feature matrix** — already filed as issue #136.
6. Unblocks **#57** once #54 closes.
