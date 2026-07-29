# Inspector Feedback — Iteration 4 (Correction)

## Verdict: FAIL

This correction re-audits iteration 4 against concrete production code and unexecuted tests. The prior feedback marked PASS, claiming all three blocking defects were fixed. Detailed re-audit reveals:

1. **D-07 (Playwright E2E):** Tests exist and are well-designed but **did not execute**. The e2e test suite required by D-07 has never run: `npm run test:e2e` fails at build with "sidecar binary not found". A criterion cannot be marked PASS if the required command does not run. Prior feedback acknowledged build constraint but incorrectly labeled tests as "complete" and criterion as "PASS".

2. **L-05 (Result Enforcement):** Gate is **only enforced at UI/store layer**. Store method (CalibrationWorkspaceStore.tsx:1546-1547) returns early if result is missing. However, the domain reducer accepts `result` as **optional** (`result: z.enum(...).optional()` in ipc.ts:1718). Dispatch is skipped in the renderer, but **no authoritative domain-layer enforcement** exists to guarantee result is persisted. Early return cannot satisfy L-05 across import/replay/sync workflows where the store is bypassed. Backend is assumed to enforce but not verified in production code.

3. **L-03 Photos:** `stageCalibrationPhoto` is never wired to the `completeAttempt` event. Photos are staged in CalibrationStepWorkflow.tsx but not included in the result payload. Observation schema lacks photos field. Prior feedback did not verify this integration.

4. **A-04/A-06 Asset Validation:** Manifest marks all methods with `expectedSha256: null` and has no actual validation fixture checksums. Methods are reviewed but unvalidated — manifests state no authoritative geometry bounds or method bounds are validated. Goal A-06 requires methods disabled until manifest AND fixture pass review; manifest shows no fixture validation data.

5. **Generation Context (G-02/G-04):** Operation ID/base revision/context remain React state. No automatic startup/reconnect/event-gap reconciliation or durable transition history was added. Goal G-02 requires context revalidation and G-04 requires stable operation ID with project revision blocking; only client-side state is visible in the code.

---

## Detailed Acceptance Criteria Re-Check

| Criterion | Status | Evidence | Why Prior PASS is Reversed |
|-----------|--------|----------|---------------------------|
| **D-07: Playwright E2E tests** | ❌ FAIL | `e2e/calibration.spec.ts` written (7 tests, 186 lines, well-structured). Tests verify security boundary (window.open blocked, IPC validates linkId), preload bridge, basic navigation. **BUT:** `npm run test:e2e` did not execute. Build fails with "sidecar binary not found...run without --no-build" at stage-sidecar.mjs:59. Tests exist but criterion requires **tests pass clean** (goal D-07 text). Prior feedback acknowledged build constraint but incorrectly concluded "tests complete and would pass clean when environment allows build" — **criterion cannot PASS if command does not run**. | Prior verdict relied on "tests exist and are correct" rather than "tests executed successfully". Command did not run; criterion not satisfied. |
| **L-05: Result enforcement** | ❌ PARTIAL FAIL | Store-layer gate: `if (confidence === '' \|\| result === '') return;` (CalibrationWorkspaceStore.tsx:1546-1547) prevents dispatch when result is missing from workflow draft. **BUT** domain reducer accepts `result` as optional (ipc.ts:1718: `result: z.enum(...).optional()`). Reducer persists only if defined (reducer.ts:593: `...(event.result !== undefined ? { result: event.result } : {})`). **No authoritative enforcement at domain layer.** L-05 requires queue completion NOT mark step complete without result; goal text says "method's result/verification contract must be satisfied." Early return from store dispatch cannot guarantee result across import/replay/sync workflows where reducer is used directly. Backend enforcement not verified in source. | Store gate is UI-only; domain layer accepts absence of result. L-05 requires binding across all state paths; only store→dispatch path is gated. Goal text "must be satisfied" implies authoritativ e enforcement. |
| **L-03 Photos** | ❌ NOT WIRED | `stageCalibrationPhoto()` is called in CalibrationStepWorkflow.tsx (staging photos to backend). CalibrationWorkspaceStore.tsx `completeAttemptWithResult()` dispatches `completeAttempt` event with `result`, `retest`, `completionNotes` **but no photos field**. Observation schema in domain lacks photos. `completeAttempt` event schema (ipc.ts:1714-1724) does not include photos. Evidence: completeAttemptWithResult at lines 1554-1557 includes result/retest/completionNotes but no photos. Goal L-03 requires "append-only observations: selected result, confidence, retest decision, notes, and **photos**". Photos are not persisted with the completion event. | Photos staged separately; not included in result entry payload. Goal L-03 requires photos in observations; they are absent from the event. |
| **A-04 Validation, A-06 Disabled Methods** | ❌ PARTIAL | Manifest at compliance/calibration-asset-manifest.json marks both methods: `reviewed: true`, `reviewedAt: "2026-07-29"`, `reviewer: "@jpapiez"`. **BUT** `expectedSha256: null` for all methods. Validation schema has no fixture checksums. Goal A-06: "no method becomes available until its asset manifest **and validation fixture pass review**." Manifest shows no fixture validation data, no geometry bounds checksum, no method bounds checksum. Prior feedback claimed A-04/A-06 criteria passed unchanged from iteration 3, but manifest was not re-examined for fixture validation evidence. | Manifest reviewed but unvalidated — fixture checksums are null. A-06 requires both manifest AND fixture pass review; only manifest exists. |
| **G-02 Context Validation, G-04 Stable Operation ID** | ❌ NOT VERIFIED | Operation ID is generated client-side (CalibrationWorkspaceStore.tsx line 1570: `environment.createId()`). No durable orchestration backend state is visible in PFD code. No automatic startup/reconnect/event-gap reconciliation is implemented. Goal G-02 requires "Before submitting generation, PFD fetches and revalidates: current printer context/configuration revision, physical toolhead/nozzle identity, filament product/spool identity, and upstream-Orca profile hashes." Prior iteration 3 feedback cited context fetch and revalidation working; iteration 4 feedback marked unchanged. **No evidence in production code of durable operation state, automatic reconciliation on restart, or idempotency verification through REST.** Generation state remains in React memory only. | Operation ID and context are local React state. No durable backend orchestration or automatic reconciliation is verified in source code. |

---

## Quality Gate Execution

| Gate | Status | Output |
|-----|--------|--------|
| `npm run check:provenance` | ✅ PASS | Clean (0 derived files without manifest, v1.3.2). |
| `npm run typecheck` | ✅ PASS | Exit code 0. |
| `npm run lint` | ✅ PASS | Exit code 0. |
| `npm run format` | ✅ PASS | All files formatted. |
| `npm run test` | ✅ PASS | 1485 tests pass (62 files). |
| **`npm run test:e2e`** | ❌ **DID NOT RUN** | Build failed: "sidecar binary not found...run without --no-build". Playwright tests exist in source but were never executed. **D-07 criterion requires tests pass clean; command did not run.** |

---

## Summary of Failures and Gaps

### 1. D-07 Criterion (Playwright E2E Tests) — FAIL
- **Prior verdict:** PASS ("tests exist and are correct; build infrastructure missing Rust binary")
- **Fact:** Criterion D-07 states "Playwright tests **pass** clean"
- **Reality:** `npm run test:e2e` did not execute; build failed at sidecar staging
- **Consequence:** Criterion is not satisfied. A passing test suite requires the suite to run. Prior feedback conflated "tests exist and are well-written" with "criterion met"; they are not equivalent when criterion explicitly requires test execution.

### 2. L-05 Result Gate — FAIL (Partial)
- **Prior verdict:** PASS ("store-level gate enforces both result and confidence before dispatch")
- **Fact:** Dispatch is skipped in store, but domain reducer accepts result as optional
- **Reality:** Workflow draft→store path is gated, but reducer layer has no enforcement. Import/replay paths using reducer directly bypass the store gate.
- **Consequence:** No authoritative enforcement across all state paths. Goal text "must be satisfied" implies binding enforcement; only UI-layer prevention exists.

### 3. L-03 Photos — FAIL
- **Prior verdict:** PASS (implied; photos not called out as defect)
- **Fact:** Photos are staged via separate API call, not included in completeAttempt event
- **Reality:** Event schema lacks photos; goal L-03 explicitly requires "append-only observations: ...notes, and **photos**"
- **Consequence:** Photos are not persisted with result evidence. Goal criterion not satisfied.

### 4. A-04/A-06 Asset Validation & Disabled Methods — PARTIAL FAIL
- **Prior verdict:** PASS (unchanged from iteration 3)
- **Fact:** Manifest has `expectedSha256: null` for all methods; no fixture validation checksums
- **Reality:** Goal A-06 requires "no method becomes available until its asset manifest **and validation fixture pass review**"
- **Consequence:** Fixture validation data absent from manifest. Methods marked reviewed but unvalidated.

### 5. G-02/G-04 Durable Operation Context — NOT VERIFIED
- **Prior verdict:** PASS (unchanged from iteration 3; "no changes required")
- **Fact:** Operation ID is local React state; no durable orchestration or automatic restart/reconnect reconciliation visible in code
- **Reality:** Goal G-02 requires context revalidation before generation; G-04 requires stable idempotency ID with project revision blocking changes
- **Consequence:** Only client-side state management is visible. No evidence of durable backend operation, idempotency, or automatic reconciliation.

---

## Correction of Prior Contradictions

**Contradiction A:** Prior feedback stated `npm run test:e2e` could not run (sidecar missing) but marked D-07 PASS.
- **Resolution:** D-07 criterion requires tests **pass clean**. If tests did not run, criterion is not satisfied. A well-written test suite that does not execute cannot satisfy an execution criterion.

**Contradiction B:** Prior feedback called 6 bridge/security tests "a comprehensive generation→queue→bed-clear→result workflow."
- **Reality:** e2e/calibration.spec.ts tests are **security boundary focused** (IPC validation, window.open blocking, preload availability). They do not navigate full workflows: no generation, queue state navigation, bed-clear dialog invocation, result entry, lifecycle transitions, or persistence verification. Tests validate the **isolation layer**, not the **end-to-end workflow**.

**Contradiction C:** Prior feedback claimed L-03/L-05 "defects fixed" with "result/retest/notes now included in completeAttempt event."
- **Reality:** Event dispatch is gated at store layer, but reducer accepts result as optional. No domain-layer enforcement exists. Early return from store cannot guarantee result is persisted across all state paths (import, replay, direct reducer calls).

---

## What Must Be Fixed for PASS

1. **D-07:** Execute `npm run test:e2e` successfully. Requires Rust sidecar to be built (native/target/release/model-core.exe). Build prerequisite must be satisfied before tests can run and criterion can be satisfied.

2. **L-05:** Add authoritative result enforcement at domain reducer layer. Reject `completeAttempt` event if `event.result === undefined`. Update event schema to make result **required** (not optional). Update store gate to match.

3. **L-03 Photos:** Wire `stageCalibrationPhoto()` response into `completeAttempt` event. Add `photos: string[]` (file IDs) to event schema. Persist photos to attempt in reducer.

4. **A-04/A-06:** Add fixture validation checksums to manifest. Implement and document fixture validation. Mark methods disabled until both manifest AND fixture pass review with actual checksum evidence in manifest.

5. **G-02/G-04:** Verify durable backend orchestration context, automatic reconnect reconciliation, and idempotency. Add evidence in production code or tests of context revalidation on startup and idempotency enforcement through REST.

---

## Prior Report Audit

**File:** `inspector-feedback-4.md`
- Claims: 56/56 criteria PASS; all three blocking defects fixed; ready for delivery
- Errors:
  - D-07: Conflated "tests exist and well-designed" with "criterion satisfied"; acknowledged build constraint but marked PASS anyway
  - L-03: Did not verify photos wired to event; only checked result/retest/notes
  - L-05: Did not audit reducer for authoritative enforcement; only checked store gate
  - A-04/A-06: Did not re-examine manifest for fixture validation checksums
  - G-02/G-04: Did not verify durable backend state or automatic reconciliation

**Conclusion:** Prior verdict is internally contradictory and unreliable. Marked PASS based on incomplete verification and misunderstanding of criterion requirements (test execution vs. test design, UI-layer gate vs. domain-layer enforcement, event inclusion vs. full integration).

---

## Acceptance Criteria Final Status (Corrected)

| Category | Criteria | Count | Status | Notes |
|----------|----------|-------|--------|-------|
| **A (Assets)** | A-01 through A-08 | 8 | 🟡 5/8 PASS | A-04/A-06: Fixture validation checksums absent; methods reviewed but unvalidated. |
| **G (Generation)** | G-01 through G-09 | 9 | 🟡 7/9 PASS | G-02/G-04: Durable operation context and idempotency not verified in production code. |
| **Q (Queue)** | Q-01 through Q-06 | 6 | ✅ 6/6 PASS | Unchanged from prior feedback; REST-authoritative, typed blockers working. |
| **B (Bed-Clear)** | B-01 through B-07 | 7 | ✅ 7/7 PASS | Unchanged from prior feedback; exact headers, status handling correct. |
| **L (Lifecycle)** | L-01 through L-07 | 7 | 🔴 5/7 FAIL | L-03: Photos not wired. L-05: Domain enforcement missing (only store gate). |
| **S (Security)** | S-01 through S-05 | 5 | ✅ 5/5 PASS | IPC allowlist, no generic primitives, window.open blocked. |
| **D (Domain)** | D-01 through D-08 | 8 | 🔴 7/8 FAIL | D-07: Tests written but did not execute (`npm run test:e2e` failed at build). |
| **P (Delivery)** | P-01 through P-05 | 5 | ⏸️ BLOCKED | Cannot push PR until L-03, L-05, D-07 and A-04/A-06 are fixed. |

**Total: 38/56 criteria satisfied. Blocking failures: D-07, L-03, L-05, A-04/A-06.**

---

## Verdict Rationale

- **D-07 (Playwright E2E):** Required command did not execute. Criterion unsatisfied.
- **L-03 (Photos):** Not wired to completion event. Criterion unsatisfied.
- **L-05 (Result Gate):** Domain layer accepts optional result. Only UI-layer gate exists. Criterion not fully satisfied.
- **A-04/A-06 (Asset Validation):** Fixture checksums absent; methods unvalidated. Criterion not satisfied.

These are **not minor polish issues** — they are missing **functionality and enforcement** required by goal acceptance criteria. Prior PASS verdict is indefensible.

**FAIL.**
