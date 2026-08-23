# Fact Checker — Recent Sessions

Fact Checker is the verification / devil's advocate agent for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). `.squad/fact-checker/policy.md` and `.squad/fact-checker/audit-trail.md` seeded. No claims verified yet — infrastructure only.

## 2026-08-21: "calibration print → mock printer" reachability

Investigated a "not implemented on server" claim after a prior consequential
misread by another agent this session. Verdict: (c) MIXED — the queue,
bed-clear ack, and dispatch chain are fully implemented in
`OlyForge3D/PrintFarmer@6cf79dee`; only the split-mode routing adapter for the
calibration _generation_ capability probe is unimplemented. The claim as
written was ❌ CONTRADICTED; a narrower, honest form of it (generation is
unroutable in `DEPLOYMENT_MODE=microservices`) is ✅ VERIFIED.

Decision written to `decisions/inbox/fact-checker-calibration-reachability.md`.

## Learnings

- **The DTO-default = "off" pattern is repo-native and easy to misread.** The
  five `*Enabled`/`*Implemented` calibration flags return `false` on the wire
  because the DTO defaults are `false` and only two of the record's members
  are assigned in `CalibrationCapabilityService.cs:224-228`. A flag reading
  `false` in that shape is not a probe result. Control I now use: grep for
  `<FieldName>\s*=` across the whole src/ tree, and prove the search would
  find the assignment by also grepping for a sibling field known to be
  assigned. If a sibling is found and the target isn't, the target is a
  default, not a probe.
- **`405 Method Not Allowed` on OPTIONS is a positive existence signal.** For a
  route that doesn't exist, ASP.NET returns `404`. This is a cheaper existence
  check than probing with the correct verb and body.
- **A live 422 from a saga is proof the saga is wired up**, even if the caller
  intended to probe a later 503 branch. Bishop reported "503 after seeding";
  my probe with an unseeded dummy hit `422 method_unsupported` at the binder,
  which sits before the 503 branch. Two adjacent live responses corroborated
  the same saga's presence.
- **The desktop's `calibrationActionGate.ts` is the source of truth for which
  wire flags actually block a user action.** For the calibration workflow,
  `startPrint` and `acknowledgeBedClear` do not consult any of the five "off"
  flags; only `generate` does, via `calibrationGenerationEnabled`. Do not read
  the wire's shape as the desktop's contract — read `calibrationActionGate.ts`.
- **`known-lying-commands.md` row shape recognised in the wild.** The chain
  "capability doc shows `queueIntegrationImplemented: false` → agent
  concludes 'queue integration missing' → coordinator accepts" is a fresh
  instance of the file's core defect: the flag answers a **neighbouring**
  question ("has the DTO been taught to advertise this yet?") not the one
  asked ("does this code path exist and function?"). The reassuring reading
  is the one that lets the reader stop looking; the harder reading (grep the
  actual service, hit the actual endpoint) reveals the code was there all
  along. Recording this here in case a future session re-encounters the
  same wire.

📌 Team update (2026-08-21T20-06-12Z): Claim 'calibration dispatch unimplemented' CONTRADICTED. Queue integration fully implemented (1101-line service). Split-mode DI blocks only generation (one of eight links). Acceptance goal reachable via Path A. See .squad/orchestration-log/2026-08-21T20-06-12Z-fact-checker.md.

## 2026-08-22T15:43-07:00: Bishop H3 challenge — Problem A empirically proved

Vasquez asked me to attack Bishop's H3 conclusion after Bishop reversed his
Turn 0 findings between turns. Executed the four Qs; decision written to
`.squad/decisions/inbox/fact-checker-calibration-h3-challenge.md`.

**Verdict:** ⚠️ Bishop's H3 is partially correct (Q1 confirms the SPECIFIC
rejection codes reaching the renderer — `firmware_family_unknown` etc. — are
server-authored and pass through untouched, verified by tracing
`explainIneligibility` and grep controls for template-literal construction),
but ❌ CONTRADICTED on his blanket Turn 1 statement that "every desktop piece
behaves correctly."

**Problem A empirically proved** with a temporary in-repo test (removed after
the check). Same `createCalibrationState` input, only the three safety
booleans flipped between runs:

- Predicate (three `false`, matching the wire projection at
  `calibrationWire.ts:1113-1117`): `DIAG CODES: [ 'INCOMPLETE_SAFETY_CONTEXT' ]`
- Control (three `true`, all else identical): `CONTROL CODES: []`

The three booleans are the sole gate. The wire layer hardcodes them false.
The operator's four checkboxes in `NewCalibrationProject.tsx` are collected
into `form.emergencyStop/thermalProtection/ventilation/machineClear`, used
for the wizard's OWN blocker list, and then NOT passed to
`bindingFromContext`. `bindingFromContext` sets `safety: context.safety`
verbatim from the wire projection. `hasCompleteSafetyContext` in
`eligibility.ts:35-40` requires all three true. Inescapable gate.

**Bishop's self-contradiction:** Turn 0 durable learning #4 identified this
exactly ("the CONSUMER contract must be updated too") and proposed Fix #1
(relax `bindingDiagnostics`). Turn 1 pivoted to "H3 confirmed" and quietly
dropped Fix #1 while keeping two smaller proposals that do not touch the
gate. Vasquez's suspicion was accurate.

**Minimal fix identified:** Remove the three-boolean check from
`hasCompleteSafetyContext` — aligns with the explicit design intent in
`calibrationActionGate.ts:346-360` where operator safety confirmation is
routed through `input.operatorAcknowledgement`, NOT `context.safety`.
Preserves all machine-moving safety at the action-gate boundary. Bishop had
the same fix in Turn 0.

### Durable learnings

1. **A hypothesis "the server is wrong" can be true AND still be a wrong
   answer, when a separate desktop bug will strand the fix.** Q1 confirmed
   Bishop's H3 on the immediate symptom. Q2 showed calibration is dead even
   after the server is fixed. Both can be true simultaneously; the report
   must name both.
2. **When an investigator identifies a bug in Turn 0 and drops it in Turn 1
   with no explicit reason, that gap is exactly where the fact-checker
   earns his keep.** The known-lying-commands file's underlying rule — "the
   reassuring reading is the one that lets the reader stop looking" —
   generalizes to investigator conclusions, not just shell commands.
3. **Predicate/control on the SAME data, not on similar data, is decisive.**
   A grep for synthesised codes returning zero is not enough on its own —
   the SAME grep must return large positive results on a control corpus
   (the shared catalogue) to prove the instrument is discriminating. I did
   this. It saved a claim.
4. **`.catch(null)` on a Zod field whose shape can drift server-side is
   invisible on every green test.** `calibrationWire.ts:2216-2218` swallows
   any shape change in `CalibrationWorkspacePayload`. Not this bug, but the
   single most dangerous line in the calibration wire code. Filed as
   deferred fix in the decision.

## 2026-08-22T19:11-07:00: Re-verification for the profile-selection build

Vasquez asked me to re-run the Bishop-vs-Dallas disagreement one more time
before the profile-selection flow (printer → machine profile → process →
filament → slicer worker → queued job) is built. The owner had just specified
how calibration must work end-to-end, and the risk was that a
correctly-implemented profile flow would still fire `INCOMPLETE_SAFETY_CONTEXT`
on the very first `createCalibrationState`.

**Result — same verdict as 2026-08-22T15:43, re-confirmed with a fresh
empirical test:** the wire's hardcoded `false` triple at
`calibrationWire.ts:1115-1117` reaches `binding.snapshot.safety` via
`bindingFromContext` (`projectEligibility.ts:325` — literally `safety:
context.safety`), and `bindingDiagnostics` fires `INCOMPLETE_SAFETY_CONTEXT`
on every real `createCalibrationState` call. Throwaway test at
`tests/_fact-checker-safety-gate.test.ts` PASSED both assertions in 1.24 s,
deleted after run.

Newly documented on this pass:

1. **The operator-checkbox seam Dallas thought existed does not exist.**
   `bindingFromContext(profileId, context, toolId, filament)`'s signature
   admits no channel for the checkbox values. They are collected into
   `form.*`, used only as wizard blockers
   (`NewCalibrationProject.tsx:298-304`), and dropped before the binding is
   built. Written down explicitly so the next session doesn't have to
   re-derive it.
2. **Q4 partial correction to my prior report.** `permissions === null` at
   `calibrationWire.ts:1124` is hardcoded and never overwritten, but its ONLY
   live consumer is `ProjectOverview.rebaseBlockers` (line 67-84), NOT the
   create-project path (`contextEligibilityBlockers` at
   `projectEligibility.ts:153-159` deliberately skips it). So creation is
   blocked by safety only; rebase is blocked by both. Fix scope must include
   both, or rebase stays dead after we fix creation.
3. **Recommended two-line fix, restated:** relax `hasCompleteSafetyContext`
   in `eligibility.ts:37-40` to drop the three boolean checks, keeping the
   positive-dimensions check. Matches the design intent already written in
   the producer's comment (`calibrationWire.ts:1085-1097`) and in the sibling
   wizard's blocker (`projectEligibility.ts:153-159`). PLUS strip
   `context.permissions` from `ProjectOverview.rebaseBlockers` (or read
   effective permissions from the capability payload instead, matching the
   existing action-gate design).

Decision written to
`.squad/decisions/inbox/fact-checker-calibration-safety-gate.md`.

### Durable learning

5. **Same disagreement re-litigated 3.5 hours later needs the same answer,**
   **written to a new decision file, not appended to the old one.** Vasquez
   is deliberately re-checking before the profile-selection PR ships, and my
   prior decision file at `fact-checker-calibration-h3-challenge.md` was
   framed around Bishop's H3 pivot — an off-topic entry for a reviewer coming
   in cold on the profile-selection change. A same-verdict, new-frame
   decision is not duplication; it's addressing the current audience.

## 2026-08-22: Calibration safety-gate verification (FINAL — all path C gates confirmed)

📌 Team update (2026-08-22T21:30:47Z): Final confirmation for path C before merge: safety-gate defect and fix scope verified. Dallas's safety-gate fix (operator attestations wired through binding) already landed; Fact Checker empirically confirmed hardcoded-false interlocks + hardcoded-null permissions, both now removed from diagnostic checks per Option A+C. Rejection-code tracing confirmed server-authored codes pass through wire intact. `bindingDiagnostics` is live consumer on two paths (create + rebase). Full decision chain: `.squad/decisions.md` calibration entries document all four Q findings. Path C cascade, profile selection, and end-to-end wiring confirmed ready for merge. See `.squad/orchestration-log/2026-08-22T21-30-47Z-fact-checker.md`.
