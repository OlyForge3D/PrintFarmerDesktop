# Inspector Feedback — Iteration 2

## Verdict: FAIL

The Builder's iteration-2 work provides comprehensive **renderer UI implementation** for generation, queue state, and bed-clear workflows, with 46 focused unit/Vitest/React tests. However, critical user-visible features required by acceptance criteria are **missing or incomplete**:

1. **No asset manifest validation UI** (A-01 through A-08): Users cannot load, display, or validate external calibration asset manifests.
2. **No result entry workflow** (L-03, L-05, L-06, L-07): After print completion, users cannot enter observations, confidence, retest decisions, or photos.
3. **No lifecycle state display in UI** (L-02 through L-07): Terminal-state history is not preserved or displayed.
4. **Incomplete test coverage** (D-07): New tests cover G-03/G-05/G-07/G-09, Q-01/Q-05/Q-06, B-01-B-07, L-01/L-04, S-05, A-03/A-07/A-08, but **miss L-02, L-03, L-05, L-06, A-04, A-05, A-06**.

The work is end-to-end for generation/queue/bed-clear **only**; the full calibration workflow (asset validation, result entry, append-only history) is incomplete.

---

## Detailed Acceptance Criteria Status

### A-01 through A-08: External Calibration Assets and Provenance

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **A-01: Versioned manifest** | ❌ FAIL | Manifest schema exists in IPC (`src/shared/ipc.ts:3436-3453`). No renderer UI loads or displays it. | No asset loader UI exists. |
| **A-02: HTTPS allowlist** | ⚠️ PARTIAL | HTTP client contract supports external URLs via PrintFarmer. No renderer navigates to manifests. | No "Load Manifest" button or workflow. |
| **A-03: Users select local files** | ⚠️ PARTIAL | Schema assumes user-selected files. No UI prompts for selection. | Missing file picker UI. |
| **A-04: Local validation** | ❌ FAIL | HTTP client returns validation errors. Renderer never presents them to user. | No validation error display. |
| **A-05: Provenance displayed** | ❌ FAIL | Schema captures provenance. Zero renderer code displays it. | No provenance panel. |
| **A-06: Disabled methods with reason** | ⚠️ PARTIAL | IPC schema supports reason codes. Renderer never shows disabled methods or reasons. | No method availability UI. |
| **A-07: `npm run check:provenance`** | ✅ PASS | Runs clean: `Calibration provenance check passed: 0 derived file(s)`. | — |
| **A-08: Unit tests** | ⚠️ PARTIAL | Tests cover manifest structure and HTTP errors (1382 existing tests). New tests mention A-03/A-07/A-08 but do not verify A-04/A-05/A-06 (local validation flow, provenance display, or method disabling). | Missing UI assertion tests for validation/provenance/disabled methods. |

**Gap:** Users have zero way to load, validate, or see provenance for calibration assets.

---

### G-01 through G-09: Typed Durable Backend Generation Operation

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **G-01: PR #979 API contract** | ✅ PASS | HTTP client correctly maps to endpoints: `/api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job`. Headers, body, and responses verified against PR #979 structure. Routes are fixed constants in `calibrationHttp.ts:55-87`. | — |
| **G-02: Revalidate context before submit** | ⚠️ PARTIAL | HTTP client accepts baseRevision parameter (triggers 412 on mismatch). Renderer must call `refreshProjectContext()` before submission—NOT enforced. Tests do not verify pre-submission context fetch. | No mandatory context refresh before generation start. |
| **G-03: Preview before POST** | ✅ PASS | CalibrationGenerationPanel displays method, stage, and specification before button click. Test: `'shows generation panel with method preview when gate passes'` (line 414). | — |
| **G-04: Stable operation ID** | ✅ PASS | Renderer generates UUID via `environment.createId()` (deterministic in tests). IPC request includes `operationId`. HTTP `Idempotency-Key: <operationId>` header sent per line 632 of `calibrationHttp.ts`. | — |
| **G-05: All seven stages displayed** | ✅ PASS | CalibrationGenerationPanel renders all stages in order: ModelAccepted, SlicingQueued, SlicingClaimed, SlicingProgress, ArtifactValidated, Promoted, QueueJobCreated. Test: `'shows all seven durable stages in the panel'` (line 434). | — |
| **G-06: REST reconciliation after restart** | ✅ PASS | `pollOrchestrationStatus()` calls `getCalibrationOrchestrationStatus()` which fetches `GET /api/calibration-orchestrations/{id}`. Test: `'poll button calls getCalibrationOrchestrationStatus (G-06)'` (line 533). | — |
| **G-07: Display hashes and versions** | ✅ PASS | CalibrationGenerationPanel shows spec/plan/gcode hashes, generator version, slicer digest. Test: `'shows provenance hashes when present in orchestration (G-07)'` (line 460). | — |
| **G-08: Never re-upload G-code** | ✅ PASS | HTTP client only receives `GcodeFile` reference; never downloads or re-emits raw G-code. | — |
| **G-09: Structured failures** | ✅ PASS | CalibrationGenerationPanel maps `orchestration.problems[].code` (e.g., `CONTEXT_STALE`) to user-visible text. Test: `'maps structured failure problems to typed codes'` (line 502). | — |

**Gap:** G-02 context validation is NOT enforced by UI before submission. Tests mock successful submission without verifying pre-submission context fetch.

---

### Q-01 through Q-06: REST-Authoritative Queue and Dispatch State

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **Q-01: All queue state from REST** | ✅ PASS | CalibrationQueuePanel displays job ID, status, printer, nozzle, material, position, priority from `CalibrationQueueJobState` DTO. Tests verify each field individually (lines 594-635). | — |
| **Q-02: Direct use of PrintJob** | ✅ PASS | Store `refreshQueueState()` directly uses HTTP response DTO; no alternative job creation path. | — |
| **Q-03: Idempotent replays** | ✅ PASS | Same operationId → same job returned from REST. No duplicate display. (Tested via HTTP client unit tests in iteration 1). | — |
| **Q-04: Reconnect refetch** | ✅ PASS | `refreshQueueState()` is synchronous REST fetch. Renderer calls it on dialog open or after stale revision. | — |
| **Q-05: Typed blocked reasons** | ✅ PASS | `blockedReasonLabel()` function maps 12 codes: `staleTelemetry`, `changedFirmwareOrConfig`, `materialNozzleMismatch`, etc. Test: verified (implicit in Q-01 tests). | — |
| **Q-06: REST is authoritative** | ✅ PASS | `refreshQueueState()` always calls `getCalibrationQueueState()` (IPC → main → HTTP). SignalR is not referenced in store. Test: `'refreshQueueState calls IPC (REST), not SignalR'` (line 1047). | — |

**Status:** ✅ PASS — Queue state is fully REST-authoritative in new UI.

---

### B-01 through B-07: Exact-Job Bed-Clear Acknowledgement

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **B-01: Dialog displays exact fields** | ✅ PASS | BedClearDialog shows: job ID, G-code file, assigned printer (name + ID), queue revision ETag, dispatch state revision, required nozzle, required material, bed-clear expiry, pinned config revision. Tests verify each field (lines 688-723). | — |
| **B-02: Single endpoint, exact headers** | ✅ PASS | Renderer calls `store.acknowledgeBedClear()` → IPC `acknowledgeCalibrationBedClear` → HTTP POST `/api/job-queue/{jobId}/acknowledge-bed-clear-and-start`. Headers: `Idempotency-Key`, `If-Match` (jobEtag), `X-Dispatch-State-If-Match` (dispatchStateEtag), body: `{ printerId }`. Verified in `calibrationHttp.ts:788-801` and test line 729. | — |
| **B-03: All five status codes** | ✅ PASS | HTTP outcomes: 202→starting, 200→alreadyStarting, 409→conflict (with reason+detail), 412→staleRevision, 503→printerOffline (with detail), 428→preconditionRequired. Tests verify each (lines 775-878). | — |
| **B-04: Starting state, no blind retry** | ✅ PASS | After 202/200, dialog closes. Job is updated to `Starting` state. No automatic retry or polling. Test: `'shows no-retry notice for Starting status'` (line 895). | — |
| **B-05: Fresh UUID per dialog** | ✅ PASS | `openBedClearDialog()` calls `environment.createId()` to generate operationId. Each dialog invocation generates unique ID. Test: `'uses different operationId for each dialog invocation'` (line 914). | — |
| **B-06: Withheld when unsafe** | ⚠️ PARTIAL | Dialog opens only when `awaitsBedClear` (job is Assigned + has expiry + printer assigned). Code checks `bedClearDialog.acknowledging`, `isExpired`, `job===null`. Renderer does NOT verify printer reports Klipper. | No Klipper capability check in renderer before opening dialog. |
| **B-07: Test coverage** | ✅ PASS | All outcomes, header values, replay behavior, expiry, offline, and focus restoration tested (46 new tests). | — |

**Gap:** B-06 does not verify the assigned printer explicitly reports Klipper firmware before allowing acknowledgement.

---

### L-01 through L-07: Print Lifecycle and Result Entry

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **L-01: All eight states from REST** | ✅ PASS | CalibrationQueuePanel displays `jobStatus` from REST: Queued, Assigned, Starting, Printing, Paused, Completed, Failed, Cancelled. Test: `'displays [state] lifecycle state from REST'` (line 995, parametrized). | — |
| **L-02: Immutable links** | ❌ FAIL | Schema defines immutable IDs (attemptId, operationId, orchest rationId, gcodeFileId). NO renderer UI verifies or displays these links. No "View Attempt History" or "Show Linked Artifacts" functionality. | No UI to display/verify immutable attempt→orchestration→artifact→job links. |
| **L-03: Result entry guidance** | ❌ FAIL | IPC schema supports CalibrationResult with result, confidence, retestDecision, notes, photos. ZERO renderer code implements result entry UI after print completion. | Missing result entry form/workflow. |
| **L-04: Terminal history preservation** | ✅ PASS | When job reaches Completed/Failed/Cancelled, UI shows terminal notice without mutating display history. Test: `'shows terminal notice for [status] without mutating history'` (line 1023). | — |
| **L-05: Queue completion ≠ step complete** | ❌ FAIL | No verification that queue completion alone does not mark the calibration step complete. Method's result/verification contract is not enforced in renderer. | No UI enforces "result entry required before marking step done." |
| **L-06: Typed blockers** | ⚠️ PARTIAL | IPC enum and `blockedReasonLabel()` support all typed codes. Renderer never displays blockers for lifecycle transitions (only for queue state). | Blockers are shown in queue panel but not checked before allowing print start. |
| **L-07: Test coverage** | ⚠️ PARTIAL | Tests cover L-01 and L-04. Missing: L-02 (link immutability), L-03 (result entry workflow), L-05 (step-complete gate), L-06 (transition blockers). | 4 of 7 lifecycle criteria lack UI tests. |

**Gap:** Result entry workflow (L-03, L-05), immutable link display (L-02), and blocker enforcement (L-06) are not implemented in the renderer.

---

### S-01 through S-05: IPC and Security Boundary

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **S-01: Only named, validated channels** | ✅ PASS | New IPC channels added to `src/shared/ipc.ts`: `CalibrationStartGeneration`, `CalibrationGetOrchestrationStatus`, `CalibrationGetQueueState`, `CalibrationAcknowledgeBedClear`. All have Zod schemas. Preload bridges all with schema.parse() validation. | — |
| **S-02: Main owns authenticated I/O** | ✅ PASS | Renderer never calls PrintFarmer directly. Main process owns `CalibrationHttpClient` (authentication, retries, error mapping, header construction, body limits). | — |
| **S-03: Secrets/paths redacted** | ✅ PASS | HTTP client never logs JWTs. Error responses strip credentials. Renderer only receives typed error codes and operator-facing detail messages, no raw backend payloads or local paths. | — |
| **S-04: No generic primitives** | ✅ PASS | Renderer has zero access to network (fetch/XMLHttpRequest), filesystem (readFile/writeFile), shell (child_process), printer (direct serial), or G-code generation. All via named IPC channels only. | — |
| **S-05: Renderer-boundary tests** | ✅ PASS | 46 new tests verify: renderer calls IPC channels with exact payloads, responses are typed, no raw network primitives exist. | — |

**Status:** ✅ PASS — IPC boundary is secure and properly enforced.

---

### D-01 through D-08: Domain Reuse and Quality Gates

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **D-01: Existing domain reused** | ✅ PASS | No new domain models added. Existing CalibrationProject, CalibrationAttempt, CalibrationStep structures reused. | — |
| **D-02: No duplication** | ✅ PASS | No duplicate state models, local printer DB, or arbitrary G-code flow. All via PrintFarmer HTTP. | — |
| **D-03: `npm run typecheck`** | ✅ PASS | Runs clean: `tsc --noEmit` (no output, exit code 0). | — |
| **D-04: `npm run lint`** | ✅ PASS | Runs clean: `eslint .` (no output, exit code 0). | — |
| **D-05: `npm run format`** | ✅ PASS | Runs clean: `prettier --check .` (all files use Prettier style). | — |
| **D-06: `npm run test`** | ✅ PASS | **1428 tests pass** (1382 existing + 46 new). No tests skipped, weakened, or deleted. | — |
| **D-07: Playwright UI tests** | ⚠️ PARTIAL | New tests are Vitest/React/jsdom (unit/component tests), NOT Playwright. Per D-07: "When Playwright UI paths are covered, relevant Playwright tests pass clean." New UI is covered but no Playwright e2e tests exist. | No Playwright e2e tests for generation/queue/bed-clear workflows. |
| **D-08: Native cargo checks** | ✅ PASS | No native/ files modified. Cargo checks not run (N/A). | — |

**Gap:** D-07 requires Playwright tests when UI paths are covered; only Vitest/React jsdom tests exist.

---

### P-01 through P-05: Delivery and Reporting

| Criterion | Status | Evidence | Gap |
|-----------|--------|----------|-----|
| **P-01 through P-05** | ⊘ DEFERRED | After Inspector PASS verdict, Builder will push branch and open PR targeting `development`. Currently deferred pending this verdict. | PR not yet opened; deferred until verdict. |

---

## Quality Gate Summary

| Gate | Status | Output |
|------|--------|--------|
| `npm run check:provenance` | ✅ PASS | `Calibration provenance check passed: 0 derived file(s), source v1.3.2…` |
| `npm run typecheck` | ✅ PASS | `tsc --noEmit` (no errors) |
| `npm run lint` | ✅ PASS | `eslint .` (no errors) |
| `npm run format` | ✅ PASS | `prettier --check .` (all matched files use Prettier code style) |
| `npm run test` | ✅ PASS | **1428 tests passed** (1382 existing + 46 new). Duration: 28.65s |
| **Playwright e2e tests** | ⚠️ MISSING | No Playwright tests for new UI workflows (D-07 violation). |

---

## Critical Gaps Summary

### Tier 1: User-Visible Workflow Missing

1. **Asset Manifest Loading & Validation** (A-01 through A-08)
   - Users cannot load external calibration asset manifests.
   - No file picker, manifest display, or validation error presentation.
   - All asset-related acceptance criteria are unmet in the UI.
   - **Impact:** Users cannot validate or provision calibration methods.

2. **Result Entry Workflow** (L-03, L-05, L-06, L-07)
   - After print completes, users are not guided to enter observations, confidence, retest decisions, notes, or photos.
   - No result form or workflow exists.
   - Append-only history is not enforced or displayed.
   - **Impact:** Users cannot record calibration results or mark steps complete.

3. **Immutable Attempt/Artifact Linking** (L-02)
   - Links between attempt, generation, orchestration, and print job are not displayed.
   - No verification that links remain immutable after creation.
   - **Impact:** No audit trail or traceability for calibration work.

### Tier 2: Incomplete UI Enforcement

4. **Pre-Submission Context Validation** (G-02)
   - UI does not enforce mandatory context refresh before generation submission.
   - Users could submit with stale printer/config/material context.
   - **Impact:** Silently accepted generation requests may fail at server (backward compatible but poor UX).

5. **Printer Klipper Verification** (B-06)
   - Bed-clear dialog does not verify assigned printer explicitly reports Klipper firmware.
   - Dialog could be opened for incompatible printers.
   - **Impact:** Bed-clear could be sent to non-Klipper printer.

6. **Result Entry Gate** (L-05)
   - No UI prevents marking calibration step complete without entering result.
   - Queue completion alone is accepted as step completion.
   - **Impact:** Calibration steps marked done without result entry.

### Tier 3: Test Coverage Gaps

7. **Missing Playwright e2e Tests** (D-07)
   - Criterion: "When Playwright UI paths are covered, relevant Playwright tests pass clean."
   - New UI paths: generation panel, queue panel, bed-clear dialog, lifecycle display.
   - Tests implemented: Vitest/React/jsdom components only.
   - **Impact:** E2E browser rendering, focus management, and keyboard navigation not verified.

8. **Incomplete Criterion Coverage** (D-07)
   - New tests mention A-03/A-07/A-08 but do NOT test A-04/A-05/A-06 (validation/provenance/disabled methods).
   - Tests do NOT cover L-02 (link immutability), L-03 (result entry), L-05 (step-complete gate), L-06 (blocker enforcement).
   - **Impact:** 4 lifecycle criteria and 3 asset criteria lack UI test assertions.

---

## What Must Be Fixed for Iteration 3

### Must Implement (Blocking)

1. **Asset Manifest Loading & Validation UI** (A-01 through A-08)
   - Create `src/renderer/calibration/CalibrationAssetLoaderPanel.tsx`
   - Allow users to load manifest from HTTPS via PrintFarmer allowlist
   - Display manifest metadata: source URL, author, license, checksum
   - Show available methods with availability status (enabled/disabled reason)
   - Implement local validation: extension, magic/container, size, geometry, method-specific bounds
   - Display validation failures with concrete, actionable reasons
   - Store provenance immutably with attempt record

2. **Result Entry Workflow** (L-03, L-05)
   - Create `src/renderer/calibration/CalibrationResultEntryPanel.tsx`
   - Guide user through: selected result (pass/fail/inconclusive), confidence (1-5), retest decision (YES/NO/PENDING), notes, photos
   - Link all observations immutably to the attempt
   - Enforce result entry before marking step complete
   - Append-only history of result entries

3. **Immutable Attempt/Artifact Linking** (L-02)
   - Display links in UI: attempt → orchestration → artifacts → print job
   - Verify links are never mutated after creation (unit test)
   - Provide audit trail showing exact linkage for traceability

4. **Lifecycle State Display & Terminal History** (L-01 through L-07)
   - Integrate lifecycle display with result entry
   - Show terminal-state notice (Completed/Failed/Cancelled) without clearing history
   - Preserve all prior state transitions in history
   - Prevent step completion until result is entered

5. **Playwright e2e Tests** (D-07)
   - `tests/calibration.e2e.test.ts`: Test generation → queue → bed-clear → result entry full workflow
   - Verify focus management, keyboard navigation, and accessibility
   - Test all UI paths covered by new components

### Should Fix (Strongly Recommended)

6. **Pre-Submission Context Refresh** (G-02)
   - Enforce `refreshProjectContext()` call before `startGeneration()` in UI
   - Display current context (printer, nozzle, material, Orca version) before generation start
   - Block generation if context is stale

7. **Printer Klipper Capability Check** (B-06)
   - Query printer object in job for `capabilities` or `firmwareType` field
   - Verify "Klipper" is reported before enabling bed-clear dialog
   - Block dialog with reason if printer does not report Klipper

---

## Files Requiring Changes

**New files to create:**
- `src/renderer/calibration/CalibrationAssetLoaderPanel.tsx` (asset manifest loading and validation)
- `src/renderer/calibration/CalibrationResultEntryPanel.tsx` (result entry after print completion)
- `tests/calibration.e2e.test.ts` (Playwright e2e tests for full workflows)

**Existing files to update:**
- `src/renderer/calibration/CalibrationStepWorkflow.tsx` (integrate asset loader and result entry panels)
- `src/renderer/calibration/CalibrationQueuePanel.tsx` (add Klipper check before bed-clear dialog; integrate result entry)
- `src/renderer/calibration/CalibrationGenerationPanel.tsx` (enforce context refresh before generation start; display current context)
- `tests/calibration.generation-ui.test.tsx` (add tests for A-04/A-05/A-06, L-02/L-03/L-05/L-06)

---

## Confidence Assessment

| Aspect | Verdict | Notes |
|--------|---------|-------|
| **Generation → Queue → Bed-Clear End-to-End** | 95% | Core workflows fully implemented and tested. Only minor UX gaps (pre-submission context, Klipper check). |
| **UI Rendering & Accessibility** | 90% | Proper focus trap, aria attributes, live regions. Missing: Playwright e2e for browser-native behavior. |
| **IPC & Security Boundary** | 100% | Main-owned authenticated I/O, Zod-validated schemas, no generic primitives, error redaction all correct. |
| **HTTP Contract Compliance** | 100% | Exact headers, all 5 status codes handled, typed outcomes, immutable operation IDs. |
| **User-Visible Completeness** | 40% | Generation/queue/bed-clear workflows visible. Asset validation (A-01-A-08), result entry (L-03/L-05), and history (L-02/L-04) missing. Less than half the goal is end-to-end. |

---

## Root Cause

The Builder focused iteration 2 on the **most visible user-facing workflows** (generation → queue → bed-clear) and delivered them comprehensively. However, the goal's Refined Goal states:

> "Implement the **full end-to-end flow** for PFD's Printer Calibration workspace"

and scope says:

> "Implementing issue #54 **end-to-end**"

This iteration completes only **3 of 7 major workflows**:
- ✅ Generation with durable stages (G-01 through G-09)
- ✅ Queue state and dispatch (Q-01 through Q-06)
- ✅ Bed-clear acknowledgement (B-01 through B-07)
- ❌ Asset manifest validation (A-01 through A-08)
- ❌ Result entry workflow (L-03, L-05, L-06, L-07)
- ❌ Immutable attempt linkage (L-02)
- ⚠️ Incomplete lifecycle enforcement (L-04 only)

This is **progress toward end-to-end**, but not yet end-to-end.

---

**Inspector:** Claude:Haiku-4.5  
**Iteration:** 2  
**Date:** 2026-07-29T02:56:00Z  
**Session:** 8f0a4783-d5be-4a2e-b21a-634cbba71c30
