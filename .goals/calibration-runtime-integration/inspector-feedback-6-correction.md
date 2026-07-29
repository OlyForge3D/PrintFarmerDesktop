# Inspector Feedback — Iteration 6 (Correction)

## Verdict: FAIL

**The iteration-6 PASS verdict is factually unsupported by production code evidence.**
This correction supersedes the prior report. Prior PASS relied on inaccurate code
location claims and incomplete verification of acceptance criteria.

---

## Preservation of Iteration-6 Report

The original iteration-6 report claimed all 56 criteria met and all quality gates passed.
This correction identifies specific false claims and concrete gaps remaining unresolved.

---

## Objective Factual Findings

### **pendingGeneration State Storage (Core Durable Recovery)**

**Finding:** `pendingGeneration` stores only 9 fields and lacks method-context recovery.

**Code Evidence:**
- **File:** `src/shared/ipc.ts`, lines 2393-2413
- **Type definition:**
  ```typescript
  pendingGeneration: z
    .object({
      operationId: z.string().uuid(),           // Stable UUID
      stageId: CalibrationWorkspaceStageId,      // Stage name
      attemptId: z.string().uuid(),              // Attempt UUID
      expectedProjectRevision: z.number().int().nonnegative().nullable(),
      orchestrationId: z.string().uuid().nullable(),  // Null until server returns
      orchestrationStep: z.string().max(128).nullable(),
      jobId: z.string().uuid().nullable(),
      lastReconcileAt: z.string().datetime().nullable(),
      createdAt: z.string().datetime(),
    })
    .strict()
    .nullable()
  ```

**Critical Absence (violates G-02, G-04, G-07, L-02):**
- ❌ NO `method` (required for display)
- ❌ NO `definitionVersion` (required for replay)
- ❌ NO `methodOptions` (required for replay)
- ❌ NO `profileId` (required for context validation)
- ❌ NO project context hashes (printer, nozzle, material, Orca snapshots missing)
- ❌ NO dispatch revision tracking
- ❌ NO sequence/step ordering for multi-step workflows

**Hydration Behavior (Line 1837, CalibrationWorkspaceStore.tsx):**
```typescript
if (pending.orchestrationId !== null) {
  void pollOrchestrationStatus(pending.orchestrationId);
}
```
- If `orchestrationId` is NULL (not yet submitted or crashed before server response),
  `startCalibrationGeneration` is NOT called.
- Crash-after-persist-before-response scenario: operationId is persisted but orchestrationId
  remains null → hydration skips reconciliation → exact operationId is merely displayed,
  NOT reused.
- Start button creates a FRESH operationId → duplicate generation operations possible.

**Impact on Criteria:**
- G-02/G-04: No exact replay after crash-before-server-response
- L-02: No immutable attempt-to-orchestration linking across restarts
- G-06: Reconciliation depends on server confirming orchestrationId; local recovery incomplete

---

### **e2e/calibration.spec.ts Test Scope (D-07 Claim)**

**Finding:** Test file is limited to 11 security/schema tests; zero workflow coverage.

**Count Evidence:**
- **File:** `e2e/calibration.spec.ts`
- **Line 1-14:** Header claims "Focus trap skeleton: Tab key cycles focus inside modal-like panels"
- **Actual test count:** 11 tests (verified by line-count `test(` declarations)
- **Total e2e suite:** 22 tests (11 in calibration.spec.ts + 11 in other files)

**Test Categories in calibration.spec.ts:**
1. A-02/S-01/S-04 — openCalibrationExternalUrl IPC exists (lines 79-185)
2. S-01/S-05 — IPC schema validation rejects missing/invalid fields (lines 189-261)
3. S-04 — No generic URL primitives exposed (lines 265-285)
4. S-03/S-05 — Unhandled rejection safety (lines 289-317)

**Zero Coverage (header vs reality):**
- ❌ NO `page.getBy*` or `locator` usage for DOM elements
- ❌ NO `click` actions on buttons or dialogs
- ❌ NO `press` key events (including Tab for focus trap)
- ❌ NO calibration workspace navigation sequences
- ❌ NO bed-clear dialog interaction
- ❌ NO result/photo entry workflow
- ❌ NO live-region/aria-live assertions

**Impact on D-07:**
- D-07 requires "Playwright e2e tests for covered UI workflows"
- Header comments promise "focus trap skeleton" and "navigation" testing
- Actual tests are pure security/schema bridge validation (11 tests)
- Zero end-to-end workflow tests (generation start, queue state, bed-clear, result entry)
- Full suite is 22 tests total (not workflow-specific); calibration.spec.ts contributes 0 workflow tests

---

### **BedClearDialog Focus & Expiry Management**

**Finding:** Initial focus present; focus trap and live expiry countdown missing.

**Focus Implementation (CalibrationQueuePanel.tsx, lines 148-178):**
- ✅ Initial focus on "Confirm" button (line 158)
- ✅ Escape key handler (lines 167-178)
- ❌ NO Tab/Shift+Tab focus trap (no wraparound confinement)
- ❌ NO programmatic focus management for Tab cycling

**Expiry Countdown (Line 182-183):**
```typescript
const expiry = job ? formatExpiry(job.bedClearExpiresAtUtc) : null;
const isExpired = expiry === 'Expired';
```
- Computed once on render
- ❌ NO `setInterval` or `useEffect` timer
- ❌ NO live update as expiry approaches
- ❌ User sees static "Expires in 10 min" until dialog remounts
- Violates B-06 expectation of live countdown display

**Impact on B-06:** Dialog is functional but not fully accessible (no focus trap) and
expiry display is stale (not live-updated). Production semantics differ from accessibility intent.

---

### **G-02: Pre-Submission Context Refresh — UNVERIFIED**

**Claim in Iteration-6:**
> "Lines 795-1141: `refreshProjectContext()` explicitly revalidates printer context,
> configuration snapshot, and OrcaSlicer profiles via REST before any generation attempt"

**Fact Check:**
- **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
- **Lines 795-843:** `loadPrinterContext()` loads context ONCE on printer selection
- **Lines 1200-1234:** Generation submission does NOT call `refreshProjectContext()`
- **No refresh before POST:** Context is assumed unchanged since initial load

**Code Path (Actual Flow):**
1. User selects printer → `loadPrinterContext()` called (line 795+)
2. User clicks "Start Generation" → direct POST with cached context
3. NO revalidation of printer config, nozzle, material, Orca profile before submission

**G-02 Requirement:**
> "Before submitting generation, PFD fetches and revalidates: current printer
> context/configuration revision, physical toolhead/nozzle identity, filament
> product/spool identity, and upstream-Orca profile hashes."

**Status:** NOT MET. Context is cached, not revalidated on submission.

**Impact:** A changed printer configuration between load and submit will not be detected,
violating G-02 and G-04 (context blocks generation requirement).

---

### **Asset Manifest & Photo Provenance (A-04, A-06, L-03)**

**Finding:** Asset validation incomplete; photo cross-reference unverified.

**Asset Manifest (from iteration-6 claim):**
- Iteration-6 claimed "reviewed:true for all 4 methods" with "backend-generated confirmed"
- **Reality Check Required:** `WorkspaceDomainState.superRefine()` at asset completion must verify:
  - `assetContentHash` always null (not persisted)
  - Photo descriptors vs. workspace photos (unverified cross-reference)
  - Orchestration/job artifact hashes (not in attempt record)

**Photo Staging (L-03):**
- Photos correctly wired to `completeAttempt` event
- ❌ `WorkspaceDomainState.superRefine()` checks `completePrintedAttempt` only for
  `attempt.result.confidence`
- ❌ Photo descriptor match against workspace photos not verified
- ❌ Asset provenance (source URL, checksum, attribution) not persisted immutably
  in attempt record (violates A-05)

**Impact on L-03/L-05/A-05:** Result entry workflow persists observations but lacks
full provenance chain and photo cross-reference validation.

---

### **Failed/Cancelled Retry Action (L-04)**

**Finding:** Zero implementation for retry/new attempt on failure or cancellation.

**Criterion L-04:**
> "If generation is cancelled or fails, the UI presents retry-same or new-attempt actions
> with exactly the same operationId if reusing the failed operation or a fresh operationId
> if starting new."

**Evidence Search:**
- ❌ No "Retry Generation" button in UI
- ❌ No domain action for `GenerationRetryRequested` or `GenerationRetryConfirmed`
- ❌ No test coverage for retry/cancel/new-attempt transitions
- ❌ Generation failure state does not present retry option

**Code Locations to Verify:**
- `CalibrationGenerationPanel.tsx` — No retry button rendered
- `calibration.generation-ui.test.tsx` — No retry/cancel tests
- `domain/reducer.ts` — No retry action handler

**Impact:** When generation fails, user has no workflow path to retry or restart.
L-04 criterion not met.

---

### **G-02 Context Refresh Verification Gap**

**Remaining Unverified:**
- No concrete test case for "changed printer config blocks generation"
- `refreshProjectContext()` function exists but is NOT invoked in generation submission path
- No blocking logic for stale context in `baseRevision` mismatch scenario
- G-04 requires "a changed context blocks generation" — this logic is absent from
  the submission flow

---

## Quality Gate Review

| Gate | Iteration-6 Claim | Actual Status |
|------|-------------------|---------------|
| `npm run lint` | ✅ PASS | ✅ PASS (D-04 fixed) |
| `npm run typecheck` | ✅ PASS | ✅ PASS |
| `npm run test` | ✅ 1497 PASS | ✅ PASS |
| `npm run test:e2e` | ✅ 22 PASS | ✅ PASS (but zero workflow coverage) |
| `npm run check:provenance` | ✅ PASS | ✅ PASS |

**Gates pass; coverage gaps remain.**

---

## Acceptance Criteria Summary

**Fully Met:** ~38 criteria
- D-04: Lint clean ✅
- B-01 through B-07: Bed-clear dialog implemented ✅
- Q-01 through Q-06: Queue state display ✅
- S-01/S-04/S-05: IPC security boundaries ✅

**Partially Met / Unverified:**
- **G-02:** Context refresh NOT called before submission ❌
- **G-04:** Changed context does not block generation ❌
- **G-06:** Crash-before-server-response → operationId not reused ❌
- **D-07:** E2E tests are schema-only (11 tests); zero workflow tests ❌
- **L-02:** No immutable attempt-to-orchestration linking ❌
- **L-03/L-05:** Photo cross-reference and asset provenance unverified ❌
- **L-04:** Retry/new-attempt action not implemented ❌
- **A-05:** Provenance not persisted in attempt record ❌

**Failed/Absent:**
- G-02 context refresh before submission
- L-04 retry/cancel workflow
- D-07 workflow e2e tests (only schema tests present)
- Full durable state recovery (pendingGeneration lacks method/context)

---

## Criteria-Level FAIL Evidence

### **G-02: UNVERIFIED**
- **Required:** Context revalidation before submission
- **Actual:** Context loaded once; no refresh before POST
- **File/Line:** `CalibrationWorkspaceStore.tsx` 1200-1234 (no refresh call)

### **L-04: NOT IMPLEMENTED**
- **Required:** Retry/new-attempt action on failure/cancel
- **Actual:** Zero UI, domain action, or test coverage
- **File/Line:** Not found (no implementation)

### **D-07: ZERO WORKFLOW COVERAGE**
- **Required:** Playwright e2e tests for covered UI workflows
- **Actual:** 11 security/schema tests; zero workflow e2e tests
- **File/Line:** `e2e/calibration.spec.ts` (all 11 tests are schema validation)

---

## Iteration-7 Concrete Requirements

1. **Implement G-02 Context Refresh:**
   - Call `refreshProjectContext()` immediately before `startCalibrationGeneration()`
   - Test that changed printer config blocks generation (new test case)

2. **Persist Full Generation Context (G-04/G-06):**
   - Add `method`, `definitionVersion`, `methodOptions`, `profileId` to `pendingGeneration`
   - Add printer/nozzle/material/Orca snapshot hashes to pendingGeneration
   - Implement "crash-before-server-response" recovery with exact operationId reuse

3. **Implement L-04 Retry/New-Attempt Workflow:**
   - Add UI buttons for "Retry Generation" (same operationId) and "New Attempt" (fresh operationId)
   - Add domain reducer actions for retry/cancel
   - Add e2e test for generation failure → retry → success path

4. **Add D-07 Workflow E2E Tests:**
   - Add Playwright tests for: Start Generation → Orchestration Stages → Queue → Bed-Clear → Start Print
   - Add tests for tab/focus navigation in BedClearDialog
   - Add tests for live expiry countdown
   - Cover all UI workflows, not only schema bridge validation

5. **Immutable A-05 Provenance (L-02/L-03):**
   - Persist asset source URL, checksum, attribution in attempt record
   - Verify photo descriptors cross-reference workspace photos and job artifact hashes
   - Add test case for provenance mismatch rejection

6. **BedClearDialog Accessibility (B-06):**
   - Implement focus trap (Tab/Shift+Tab confinement)
   - Implement live expiry countdown timer (update every 10s)
   - Add e2e tests for focus trap and countdown

---

## Summary

Iteration-6 PASS verdict was based on:
1. False code location claims (`refreshProjectContext` not called)
2. Incomplete durable state (pendingGeneration lacks method/context)
3. Zero workflow e2e test coverage (only schema tests)
4. Missing retry/cancel workflow (L-04)
5. Unverified photo/asset provenance

**Quality gates pass; implementation gaps remain critical for production use.**

---

**Status:** FAIL — Iteration 7 required for G-02 context refresh, L-04 retry action,
D-07 workflow tests, and full durable recovery.

