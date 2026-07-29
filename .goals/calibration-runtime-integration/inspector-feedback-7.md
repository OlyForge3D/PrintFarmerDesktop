# Inspector Feedback — Iteration 7

## Verdict: FAIL

**Critical defects remain unfixed despite iteration-6 correction feedback.**
Previous iteration claimed remediation of G-02 context refresh, but investigation reveals:
- methodOptions persisted as `null` (violates G-04/G-07 replay determinism)
- Context mismatch validation incomplete (only configurationRevision checked)
- Context refresh failure allows continuation (violates fail-closed requirement)
- `beginAttempt` domain action NOT dispatched in retryWithNewAttempt (violates L-04)
- E2E tests remain 100% IPC schema validation; ZERO UI workflow coverage (violates D-07)

---

## Cumulative Product Inspection (HEAD=284ffd6)

### Quality Gates

| Gate | Command | Result | Evidence |
|------|---------|--------|----------|
| Provenance | `npm run check:provenance` | ✅ PASS | `Calibration provenance check passed: 0 derived file(s)` |
| Typecheck | `npm run typecheck` | ✅ PASS | No errors from `tsc --noEmit` |
| Lint | `npm run lint` | ✅ PASS | No ESLint errors |
| Tests | `npm run test` | ✅ PASS | 1511 tests passed (62 files) |
| E2E | `npm run test:e2e` | ✅ PASS | 29 tests passed (but see D-07 failure below) |

**All gates pass; implementation gaps remain critical.**

---

## Acceptance Criteria Verification

### **G-02: Context Refresh Before Submission — INCOMPLETE**

**Criterion:**
> "Before submitting generation, PFD fetches and revalidates: current printer context/configuration revision, physical toolhead/nozzle identity, filament product/spool identity, and upstream-Orca profile hashes."

**Evidence:**

**File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`

**Lines 1286-1310 (startGeneration):**
```typescript
// G-02: Refresh context immediately before POST and compare against the
// project snapshot. If the printer config revision has changed, block the
// submission so we do not submit with stale context.
const contextBeforeSubmit = await refreshProjectContext();
if (profileIdRef.current !== params.profileId) return;
const projectBeforeSubmit = activeProjectRef.current;
if (
  projectBeforeSubmit !== null &&
  contextBeforeSubmit !== null
) {
  const snapshotRevision =
    projectBeforeSubmit.domainState.binding.printer
      .printerConfigurationRevision;
  if (
    contextBeforeSubmit.configurationRevision !== null &&
    contextBeforeSubmit.configurationRevision !== undefined &&
    contextBeforeSubmit.configurationRevision !== snapshotRevision
  ) {
    const msg = `Context mismatch: printer configuration revision changed from ${snapshotRevision} to ${contextBeforeSubmit.configurationRevision}. Refresh the project context before generating.`;
    setGenerationState((prev) =>
      prev ? { ...prev, submitting: false, error: msg } : prev,
    );
    reportError(msg);
    return;
  }
}
```

**Critical Findings:**

1. **Incomplete Validation:** Only checks `configurationRevision` (line 1300), but G-02 requires:
   - ✅ Printer configuration revision
   - ❌ Physical toolhead/nozzle identity (NOT checked)
   - ❌ Filament product/spool identity (NOT checked)
   - ❌ Upstream-Orca profile hashes (NOT checked)

2. **Fail-Open on Refresh Failure:**
   **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`, lines 1086-1141 (refreshProjectContext)
   ```typescript
   } catch (cause) {
     // ... snip ...
     reportError(errorMessage(cause, 'The current printer context could not be refreshed.'));
     return null;  // ← Returns null on network/auth error
   }
   ```
   
   **Then, lines 1312-1314 (startGeneration):**
   ```typescript
   /* If context refresh returned null (fetch failed), continue with a note —
    * we do not block generation entirely on a transient context fetch failure.
    * A confirmed mismatch (above) is the hard blocker. */
   ```
   
   **VIOLATION:** Goal instructions state: "Context behavior for fail-closed: network/refresh/auth/stale/unknown context must block POST."
   - Network failure → returns null → continues to POST ❌
   - Auth failure → returns null → continues to POST ❌
   - Unknown context → null → continues to POST ❌
   
   This is fail-open, not fail-closed.

**Status:** FAIL — G-02 partially implemented; incomplete field validation and fail-open on refresh error.

---

### **G-04/G-07: Full Replay Context Persistence — INCOMPLETE**

**Criterion:**
> "Generation is submitted as a typed `generate-job` POST with a stable operation/idempotency ID and the expected project revision; a changed context blocks generation and requires explicit regeneration/rebase."
> "The UI displays the exact upstream-Orca version, Klipper dialect, printer snapshot/config revision, profile/model/specification/G-code hashes, and queued job identity."

**Evidence:**

**File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`, lines 1339-1351:
```typescript
/* Full replay context (G-04, G-06, G-07). */
method: params.method,
definitionVersion: params.definitionVersion,
methodOptions: null,  // ← HARDCODED TO NULL (Line 1342)
profileId: params.profileId,
printerConfigRevision:
  binding.printer.printerConfigurationRevision,
snapshotId: binding.snapshot.snapshotId,
orcaProfileContentHash:
  selectedBaseProfile.contentHash ?? null,
nozzleId: selectedNozzleId,
spoolId: filamentSpoolId,
```

**CRITICAL ISSUE:** `methodOptions: null` on line 1342.

**Also on line 1200 (submitGenerationPost):**
```typescript
const response = await calibrationApi().startCalibrationGeneration({
  profileId: params.profileId,
  projectId: params.projectId,
  attemptId: params.attemptId,
  operationId: params.operationId,
  method: params.method,
  definitionVersion: params.definitionVersion,
  methodOptions: null,  // ← HARDCODED TO NULL
  baseRevision: params.baseRevision,
});
```

**Impact:**
- `methodOptions` are method-specific configuration (e.g., nozzle size, temperature range)
- Hardcoding to `null` means: 
  - On crash/restart, exact replay cannot recover method options
  - Reconciliation cannot verify the submitted method configuration
  - Violates "deterministic durable replay" requirement (G-04, G-07, L-02)

**File:** `src/shared/ipc.ts`, line 2422:
```typescript
methodOptions: z.record(z.string(), z.unknown()).nullable().optional(),
```

**Status:** FAIL — methodOptions persisted as `null`, preventing exact replay recovery. No source of method options visible in submission flow.

---

### **L-04: Retry/New-Attempt Workflow — INCOMPLETE**

**Criterion:**
> "On failed or cancelled print, the attempt/generation history is preserved intact; a new retry attempt/operation is offered rather than mutating prior evidence."

**Iteration-7 Specific Requirement:**
> "retryWithNewAttempt must dispatch a real `beginAttempt` with new attemptId and then a new operation, not only clear React generation state or swap operationId."

**Evidence:**

**File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`, lines 1395-1451 (retryWithNewAttempt):
```typescript
const retryWithNewAttempt = useCallback(
  async (params: GenerationStartParams): Promise<void> => {
    const projectBeforeRetry = activeProjectRef.current;
    if (projectBeforeRetry === null) return;
    setLiveMessage('Starting a new attempt — old attempt history is preserved (L-04).');
    setAlertMessage(null);
    /* Persist the new operation as pending (clears prior operation). */
    const binding = projectBeforeRetry.domainState.binding;
    const selectedBaseProfile =
      projectBeforeRetry.record.workspaceState.selectedBaseProfile;
    const filamentSpoolId = binding.filament?.spoolId ?? null;
    const selectedNozzleId = binding.selectedNozzleId ?? null;
    const newPendingPayload: CalibrationWorkspacePayload = {
      ...payloadFor(projectBeforeRetry),
      pendingGeneration: {
        operationId: params.operationId,
        stageId: params.stageId,
        attemptId: params.attemptId,
        // ... persist new operation ...
      },
    };
    await bumpAndSave(
      replacePayload(projectBeforeRetry, newPendingPayload),
      environment.now(),
      'Persisting new attempt operation for restart recovery.',
    );
    setGenerationState({
      stageId: params.stageId,
      operationId: params.operationId,
      submitted: false,
      submitting: true,
      orchestration: null,
      polling: false,
      error: null,
    });
    await submitGenerationPost(params);
  },
  [bumpAndSave, environment, submitGenerationPost],
);
```

**CRITICAL FINDING:** No `beginAttempt` domain action dispatch.

**File:** Search for "beginAttempt" in CalibrationWorkspaceStore.tsx:
```
No matches found.
```

**VIOLATION:** The function:
- ✅ Creates a new operationId (via params)
- ✅ Creates a new attemptId (via params)
- ✅ Persists new pending operation to workspace
- ✅ Updates React state
- ❌ DOES NOT dispatch `beginAttempt` domain action

The domain event `beginAttempt` exists (defined in `domain/types.ts` and reducer), but is never dispatched by retryWithNewAttempt. This means the domain state machine does not transition; only React state is cleared.

**Status:** FAIL — L-04 retry action does not dispatch required `beginAttempt` domain event.

---

### **D-07: Playwright E2E Tests for UI Workflows — FAILED**

**Criterion:**
> "When Playwright UI paths are covered, relevant Playwright tests pass clean."

**Definition (from goal):**
> "Comprehensive focused tests covering all areas listed in acceptance criteria."

**Required Coverage:** Generation start → orchestration stages → queue state → bed-clear dialog → result entry → photo upload → completion.

**Actual E2E Test Content (19 tests in e2e/calibration.spec.ts):**

All 19 tests are **IPC schema validation only**. No UI workflow tests.

**Test Categories:**
1. **Security boundary (4 tests):** window.open blocked, generic primitives not exposed
2. **Preload bridge availability (1 test):** bridge is object with methods
3. **IPC schema validation (14 tests):**
   - `startCalibrationGeneration` schema accepts/rejects
   - `getCalibrationOrchestrationStatus` schema validation
   - `getCalibrationQueueState` schema validation
   - `acknowledgeCalibrationBedClear` schema validation
   - Sequential IPC calls pass schema

**ZERO Coverage of:**
- ❌ Generation start button click
- ❌ Orchestration stage display
- ❌ Queue state rendering
- ❌ Bed-clear dialog interaction
- ❌ Tab/Shift+Tab focus cycling (mentioned in file header but not tested)
- ❌ Live countdown timer update (mentioned in file header but not tested)
- ❌ Result entry form interaction
- ❌ Photo upload workflow
- ❌ Completion button
- ❌ Any UI navigation or state transition

**File Comments (e2e/calibration.spec.ts, lines 8-14):**
```typescript
* Coverage areas:
*   - Security boundary: openCalibrationExternalUrl IPC exists, window.open blocked
*   - Preload bridge availability (A-02, S-01, S-04)
*   - CalibrationApi does not expose generic URL primitives (S-04)
*   - Basic calibration workspace navigation
*   - Focus trap skeleton: Tab key cycles focus inside modal-like panels
```

**Reality:**
- ✅ Security boundary (4 tests)
- ✅ Preload availability (1 test)
- ✅ Generic URL primitives (4 tests)
- ❌ Workspace navigation (ZERO tests)
- ❌ Focus trap Tab cycling (ZERO tests, header claims it)

**Impact:**
- D-07 explicitly requires "Playwright tests for covered UI workflows"
- E2E suite is 100% IPC schema tests
- No Playwright workflow coverage of the actual calibration workspace UI
- Focus trap and countdown are implemented correctly (verified in code), but have ZERO E2E tests

**Status:** FAIL — D-07 requires workflow E2E tests; none are present. All 19 calibration E2E tests are IPC schema validation only.

---

### **B-06: Bed-Clear Dialog Focus Trap and Expiry Countdown — PASS**

**Criterion:**
> "Acknowledgement is withheld when: offline, unsynchronized, unauthorized, expired, stale, or the assigned printer no longer explicitly reports Klipper."

**Evidence (Focus Trap):**

**File:** `src/renderer/calibration/CalibrationQueuePanel.tsx`, lines 174-203:
```typescript
/* B-06 Tab/Shift+Tab focus trap — cycles focus among enabled focusable elements. */
useEffect(() => {
  const el = dialogRef.current;
  if (!el) return;
  const handler = (event: Event): void => {
    if (!(event instanceof KeyboardEvent)) return;
    if (event.key !== 'Tab') return;
    const focusable = Array.from(
      el.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((e) => !e.closest('[inert]'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  };
  el.addEventListener('keydown', handler);
  return () => el.removeEventListener('keydown', handler);
}, []);
```

✅ Focus trap correctly implemented: Tab wraps to first, Shift+Tab wraps to last, disabled/inert elements excluded.

**Evidence (Live Countdown):**

**File:** `src/renderer/calibration/CalibrationQueuePanel.tsx`, lines 151-157:
```typescript
/* B-06: Live countdown — tick every second so users see the expiry update. */
const [, setTick] = useState(0);
useEffect(() => {
  if (!bedClearDialog.open) return;
  const id = setInterval(() => setTick((n) => n + 1), 1_000);
  return () => clearInterval(id);
}, [bedClearDialog.open]);
```

✅ Live countdown timer runs every 1 second when dialog is open.

**Test Coverage (Vitest):**
- ✅ "B-06: BedClearDialog focus trap — Tab/Shift+Tab confinement > focus trap: dialog has at least two focusable elements"
- ✅ "B-06: BedClearDialog focus trap — Tab/Shift+Tab confinement > focus trap: Tab keydown on dialog with focus on last element moves to first"
- ✅ "B-06: BedClearDialog focus trap — Tab/Shift+Tab confinement > focus trap: Shift+Tab keydown on dialog with focus on first element moves to last"
- ✅ "B-06: BedClearDialog focus trap — Tab/Shift+Tab confinement > Escape key closes the dialog and restores focus"
- ✅ "B-06: BedClearDialog live countdown updates (B-06) > live countdown displays a remaining time value"
- ✅ "B-06: BedClearDialog live countdown updates (B-06) > expired bed-clear disables confirm button and shows warning"

**Status:** PASS — B-06 focus trap and countdown implemented and tested correctly.

---

### **L-02: Immutable Attempt Chain Links — VERIFIED PRESENT**

**Evidence:**

Tests confirm immutable links are displayed:
- ✅ "L-02: Immutable attempt chain links shown after Completed > shows job ID link when job Completed"
- ✅ "L-02: Immutable attempt chain links shown after Completed > shows G-code file ID link when job Completed"
- ✅ "L-02: Immutable attempt chain links shown after Completed > shows orchestration ID link when orchestration present"

**Status:** PASS — Immutable links displayed correctly.

---

### **A-02/S-01/S-04: External URL Security Boundary — PASS**

**Tests confirm:**
- ✅ "openCalibrationExternalUrl is present on the preload bridge"
- ✅ "no generic openExternalUrl(url:string) primitive on printFarmer bridge"
- ✅ "renderer window.open is blocked by setWindowOpenHandler"
- ✅ "openCalibrationExternalUrl rejects invalid linkId via preload Zod schema"
- ✅ "openCalibrationExternalUrl with valid linkId calls through to shell"

**Status:** PASS — Security boundary correctly enforced.

---

## Summary of Findings

### Failed Criteria

| Criterion | Issue | Evidence |
|-----------|-------|----------|
| **G-02** | Incomplete context validation; fail-open on refresh error | Lines 1299-1314, 1126-1139 CalibrationWorkspaceStore.tsx |
| **G-04/G-07** | methodOptions hardcoded to null | Lines 1200, 1342 CalibrationWorkspaceStore.tsx; line 2422 ipc.ts |
| **L-04** | No beginAttempt domain dispatch | No matches for "beginAttempt" dispatch in CalibrationWorkspaceStore.tsx |
| **D-07** | E2E tests are 100% IPC schema; zero UI workflow coverage | All 19 tests in e2e/calibration.spec.ts are schema validation only |

### Passed Criteria

| Criterion | Status |
|-----------|--------|
| B-06 (Focus trap + countdown) | ✅ PASS |
| L-02 (Immutable links) | ✅ PASS |
| A-02/S-01/S-04 (Security boundary) | ✅ PASS |
| B-01/B-03/Q-01 through Q-06 | ✅ PASS (confirmed by tests) |
| D-04 (Lint) | ✅ PASS |

### Quality Gate Summary

All gates pass, but implementation gaps remain:
- G-02: Context refresh partially implemented (fail-open behavior)
- G-04/G-07: methodOptions not persisted (only null)
- L-04: beginAttempt not dispatched
- D-07: Workflow E2E tests entirely absent

---

## Iteration-8 Required Fixes

### 1. **Fix G-02: Fail-Closed Context Refresh**
   - Add check for stale/unknown/failed context refresh → BLOCK POST
   - Validate all required fields:
     - configurationRevision (currently checked)
     - printer/nozzle identity (NOT checked)
     - filament/spool identity (NOT checked)
     - Orca profile content hash (NOT checked)
   - **File/Line:** CalibrationWorkspaceStore.tsx, lines 1286-1314

### 2. **Fix G-04/G-07: Persist methodOptions Correctly**
   - Replace `methodOptions: null` with actual method options from selected calibration configuration
   - Ensure methodOptions are serializable and retrievable from the method definition
   - Test exact replay with persisted methodOptions on crash/restart
   - **File/Line:** CalibrationWorkspaceStore.tsx, lines 1200, 1342; ipc.ts line 2422

### 3. **Fix L-04: Dispatch beginAttempt Domain Event**
   - In `retryWithNewAttempt`, after persisting new operation:
     - Dispatch domain action: `{ type: 'beginAttempt', attemptId, stageId }`
     - Ensure domain state transitions correctly
   - **File/Line:** CalibrationWorkspaceStore.tsx, lines 1395-1451

### 4. **Add D-07 Workflow E2E Tests**
   - Add Playwright tests for:
     - Generation start button interaction
     - Orchestration stage display
     - Queue state rendering
     - Bed-clear dialog Tab/Shift+Tab cycling (not just code coverage)
     - Bed-clear dialog countdown live update
     - Result entry form interaction
     - Photo upload workflow
   - **File/Line:** e2e/calibration.spec.ts (new workflow test cases)

---

## Files Modified in Iteration 7

- `e2e/calibration.spec.ts` (+245 lines) — added 7 IPC schema tests (no workflow tests)
- `src/renderer/calibration/CalibrationGenerationPanel.tsx` (+99 lines) — added retry UI buttons
- `src/renderer/calibration/CalibrationWorkspaceStore.tsx` (+261 lines) — incomplete G-02, G-04, L-04 fixes
- `src/renderer/calibration/CalibrationQueuePanel.tsx` (+41 lines) — focus trap + countdown (correct)
- `src/renderer/calibration/workspaceTypes.ts` (+12 lines) — type additions
- `src/shared/ipc.ts` (+33 lines) — schema updates
- `tests/calibration.generation-ui.test.tsx` (+514 lines) — additional UI tests
- `.goals/calibration-runtime-integration/status.json` — iteration bumped to 7

---

## Conclusion

**Iteration 6 correction feedback was accurate.** Iteration 7 attempted to address:
- ✅ Focus trap (B-06) — correctly implemented
- ✅ Live countdown (B-06) — correctly implemented
- ✅ Retry UI buttons (L-04) — UI present but domain action not dispatched
- ❌ G-02 context refresh — incomplete validation, fail-open on error
- ❌ G-04/G-07 methodOptions — hardcoded null, no replay recovery
- ❌ D-07 E2E workflow tests — 100% IPC schema validation, zero UI workflows

**Status: FAIL** — Critical defects remain: incomplete context validation (fail-open), methodOptions null, missing beginAttempt dispatch, zero E2E workflow coverage.

