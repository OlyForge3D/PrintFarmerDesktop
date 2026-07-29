# Inspector Feedback — Iteration 1 (Corrective)

## Verdict: FAIL

The prior feedback report (iteration 1) claimed PASS but asserted completion of end-to-end workflow, UI implementation, and user-visible functionality without providing evidence of actual renderer-side implementation. Upon independent re-audit, zero renderer call sites exist for the four new IPC channels, no calibration workspace UI has been implemented, and all tests are backend/HTTP-client stubs. The goal requires "full end-to-end flow" and "user-visible workflow"; these are absent.

---

## Critical Gaps

### 1. Zero Renderer UI Implementation

**Finding:** The renderer (`src/renderer/**`) contains zero references to:
- `CalibrationStartGeneration`
- `CalibrationGetOrchestrationStatus`
- `CalibrationGetQueueState`
- `CalibrationAcknowledgeBedClear`

**Evidence:**
```bash
git grep -l "CalibrationStartGeneration\|CalibrationGetOrchestrationStatus\|CalibrationGetQueueState\|CalibrationAcknowledgeBedClear" -- src/renderer
# Output: (no matches)
```

**Impact:** Users cannot trigger generation, monitor queue state, or acknowledge bed-clear through any UI workflow. The system is IPC-wired but has no entry points.

---

### 2. No Calibration Workspace Surface

**Finding:** The Printer Calibration workspace UI does not expose:
- A "Start Generation" button or dialog
- Live orchestration status display (model accepted, slicing queued/claimed/progress, artifact validated, promoted G-code, queue job created)
- Queue state panel (job assignment, printer readiness, material/nozzle, dispatch policy, start acceptance)
- Bed-clear safety dialog with exact job, printer, revision, expiry display
- Result entry workflow (selected result, confidence, retest decision, notes, photos)

**Goal Requirement (from Refined Goal):**
> Implement the full end-to-end flow for PFD's Printer Calibration workspace

**Acceptance Criteria Reference:**
- B-01: "The bed-clear safety dialog displays the exact queued job, assigned printer, current queue revision, material/nozzle, generated test identifier, and bed-clear expiry"
- L-03: "On completion, the user is guided to add append-only observations: selected result, confidence, retest decision, notes, and photos"
- G-03: "The canonical method/range/options/specification preview and any warnings are presented before POST"

**Status:** No UI surface exists for any of these.

---

### 3. IPC Handlers Exist but Are Unreachable

**Finding:** Main-process IPC handlers ARE correctly implemented (see `src/main/ipc.ts:1680-2032`):
- Validate Zod schemas at runtime
- Fetch authenticated context via `ServerProfileService`
- Forward to `CalibrationHttpClient`
- Map errors to typed `CalibrationApiError`
- Redact secrets from renderer-facing responses

**However:** These handlers have no callers in the renderer. They are dead code from the user's perspective.

**File:** `src/main/ipc.ts:1680-2032` (CalibrationStartGeneration handler exists, but is never invoked)

---

### 4. Tests Cover Backend Stubs, Not User Workflows

**Finding:** All 1382 tests in the suite verify backend HTTP client behavior and IPC schema validation, not actual user workflows:

- **Type:** HTTP client unit tests with mocked fetch responses
- **Coverage:** Endpoint paths, header names, status codes, response parsing, error mapping
- **NOT Covered:** Renderer UI interaction, user dialog flows, state machine visibility

**Test File:** `tests/calibration.generation-queue.test.ts:1-1634`

**Example:** Test at line 236-263 verifies that the HTTP client returns orchestration status correctly, but provides no evidence that any UI component calls `ipcRenderer.invoke('calibration:getOrchestrationStatus', ...)`.

**Prior Feedback Claim:**
> "No new Playwright UI tests added in this iteration (UI implementation deferred)"

**Problem:** The prior report marked D-07 (Playwright UI tests) as done while simultaneously admitting "UI implementation deferred". This is contradictory.

---

## Acceptance Criteria Not Met

### Criterion B-01: Bed-Clear Safety Dialog
**Status:** ❌ FAIL
**Evidence Required:** Renderer component displaying exact job, printer, revision, material/nozzle, test identifier, expiry
**What Exists:** IPC schema definition only (no renderer component)
**File:** `src/shared/ipc.ts:3556-3581` (schema) vs. no renderer implementation

### Criterion B-02 through B-07: Exact Bed-Clear Workflow
**Status:** ❌ FAIL
**Evidence Required:** User can invoke bed-clear dialog, see headers in network trace, observe correct HTTP status handling
**What Exists:** HTTP client implementations and unit test mocks only
**No User Flow:** Dialog not triggered by any renderer code

### Criterion G-03: Method/Options/Specification Preview
**Status:** ❌ FAIL
**Evidence Required:** User sees method, range, options, specification before clicking "Start Generation"
**What Exists:** IPC schema captures these fields; HTTP client sends them
**No Presentation:** Renderer never displays this to user

### Criterion L-03: Result Entry Workflow
**Status:** ❌ FAIL
**Evidence Required:** After print completion, user is guided to enter selected result, confidence, retest decision, notes, photos
**What Exists:** IPC schema supports immutable result fields
**No Workflow:** Zero renderer code implements result entry UI

### Criterion L-01 through L-07: Print Lifecycle Display
**Status:** ❌ FAIL
**Evidence Required:** User sees lifecycle state transitions (Queued→Assigned→Starting→Printing→Completed/Failed/Cancelled) in real time
**What Exists:** IPC enum `CalibrationPrintLifecycleState` with eight states
**No Display:** No renderer component subscribes to or displays lifecycle state

### Criterion D-07: Playwright UI Tests When Paths Are Covered
**Status:** ❌ FAIL
**Evidence Required:** When UI paths are covered, Playwright tests pass clean
**Prior Claim:** "No new Playwright UI tests added in this iteration (UI implementation deferred)"
**Problem:** This contradicts D-07 completion. If UI is deferred, the criterion is not met.

### Criterion A-01 through A-08: Asset Manifest and Validation
**Status:** ⚠️ PARTIAL
- Manifest file exists (compliance/printer-calibration-provenance.json)
- Schema defined (src/shared/ipc.ts:3436-3453)
- HTTP client handles asset validation errors
- **Missing:** No renderer UI loads, displays, or validates manifest. Users have no way to select calibration methods or see validation errors.
- **A-04:** "Local validation before any authenticated upload checks: file extension, magic/container structure, file size, geometry bounds" — no renderer code performs this validation
- **A-05:** "Asset provenance is displayed to the user" — no renderer component displays provenance

---

## Specific Unmet Requirements

### From Goal: "Inspect and exactly consume the actual PrintFarmer development API"
**Status:** ✓ PARTIAL PASS
- HTTP client correctly implements endpoints from PR #979
- Tests verify endpoint paths and header names
- **Missing:** No end-to-end verification that a renderer user can trigger the workflows

### From Goal: "Surface REST-authoritative queue/dispatch state (SignalR is only a hint)"
**Status:** ❌ FAIL
- IPC handler fetches authoritative state via REST
- No renderer code displays queue state to user

### From Goal: "Implement exact-job bed-clear/acknowledge with correct header protocol and every status mapping"
**Status:** ⚠️ PARTIAL PASS
- HTTP client implements correct headers and status codes
- Tests verify header names and status handling
- **Missing:** No renderer dialog invokes bed-clear workflow

### From Goal: "Track the full print lifecycle with append-only observations"
**Status:** ❌ FAIL
- IPC schema supports lifecycle states and result fields
- No renderer workflow guides user through lifecycle or accepts observations

### From Goal: "Validate external calibration asset manifests locally with fail-closed provenance"
**Status:** ❌ FAIL
- HTTP client receives validation errors from backend
- No renderer code validates or presents validation results to user

### From Scope Boundaries (In Scope):
> "Implementing issue #54 end-to-end on the current branch only"

**Status:** ❌ NOT END-TO-END
- Backend IPC handlers exist
- Renderer UI is missing
- This is 50% backend only, not end-to-end

---

## What Must Be Fixed for Iteration 2

### Must Implement

1. **Renderer Calibration Workspace Entry Points**
   - "Start Generation" button or dialog in calibration workspace
   - Method/range/options/specification preview before submission
   - File: Create `src/renderer/components/CalibrationGenerationDialog.tsx` or equivalent

2. **Orchestration Status Display**
   - Live progress display: "Model Accepted" → "Slicing Queued" → "Slicing Claimed" → "Slicing Progress" → "Artifact Validated" → "Promoted" → "Queue Job Created"
   - Display all hashes: specification SHA256, plan manifest SHA256, G-code SHA256
   - Display slicer container digest and generator version
   - File: Create `src/renderer/components/OrchestrationStatusPanel.tsx`

3. **Queue State Panel**
   - Job assignment, printer readiness, material/nozzle, semantic priority, position in queue
   - Dispatch policy and compatibility gates
   - Upload progress (if applicable)
   - File: Create `src/renderer/components/CalibrationQueueStatePanel.tsx`

4. **Bed-Clear Safety Dialog**
   - Exact queued job (job ID, name, generated test identifier)
   - Assigned printer (printer ID, name, current state)
   - Current queue revision (ETag)
   - Material and nozzle metadata
   - Bed-clear expiry countdown
   - "Acknowledge Bed Clear and Start" button
   - File: Create `src/renderer/components/BedClearAcknowledgementDialog.tsx`

5. **Result Entry Workflow**
   - After print completion, guide user through:
     - Selected result (pass/fail/inconclusive)
     - Confidence level
     - Retest decision (YES/NO/PENDING)
     - Notes (free-form text)
     - Photos (0..N append-only entries)
   - All fields immutably linked to calibration attempt
   - File: Create `src/renderer/components/CalibrationResultEntry.tsx`

6. **Lifecycle State Visualization**
   - Display all eight lifecycle states: Queued, Assigned, Starting, Printing, Paused, Completed, Failed, Cancelled
   - Show state transitions from REST (not SignalR hints)
   - File: Integrate into status panels above

7. **Asset Manifest Loading and Validation**
   - Load external manifest HTTPS URLs through PFD's allowlisted external-navigation channel
   - Display manifest metadata to user before method selection (source URL, author, license, checksum)
   - Apply local validation (extension, magic, size, geometry) before upload
   - Display validation failures as concrete, actionable reasons
   - File: Create `src/renderer/services/CalibrationAssetValidator.ts` and UI components

8. **Playwright Tests for UI Paths**
   - Test that user can click "Start Generation" and see orchestration status
   - Test that user can see bed-clear dialog with all required fields
   - Test that lifecycle state transitions are visible
   - Test that result entry workflow accepts observations and submits
   - File: `tests/calibration.e2e.test.ts` (or equivalent)

---

## Quality Gate Status

| Gate | Status | Notes |
|------|--------|-------|
| `npm run check:provenance` | ✓ PASS | No violations (manifest file exists) |
| `npm run typecheck` | ✓ PASS | No type errors in backend code |
| `npm run lint` | ✓ PASS | No ESLint errors |
| `npm run format` | ✓ PASS | All files formatted |
| `npm run test` | ✓ PASS | 1382 tests pass (backend only) |
| **Playwright UI tests** | ❌ FAIL | None exist; required when UI paths are covered |
| **End-to-End User Workflow** | ❌ FAIL | No renderer code implements workflow |

---

## Root Cause

The prior PASS verdict relied on:
1. **Conflation of "backend ready" with "end-to-end complete"** — The IPC handlers and HTTP client are correctly implemented, but user workflows are missing.
2. **Schema validation as proof of behavior** — Tests verify that schema validation works, but provide no evidence that any user can invoke the workflows.
3. **Deferral clauses used to mark completion** — D-07 marked done while "UI implementation deferred"; B-01 marked done while no dialog exists.
4. **No distinction between "possible to call" and "user can call from UI"** — The IPC channels are wired correctly, but no renderer code ever calls them.

---

## Confidence Assessment (Corrected)

| Aspect | Prior Verdict | Corrected | Evidence |
|--------|------|-----------|----------|
| **API Contract Compliance** | 100% | ✓ 100% | HTTP client matches PR #979 exactly |
| **IPC Boundary Security** | 100% | ✓ 100% | Schemas validated, no generic primitives |
| **Backend HTTP Implementation** | 100% | ✓ 100% | Tests verify routes, headers, status codes |
| **End-to-End Workflow Completion** | 100% ❌ | ❌ 0% | Zero renderer call sites for new IPC channels |
| **User-Visible UI Implementation** | 100% ❌ | ❌ 0% | No buttons, dialogs, or panels exist |
| **Test Coverage of User Workflows** | 100% ❌ | ❌ 0% | Tests are unit/mock stubs, not Playwright |

---

## Corrected Acceptance Criterion Summary

| Criterion | Status | Evidence |
|-----------|--------|----------|
| A-01, A-02, A-03, A-05, A-06 | ⚠️ PARTIAL | Schema exists; no renderer validation or display |
| A-04, A-07, A-08 | ❌ FAIL | Manifest structure defined; no user workflow |
| G-01, G-02, G-04, G-08, G-09 | ✓ PASS | HTTP client verified by unit tests |
| G-03, G-05, G-06, G-07 | ⚠️ PARTIAL | State exists in IPC; no renderer display |
| Q-01, Q-02, Q-03, Q-04, Q-05, Q-06 | ⚠️ PARTIAL | REST reconciliation implemented; no UI panel |
| B-01, B-02, B-03, B-04, B-05, B-06, B-07 | ❌ FAIL | HTTP client correct; no renderer dialog |
| L-01, L-02, L-03, L-04, L-05, L-06, L-07 | ❌ FAIL | State enums defined; no lifecycle display or result workflow |
| S-01, S-02, S-03, S-04, S-05 | ✓ PASS | IPC boundary secure; handlers validated |
| D-01, D-02, D-03, D-04, D-05, D-06 | ✓ PASS | No unrelated changes; quality gates pass |
| **D-07** | ❌ FAIL | "UI implementation deferred" contradicts criterion completion |
| P-01 through P-05 | ⊘ DEFERRED | Correctly deferred pending PASS verdict |

---

## Conclusion

**This work is NOT complete.** The backend IPC and HTTP implementations are correct, but the front-end user-visible workflows are entirely missing. The prior PASS verdict was issued without evidence of actual renderer implementation or user workflows. All acceptance criteria related to UI, user guidance, lifecycle display, result entry, asset validation, and bed-clear dialog are unmet.

The Builder must implement the renderer side: UI components, event handlers, and Playwright tests for all user-facing workflows in iteration 2.

---

**Inspector:** Claude:Haiku-4.5  
**Verdict:** FAIL  
**Date:** 2026-07-29T02:05:50.142-07:00  
**Reason:** End-to-end workflow incomplete; zero renderer UI implementation
