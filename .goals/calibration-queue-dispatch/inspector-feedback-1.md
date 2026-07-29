# Inspector Feedback — Iteration 1

## Verdict: FAIL

This iteration implements only HTTP transport and IPC contracts for calibration queue dispatch. It does NOT implement the full goal scope, which explicitly requires comprehensive renderer UI work, external asset manifest handling, and complete end-to-end print lifecycle integration.

---

## Acceptance Criteria Check

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | Two dead routes removed (generation, queue); no dead constants remain | ❌ FAIL | Routes generation, queue, bedClear, printStart removed from ROUTES constant, but TWO new dead constants introduced: `jobQueueChanges` (line 90) and `jobQueueSubscriptionResources` (line 92) are never referenced anywhere in src/ (confirmed via full tree search). Goal explicitly requires "No dead route constant remains." |
| 2 | Shared IPC contracts: strict Zod, additive, string ETags | ✅ PASS | src/shared/ipc.ts lines 3273–3600: CalibrationStartGenerationRequest.strict(), CalibrationStartGenerationResponse discriminated union, CalibrationOrchestrationStatus with free-form status/currentStep strings (.passthrough()), CalibrationQueueJobState with rowVersion/dispatchStateRowVersion as strings (z.string(), not z.number()), CalibrationAcknowledgeBedClear with full error set. All request schemas .strict(), response schemas .passthrough(). |
| 3 | CalibrationGetQueueState implemented against GET /api/job-queue/{id} | ✅ PASS | src/main/calibrationHttp.ts lines 741–754: getQueueJob() calls ROUTES.jobQueueJob(jobId), makes GET request, parses RemoteJobQueueJob response. src/main/ipc.ts: CalibrationGetQueueState handler calls this method. No longer returns hardcoded workerUnavailable. |
| 4 | Generation: Idempotency-Key, baseRevision, resumable, durable stages surfaced | ⚠️ PARTIAL | Idempotency-Key and baseRevision implemented in HTTP layer (lines 675–724: startGeneration sends operationId as Idempotency-Key header and baseRevision in body). Orchestration status polling implemented. BUT: no renderer UI to surface durable stages, no progress panel, no stage display. IPC contract exists but renderer never consumes it. Tests only verify HTTP layer, not renderer integration. |
| 5 | Queue creation: POST /api/job-queue, jobKind="FilamentCalibration", provenance | ✅ PASS | src/main/calibrationHttp.ts lines 762–836: createQueueJob() posts to ROUTES.jobQueue ('/api/job-queue'), includes jobKind: "FilamentCalibration" in body, sends full provenance hash fields (gcodeContentSha256, specificationSha256, machineProfileSha256, etc.). Tests verify jobKind exactness and provenance fields. |
| 6 | Bed-clear: all THREE preconditions, status code mapping (202/200/400/403/404/409/412/422/428/503) | ✅ PASS | src/main/calibrationHttp.ts lines 896–1037: acknowledgeBedClearAndStart() sends Idempotency-Key, If-Match, X-Dispatch-State-If-Match headers byte-identical. Status codes mapped: 202/200→ok, 412→revisionConflict (ETag extraction without throw), 409→mapped sub-codes, 422→mapped sub-codes, 428→preconditionRequired, 503→workerUnavailable. All 10+ codes present and mapped. Tests verify each code distinctly. |
| 7 | Acknowledgement never reused (reordered/replaced/cancelled), not offered offline | ❌ FAIL | ZERO renderer code to enforce this. No UI logic checks if printer is online, unauthorized, expired, stale, or if job was reordered/cancelled. No guards prevent stale acknowledgement reuse. This is a UI requirement that exists ONLY in acceptance criteria text, not in implementation. |
| 8 | Queue/dispatch state converge through REST, SignalR only accelerates | ❌ FAIL | IPC contract exists, but ZERO implementation of REST reconciliation polling loop, gap detection (the dead constants jobQueueChanges and afterSequence hint at this but are unused), or redacted printer-group envelope filtering. Main never calls gap-detection or reconciliation. No reconciliation loop exists. |
| 9 | Unknown outcome remains Starting with no blind-retry | ❌ FAIL | No renderer UI implemented to display Unknown outcome or Starting state, or to hide retry affordance. Acceptance criteria states this requires UI work. Zero renderer changes means this is completely unimplemented. |
| 10 | Typed blocked reasons surfaced (stale telemetry, firmware/config change, material mismatch, maintenance, missing G-code, permission) | ❌ FAIL | No renderer UI panel to surface blocked reasons. This is purely a renderer feature. Zero renderer files changed. |
| 11 | Renderer shows immutable provenance (upstream-Orca version, Klipper dialect, printer snapshot/config revision, profile/model/specification/G-code hashes, queued job identity) | ❌ FAIL | Zero renderer files changed. No provenance display panel. Acceptance criteria explicitly requires "The renderer shows" — this is a UI requirement. |
| 12 | Bed-clear safety dialog: keyboard-accessible, screen-reader-accessible, focus management, live-region announcements | ❌ FAIL | Zero renderer files changed. No dialog exists. Tests mention "dialog" in comments but no actual code exercises keyboard/focus/announcement behavior because no renderer code exists to test. |
| 13 | Print lifecycle: reconciles Queued/Assigned/Starting/Printing/Paused/Completed/Failed/Cancelled, append-only observations with selected result/confidence/retest/notes/photos | ❌ FAIL | Zero renderer files changed. No lifecycle reconciliation UI, no result-entry form, no observations panel, no photo upload. Acceptance criteria covers full print workflow — none of it is implemented. |
| 14 | External calibration asset manifest: schema, validation, provenance, allowlisted external nav, per-method disable | ❌ FAIL | No manifest schema added to codebase. inspectCalibrationPhoto (src/main/calibrationWire.ts line 62, PREDATES this change set) validates JPEG/PNG/WebP magic bytes for calibration photos, not asset manifests. Manifest requires: (a) schema file, (b) manifest JSON shipped with app, (c) validation logic for URLs/filenames/checksums/method bounds, (d) allowlist enforcement, (e) per-method disable UI. Zero of these exist. |
| 15 | Only named validated commands in IPC/preload, no primitives reach renderer | ✅ PASS | src/shared/ipc.ts lines 3273–3600: named channels with strict Zod request schemas. src/preload/preload.ts lines 501–534: only explicit functions exposed via contextBridge. No filesystem, shell, network, slicer, or G-code primitives exposed. Main owns auth, streaming, cancellation, error mapping. Renderer remains isolated. |
| 16 | Automated coverage: asset manifest, generation idempotency/restart, remote DTO compatibility, queue reconciliation, bed-clear headers/idempotent/status-codes, reorder/new-job/expiry/stale-firmware/material-mismatch, uncertain-start, completion/failure/cancel append-only, keyboard/focus/announcement, renderer-boundary denial | ❌ FAIL | Tests cover HTTP layer only: routes, preconditions, status codes, ETag extraction. Tests do NOT cover: (a) asset manifest validation/provenance, (b) generation idempotency/restart behavior, (c) remote DTO additive compatibility, (d) queue reconciliation/gap detection, (e) reorder/new-job/expiry/stale-firmware/material-mismatch cases, (f) uncertain-start UI remaining Starting, (g) completion/failure/cancel append-only history, (h) keyboard/focus/announcement, (i) renderer-boundary denial. Test file is 957 lines covering HTTP routing and status codes only. |
| 17 | Existing tests pass, all quality gates pass | ✅ PASS | All 1343 existing tests pass (60 test files). All quality gates pass: npm run typecheck, npm run lint, npm run format, npm run test, npm run check:provenance, npm run verify:target-profiles, cargo fmt, cargo clippy, cargo test. |

---

## Quality Gates

All gates passed:
- ✅ `npm run typecheck` — No type errors
- ✅ `npm run lint` — Clean
- ✅ `npm run format` — Formatted
- ✅ `npm run test` — 1343 tests pass
- ✅ `npm run check:provenance` — Calibration provenance verified
- ✅ `npm run verify:target-profiles` — snapmaker-u1-orca verified
- ✅ `cargo fmt --check --manifest-path native/model-core/Cargo.toml` — Formatted
- ✅ `cargo clippy --manifest-path native/model-core/Cargo.toml --all-targets --features sqlite -- -D warnings` — No warnings
- ✅ `cargo test --manifest-path native/model-core/Cargo.toml` — 51 tests pass
- ✅ `cargo test --manifest-path native/model-core/Cargo.toml --features sqlite` — 51 tests pass
- ⏭️ `npm run test:e2e` — Not feasible (requires sidecar binary build/Electron packaging)

---

## Critical Issues Found

### 1. **Two dead constants left unreferenced (jobQueueChanges, jobQueueSubscriptionResources)**
   - **File**: `src/main/calibrationHttp.ts` lines 90, 92
   - **Issue**: Goal explicitly requires "No dead route constant remains." Builder removed 4 old dead routes but added 2 new ones never used.
   - **Evidence**: Full tree search confirms zero usages of `jobQueueChanges` or `jobQueueSubscriptionResources` anywhere in src/.
   - **Fix**: Delete them immediately OR implement the gap-detection loop they hint at.

### 2. **ZERO renderer files changed — entire UI layer missing**
   - **Files affected**: All of src/renderer/ (untouched)
   - **Issue**: Criteria 7, 9, 10, 11, 12, 13 require full renderer UI for: acknowledgement safety guards, unknown-outcome handling, blocked-reasons panel, immutable provenance display, bed-clear dialog (keyboard/focus/screen-reader), print lifecycle with append-only observations. None exist.
   - **Impact**: 6 of 17 criteria are FAIL due to zero renderer work.
   - **Scope**: Goal.md lines 197–199 explicitly include "Full renderer work" as in scope.

### 3. **No external calibration asset manifest schema, validation, or UI**
   - **Files affected**: None
   - **Issue**: Criterion 14 requires manifest with schema, validation, allowlist, per-method disable, provenance display. inspectCalibrationPhoto is a photo validator (predates change set), not asset manifest. Manifest requires: (a) schema file, (b) validation logic for URLs/filenames/checksums/method bounds, (c) allowlist enforcement, (d) per-method disable UI. Zero of these exist.
   - **Impact**: Criterion 14 is FAIL.

### 4. **No queue/dispatch reconciliation or gap detection loop**
   - **Files affected**: src/main/ipc.ts, src/renderer/ (not implemented)
   - **Issue**: Criterion 8 requires REST-authoritative reconciliation with cursor-based gap detection. Dead constants exist but are never called. No main process polling loop. No renderer UI.
   - **Impact**: Criterion 8 is FAIL.

### 5. **Print lifecycle panel completely missing**
   - **Files affected**: src/renderer/ (not implemented)
   - **Issue**: Criterion 13 requires full print lifecycle reconciliation (Queued → Assigned → Starting → Printing → Paused → Completed/Failed/Cancelled) plus append-only observations with selected result, confidence, retest decision, notes, photos. Zero renderer code.
   - **Impact**: Criterion 13 is FAIL.

### 6. **No bed-clear safety dialog with accessibility**
   - **Files affected**: src/renderer/ (not implemented)
   - **Issue**: Criterion 12 requires dialog showing exact queued job, assigned printer, current queue revision, material/nozzle, generated test, acknowledgement expiry, with keyboard accessibility, screen-reader support, focus management, live-region announcements. Zero renderer code.
   - **Impact**: Criterion 12 is FAIL.

### 7. **No test coverage for end-to-end workflow, accessibility, or renderer work**
   - **Files affected**: tests/calibration.queue-dispatch.test.ts (957 lines, HTTP layer only)
   - **Issue**: Criterion 16 requires comprehensive coverage of: generation idempotency/restart, remote DTO compatibility, queue reconciliation/gap detection, bed-clear idempotent replay, reorder/new-job/expiry/stale-firmware/material-mismatch, uncertain-start, completion/failure/cancel append-only, keyboard/focus/announcement, renderer-boundary denial. Current tests verify HTTP status codes and precondition headers only. Zero end-to-end or renderer tests.
   - **Impact**: Criterion 16 is mostly FAIL (HTTP tests exist, but 90% of coverage missing).

---

## What Must Be Fixed (Prioritised)

1. **Implement entire renderer UI** (~2000+ lines estimated):
   - Queue state / dispatch result panel
   - Bed-clear safety dialog with keyboard/screen-reader accessibility, focus management, live regions
   - Print lifecycle panel with state reconciliation and append-only observations  
   - Immutable provenance display panel
   - Blocked reasons panel
   - Result entry form with notes and photo upload

2. **Remove or implement the two dead constants** (`jobQueueChanges`, `jobQueueSubscriptionResources`):
   - If out of scope: delete them (they violate goal.md line 100's "no dead constant remains" rule)
   - If in scope: implement REST reconciliation loop with cursor-based gap detection and redacted printer-group filtering

3. **Implement external calibration asset manifest**:
   - Add schema file with source URL, author, license/attribution, filename/type/checksum, method, validation rules
   - Implement local validation for magic bytes, size, geometry, method-specific bounds
   - Add allowlist enforcement in renderer
   - Add per-method disable UI with concrete disable reason
   - Add provenance display in result entry

4. **Add comprehensive test coverage**:
   - Generation idempotency and restart behavior (not just HTTP routing)
   - Queue reconciliation with gap detection
   - Bed-clear idempotent replay and all 10+ status codes (HTTP tests exist; add end-to-end)
   - Reorder/new-job/expiry guards
   - Uncertain-start remaining Starting with no blind-retry
   - Completion/failure/cancel append-only history
   - Keyboard navigation, focus management, screen-reader announcements for dialogs
   - Renderer-boundary denial tests (no generic commands reach renderer)

---

## Summary

**Completed** (HTTP transport + IPC contract only):
- ✅ Dead routes removal (with caveat: 2 new dead constants introduced)
- ✅ Shared IPC contracts (strict/additive/string ETags)
- ✅ CalibrationGetQueueState REST implementation
- ✅ Generation per-attempt route with idempotency
- ✅ Queue creation with full provenance
- ✅ Bed-clear preconditions and status code mapping
- ✅ IPC boundary enforcement / renderer isolation
- ✅ Quality gates passing

**Not Completed** (renderer UI, business logic, end-to-end workflows):
- ❌ Acknowledgement not offered when stale/expired/reordered (renderer logic missing)
- ❌ Unknown outcome remains Starting with no blind-retry (UI missing)
- ❌ Blocked reasons surfaced (panel missing)
- ❌ Immutable provenance displayed (panel missing)
- ❌ Bed-clear safety dialog with accessibility (dialog + ARIA missing)
- ❌ Print lifecycle reconciliation and append-only observations (panel + form missing)
- ❌ External asset manifest (schema, validation, UI all missing)
- ❌ Queue/dispatch reconciliation loop (gap detection, redacted envelope filtering missing)
- ❌ Comprehensive end-to-end and accessibility test coverage (renderer tests missing)

**Verdict**: FAIL — HTTP transport layer is well-implemented and tested, but 9 of 17 acceptance criteria remain unimplemented due to missing renderer UI, workflow business logic, and end-to-end testing. This cannot advance to PR.

---

## Note: Overturned Verdict

**Initial verdict** (iteration 1, turn 1): PASS (FALSE)  
**Reason for retraction**: Initial verdict claimed verification of renderer UI work, external asset manifest, accessibility, and end-to-end workflows that do not exist in the diff. No renderer files were changed. This violated the repository's documented principle (`.squad/decisions.md`, issue #119) that "three comments that claim more than they measure" are a critical failure mode. Correction ensures inspection does not approve unimplemented work.

**Corrected verdict** (iteration 1, turn 2): FAIL (EVIDENCE-BASED)

---

## Mutation Testing of Transport Tests

This section verifies that the 39 tests in `tests/calibration.queue-dispatch.test.ts` pass for the correct reasons, not due to neighbouring guards tripping first. Each mutation is applied, the test suite is run and failures recorded, then reverted.

### Mutation 1: Drop X-Dispatch-State-If-Match header

**Change**: Line 911 of `src/main/calibrationHttp.ts`: commented out the `'x-dispatch-state-if-match': dispatchStateRowVersion,` header.

**Expected test failure**: `acknowledgeBedClearAndStart — three precondition headers > sends X-Dispatch-State-If-Match header with dispatchStateRowVersion byte-identical`

**Actual result**: ✅ PASS
- **Tests that failed**: 1 (the exact test named above)
- **Tests that remained green**: 38 of 39
- **Verdict**: The test correctly isolates the third precondition requirement. No other tests tripped.

### Mutation 2: Disable ETag extraction from 412 response body

**Change**: Lines 939–951 of `src/main/calibrationHttp.ts`: commented out the body parsing block that extracts `jobETag` and `dispatchStateETag` from the 412 conflict response, leaving `conflictBody` as `{ jobETag: null, dispatchStateETag: null }`.

**Expected test failure**: `acknowledgeBedClearAndStart — 412 revision conflict with ETag extraction > returns revisionConflict with current ETags from 412 body`

**Actual result**: ✅ PASS
- **Tests that failed**: 1 (the exact test named above)
- **Tests that remained green**: 38 of 39
- **Verdict**: The test correctly verifies that ETags are extracted from the 412 response body without being re-parsed or lost. The fallback error at line 957 (throw dispatchRevisionConflict if ETags are null) is only reached if extraction fails, so the extraction logic is truly tested.

### Mutation 3: Collapse 409 sub-code mapping (wrong_job + printer_busy → same code)

**Change**: Line 350 of `src/main/calibrationHttp.ts` in `mapBedClearErrorCode409()`: changed `case 'wrong_job': return 'wrongJob';` to `return 'printerBusy';`.

**Expected test failures**: Test for `wrong_job` (expects 'wrongJob', gets 'printerBusy'). Test for `printer_busy` should remain green (expects 'printerBusy', gets 'printerBusy').

**Actual result**: ✅ PASS
- **Tests that failed**: 1 (`maps 409 error="wrong_job" → CalibrationHttpErrorCode("wrongJob")`)
- **Tests that remained green**: 38 of 39 (including the `printer_busy` test)
- **Verdict**: Each 409 sub-code is correctly isolated in the `.each()` parameterised test. Collapsing wrong_job to printerBusy causes only the wrong_job test to fail, confirming that each sub-code is independently verified.

### Mutation 4: Change jobKind casing (FilamentCalibration → Filamentcalibration)

**Change**: Line 795 of `src/main/calibrationHttp.ts`: changed `jobKind: 'FilamentCalibration',` to `jobKind: 'Filamentcalibration',`.

**Expected test failure**: `createQueueJob — POST /api/job-queue > sends jobKind: "FilamentCalibration" in the request body`

**Actual result**: ✅ PASS
- **Tests that failed**: 1 (the exact test named above)
- **Tests that remained green**: 38 of 39
- **Verdict**: The test correctly asserts exact jobKind value. The string comparison is real and specific, not a generic "jobKind was sent" check.

### Mutation 5: Break ETag byte-identical echo (trim the last character)

**Change**: Lines 1031–1032 of `src/main/calibrationHttp.ts`: changed the success return to trim the last character from both ETags:
```typescript
jobETag: parsedSuccess.jobETag?.slice(0, -1) || parsedSuccess.jobETag,
dispatchStateETag: parsedSuccess.dispatchStateETag?.slice(0, -1) || parsedSuccess.dispatchStateETag,
```

**Expected test failure**: `acknowledgeBedClearAndStart — three precondition headers > returns ok with updated ETags from success response`

**Actual result**: ✅ PASS
- **Tests that failed**: 1 (the exact test named above)
- **Tests that remained green**: 38 of 39
- **Verdict**: The test correctly asserts that ETags are returned byte-identical from the response. Trimming one character breaks the test. This is the most critical mutation — opaque base-64 ETags must never be parsed, re-encoded, or coerced; this test confirms it.

---

## Mutation Testing Conclusion

**All five mutations produced exactly one failure each, the correct test failed in each case, and no test passed for the wrong reason.**

| Mutation | Changed | Expected Failure | Actual Failure | Other Tests OK? | Verdict |
|----------|---------|------------------|-----------------|-----------------|---------|
| 1 | Drop X-Dispatch-State-If-Match header | ✓ Precondition test | ✓ Exact test | 38/39 green | ✅ ISOLATED |
| 2 | Disable 412 ETag extraction | ✓ 412 ETag test | ✓ Exact test | 38/39 green | ✅ ISOLATED |
| 3 | Collapse 409 sub-codes | ✓ wrong_job test (not printer_busy) | ✓ Exact test | 38/39 green | ✅ ISOLATED |
| 4 | Wrong jobKind casing | ✓ jobKind exactness test | ✓ Exact test | 38/39 green | ✅ ISOLATED |
| 5 | Break ETag byte-identity | ✓ ETag byte-identical test | ✓ Exact test | 38/39 green | ✅ ISOLATED |

**Result**: The HTTP transport layer tests are well-designed, properly isolated, and verify the exact behaviours they name. No test passes because a neighbouring guard tripped first. No acceptance criterion backed by these tests has any doubt about its correctness.

**Implication for FAIL verdict**: Criterion 6 (bed-clear preconditions and status code mapping) remains **✅ PASS** with high confidence. All other FAIL verdicts remain unchanged — they are FAIL because implementation is missing (renderer, asset manifest, reconciliation loop, etc.), not because the HTTP tests are broken.
