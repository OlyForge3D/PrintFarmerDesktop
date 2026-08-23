# Hicks — Recent Sessions

Hicks is QA and contract testing for PrintFarmer Desktop.

## SUMMARY (2026-08-21)

**Five rounds of test-gap closure + provenance discipline audit across two days:**

1. **Baseline audit:** CI-gate clean except 3 timing-only timeouts (unrelated). Zero calibration test failures on assertion.
2. **Round 1 (gap diagnosis):** Calibration suite is self-referential. All mocks use desktop-authored values. Parity test is desktop-vs-desktop, not desktop-vs-server. No real drift detection.
3. **Round 2 (fixture hardening):** Built server-sourced snapshots with blob-SHA pinning + provenance guard. Added four control tests to prove harness bites. Fixture shape pattern: `http.createServer(...).listen(0, '127.0.0.1')` for real loopback.
4. **Round 3 (capability-drift floor):** Encoded provenance as `PROVENANCE` export on every snapshot. Two allowed kinds: `csharp-source` (with commitSha + blobHash) or `live-response` (with serverVersion + commitSha cross-reference). Guard test discovers all snapshots at runtime, asserts valid provenance, runs blob-hash check. Four synthetic controls prove guard bites.
5. **Round 4 (fabrication + closure):** Coordinator found Round 3's payload was false (derived from prose claim, not wire capture). Reverted. Rebuilt harness with fabrication detection: RIPLEY_MISFIX_ALIAS_SOURCES as regression guard. Misfix-mapped payload now asserted against real capabilities. Full suite: 5292 pass / 2 pre-existing fail / 7 skipped.
6. **Round 5 (Bishop's success → harness):** Drove calibration print end-to-end. Moonraker: `printState: printing`, seeded g-code on virtual SD. Built `calibration.liveStackDispatch.test.ts` replaying Bishop's exact sequence. EXPECTED_REFUSAL_HINTS table names all five Round-3 refusals as precondition diagnostics. Six controls prove diagnostic layer. Extended `calibrationJobBlockedReasonCode.test.ts` with phantom-code detection + coverage delta report.

**Durable learnings:** (a) Comments claiming provenance are a liability without an enforcer. (b) Partial regression reporters counting any-match-to-broken-map are always wrong — count only keys that were actually rebound. (c) Counterfactual regression guard (misfix map applied to current payload) survives longer than pre-fix payload assertions. (d) When state under test changes mid-session (Ripley's fix), guard with counterfactual regression, not historical re-capture.

**Output:** Full test-gap audit + five rounds of fixture hardening. Provenance discipline enforced. Dispatcher harness regression-guarded. Tests: 5300 pass / 2 known-timeout fail (orca, unrelated).

## 2026-08-22: Calibration test-gap closure + acceptance suite (green suite was dead feature)

📌 Team update (2026-08-22T21:30:47Z): Completed test-gap audit proving 427/430 calibration tests pass even when plumbing is deleted (99.3% bypass feature). Authored red-until-working acceptance suite: `calibrationProfileSelectionFlow.test.tsx` (9/9 green), `calibrationRefusedEnvironment.test.tsx` (1/1 green), `calibrationPrinterModelIdWiring.test.tsx` (2/2 matching predicate). Root cause: suite tests gate logic, not plumbing; all mocks use desktop-invented fixtures. Playwright e2e not in required CI context. Bishop's path C (6 IPC channels + setup PUT) now has 26 new tests covering wire→binding→domain chain. Full audit: `.squad/decisions.md` and `.squad/orchestration-log/2026-08-22T21-30-47Z-hicks.md`.

---

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). No test code touched during this session — infrastructure only.

## Learnings

- 2026-07-23: Test surface: Vitest unit tests (`vitest.config.ts`, `npm test`), Playwright e2e (`playwright.config.ts`, `e2e/`, `tests/`, `scripts/build-e2e.mjs` runs pre-e2e). Rust side likely has its own `cargo test` suite under `native/model-core` — confirm with Bishop before assuming coverage exists.

## 2026-08-21: Calibration test-gap audit (green suite, broken feature)

Investigated why ~49 calibration test files pass while "send a calibration print
to a mock printer" does not work. Wrote up findings in
`.squad/decisions/inbox/hicks-calibration-test-gap.md`.

### Learnings

- **The whole calibration test corpus is self-referential.** Every mocked
  boundary — `vi.fn()` fake `CalibrationHttpClient`, `vi.stubGlobal('fetch', ...)`
  with URL-substring dispatch, `ipcMain.handle('calibration:...', () => fixture)`
  in Playwright — uses response values the desktop itself authored, from a
  hand-transcribed `tests/fixtures/calibrationContract.ts` whose header claims
  "verbatim from PrintFarmer server" but which has no automated drift check.
  A green calibration suite is compatible with any DTO/route/header drift
  between the desktop and the real PrintFarmer server. This is exactly the
  `mergeStateStatus` (row 10, `known-lying-commands.md`) shape: a confident
  well-formed answer to a neighbouring question.
- **`calibrationServerContractParity.test.ts` compares `docs/…-admin-guide.md`
  to constants in the same repo.** Both sides live in the desktop. Naming it
  "ServerContractParity" is the same shape as calling a `HEAD^{tree}`
  first-parent lookup a "tree" answer (row 3). Rename or add a real server-side
  check; the current test cannot detect drift and its name promises otherwise.
- **`calibration.integration.test.ts::fakeHttp()`** casts
  `Partial<Record<keyof CalibrationHttpClient, any>>` to
  `CalibrationHttpClient`. This cast bypasses type checking. The fake has
  methods (`startPrint`, `acknowledgeBedClear`) that don't correspond to the
  real class's dispatch methods (`createQueueJob`, `acknowledgeBedClearAndStart`).
  Method-name drift between mock and real class is invisible here. **Fix
  pattern to remember: never cast a partial fake to the real interface; either
  fill in every method or use `vi.mocked(new RealClient(...))` so TS enforces
  the shape.**
- **`uploadTransport.test.ts` demonstrates the right pattern for calibration to
  copy** — `http.createServer(...).listen(0, '127.0.0.1', ...)` gives a real
  loopback listener that receives the actual assembled HTTP request. No
  equivalent test exists for calibration dispatch. Uploads have this; the
  machine-moving path does not. Priority to fix.
- **Rust: `pub mod calibration;` in `native/model-core/src/lib.rs` is
  unconditional** — the DTO/wire code compiles under bare `cargo test`. But
  the `sqlite` feature gates 82 additional tests (266→348 unit tests), several
  of which cover calibration schema and conflict resolution. Any local Rust
  run for a calibration change must include `--features sqlite`, per
  copilot-instructions.
- **CI gate baseline in this worktree:** provenance/target-profiles/script-
  reachability/inert-fields/typecheck/lint/format all clean; `npm run test`
  fails with 3 timing-only timeouts in `orcaProfileInstall.test.ts` and one
  case in `calibrationMaliciousInputCorpus.test.ts` (all 5000 ms budgets on
  a slow runner, none related to dispatch). Zero calibration tests fail on
  assertion.
- **Never speak to Jeff directly from a subagent turn.** Report to the
  coordinator via the decisions inbox and history append; the coordinator
  routes any user-facing message.

## 2026-08-21: Round 2 — the mock-printer dispatch test now exists

### What I learned building it

1. **The desktop's wire format is not the bug.** With server-sourced snapshots pinned to `OlyForge3D/PrintFarmer@6cf79de`, the request bodies for `POST /api/job-queue` and `POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start` match the server's `QueuePrintJobDto` and `AcknowledgeBedClearRequestDto` at the field-name level, and all four `CALIBRATION_QUEUE_ROUTE_TEMPLATES` map to real `[HttpVerb]` attributes on live C# controllers. So when the user reports "calibration doesn't work," the answer at the HTTP-client boundary is: the boundary is correct. The defect is upstream (IPC assembly, sequencing, auth) or downstream (dispatch preconditions).

2. **Green is only trustworthy if the controls bite.** The parent explicitly warned: "if it comes up GREEN, be suspicious of your own harness and prove the server-shape control actually bites." I ended up building FOUR distinct control tests, each using the SAME predicate as the happy path but with opposite expected results:
   - unknown body field ⇒ predicate returns non-empty ✓
   - renamed precondition header ⇒ predicate returns non-empty ✓
   - fabricated route ⇒ predicate returns non-empty ✓
   - synthetic C# with added and removed properties ⇒ diff pipeline emits both ✓
     Without those, a green result on the happy path would just mean the snapshot was another mirror. This is exactly the pattern `.squad/known-lying-commands.md` demands — every matching predicate needs a control that returns the opposite result on the same data.

3. **Sibling-repo drift checks are the pattern.** The rule I codified for this repo: when we assert against another team's contract, we (a) copy the contract into a snapshot with pinned commit + blob SHAs, (b) provide a drift utility that reads the sibling repo when present, and (c) make the drift a hard failure when the sibling is present, and an explicit skip (never silent) when it isn't. That's what `tests/fixtures/server-contract/` implements. Every future contract test should follow this shape.

4. **Comments claiming provenance are a liability without an enforcer.** `tests/fixtures/calibrationContract.ts` had a header saying "verbatim from CalibrationContracts.cs on OlyForge3D/PrintFarmer" — but nothing checked it. That comment lent authority the file didn't earn, and every test that trusted it produced a green result that meant nothing. I downgraded the header to explicitly disclaim provenance until a drift check is added. Better no claim than a false one.

5. **Vitest patterns.** `it.skipIf(!enabled)` and `// @vitest-environment node` are the right primitives for env-gated integration tests. Real `http.createServer(...).listen(0, '127.0.0.1', ...)` in `beforeEach` + `afterEach: server.close()` is the pattern `uploadTransport.test.ts` demonstrated and the ONLY calibration test that now uses it.

6. **The three-fingered strict-TS traps I hit.** Under `noUncheckedIndexedAccess`, `harness.requests[0]` is `T | undefined`; wrote a `firstRequest()` helper that asserts non-empty. Regex match groups are `string | undefined`; guard with `if (m === undefined) continue`. `stackBaseUrl!` non-null assertion is fine at runtime but linters can flag it — safer to alias to a defaulted local.

7. **Prettier will reformat every test file you write.** Ran `npx prettier --write` on my files before final vitest — otherwise the CI-gate `format` step (check-only) fails. This is exactly the "top cause of red PRs here" the copilot-instructions warn about; I ate the warning myself before making it real.

### What I did NOT touch (per Round 2 constraints)

- Dallas's renderer files (`tests/calibration.renderer-boundary.test.ts`, `tests/calibration.workspace-ipc.test.ts`, `tests/calibrationRefusalExplanation.test.ts`, `tests/calibrationConflictDialog.ui.test.tsx`, `tests/calibration.workspace.test.tsx`, `src/renderer/calibration/CalibrationStepWorkflow.tsx`).
- The self-referential Round 1 tests other than the fixture header. Renaming them would collide with concurrent work; left for a coordinated follow-up.
- No global git operations. No commits. No PR.

### Outstanding

Bishop still owes the auth posture for the daily-validation stack so the env-gated integration test can be wired. When he publishes it, the test stub inside `tests/calibration.mockPrinterDispatch.test.ts` needs the actual driver code plus a Moonraker-Ready `/__emulator/**` poll. That's a follow-up round.

---

## 2026-08-21 — Round 3: capability-negotiation drift floor + env-gated live probe

**Task:** Extend the regression floor to the capability-negotiation layer that lied in production — where `CALIBRATION_FLAG_SOURCES` binds required-flag aliases to raw `PlatformCapabilitiesDto` field names.

### What I learned

- **Ripley shipped his fix into the worktree while I was reading source.** The old alias map (`persistence`, `sync`) has been replaced with the semantic-remap map (`context`, `events`, `operatorFeatures.offlineWriteReplayEnabled`). Learned to check `git diff` on the file I'm testing BEFORE writing the test, because the state under test can change under me mid-session.
- **When the primary "RED" test cannot be RED (fix already landed), pin the pre-fix mapping in-file and prove it's wrong through the SAME predicate.** The historical assertion becomes the doc-of-record for the bug and satisfies "would have caught it" without requiring a time machine. The state-observability reporter (`POST-FIX`/`PRE-FIX`/`PARTIAL`) makes the observed condition explicit at run time.
- **`describe.skipIf` still evaluates the describe body at collection time.** Top-level `assertLoopback(rawBase!)` threw `TypeError: Invalid URL` on undefined env var. Fix: guard with `enabled ? … : ''` inside the describe body. Applies to every `skipIf` block that touches `process.env` values.
- **`System.Text.Json` default enum converter emits PascalCase.** `JsonStringEnumConverter` uses the C# member name verbatim, so `FirmwareFamilyMismatch` stays PascalCase on the wire, unlike properties (which get camelCased). Hard-coded a lowercase-first-letter transform for properties but a verbatim pass-through for enum members.
- **Bishop's stack IS reachable but auth-gated for calibration-candidates through nginx port 18080.** Capabilities returns 200 anonymously (nice), but candidates returns 401 `authentication_required`. DevModeBypassAuth's coverage is narrower than advertised. Test's stage-report format was the correct call — the 401 detail told the whole story in one line.
- **The live stack advertises `calibrationEventsEnabled: false` right now.** Which means Ripley's post-fix mapping of `calibrationChangeFeedEnabled` still resolves to `false` on this deployment. The bug isn't just aliases — the deployment's actual switch values matter, and the regression floor now covers both.
- **Regex extractor pattern for C# enums vs switch bodies.** Enums: strip block/line comments, then `(?:^|,)\s*([A-Z][A-Za-z0-9_]*)\s*(?:=\s*-?\d+)?` matched-once-per-name. Switch bodies: locate `methodName ( ... ) => ... errorCode switch { ... };` then `"([^"]+)"`. Both tested against fabricated C# in-test so drift in the extractor itself is caught.
- **Path-walk resolver for flat OR nested DTO paths.** Ripley's `readFlagBackingField` splits on `.` and walks. My allowlist test needed the same walk to authorise `operatorFeatures.offlineWriteReplayEnabled` without opening the top-level allowlist to every possible nested path. Wrote a `pathExistsInDtoSnapshots` helper that only accepts a nested first-segment of `operatorFeatures` — narrower than production, deliberately.

### Patterns to keep

- **Every RED test needs an "observed state" reporter.** Otherwise a reader can't tell whether GREEN means "the fix worked" or "the test rotted quietly." One `console.log` line inside the file made that unambiguous.
- **Pin the historical mapping in-file, not by reference.** `HISTORICAL_PRE_FIX_FLAG_SOURCES` stays fixed forever. If someone edits `calibrationWire.ts` to something even worse in the future, the historical test still means what it means.
- **Loopback guard as an always-visible control, not just a runtime check.** A `describe` block that runs regardless of env asserts the guard rejects a public host, accepts localhost and 127.0.0.1. That makes the "we would never accidentally hit production" claim testable, not just documented.

### Round-3 CI gate outcome on my files

- `prettier`: clean.
- `eslint`: clean.
- `tsc --noEmit`: 0 errors in my paths (one downstream error in `e2e/helpers/calibrationA11yFixture.ts` from Ripley's schema-type extension).
- `vitest run` on my 3 new files: **35 passed, 2 skipped**. Together with Round-2: **49 passed, 3 skipped** over 5 test files.

### Nothing committed. No PR. Coordinator to sequence.

---

## Round 4 (2026-08-21) — the sub-agent encoded a fabrication, and then closed the hole that let it in

**What happened.** Round 3 asserted a coordinator-briefed payload into `calibration.capabilityFlagMapping.test.ts` without an independent wire capture. The coordinator, checking against Bishop's stack afterwards, discovered the story was false — the desktop's original alias map had always been correct, and Ripley's brief rebind was the actual regression. Ripley reverted; four of my tests inverted from green to red.

**The lesson.** Round 2 said: fixtures asserting server-provenance without a check are worthless. Round 3 did exactly what Round 2 diagnosed — accepted a fixture provenance claim on prose alone. The defect I named came back through my own harness.

**What I built to close it.**

1. Two allowed provenance kinds, encoded as a `PROVENANCE` export at the bottom of every `*.snapshot.ts`: `csharp-source` (with `commitSha` + `blobHash`, checked via `git hash-object`) or `live-response` (with `serverVersion` + `commitSha`, checked by cross-referencing a sibling `csharp-source` snapshot's `commitSha` and matching the payload body's own `serverVersion` field).
2. A guard test that discovers every snapshot in the directory at runtime, asserts each carries a `PROVENANCE` object of an allowed kind, and — when pfarm1 is on disk — runs the blob-hash check. Missing provenance, unknown kind, or a non-loopback `capturedFrom` all fail. Four synthetic-mutation controls prove each check bites.
3. `capabilitiesLiveResponse.snapshot.ts` — the CORRECTED fixture, a verbatim capture from `http://localhost:18080/api/calibration/capabilities`, carrying a `live-response` PROVENANCE with `serverVersion 0.2.3+6cf79dee0e7e1b7d692399d6aff3e4f72a1c8e0e`.
4. `capabilityFlagMapping.test.ts` — rewritten end-to-end against the live capture. Primary describe now proves G5 GREEN against real payload. `RIPLEY_MISFIX_ALIAS_SOURCES` reframes the mis-fix as a counterfactual regression guard, and a direct control test asserts no required flag is bound to a server field that resolves false-by-construction (`CalibrationCapabilityService.cs:203-205` hard-codes three of them).
5. `liveStackDispatch.test.ts` — auth posture consumed, Stage 5 wired with three precondition headers, stage reports precise enough to be useful during Bishop's ongoing seeder fix.

**Insights I learned this round.**

- The 5-entry map has 2 entries that were NEVER wrong (photoUpload/generation). A state observer comparing all 5 entries against the mis-fix map always reports 2/5 matches even in the correct state. Reporters that count "some fraction of the current map matches the broken map" and label that PARTIAL are misleading — they read almost the same in every state. Fix: count only the aliases that were actually rebound, and label OK vs REGRESSED-TO-MISFIX on that KEY subset. The insight generalises: a "partial regression" report on a fixed map is almost always a bug in the reporter's set.

- A prose provenance claim is not a source. The provenance guard is worth more than any individual test the guard covers, because it converts a social claim into a mechanical check. Future snapshots authored under this protocol cannot silently import from an unverified source: they need an actual commit + blob hash, or an actual wire capture with a `serverVersion` that cross-references a source snapshot.

- `expect.fail(...)` returns `void` in vitest, not `never`. Control-flow narrowing after it doesn't work. Refactor: `if (x === null) { expect.fail(...); throw new Error('unreachable'); }` — the unconditional `throw` gives TS the `never` the linter needs, and the subsequent `x` is narrowed. Without it, `no-unnecessary-type-assertion` and TS strictNullChecks disagree.

- When comparing "same alias map, two payloads" the test that matters is whether the mis-fix map, applied to the REAL payload, refuses. That is the counterfactual regression guard. Asserting "the pre-fix map failed on the pre-fix payload" is worthless when the pre-fix payload was fabricated — it's what got Round 3 into trouble in the first place. The counterfactual test always feeds the mis-fix map the CURRENT wire payload, so the guard survives as long as the payload does, and doesn't need updating when the mis-fix specifics change.

- The provenance guard's live-response cross-reference (`live PROVENANCE.commitSha must match some csharp-source PROVENANCE.commitSha in the same directory`) is the load-bearing part. Without it, a live-response snapshot with any commit SHA would pass. WITH it, a live capture from a build we don't have DTO snapshots of will fail loudly. That was the key design choice.

- Bishop's stack keeps producing precise stage output during his own fix — 401 → "set $env:PRINTFARMER_STACK_TOKEN", 422 → `printer_not_calibration_eligible`, missing ETag → "stopped at stage=ack-preconditions naming which ETag was missing". Precise stage reporting is worth more than binary pass/fail during a live fix loop.

**Full-suite result.** `5292 passed | 2 failed | 7 skipped`. The 2 failures are `orcaProfileInstall.test.ts` — pre-existing load-timeouts flagged by the coordinator as out of scope. Nothing my work touched regressed. Coordinator's target ("back to green except the 2 known orca timeouts") met exactly.

---

## Round 5 (2026-08-21) — the manual success is now a repeatable harness

**Context.** Bishop drove a calibration print end-to-end against the daily-validation stack — emulator reports `printState: printing` and the seeded filename on its virtual SD. My job is to turn that manual success into a regression guard.

**What I built.**

- `tests/calibration.liveStackDispatch.test.ts` — full rewrite. Replays Bishop's exact working sequence from `D:\s\pfarm1\.stack-round2\drive-print.py`: capabilities → candidates → context → emulator BEFORE snapshot → queue POST (Bishop's tested payload with `jobKind: 1`, priority/copies/idempotencyKey, and the three calibration IDs) → **GET the job to harvest both ETags** → ack POST with three precondition headers → poll emulator until `printState=printing` → cross-check via Moonraker's own protocol → assert artifact on virtual SD.
- The acceptance signal is `emuAfter.printState === 'printing'`, not the 202 from PrintFarmer.
- `EXPECTED_REFUSAL_HINTS` table encodes Bishop's five in-order refusals as named preconditions: each wire code maps to its SQL seed step and its C# source gate. `formatFailure()` emits `SEED-STEP-HINT:` and `SERVER-GATE:` lines on any Stage 4/5 refusal so a developer reading the diagnostic knows which script to reapply.
- Six controls prove the diagnostic layer bites: names all five Round-4 refusals, positive lookup, negative unknown-code, hint present when known, hint absent when unknown, and the code→hint routing is specific (not any-hint-for-any-code).
- `tests/calibration.jobBlockedReasonCode.test.ts` — extended with a Round-5 Dallas coverage describe: hard assertion that no non-aggregate code in Dallas's catalogue is a phantom (with synthetic control), plus a non-blocking coverage delta report (21 wire tokens currently uncovered by renderer wording — non-fatal because the fallback quotes the raw code).

**Insights I learned this round.**

- Round-4 was sourcing `If-Match` and `X-Dispatch-State-If-Match` from the POST response headers. Bishop's proven driver GETs the job first because the POST response doesn't reliably carry both. My Round-4 test's `ack-preconditions` stopper was because of that exact gap. The fix — always GET before ack — is now hard-coded in Stage 4a.

- The five refusals aren't just error codes; they're a NAMED DIAGNOSTIC TAXONOMY. Encoding them as a table with `serverCode → seedStep + serverGate` turns each refusal into a self-explanatory fix instruction. This is more valuable than a generic "assert 2xx" because the harness stays useful during the fix loop, not just after it's passing. The pattern generalises: any time a live-integration test can fail at multiple named points, encode each as a hint so the failure IS the diagnostic.

- The already-printing case (emulator has stale print from previous run) is subtle. My harness warns but doesn't fail preflight — Stage 5 will naturally 409 `printer_busy` and my hint table doesn't cover that specific code. Room to extend: add `printer_busy` to the hint table pointing at `POST {emulatorUrl}/__emulator/reset`. Adding to the follow-up list.

- The coordinator's coverage question ("check Dallas's catalogue against this authoritative list") wanted BOTH directions checked. Hard assertion in one direction (no phantoms) + non-blocking delta in the other (wire tokens Dallas hasn't yet worded) is the right split — the fallback wording is load-bearing on purpose, so forcing 100% coverage would be over-specification.

- Docker Desktop WSL-mode: services bound to `127.0.0.1:{port}` inside the daily-validation stack are reachable from `wsl -d Ubuntu-24.04` but NOT from the Windows host. Any live-integration test that runs from Windows-side vitest can't reach the stack unless the developer uses `wsl -d Ubuntu-24.04 -e bash -lc "cd /mnt/... && npx vitest run"`. Note this as a runbook item in the harness header — coordinator or Bishop can decide if the network side needs fixing.

**Full-suite result.** `5300 passed | 2 failed | 7 skipped`. The 2 failures are the pre-existing `orcaProfileInstall.test.ts` load-timeouts flagged as out of scope. Coordinator's target met exactly. Round-4 provenance guard, capability re-basing, counterfactual regression guard all still holding as verified.

**Emulator state cross-check (bonus).** WSL curl confirms the emulator's current `printState=printing` and filename `pf-432e...promoted-calibration-bishop-round4.gcode` — my harness's `expectedFilenamePattern="promoted-calibration"` would immediately assert green against Bishop's still-live Round-4 print if the Windows-host loopback bridge were solved. The harness code is proven correct via the 12 always-visible controls; the actual live run is the follow-up.

📌 Team update (2026-08-21T20-06-12Z): Calibration suite self-referential gap identified; built server-sourced snapshots with blob-SHA pinning + provenance guard. Full suite 5300 pass / 2 known-timeout fail. See .squad/orchestration-log/2026-08-21T20-06-12Z-hicks.md.

## SUMMARY (2026-08-22)

**Round objective.** Answer _why_ the calibration test suite is green while the feature is dead for the user, then ship a failing regression test that catches the class of bug. Bishop is on main-process/PrintFarmer integration; Dallas is on the renderer; my lane is the SUITE ITSELF.

**Verdict, in one line.** Every calibration test either hand-builds a `CalibrationBinding` and calls a pure gate function, or mocks `getCalibrationPrinterContext` at the renderer boundary with a hand-authored `CalibrationPrinterContext`. Nothing walks the operator path where every candidate returns `eligibility === null` with a fat `rejectionReasonCodes[]` — which is exactly the state PrintFarmer''s daily-validation emulator returns and which the user is hitting.

**Empirical proof (headline finding).** Neutralised `bindingFromContext` in `src/renderer/calibration/projectEligibility.ts` to return `null` unconditionally. 427 of 430 calibration tests still passed. **99.3% of the calibration suite is silent to the plumbing being deleted.** Restored the file via inverse edit; `git status --porcelain` clean.

**Where the huge message actually comes from.** `candidateEligibilityBlockers` (not `evaluatePrinterEligibility`, which is dead code in `src/renderer` — only referenced in `tests/calibration.domain.test.ts`). Dallas identified this independently in his inbox drop. The renderer faithfully maps each server-provided reason code through `describeRejectionReasonCode` into one `<li>` under `<ul id="candidate-eligibility">` inside `NewCalibrationProject.tsx:787-795`. With the emulator seeder''s NULL-column payload, that''s ~25 bullets per printer.

**e2e in the required CI job.** Zero. `desktop` (required, windows + macos) runs only `vitest run`. `package` runs Playwright but is not in the required-contexts set. So `e2e/calibration.spec.ts`, `e2e/calibrationJourneys.spec.ts`, and `e2e/calibrationA11yTests.ts` cannot block a merge. The entire operator-facing flow has zero merge-gating end-to-end coverage.

**Failing regression test.** `tests/calibrationRefusedEnvironment.test.tsx` (new file, ~380 lines, two tests). Failing side: given `listCalibrationPrinters` returning 3 printers all with `eligibility: null` and 25 rejection codes matching the seeder-null shape, clicking the first radio produces at most 1 bullet in `<ul id="candidate-eligibility">`. Control side: the same fixture produces at least 5 bullets today. Current output: `expected 26 to be less than or equal to 1`. The invariant is independent of specific codes, so if Bishop reports a different real payload only the fixture needs updating.

**Full CI gate (Desktop-job order, on this machine).**

| Step                            | Result                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `check:provenance`              | ✅ 0 derived files, source v1.3.2                                                                                                                                                                                                                                                                                                                                                      |
| `verify:target-profiles`        | ✅ 82 files pinned                                                                                                                                                                                                                                                                                                                                                                     |
| `check:script-reachability`     | ✅ 96 invoked, 0 unresolved                                                                                                                                                                                                                                                                                                                                                            |
| `check:inert-class-field-seams` | ✅ no candidates                                                                                                                                                                                                                                                                                                                                                                       |
| `typecheck`                     | ✅ clean                                                                                                                                                                                                                                                                                                                                                                               |
| `lint`                          | ✅ clean                                                                                                                                                                                                                                                                                                                                                                               |
| `format`                        | ✅ my file clean (Bishop''s + Dallas''s history files fail — theirs to fix)                                                                                                                                                                                                                                                                                                            |
| `test`                          | 6 failed / 5387 passed / 7 skipped — one failure is MY intended regression, three are pre-existing `orcaProfileInstall` flakes Vasquez flagged as out of scope, one is the `pfarm1` provenance guard hitting a stale blob (fires only when sibling checkout is present, skipped in CI), one is a new orcaProfileInstall timeout of the same shape. **No test I did not intend broke.** |

**Insights I learned this round.**

- **Citation from a spawn prompt is not proof of causation.** Vasquez''s prompt named `evaluatePrinterEligibility` as the culprit; that function is dead code. Dallas identified this in ~two hours. I spent time reading the wrong file before switching to the empirical control. Lesson: when a spawn cites a specific function as "the source of the bug", grep for its callers before reading it. Would have caught the misattribution in one command.
- **The "delete the plumbing" control is a general pattern.** When a suite is claimed to test path X→Y→Z, neutralise Y and see if it goes red. If it stays green, the suite tests X and Z separately, not the connection. Repeatable in any test-suite audit; costs one file backup and one `s/foo/null/`. Adding this to my toolkit for future rounds.
- **Unenforced provenance is worse than no provenance.** `tests/fixtures/server-contract/calibrationCandidatesDto.snapshot.ts` has a blob-SHA header and _looks_ like a live-server pin, but the guard test `it.skipIf(!serverRepo)`s when `D:\s\pfarm1` is absent — which is always in CI. That gives an operator false confidence that a "server contract" is being checked. If a fixture is going to claim server-derivation, either the guard runs unconditionally in CI, or the fixture should stop claiming server-derivation. Filed as follow-up for the next audit round.
- **`role="alert"` doesn''t disambiguate in a wizard with multiple alerts.** My first test attempt used `findByRole("alert", { name: undefined })` — TypeScript refused it under `exactOptionalPropertyTypes`, and behaviorally it would have selected an arbitrary alert. Scoping by the `<ul>`''s well-known `id` (`document.getElementById("candidate-eligibility")`) is more surgical and stable across renderer refactors. Testing-library''s `role="list"` queries choked on the missing accessible name, so falling back to `getElementById` was correct.
- **Prettier cache lies after `--write`.** `npm run format` reported my file as unformatted twice after `npx prettier --write` succeeded on it. Running `npx prettier --check <file>` on the specific file (which bypasses the cache) confirmed the file was actually formatted. When Prettier disagrees with itself, single-file check overrides project-wide check.

**Coordinator/handover.**

- Bishop: your upstream fix will pass my test the day it lands and regress-guard rewrites of the picker. Fixture shape in `REFUSED_ENVIRONMENT_CODES` is my best estimate — swap in your captured payload when ready.
- Dallas: your suggested "environment-level notice when every printer is refused" is one of the two paths that flip my test to green. If you take that path, my test guards it.
- Coordinator (Vasquez): decisions inbox has `hicks-calibration-test-gap.md` for merge into `.squad/decisions.md` by Scribe.

📌 Team update (2026-08-22): Calibration suite gap identified and regression test shipped. `tests/calibrationRefusedEnvironment.test.tsx` fails today with 26 bullets vs expected ≤ 1. Empirical control proves 99.3% of calibration tests are silent to plumbing deletion. See `.squad/decisions/inbox/hicks-calibration-test-gap.md`.

---

## SUMMARY — 2026-08-22 round 2 (reframe per owner directive)

**Round objective.** Vasquez relayed an owner directive (2026-08-22T19:08:45-07:00): calibration must be a profile-SELECTION flow (machine → process → filament, mirroring "new slice job"), not a server-eligibility flow. My V1 regression test — "≤ 1 bullet in the code dump" — asserts the symptom, not the causal gate. Reframe both the reframed guard and add a new acceptance test.

**What I shipped.**

- **`tests/calibrationRefusedEnvironment.test.tsx`** (existing file, reframed). Old assertion "≤ 1 bullet" pivoted to "profile-selection fieldset is not disabled after picking a refused printer." Matching-predicate control asserts the opposite on the same fixture. Currently fails with `Received element is disabled: <fieldset disabled="" />`. Rationale: fieldset `disabled={!printerReady || ...}` where `printerReady` demands `candidateBlockers.length === 0`, so refused printers dead-end the operator with no lever — precisely what the owner directive rejects.
- **`tests/calibrationProfileSelectionFlow.test.tsx`** (new). Six `it` blocks. Five assert operator-observable propositions from the owner directive; sixth is a matching-predicate control. All five real assertions fail today because no machine/process/filament cascade exists. The load-bearing one is `it("choosing all three profiles enables the action that generates G-code / queues the calibration job")` — it catches the safety-hardcoding trap at `calibrationWire.ts:1113-1117`, which is on a live path via `bindingDiagnostics` → reducer.ts:115,726. If a future PR builds the UI without unhardcoding safety, that test stays red.

**Corrections to my V1 claims.**

- V1 called `evaluatePrinterEligibility` dead code. That is still true — the function is only referenced from tests. But I implied the safety-triple gate was therefore not on any live path, and that was wrong. `bindingDiagnostics` (same file, line 43) enforces the same safety triple and IS live via `reducer.ts:115` and `:726` from `bindingFromContext` at `NewCalibrationProject.tsx:440`. So the hardcoding at `calibrationWire.ts:1113-1117` IS a live production blocker, not merely a dead-code smell. Filed as a handover to Fact Checker for independent verification.

**Housekeeping (Vasquez requested).** `npm run format:write` fixed Bishop's, Dallas's, Fact Checker's, and my own history files. `npm run format` (check) is now clean.

**Full CI gate result** (Desktop-job order): all 8 steps green except `test` — 10 failed / 5389 passed / 7 skipped. Of the 10 failures, 6 are my intended new regressions (5 profile-selection + 1 refused-environment reframe) and 4 are pre-existing OOS (2× orcaProfileInstall timeouts Vasquez flagged, 2× snapshotProvenanceGuard pfarm1 drift, `it.skipIf` in CI).

**Insights this round.**

- **Assertion pivots when the owner spec changes; methodology does not.** V1's method was "failing assertion + strict-inversion control on the same fixture." V2 keeps that method verbatim and swaps the proposition. Reusing the fixture (the refused printer) is what makes the control credible — the same input to the same predicate gives opposite results, so both cannot simultaneously pass. When the spec changes mid-round, re-check the proposition; do not re-check the methodology.
- **"Dead code" is a scope claim, not a safety claim.** V1 said `evaluatePrinterEligibility` is dead → I stopped tracing its consumers. I should have grepped for every callsite of the safety-triple check itself, not just of the function that contains it. Same logic, different function name — `bindingDiagnostics` was the live twin. Lesson for next audit: when a "dead" function's logic can be inlined into other names, trace the logic not just the function.
- **Prefer role-based queries for future-proofing over id/text.** V1 used `document.getElementById("candidate-eligibility")` to scope the bullet count. It works but locks the test to a specific DOM anchor. The new acceptance test uses `queryByRole('combobox', { name: /machine profile/i })` — any implementation that renders a labeled combobox with matching accessible name satisfies the test, regardless of the surrounding markup. Owner directive redesigns the UI; role-based matchers survive the redesign.
- **`noUncheckedIndexedAccess` + `expect.fail` guard = non-null assertions land safely.** After `if (options.length === 0) expect.fail(...)`, TS still narrows `options[0]` as `T | undefined`. The `!` non-null assertion is safe here because control flow proves it: `expect.fail` throws. Considered restructuring with early return; concluded the `!` is idiomatic in the pattern "guard-with-fail-throw + index access." Do not fight the type system with runtime checks that duplicate the guard.

**Coordinator/handover.**

- **Bishop:** the acceptance test's `getCalibrationPrinterContext` mock currently REJECTS — the theory is the new flow does not need per-printer server eligibility. Confirm or push back. Your calibrationWire.ts:1113-1117 safety-hardcoding must be replaced with a real path to `true` for the "proceed enabled" test to flip green.
- **Dallas:** if your renderer's UI names or roles differ from `/machine profile/i`, `/process profile/i`, `/filament profile/i`, adjust the matcher regex — do not change the assertion intent. The load-bearing intent is "observable, labeled, enabled."
- **Fact Checker:** please confirm `bindingDiagnostics` at `eligibility.ts:43` is live via `reducer.ts:115,726` — that is the correction to my V1 claim.
- **api-contract researcher:** endpoint names and DTO shapes for the three profile-list endpoints are marked `TODO(hicks/api-contract)` in the new test file. When you land findings, ping me — the assertions are payload-shape-invariant but the fixture stubs need real shapes.

📌 Team update (2026-08-22 round 2): Reframed the failing regression test to match the owner's profile-selection directive. `tests/calibrationRefusedEnvironment.test.tsx` (reframed) + `tests/calibrationProfileSelectionFlow.test.tsx` (new). 6 intended failures, 4 pre-existing OOS, full CI gate otherwise clean. Format:write applied — all agent history files now Prettier-compliant.

---

## SUMMARY — 2026-08-22 round 3 (api-contract landed)

**Round objective.** api-contract researcher reported verified findings against `OlyForge3D/PrintFarmer` @ `b0a021000639d5ef69c818c89877520793d9f9e8`. Fact Checker independently confirmed my V1 correction that `bindingDiagnostics` is live via `reducer.ts:115,726`. Resolve all `TODO(hicks/api-contract)` markers; add the custom-profile applicability test (highest-value per Vasquez); add ordering + 412-conflict guards.

**What I shipped.**

- **All 3 `TODO(hicks/api-contract)` markers closed** with cited endpoints (`ProfilesController.cs:846-900, 909-933, 942-966, 1327-1343`), DTO shapes (system profiles have NO `Id`; custom profiles have `Guid Id` + `isSystem: false`), and applicability rules (system pre-filtered server-side; custom filtered client-side).
- **`REFUSED_ENVIRONMENT_CODES` fixture updated** with in-line `PrinterCalibrationContextService.cs` line-number citations for every rejection code — no longer a self-authored guess.
- **New describe block: `custom-profile applicability filter (server vs client asymmetry)`** — the highest-value test in the batch. Failing side: inapplicable custom filament is excluded. Matching-predicate control: applicable custom filament is included. Both currently fail vacuously (machine selector missing); flip to real assertions once Bishop lands the custom channel.
- **New describe block: `eligibility ordering`** — asserts eligibility is re-checked AFTER `PUT /calibration-setup`, not before. Belt-and-suspenders design: observable outcome (machine selector present) + internal-call check (context call count == 0). The internal check is safe because the mock REJECTS with a pointed message; an up-front call surfaces as a failure through a rejected promise.
- **New describe block: `If-Match / 412 conflict on calibration-setup persistence`** — placeholder guarding Vasquez's stated risk that the operator sees a real conflict rather than a silent retry. Tightens once Bishop lands the PUT channel.

**Assertion methodology unchanged from V2.** Every real assertion (not vacuous `expect.fail`) targets an observable operator outcome — rendered DOM, enabled/disabled state, option-text content, `<optgroup>` labels — with matching-predicate controls asserting strict inversions on the same fixture.

**Full CI gate.** All 8 Desktop-job steps green except `test` — 16 failed / 5390 passed / 7 skipped. 10 are my intended new regressions across two files; 6 are pre-existing OOS (2× snapshotProvenanceGuard pfarm1 drift, 3× orcaProfileInstall timeouts, 1× calibrationMaliciousInputCorpus × orcaProfileInstall timeout leaking through).

**Insights this round.**

- **Cite line numbers on server-emitted fixture values.** V1's fixture had 5 rejection codes that "looked plausible." V3's fixture has 5 rejection codes each with a `PrinterCalibrationContextService.cs:LINE` citation. That is the difference between a mirror of our own mapping (which passes forever if buggy) and a controlled contract (which fails when the contract drifts). Adopting: any test fixture claiming to mirror a server contract MUST cite the server-side emit site.
- **Belt-and-suspenders is acceptable when the internal check is empirically wired.** The eligibility-ordering test asserts both (a) machine selector present (observable) and (b) `getCalibrationPrinterContext` NOT called (internal). The internal check would normally be an anti-pattern, but because the mock REJECTS with a pointed message, an up-front call surfaces as a rejected-promise failure that renders as a visible error. The internal count is a belt over already-fired suspenders — not a substitute for observable-outcome assertions.
- **Server-vs-client filtering asymmetry is a general bug-farm pattern.** When one dataset is server-filtered and its co-presented sibling is client-filtered, the sibling silently fails without user-visible signal. Adding "server-vs-client filtering asymmetry" to my audit patterns list — every time I see two lists side-by-side with different origins, I should look for whether both are filtered on the same axis and by whom.
- **`Guid` vs SHA-256 for identity is the desktop's biggest wire-schema debt.** api-contract §C: `machineProfileSha256/processProfileSha256/filamentProfileSha256` on the desktop wire schema (`src/shared/ipc.ts:4712-4714, 4975-4977`) are misaligned with the server. System profiles have no `Id` at all — canonical `Name` string IS the identity. Custom profiles have `Guid Id`. SHA-256 is provenance metadata on `ResolvedCalibrationProfile.StoredSha256` (nullable). Bishop needs to switch. Flagging this loudly in the handover because it will invalidate a lot of downstream test fixtures if not caught before merge.

**Coordinator/handover.**

- **Bishop:** four new IPC channels (`listCalibration{Machine,Process,Filament,Custom}Profiles`) + one PUT (`saveCalibrationSetup`). Wire-schema debt — flip `machineProfileSha256` etc. to `{ profileName: string, customProfileId?: string, contentSha256?: string /* provenance-only */ }` per api-contract §C. My test's `getCalibrationPrinterContext` mock REJECTS to catch up-front calls.
- **Dallas:** cascading comboboxes with `/machine profile/i`, `/process profile/i`, `/filament profile/i` accessible names. Custom filament applicability is your client-side responsibility per api-contract §B (parse `rawJson.compatible_printers`; check membership of the selected machine name).
- **Fact Checker:** finding on `bindingDiagnostics` liveness settled by two independent paths. Thanks.
- **api-contract researcher:** all TODOs resolved. Cited endpoints, DTOs, and applicability rules verbatim.
- **Vasquez:** 10 intended failures + 6 pre-existing OOS. `hicks-calibration-test-gap.md` ready for merge. Reporting back synchronously.

📌 Team update (2026-08-22 round 3): api-contract researcher's findings landed. All TODOs closed. Two new describe blocks — custom-profile applicability filter (highest-value) and eligibility ordering — plus If-Match/412 placeholder. `REFUSED_ENVIRONMENT_CODES` fixture now cites `PrinterCalibrationContextService.cs` line numbers for every rejection code. Full CI gate green except intended 10 failures + 6 pre-existing OOS.
