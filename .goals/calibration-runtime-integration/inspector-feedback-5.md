# Inspector Feedback — Iteration 5

## Verdict: FAIL

**Critical Production Defects Remaining:**
1. **D-04 Lint Error:** `e2e/calibration.spec.ts:158` has async arrow function without await (quality gate BLOCKED)
2. **A-04/A-06 Asset Validation:** Manifest shows `reviewed: false`, no fixture validation checksums (methods unvalidated)
3. **G-02/G-04 Restart Recovery:** No code hydrates/reconciles `pendingGeneration` on project load; in-flight operations not recovered

---

## Quality Gate Execution

| Gate | Status | Command/Output |
|------|--------|---|
| `npm run check:provenance` | ✅ PASS | Clean (0 derived files, v1.3.2) |
| `npm run typecheck` | ✅ PASS | Exit code 0 |
| **`npm run lint`** | ❌ **FAIL** | 1 error at `e2e/calibration.spec.ts:158:27`: Async arrow function has no 'await' expression |
| `npm run format` | ✅ PASS | All files formatted per Prettier |
| `npm run test` | ✅ PASS | 1492 tests passed (62 files) |
| **`npm run test:e2e`** | ✅ **PASS** | **22 tests PASSED** (all e2e/calibration.spec.ts + others) |

---

## Acceptance Criteria Check

### **D-04: ESLint Passes Clean — ❌ FAIL**

**Criterion:** `npm run lint` passes clean with no new ESLint warnings or errors.

**Evidence — File Violation:**
- **File:** `e2e/calibration.spec.ts`
- **Line:** 158:27
- **Error:** `Async arrow function has no 'await' expression` (@typescript-eslint/require-await)
- **Code:**
  ```typescript
  await app.evaluate(({ shell }) => {
    (shell as { openExternal: (url: string) => Promise<void> }).openExternal =
      async (url: string) => {    // ← Line 158: async but no await inside
        process.env['PRINTFARMER_TEST_LAST_OPENED_URL'] = url;
      };
  });
  ```

**Issue:** The async arrow function on line 158 contains only synchronous code (assignment to `process.env`). It should not be declared async.

**Impact:** Criterion D-04 is NOT satisfied. A quality gate command MUST pass clean before any criterion can be marked PASS.

**Status:** ❌ **FAIL — Quality gate blocked. Lint must pass before proceeding.**

---

### **D-07: Playwright E2E Tests Pass Clean — ✅ PASS**

**Criterion:** When Playwright UI paths are covered, relevant Playwright tests pass clean.

**Evidence:**
- **File:** `e2e/calibration.spec.ts`
- **Line Count:** 316 lines (security, preload bridge, IPC validation tests)
- **Test Count:** 11 calibration-specific tests
  1. `openCalibrationExternalUrl is present on the preload bridge (A-02, S-01)` ✓
  2. `no generic openExternalUrl(url:string) primitive on printFarmer bridge (S-04)` ✓
  3. `renderer window.open is blocked by setWindowOpenHandler (S-04)` ✓
  4. `openCalibrationExternalUrl rejects invalid linkId via preload Zod schema (S-05)` ✓
  5. `calibration: preload bridge is an object with calibration IPC methods` ✓
  6. `calibration: openCalibrationExternalUrl with valid linkId calls through to shell (A-02)` ✓
  7. `calibration: getCalibrationQueueState rejects request with missing profileId (S-01)` ✓
  8. `calibration: acknowledgeCalibrationBedClear rejects request with invalid UUID (S-05)` ✓
  9. `calibration: startCalibrationGeneration rejects renderer-supplied arbitrary method (S-04)` ✓
  10. `calibration: no generic getCalibrationOrchestrationStatus without profileId (S-04)` ✓
  11. `calibration: renderer IPC rejection is surfaced as a thrown error, not an unhandled promise (S-05)` ✓

- **Total Playwright Test Count:** 22 tests (11 calibration + 11 mvp/accessibility/gpu/retarget)
- **Command:** `npm run test:e2e`
- **Result:** 22 passed (16.0s)

**Coverage Assessment:**
- ✅ Security boundary: IPC allowlist, window.open blocked
- ✅ Preload bridge availability and named channels
- ✅ Schema validation (Zod)
- ✅ IPC rejection handling (no unhandled promises)
- ⚠️ **NOTE:** Tests do NOT cover full end-to-end workflows: generation→queue→bed-clear→result entry workflow navigation is NOT tested. Tests cover security/isolation layer, not user workflow. However, criterion D-07 only requires that tests **pass clean**, not that they cover all workflows.

**Verdict:** ✅ **PASS** — Tests executed successfully. Criterion satisfied.

---

### **L-03: Photos Wired to Result Entry — ✅ PASS**

**Criterion:** On completion, the user is guided to add append-only observations: selected result, confidence, retest decision, notes, and **photos**.

**Evidence — Production Code:**
- **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
- **Lines 1600-1610:** Photo collection and descriptor creation:
  ```typescript
  /* Collect approved photo descriptors staged for this attempt (L-03). */
  const stagedPhotos = project.record.workspaceState.photos.filter(
    (photo) => photo.attemptId === activeAttempt.attemptId,
  );
  const photoDescriptors = stagedPhotos.map((photo) => ({
    photoId: photo.photoId,
    contentHash: photo.contentHash,
    mimeType: photo.mimeType,
    caption: photo.caption,
    order: photo.order,
  }));
  ```

- **Lines 1616-1630:** `completeAttemptWithResult` dispatches `completePrintedAttempt` event WITH photos:
  ```typescript
  await dispatchEvent({
    type: 'completePrintedAttempt',
    attemptId: activeAttempt.attemptId,
    confidence: confidence,
    result: result,
    retest: (draft?.observation.quality ?? 'PENDING'),
    completionNotes: draft?.observation.notes,
    photos: photoDescriptors,  // ← Photos included
    orchestrationId,
    jobId,
    assetContentHash: null,
  });
  ```

- **File:** `src/shared/ipc.ts`
- **Lines 1761-1789:** Event schema includes photos as REQUIRED array:
  ```typescript
  z.object({
    type: z.literal('completePrintedAttempt'),
    photos: z.array(
      z.object({
        photoId: z.string().uuid(),
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
        mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
        caption: z.string().min(1).max(512),
        order: z.number().int(),
      })
    ).max(100),
    // ... other fields
  })
  ```

- **File:** `src/renderer/calibration/domain/reducer.ts`
- **Lines 714:** Reducer persists photos immutably:
  ```typescript
  const completedAttempt: CalibrationAttempt = {
    ...attempt,
    photos: event.photos,  // ← Appended to attempt record
    // ... other fields
  };
  ```

- **Test Evidence:** `tests/calibration.generation-ui.test.tsx` contains test:
  ```
  ✓ L-03/L-05: completeAttemptWithResult includes result, retest, notes > 
    dispatching completeAttemptWithResult persists result, confidence, retest, notes in event
  ```

**Verdict:** ✅ **PASS** — Photos are collected, wired into `completePrintedAttempt` event, and persisted immutably in attempt record.

---

### **L-05: Result Gate Enforced Authoritatively — ✅ PASS**

**Criterion:** Queue completion alone does not mark a calibration step complete; the method's result/verification contract must be satisfied.

**Evidence — UI Layer:**
- **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
- **Lines 1597-1599:** Store-layer gate (early return if result or confidence missing):
  ```typescript
  if (confidence === '' || result === '') return;
  ```
- **Comment:** "Enforce the result gate (L-05): both result and confidence required at the store layer; the domain reducer enforces this authoritatively."

**Evidence — Domain Layer (Authoritative Enforcement):**
- **File:** `src/shared/ipc.ts`
- **Lines 1767:** Schema makes result REQUIRED (non-optional):
  ```typescript
  z.object({
    type: z.literal('completePrintedAttempt'),
    // ... other fields ...
    result: z.enum(['pass', 'fail', 'inconclusive']),  // ← REQUIRED, not optional
    confidence: z.enum(['low', 'medium', 'high']),      // ← REQUIRED
    retest: z.enum(['YES', 'NO', 'PENDING']),           // ← REQUIRED
  })
  ```

- **File:** `src/renderer/calibration/domain/reducer.ts`
- **Line 619 onwards:** Domain reducer case handles `completePrintedAttempt` with schema-validated result field:
  ```typescript
  case 'completePrintedAttempt': {
    const attempt = state.attempts.find(...);
    // ... validation ...
    const completedAttempt: CalibrationAttempt = {
      result: event.result,  // ← Result persisted from schema-required field
      // ... other fields immutable ...
    };
  }
  ```

**Test Evidence:**
  - `✓ L-05: Complete button disabled until result and confidence selected` (×3)
  - `✓ L-03/L-05: completeAttemptWithResult includes result, retest, notes` (×4 related tests)

**Verdict:** ✅ **PASS** — Result is REQUIRED by schema at domain layer AND gated at UI layer. Criterion satisfied.

---

### **A-04/A-06: External Asset Validation and Review — ❌ FAIL**

**Criterion:**
- **A-04:** Local validation before any authenticated upload checks file extension, magic/container structure, file size, geometry bounds, and method-specific bounds.
- **A-06:** Any unreviewed or unvalidated calibration method is disabled with a concrete, user-visible reason; no method becomes available until its asset manifest **and validation fixture pass review**.

**Evidence — Manifest Status:**
- **File:** `compliance/calibration-asset-manifest.json`
- **Current Manifest Content (lines 15-54):**
  ```json
  "methods": [
    {
      "methodId": "temperatureTower",
      "reviewed": false,               // ← NOT reviewed
      "disabledReason": "Asset not yet validated: expectedSha256 is null. Download the file from the reviewed source, compute its SHA-256 checksum, record it here, and re-enable after per-file review. No method may be enabled without an exact checksum fixture.",
      "sourceModelPath": "models/temperature_tower.3mf",
      "sourceModelBlob": null,         // ← No fixture checksum
      "validationRules": { ... }
    },
    {
      "methodId": "flowStandard",
      "reviewed": false,
      "disabledReason": "Asset not yet validated: expectedSha256 is null. ...",
      "sourceModelBlob": null,         // ← No checksum
      ...
    },
    {
      "methodId": "pressureAdvanceTower",
      "reviewed": false,
      "disabledReason": "Asset manifest not yet reviewed for this method. ...",
      "sourceModelUrl": "https://..."  // ← No sourceModelPath, no checksum
    }
  ]
  ```

**Key Finding:**
1. **All methods have `reviewed: false`** — Methods are not marked as reviewed in manifest
2. **No `expectedSha256` checksums** — Manifest states checksums are `null` (explicitly missing)
3. **Goal A-06 requires:** "no method becomes available until its asset manifest **and validation fixture pass review**"
4. **Current state:** Manifest is a shell; no validation fixture data (checksums) exists

**Evidence — Asset Panel UI (confirms disabled state):**
- Test: `✓ A-05/A-06: All methods currently disabled-until-review (no SHA-256)` ×2
- Test: `✓ A-04/A-08: Disabled methods block file upload and generation` ×3

**Verdict:** ❌ **PARTIAL FAIL**
- ✅ Methods are correctly disabled and show concrete reasons in UI
- ✅ File upload/generation is blocked for disabled methods
- ❌ **A-04/A-06 criterion NOT satisfied:** Manifest shows no fixture validation data (checksums). Goal requires both manifest AND fixture validation checksums before methods can be enabled. Manifest shows no evidence of fixture validation.

**Status:** ❌ **FAIL — Methods remain unvalidated; manifest contains no fixture checksum data.**

---

### **G-02/G-04: Durable Generation Context and Idempotency Recovery — ❌ FAIL**

**Criterion:**
- **G-02:** Before submitting generation, PFD fetches and revalidates: current printer context, config revision, physical toolhead/nozzle, filament/spool identity, upstream-Orca profile hashes.
- **G-04:** Generation submitted with stable operation/idempotency ID; changed context blocks generation and requires explicit regeneration/rebase.

**Evidence — Generation Submission (Code Present):**
- **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
- **Lines 1200-1223:** `pendingGeneration` persisted before POST (stable operation ID):
  ```typescript
  const pendingPayload: CalibrationWorkspacePayload = {
    pendingGeneration: {
      operationId: params.operationId,       // ← Stable idempotency ID
      stageId: params.stageId,
      attemptId: params.attemptId,
      expectedProjectRevision: params.baseRevision,
      orchestrationId: null,
      lastReconcileAt: null,
      createdAt: environment.now(),
    },
  };
  ```
- **Lines 1264-1286:** `pendingGeneration` updated after submission with orchestrationId for restart recovery

**Evidence — Context Refresh Before Generation:**
- **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
- **Lines 1086-1141:** `refreshProjectContext()` fetches authoritative printer context and Orca profiles before generation

**Critical Gap — NO HYDRATION/RECOVERY ON PROJECT LOAD:**
- **File:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
- **Lines 254-268:** `hydrateActiveProject()` function:
  ```typescript
  const hydrateActiveProject = useCallback(
    (project: OpenCalibrationProject | null): void => {
      setActiveProject(project);  // ← Only sets active project
      setMetadataDraft(...);       // ← Only sets metadata
      // ← NO CODE to check pendingGeneration or reconcile in-flight operations
    },
    [setActiveProject],
  );
  ```

- **Lines 570-631:** `openProject()` function calls `hydrateActiveProject()` after loading record but does NOT:
  - Check if `record.workspaceState.pendingGeneration` exists
  - Reconcile pending operations on startup
  - Poll orchestration status after restart

**Missing Reconciliation Flow:**
1. ❌ NO code checks `project.record.workspaceState.pendingGeneration` on project load
2. ❌ NO code calls `pollOrchestrationStatus()` for persisted orchestrationId on startup
3. ❌ NO code validates that `expectedProjectRevision` matches current context before replay
4. ❌ NO code calls `refreshProjectContext()` automatically on startup to revalidate G-02 requirements

**Test Coverage:**
- Tests verify `pendingGeneration` is persisted BEFORE submit (good)
- Tests verify it's updated WITH orchestrationId AFTER submit (good)
- ❌ **NO test** verifies `pendingGeneration` is recovered/reconciled on project load after restart

**Verdict:** ❌ **FAIL**
- ✅ `pendingGeneration` is persisted with stable operationId
- ✅ Orchestration context refresh happens before initial submission
- ❌ **G-02/G-04 criterion NOT satisfied:** No hydration/reconciliation of `pendingGeneration` on project load. Restart recovery is incomplete; in-flight operations are abandoned on app restart rather than resumed.

**Status:** ❌ **FAIL — Restart/recovery logic not implemented. In-flight generations not reconciled on app/project load.**

---

## Detailed Findings Summary

### **Blocking Issues (Must Fix Before PASS)**

| Issue | Category | Impact | Required Fix |
|-------|----------|--------|-------------|
| Lint error: async without await (line 158) | D-04 | Quality gate BLOCKED | Remove `async` or add `await` in test stub |
| Asset manifest: no fixture checksums | A-04/A-06 | Methods unvalidated/disabled | Add fixture validation checksums to manifest |
| No `pendingGeneration` hydration on load | G-02/G-04 | Restart recovery broken | Add reconciliation logic in `openProject()` or `hydrateActiveProject()` |

### **Criteria Status by Category**

| Category | ID | Status | Notes |
|----------|----|---------| ------|
| **A (Assets)** | A-04, A-06 | ❌ FAIL | Manifest unvalidated; methods disabled correctly but without fixture checksums |
| **D (Domain)** | D-04, D-07 | ❌ FAIL | D-04 lint error blocks quality gate; D-07 tests pass but D-04 must pass first |
| **G (Generation)** | G-02, G-04 | ❌ FAIL | Context refresh exists but no startup reconciliation of `pendingGeneration` |
| **L (Lifecycle)** | L-03, L-05 | ✅ PASS | Photos wired; result enforced authoritatively |
| **Q (Queue)** | Q-01–Q-06 | ✅ PASS | 1492 tests pass including queue lifecycle |
| **B (Bed-Clear)** | B-01–B-07 | ✅ PASS | Tests verify exact headers and status handling |
| **S (Security)** | S-01–S-05 | ✅ PASS | IPC allowlist, window.open blocked, preload validated |
| **E2E (Playwright)** | D-07 | ✅ PASS | 22 tests pass (11 calibration + others) |

---

## What Must Be Fixed for PASS

### 1. **D-04: Fix Lint Error (e2e/calibration.spec.ts:158)**
   - **Action:** Remove `async` from arrow function on line 158, or add an await expression inside
   - **Location:** `e2e/calibration.spec.ts:158`
   - **Code change:** Remove `async` keyword from the arrow function that only assigns to `process.env`

### 2. **A-04/A-06: Add Fixture Validation Checksums to Manifest**
   - **Action:** For each method (`temperatureTower`, `flowStandard`, etc.), add the actual SHA-256 checksum of the validated fixture file
   - **Location:** `compliance/calibration-asset-manifest.json`
   - **Change:** Replace `"sourceModelBlob": null` with `"expectedSha256": "<sha256-hash>"` for all methods after validation
   - **Prerequisite:** The fixture files must be downloaded from the reviewed source, their SHA-256 computed, and checksums recorded
   - **Mark reviewed:** Change `"reviewed": false` to `"reviewed": true` and add `"reviewedAt"` timestamp

### 3. **G-02/G-04: Implement `pendingGeneration` Reconciliation on Project Load**
   - **Action:** In `openProject()` or `hydrateActiveProject()`, check if `project.record.workspaceState.pendingGeneration` exists with an active orchestrationId
   - **If found:** Automatically call `pollOrchestrationStatus()` with the persisted orchestrationId to resume reconciliation
   - **Also:** Call `refreshProjectContext()` on startup to revalidate G-02 requirements (printer context, config revision, nozzle, filament, Orca profile hashes)
   - **Location:** `src/renderer/calibration/CalibrationWorkspaceStore.tsx`
   - **Scope:** Modify `openProject()` and/or add an effect that runs after `hydrateActiveProject()` to reconcile pending state

---

## Prior Iteration Analysis

**Iteration 4 Correction (inspector-feedback-4-correction.md) identified:**
1. D-07 tests exist but `npm run test:e2e` failed to build (sidecar binary missing)
2. L-05 result gate only at UI layer (domain layer accepts optional result)
3. L-03 photos not wired to event
4. A-04/A-06 fixture checksums absent

**Iteration 5 Progress:**
- ✅ D-07: Tests now EXECUTE and PASS (22 tests)
- ✅ L-03: Photos ARE wired to `completePrintedAttempt` event
- ✅ L-05: Result is REQUIRED at domain schema layer (authoritative enforcement)
- ❌ D-04: New lint error introduced (async without await)
- ❌ A-04/A-06: Manifest still shows no fixture checksums; methods remain unvalidated
- ❌ G-02/G-04: No startup reconciliation of `pendingGeneration` implemented

---

## Acceptance Criteria Final Status (Iteration 5)

| Category | Criteria | Count | Status | Notes |
|----------|----------|-------|--------|-------|
| **A (Assets)** | A-01 through A-08 | 8 | 🟡 6/8 PASS | A-04/A-06: Fixture checksums absent from manifest; methods disabled but unvalidated. |
| **D (Domain)** | D-01 through D-08 | 8 | 🔴 6/8 FAIL | D-04: Lint error blocks quality gate. D-07: Tests pass. |
| **G (Generation)** | G-01 through G-09 | 9 | 🟡 7/9 FAIL | G-02/G-04: No `pendingGeneration` reconciliation on project load. |
| **Q (Queue)** | Q-01 through Q-06 | 6 | ✅ 6/6 PASS | REST-authoritative; typed blockers; reconciliation working. |
| **B (Bed-Clear)** | B-01 through B-07 | 7 | ✅ 7/7 PASS | Exact headers, status handling, idempotency, Klipper check. |
| **L (Lifecycle)** | L-01 through L-07 | 7 | ✅ 7/7 PASS | Photos wired; result enforced; lifecycle states correct. |
| **S (Security)** | S-01 through S-05 | 5 | ✅ 5/5 PASS | IPC allowlist, no generic primitives, window.open blocked. |
| **P (Delivery)** | P-01 through P-05 | 5 | ⏸️ BLOCKED | Cannot open PR until D-04, A-04/A-06, G-02/G-04 are fixed. |

**Total: 42/56 criteria satisfied. Blocking failures: D-04 (lint), A-04/A-06 (validation), G-02/G-04 (recovery).**

---

## Verdict Rationale

- **D-04 (Lint):** Quality gate MUST pass before any criterion can be PASS. Currently blocked by async-without-await error.
- **A-04/A-06 (Asset Validation):** Methods remain disabled; manifest shows no fixture validation checksums. Goal requires both manifest AND fixture pass review; only manifest shell exists.
- **G-02/G-04 (Durable Context):** Restart recovery not implemented. `pendingGeneration` is persisted but never reconciled on project load. In-flight operations abandoned on app restart.

These are **not minor style issues** — they are missing **functionality** (reconciliation, validation data) and **quality gate compliance** (lint passing). The prior iteration marked A-04/A-06 as passing unchanged from iteration 3; re-audit reveals manifest is still unvalidated. D-07 now passes tests, but D-04 lint gate is newly failing.

**FAIL.**

---

## Status.json Update

Update `.goals/calibration-runtime-integration/status.json` history array:

```json
{
  "iteration": 5,
  "verdict": "FAIL",
  "timestamp": "2026-07-29T05:25:00Z",
  "summary": "D-04 lint error blocks quality gate: async function without await in e2e test. A-04/A-06: Asset manifest unvalidated—no fixture checksums despite methods being disabled. G-02/G-04: pendingGeneration persisted before submit but no reconciliation on project load; restart recovery not implemented. L-03 photos wired correctly. L-05 result enforced at domain layer. D-07 e2e tests pass (22 tests). 42/56 criteria met; three blocking defects."
}
```
