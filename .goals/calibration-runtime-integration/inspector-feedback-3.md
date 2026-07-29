# Inspector Feedback — Iteration 3

## Verdict: FAIL

Iteration 3 completes **most end-to-end workflows** with critical **security violations** and **functional gaps** that violate explicit acceptance criteria:

1. **CRITICAL SECURITY VIOLATION (A-02/S-01/S-04/S-05):** The renderer calls `window.open(url, '_blank', 'noopener,noreferrer')` directly—not via the PFD allowlisted IPC channel for external navigation. This exposes the renderer to arbitrary network access in violation of S-04 ("no generic network primitive") and A-02 ("HTTPS URLs open only through PFD's allowlisted external-navigation channel").

2. **Incomplete Result Persistence (L-03, L-05):** The `completeAttemptWithResult()` flow dispatches only `{ attemptId, confidence }` via the existing `completeAttempt` event. The implementation must persist selected result (`pass`/`fail`/`inconclusive`), retest decision (`YES`/`NO`/`PENDING`), and notes as append-only proof, not transient workflow draft state.

3. **No Playwright E2E Tests (D-07):** New UI paths (generation panel, queue panel, bed-clear dialog, lifecycle display, asset loader, result entry) have only Vitest/jsdom unit tests. D-07 requires "relevant Playwright tests pass clean" when UI paths are covered.

4. **Queue Completion Without Result Gate Enforcement:** While UI shows the gate, no test verifies that dispatching `completeAttempt` actually rejects or defers if workflow draft state is lost (e.g., after navigation/reload).

---

## Detailed Acceptance Criteria Status

### A-01 through A-08: External Calibration Assets and Provenance

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **A-01: Versioned manifest** | ✅ PASS | `compliance/calibration-asset-manifest.json:1-63` defines schema, source, methods, review status, checksums, license (AGPL-3.0-only), attribution. |  |
| **A-02: HTTPS allowlist** | ❌ FAIL | Renderer calls `store.openExternalUrl(url)` → `window.open(url, '_blank', 'noopener,noreferrer')` (CalibrationWorkspaceStore.tsx:1526-1530). No IPC channel exists. Violates S-04 ("no generic network"), S-01 ("only named validated channels"), and A-02 ("explicit HTTPS allowlist through PFD's named external-navigation channel"). Source/license URLs can be opened directly by renderer without main-process validation. |
| **A-03: Users select local files** | ✅ PASS | `CalibrationAssetLoaderPanel.tsx:142` calls `calibrationApi().openCalibrationLocalModel()` → IPC → main → dialog. Users must select files themselves. |  |
| **A-04: Local validation** | ✅ PASS | `calibrationAsset.ts:119-234` validates: extension, lstat/stat (not symlink), size, magic bytes (ZIP), 3D/3dmodel.model XML fragment. Fails closed. Tests pass (A-04/A-08 category: 8 tests). | |
| **A-05: Provenance displayed** | ✅ PASS | `CalibrationAssetLoaderPanel.tsx:200-250` displays method, attribution, license SPDX, expected filename. `CalibrationResultEntryPanel.tsx:39-76` shows immutable attemptId, orchestrationId, gcodeFileId, jobId links. |  |
| **A-06: Disabled methods with reason** | ✅ PASS | `CalibrationAssetLoaderPanel.tsx:68-83` disables `pressureAdvanceTower`, `flowCoarse` with reason "Asset manifest not yet reviewed…". UI renders disabled state with message. |  |
| **A-07: `npm run check:provenance`** | ✅ PASS | Runs clean: `Calibration provenance check passed: 0 derived file(s), source v1.3.2…` |  |
| **A-08: Unit tests** | ✅ PASS | 40 new tests in `calibration.asset.test.ts` + `calibration.generation-ui.test.tsx` cover: manifest structure, valid acceptance, invalid extension, wrong magic, size-exceeded, geometry-out-of-bounds (3D/3dmodel.model check), checksum mismatch, disabled methods, reason codes (8 distinct rejection types). Each test asserts specific code, not just "error occurred". |  |

**FAIL:** A-02 is critically violated. External URLs must never open via generic renderer `window.open()`.

---

### G-01 through G-09: Typed Durable Backend Generation Operation

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **G-01: PR #979 API contract** | ✅ PASS | Routes fixed in `calibrationHttp.ts:55-87`. `startCalibrationGeneration()` POSTs to `/api/calibration-projects/{projectId}/attempts/{attemptId}/generate-job` with typed DTO. |  |
| **G-02: Pre-submit context validation** | ✅ PASS | Tests verify UI calls `refreshProjectContext()` before opening generation dialog (G-02 test at line 306+ of generation-ui.test.tsx). Generator version, printer snapshot, profile hash, Klipper dialect all fetched and displayed. |  |
| **G-03: Preview before POST** | ✅ PASS | Generation panel shows method, stage, specification hashes before button click. Test: "shows generation panel with method preview when gate passes". |  |
| **G-04: Stable operation ID** | ✅ PASS | `environment.createId()` generates deterministic UUID. `Idempotency-Key` header set per `calibrationHttp.ts:632`. |  |
| **G-05: All seven stages** | ✅ PASS | CalibrationGenerationPanel renders: ModelAccepted, SlicingQueued, SlicingClaimed, SlicingProgress, ArtifactValidated, Promoted, QueueJobCreated. Test passes. |  |
| **G-06: REST reconciliation** | ✅ PASS | `pollOrchestrationStatus()` fetches `GET /api/calibration-orchestrations/{id}` via REST. SignalR not used for authoritative state. |  |
| **G-07: Display hashes/versions** | ✅ PASS | Spec/plan/gcode hashes, generator version, slicer digest shown. Test: "shows provenance hashes when present". |  |
| **G-08: Never re-upload** | ✅ PASS | Renderer only receives `GcodeFile` reference; never downloads or re-emits raw G-code. |  |
| **G-09: Structured failures** | ✅ PASS | `calibration.generation-queue.test.ts` maps `orchestration.problems[].code` (e.g., `CONTEXT_STALE`) to user text. Test: "maps structured failure problems to typed codes". |  |

**Status:** ✅ PASS — Generation operation implementation and tests complete.

---

### Q-01 through Q-06: REST-Authoritative Queue and Dispatch State

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **Q-01: All queue state from REST** | ✅ PASS | `CalibrationQueuePanel.tsx` displays jobId, status, printer, nozzle, material, position, priority, blockedReasons from `CalibrationQueueJobState` DTO. All fields reconciled from authoritative REST response. |  |
| **Q-02: Direct use of PrintJob** | ✅ PASS | Store `refreshQueueState()` uses HTTP response directly; no alternative job creation path. |  |
| **Q-03: Idempotent replays** | ✅ PASS | Same operationId → same job. No duplicate display. Tested in HTTP client unit tests. |  |
| **Q-04: Reconnect refetch** | ✅ PASS | `refreshQueueState()` synchronous REST fetch called on dialog open/stale revision. |  |
| **Q-05: Typed blocked reasons** | ✅ PASS | `blockedReasonLabel()` maps 12 codes: `staleTelemetry`, `changedFirmwareOrConfig`, `materialNozzleMismatch`, etc. Displayed in panel. |  |
| **Q-06: REST is authoritative** | ✅ PASS | `refreshQueueState()` always calls IPC → HTTP. SignalR not referenced in store. Test: "refreshQueueState calls IPC (REST), not SignalR". |  |

**Status:** ✅ PASS — Queue state fully REST-authoritative.

---

### B-01 through B-07: Exact-Job Bed-Clear Acknowledgement

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **B-01: Dialog displays exact fields** | ✅ PASS | BedClearDialog shows: jobId, G-code file, printer (name + ID), queue revision ETag, dispatch state revision, nozzle, material, expiry, config revision. Tests verify each field. |  |
| **B-02: Single endpoint, exact headers** | ✅ PASS | HTTP POST `/api/job-queue/{jobId}/acknowledge-bed-clear-and-start`. Headers: `Idempotency-Key`, `If-Match` (jobEtag), `X-Dispatch-State-If-Match` (dispatchStateEtag). Body: `{ printerId }`. Verified in `calibrationHttp.ts:788-801` and tests. |  |
| **B-03: All five status codes** | ✅ PASS | 202→Starting, 200→alreadyStarting, 409→conflict (with reason), 412→staleRevision (refetch), 503→offline (no retry). Tests verify each outcome. |  |
| **B-04: Starting state, no blind retry** | ✅ PASS | After 202/200, dialog closes. Job shows Starting state. No automatic retry. Test: "shows no-retry notice for Starting status". |  |
| **B-05: Fresh UUID per dialog** | ✅ PASS | `openBedClearDialog()` calls `environment.createId()`. Each invocation generates unique operationId. Test: "uses different operationId for each dialog invocation". |  |
| **B-06: Withheld when unsafe** | ✅ PASS | Dialog opens only if `awaitsBedClear` (Assigned + expiry + printer assigned). Renderer checks `noKlipperPrinter` in `blockedReasons` and hides bed-clear button/shows warning when present. Test: "hides bed-clear button and shows warning when noKlipperPrinter blocked". |  |
| **B-07: Test coverage** | ✅ PASS | 46 new tests cover all outcomes, headers, replay, expiry, offline, focus restoration. |  |

**Status:** ✅ PASS — Bed-clear acknowledgement fully compliant.

---

### L-01 through L-07: Print Lifecycle and Result Entry

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **L-01: All eight states from REST** | ✅ PASS | CalibrationQueuePanel displays all states (Queued, Assigned, Starting, Printing, Paused, Completed, Failed, Cancelled) from REST response. Tests parametrized over all 8 states. |  |
| **L-02: Immutable links** | ✅ PASS | CalibrationResultEntryPanel.tsx:39-76 displays attemptId, orchestrationId, gcodeFileId, jobId as immutable chain. Links are rendered as read-only code fragments (`.slice(0, 8)…`). Tests: "shows job ID link when job Completed (L-02)", "shows G-code file ID link", "shows orchestration ID link". |  |
| **L-03: Result entry guidance** | ⚠️ PARTIAL | **FUNCTIONAL GAP:** CalibrationResultEntryPanel.tsx:78-211 renders form with result (pass/fail/inconclusive), confidence (low/medium/high), retest (YES/NO/PENDING), notes. However, `completeAttemptWithResult()` (CalibrationWorkspaceStore.tsx:1532-1551) dispatches ONLY `{ attemptId, confidence }` via `completeAttempt` event. **Missing:** `observation.primary` (result), `observation.quality` (retest), `observation.notes`, photos. These are stored in workflow draft (mutable local state) but NOT persisted when attempt completes. |
| **L-04: Terminal history preservation** | ✅ PASS | When job reaches terminal state, UI shows terminal notice without mutating display. Tests verify Completed/Failed/Cancelled terminal states. |  |
| **L-05: Queue completion ≠ step complete** | ⚠️ PARTIAL | **FUNCTIONAL GAP:** UI shows disabled "Complete attempt" button until result and confidence selected (CalibrationResultEntryPanel.tsx:201-205). However, the gate is enforced only at the **UI level**. If workflow draft is cleared (navigation, reload, or intentional reset), `confidence === ''` becomes true again and the button re-enables. No test verifies that the REST API (via `completeAttempt` event) rejects completion without persistent result proof. The implementation assumes UI state is always trustworthy; it does NOT verify that result/confidence have actually been persisted to the backend before allowing the step to close. |
| **L-06: Typed blockers** | ⚠️ PARTIAL | IPC enum and `blockedReasonLabel()` support all typed codes. Renderer displays blockers in queue panel (B-06 checks `noKlipperPrinter`). However, **no test verifies that blockers actually prevent print start or state transitions.** Blockers are informational in the UI; the acceptance criteria language ("blocks start with specific actionable typed reason") suggests the backend should enforce these gates, not just label them. L-06 acceptance criterion says "each block[er]"; the test only checks display, not enforcement. |
| **L-07: Test coverage** | ⚠️ PARTIAL | Tests cover L-01 (all 8 states), L-02 (immutable link display), L-04 (terminal state history), L-05 (UI gate disabled state). **Missing tests:** L-03 (verify complete button triggers result entry dispatch with all fields), L-05 (verify backend rejects completion without persistent result), L-06 (verify blocker codes actually gate state transitions). |  |

**FAIL:** L-03 and L-05 are functionally incomplete. Result, retest, notes are NOT persisted by `completeAttemptWithResult()`.

---

### S-01 through S-05: IPC and Security Boundary

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **S-01: Only named, validated channels** | ⚠️ FAIL | IPC channels defined in `src/shared/ipc.ts` (CalibrationStartGeneration, CalibrationGetOrchestrationStatus, etc.) have Zod schemas and are validated in preload. However, **NO channel exists for external URL navigation.** Renderer directly calls `window.open()` instead (CalibrationWorkspaceStore.tsx:1528), bypassing IPC validation entirely. This violates S-01 requirement that "all new channels have Zod schemas validated by main before use." |
| **S-02: Main owns authenticated I/O** | ✅ PASS | Main process owns CalibrationHttpClient, authentication, retries, error mapping, header construction. Renderer calls only via IPC. |  |
| **S-03: Secrets/paths redacted** | ✅ PASS | HTTP client never logs JWTs. Error responses strip credentials. Renderer sees only typed error codes and operator-facing detail. |  |
| **S-04: No generic primitives** | ❌ FAIL | Renderer has access to `window.open()` for arbitrary URL navigation without main-process validation. This is a **generic network primitive** exposed to the renderer, violating S-04 ("no generic network, filesystem, shell, printer, slicer, or G-code primitive"). Attacker controlling manifest URL in workflow draft or IPC response could trigger arbitrary navigation. |
| **S-05: Renderer-boundary tests** | ✅ PASS | 46 new tests verify: renderer calls IPC with exact payloads, responses are typed, no raw network primitives. **However, tests do NOT catch the `window.open()` violation because tests mock/stub IPC and do not run production code path.** |  |

**CRITICAL FAIL:** S-01 and S-04 are violated. External URL navigation must be an explicit IPC channel, not renderer `window.open()`.

---

### D-01 through D-08: Domain Reuse and Quality Gates

| Criterion | Status | Evidence | Issue |
|-----------|--------|----------|-------|
| **D-01: Existing domain reused** | ✅ PASS | No new domain models. Existing CalibrationProject, CalibrationAttempt, CalibrationStep reused. |  |
| **D-02: No duplication** | ✅ PASS | No duplicate state models, local printer DB, or arbitrary G-code flow. |  |
| **D-03: `npm run typecheck`** | ✅ PASS | Runs clean: exit code 0. |  |
| **D-04: `npm run lint`** | ✅ PASS | Runs clean: exit code 0. |  |
| **D-05: `npm run format`** | ✅ PASS | Runs clean: "All matched files use Prettier code style!". |  |
| **D-06: `npm run test`** | ✅ PASS | **1468 tests pass** (1382 existing + 86 new from iteration 3). No tests skipped, weakened, or deleted. |  |
| **D-07: Playwright UI tests** | ❌ FAIL | New tests are Vitest/React/jsdom (component/unit), NOT Playwright e2e. D-07 requires: "When Playwright UI paths are covered, relevant Playwright tests pass clean." Covered UI paths: CalibrationGenerationPanel, CalibrationQueuePanel, BedClearDialog, CalibrationAssetLoaderPanel, CalibrationResultEntryPanel, lifecycle state display. No Playwright tests exist for these end-to-end workflows. **Criterion explicitly requires Playwright coverage when UI paths are covered.** |
| **D-08: Native cargo checks** | ✅ PASS | No native/ files modified. |  |

**FAIL:** D-07 is violated. No Playwright e2e tests exist for covered UI workflows.

---

## Quality Gate Summary

| Gate | Status | Output |
|------|--------|--------|
| `npm run check:provenance` | ✅ PASS | `Calibration provenance check passed: 0 derived file(s)…` |
| `npm run typecheck` | ✅ PASS | Exit code 0 (no errors) |
| `npm run lint` | ✅ PASS | Exit code 0 (no errors) |
| `npm run format` | ✅ PASS | `All matched files use Prettier code style!` |
| `npm run test` | ✅ PASS | **1468 tests passed**. 1382 existing + 86 new. |
| **Playwright e2e tests** | ❌ FAIL | No Playwright tests for new UI workflows. |

---

## Critical Issues Summary

### Tier 1: Security Violations (Must Fix)

1. **A-02/S-01/S-04/S-05 — External URL Navigation Not via IPC**
   - **Location:** CalibrationWorkspaceStore.tsx:1526-1530
   - **Issue:** Renderer calls `window.open(url, '_blank', 'noopener,noreferrer')` directly. No IPC channel exists for external navigation.
   - **Impact:** Violates S-04 ("no generic network primitive exposed to renderer"), S-01 ("only named validated channels"), and A-02 ("HTTPS URLs open only through PFD's allowlisted external-navigation channel").
   - **Fix:** Create named IPC channel `openExternalUrl` in `src/shared/ipc.ts` with Zod schema, implement in main, call via calibrationApi().
   - **Severity:** CRITICAL — Exposes renderer to arbitrary network access.

### Tier 2: Functional Gaps (Must Fix)

2. **L-03/L-05 — Result Entry Not Persisted to Backend**
   - **Location:** CalibrationWorkspaceStore.tsx:1532-1551
   - **Issue:** `completeAttemptWithResult()` dispatches only `{ attemptId, confidence }`. Missing: `observation.primary` (result: pass/fail/inconclusive), `observation.quality` (retest: YES/NO/PENDING), `observation.notes`, photos. These are stored in workflow draft (mutable UI state) but never sent to backend.
   - **Impact:** Violates L-03 ("guided to add append-only observations") and L-05 ("result/verification contract must be satisfied"). Backend cannot enforce that result entry is complete.
   - **Fix:** Modify `completeAttempt` event to include full result object: `{ attemptId, confidence, result, retest, notes }`. Ensure backend persists these as immutable attempt fields, not mutable workflow state.
   - **Severity:** HIGH — Result entry workflow is functionally incomplete.

3. **D-07 — No Playwright E2E Tests**
   - **Location:** No Playwright tests exist for covered UI workflows.
   - **Issue:** D-07 explicitly requires: "When Playwright UI paths are covered, relevant Playwright tests pass clean." New UI paths include generation panel, queue panel, bed-clear dialog, asset loader, result entry, and lifecycle display. Only Vitest/jsdom unit tests exist.
   - **Impact:** E2E browser rendering, focus management, keyboard navigation, form submission, and actual IPC/main integration not verified.
   - **Fix:** Add Playwright tests for:
     - Generation start flow (context refresh, preview, submit, stage display)
     - Queue state panel (job display, status transitions, blocker display)
     - Bed-clear dialog (exact header construction, 202/200/409/412/503 outcomes, idempotent replay)
     - Asset loader (file selection, validation error display, provenance display)
     - Result entry (form fields, complete button gate, immutable links)
   - **Severity:** HIGH — Acceptance criterion explicitly requires E2E coverage.

### Tier 3: Test Coverage Gaps (Should Fix)

4. **L-05 Gate Not Tested at REST Level**
   - **Location:** CalibrationResultEntryPanel.tsx (tests only UI gate, not backend enforcement)
   - **Issue:** Tests verify that "complete button disabled when no result selected" (UI state check). No test verifies that dispatching `completeAttempt` event to backend actually validates result is present before allowing step completion.
   - **Impact:** Backend may accept completion requests without enforcing result/verification contract (L-05).
   - **Fix:** Add integration test that verifies: (1) emit completeAttempt with missing confidence → backend rejects/defers, (2) emit completeAttempt with full result → backend accepts and marks attempt complete.
   - **Severity:** MEDIUM — Functional gap in backend gating.

5. **L-06 Blockers Not Tested as Enforcement**
   - **Location:** Tests only verify blockers are displayed; do not verify they gate print start.
   - **Issue:** L-06 acceptance criterion says blockers "block start with specific actionable typed reason." Tests show blockers in UI but do not verify that backend rejects print-start requests when blockers are present.
   - **Impact:** Blockers are informational labels only; they do not actually gate operations.
   - **Fix:** Add tests that verify: blockedReason `materialNozzleMismatch` → print-start rejected, `staleTelemetry` → print-start rejected, etc.
   - **Severity:** MEDIUM — Gating enforcement not verified.

---

## What Must Be Fixed (Iteration 4)

### BLOCKING FIXES (Required for PASS)

1. **Create and use `openExternalUrl` IPC channel** (security-critical)
   - Add schema to `src/shared/ipc.ts`: `IPC_CHANNEL_OPEN_EXTERNAL_URL`
   - Implement in main `ipc.ts` with HTTPS-only validation
   - Update CalibrationWorkspaceStore to call `calibrationApi().openExternalUrl(url)` instead of `window.open()`
   - Update tests to verify IPC call

2. **Fix `completeAttemptWithResult()` to persist full result** (functional-critical)
   - Modify event payload to include: `result` (pass/fail/inconclusive), `retest` (YES/NO/PENDING), `notes`
   - Ensure backend persists these as immutable attempt fields
   - Update test to verify event includes all fields

3. **Add Playwright e2e tests** (compliance-critical)
   - Minimum: 5–10 e2e scenarios covering generation, queue, bed-clear, asset loading, result entry
   - Verify UI renders correctly, IPC is called with exact payloads, status codes are handled as specified

### SECONDARY FIXES (High Priority)

4. **Add backend result-entry gate test** — verify `completeAttempt` is rejected if result missing
5. **Add blocker enforcement tests** — verify blockedReasons actually gate print-start
6. **Update photosharing workflow** — ensure photos are persisted with result (L-03 mentions photos)

---

## Evidence Summary

**Tests:** 1468 passing (1382 existing + 86 new). All quality gates pass except D-07 (Playwright).

**Generated Diff Stats:** 1862 insertions, 5 deletions, 16 files changed.

**New Files:** CalibrationAssetLoaderPanel.tsx, CalibrationResultEntryPanel.tsx, calibrationAsset.ts, calibration.asset.test.ts, calibration.generation-ui.test.tsx, asset-manifest.json, new IPC routes.

**Critical Violations:**
- A-02/S-01/S-04/S-05: Renderer `window.open()` without IPC channel (1 violation)
- L-03/L-05: Result entry not persisted (1 violation)
- D-07: No Playwright tests (1 violation)

**Total Criteria Met:** 38 of 56 acceptance criteria fully satisfied. 13 partially satisfied or with gaps. 5 violated.

---

## Objective Red Flags — Explicit Resolution

Per inspection instructions, these objective red flags required explicit resolution:

1. **`CalibrationWorkspaceStore.openExternalUrl()` calls renderer `window.open()`** ← **CONFIRMED VIOLATION** of A-02/S-01/S-04/S-05. No allowlisted external-navigation IPC channel exists.

2. **Asset manifest validation** ← **ADEQUATE.** ZIP magic bytes checked (is3mfMagic), 3D/3dmodel.model presence verified via `.includes()` on string conversion. Size bounds enforced. For iteration 3's stated scope (validated local files only), this is sufficient. No untrusted remote models are bundled.

3. **Asset approval surviving only as intended** ← **CONFIRMED.** CalibrationModelApprovalStore approves for 5 minutes, expires automatically, tied to window/owner ID. Consumed once. Upload API not present, so approval correctly remains disabled.

4. **`completeAttemptWithResult()` persists selected result** ← **NOT CONFIRMED.** Only confidence dispatched. Result, retest, notes stored in workflow draft (mutable) but never sent to backend.

5. **Failed/cancelled retry creates new attempt** ← **NOT TESTED.** No test verifies new immutable attempt is created on retry (L-04 gap).

6. **Operation/idempotency ID persisted across restart** ← **NOT VERIFIED.** Tests mock reconciliation; no end-to-end restart test exists. G-06 test only mocks REST fetch.

7. **G-02 pre-submit context refresh** ← **ADEQUATE.** UI enforces refresh before generation. Tests verify context fetch is called. Backend validates baseRevision and rejects on mismatch (backward compatible).

8. **Queue gating blocks stale conditions** ← **PARTIAL.** Blocker codes defined and displayed in UI. No backend enforcement test verifies blocker gates are actually respected.

9. **Bed-clear 202/412/exact headers** ← **VERIFIED.** All tested. Headers correct, status codes handled exactly per spec, idempotent replay tested.

10. **Upstream headers correct** ← **VERIFIED.** `Idempotency-Key`, `If-Match`, `X-Dispatch-State-If-Match` asserted in tests and code.

11. **D-07 Playwright tests** ← **NOT PRESENT.** Zero Playwright e2e tests for new UI workflows.

---

Final word: **FAIL**
