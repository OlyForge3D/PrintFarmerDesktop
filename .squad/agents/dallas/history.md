# Dallas — Recent Sessions

Dallas is the React/Electron UI developer for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). No UI code touched during this session — infrastructure only.

## 2026-08-21: Calibration UI trace (read-only)

Traced the calibration renderer path in response to "the calibration
thing still doesn't work." Full write-up:
`.squad/decisions/inbox/dallas-calibration-ui-trace.md`.

Headline: the actual dispatch to the printer queue happens in
`CalibrationStepWorkflow.tsx:395-503` (`handleQueuePrint` →
`startCalibrationPrint`), bound to the "Queue calibration print"
button at line 1394-1409. The visually-later "Start calibration print"
button at line 1420-1430 has **no onClick handler** and its gate
`startDecision.allowed` is unconditionally false because
`runtime.bedClearConfirmed` and `runtime.operatorPresent` are
hardcoded to `false` at line 862-863. A user who reads the four
handoff buttons top-to-bottom (Generate → Queue → Confirm bed clear →
Start) will read the last one as "send the print" — and it is dead.

Ancillary: reachability via WorkspaceRail is intact post-#739. Every
`window.printFarmer.*` call the calibration UI makes has a declared
IPC channel with Zod request+response schemas. Empty printer list and
per-reason refusal messages ARE surfaced (post-#723, #733). No inert
class-field seams — there are no classes at all in
`src/renderer/calibration/**`.

## Learnings

- 2026-07-23: Renderer stack is React 18 + TypeScript + Three.js,
  built via Vite (`vite.renderer.config.ts`), tested with Vitest +
  Testing Library and Playwright e2e (`e2e/`, `tests/`). ESLint flat
  config lives at `eslint.config.js`.
- 2026-08-21: `npm run check:inert-class-field-seams` is a real gate;
  running it eliminates a whole hypothesis class in seconds. Should be
  the first thing to reach for on any "code looks right, does nothing"
  report.
- 2026-08-21: A dead JSX button (no onClick) is not caught by the
  inert-class-field-seams check — that check is specifically about
  `useDefineForClassFields` shadowing prototype methods. A missing
  onClick handler on a plain button is invisible to TS, ESLint, and
  the typecheck. Worth its own guard if it turns out to be a repeat
  pattern.
- 2026-08-21: The calibration button ladder — "Queue calibration
  print" (`startCalibrationPrint` IPC → the actual dispatch) vs

## 2026-08-22: Calibration Path C complete (Profile-Selection Cascade)

📌 Team update (2026-08-22T21:30:47Z): Completed profile-selection cascade renderer + safety-gate fix + printerModelId enrichment end-to-end (commits a45fae54, 3e114396, 05c355ff, 9bdd7a45, 34fce54e). Root cause identified by Bishop/Fact Checker: desktop never called `PUT /api/printers/{id}/calibration-setup`, leaving profile columns NULL. Path C fixes this by cascading machine → process → filament selection before setup. Acceptance suite 9/9 green. Full write-up in `.squad/decisions.md` calibration entries and `.squad/orchestration-log/2026-08-22T21-30-47Z-dallas.md`.
"Start calibration print" (no IPC) — reads label-first as the
opposite of what happens. A user hunting for "send print" naturally
clicks "Start."

## 2026-08-21 (evening): Calibration UI Round 2 — three fixes shipped

Coordinator asked for the three renderer-lane fixes based on my Round 1
trace + Ripley's gate-chain map + Bishop's server recon. Full detail in
`.squad/decisions/inbox/dallas-calibration-ui-trace.md`.

Delivered:

1. **Deleted the dead "Start calibration print" button** in
   `CalibrationStepWorkflow.tsx`. Chose delete over wire because
   Ripley's finding was two-click dispatch (Queue → Confirm bed clear,
   with Confirm bed clear as the true send), so a third button labelled
   "Start" would either fork the dispatch path (forbidden) or lie about
   what it does (still a UI trap). Backfilled with a "two-click"
   explainer + a persistent `bed-clear-dispatch-hint` under the actual
   send button, so a screen-reader operator hears "this is the send"
   from the button that actually sends.
2. **Built the blocked-reason catalogue.** `blockedReasonMessages.ts`
   with 17 codes (9 from `DispatchSafetyGates.MapBlockedReason`, 2 from
   422 mapper, 4 from 409 mapper, 2 from 503 discrimination). The
   compile-error-if-missing property comes from `Record<UnionType,
string>` where the union is derived from a `const` tuple — one edit
   extends both, adding a code without wording is a `tsc` error. To get
   the code across IPC I added
   `CalibrationApiError.blockedReasonCode` and had
   `CalibrationHttpError.toApiError` pass `serverErrorCode` through,
   with a widened docblock explaining the #177 exception (bounded
   enum-shaped identifier, not free-form prose).
3. **Made "Queue calibration print" self-explaining.** Extracted the
   inline disable expression into `queueButtonDisabled` and a
   `computeQueueDisabledReason` helper whose ordered walk names the
   first cause: "already queued below" → "generate first" or the
   Stage-4 slicing-worker sentence → the first `queueDecision.blockers`
   message (surfaces `STALE_PRINTER_SNAPSHOT`, `PHYSICAL_TOOLHEAD_NOZZLE_MISMATCH`,
   `UNSYNCED_MUTATIONS` adjacent to the button rather than paragraph-only).

CI gate green: typecheck, lint, format (only Bishop's history.md warns
— his file, his fix), inert-seam guard, and 266/266 targeted
calibration tests including my new 20 for the blocked-reason catalogue.

### Small self-corrections this round

- **Schema orphan:** discovered `printStartBlockedReason` at
  `ipc.ts:4507` lives on `CalibrationQueueState` — a schema no IPC
  channel returns. The server's `JobBlockedReasonCode` isn't even
  emitted in `JobQueuePrintJobDto`. So the field the desktop was
  ostensibly "carrying" for this purpose was dead code on both sides.
  The real wire vehicle turned out to be
  `RemoteCalibrationProblemDetails.errorCode` on refusal responses,
  parsed into `CalibrationHttpError.serverErrorCode` already —
  main-process had it, IPC boundary dropped it. Flagged for Bishop
  cleanup.
- **`exactOptionalPropertyTypes` bit me once:** my first
  `calibrationErrorText` param signature was `blockedReasonCode?:
string | null` but `CalibrationApiError` at the call sites has the
  three-way `string | null | undefined` — with
  `exactOptionalPropertyTypes: true`, the `?` alone doesn't add
  undefined to the value type. Widened to `string | null | undefined`.
  Own version of the classic that inert-class-field-seams also warns
  about: TS's ES2022+strict quirks land hardest on optional properties
  where the "..this field might be missing" understanding of `?` is
  the wrong one.
- **Compile-time exhaustiveness pattern reused:** matched the shape
  from `refusalMessages.ts` (const array → derived union → exhaustive
  Record). Good project pattern to keep applying whenever the desktop
  has to translate a server enum.

### For future me

- When a renderer needs a server-provided code translated, the wire
  vehicle is `RemoteCalibrationProblemDetails.errorCode` (bounded to
  64 chars, parsed in `calibrationHttp.ts`). `serverDetail` stays
  main-process-only (#177). Add codes to `blockedReasonMessages.ts`,
  don't bypass `calibrationErrorText`.
- Ripley's safety gates deliberately fail closed and set the runtime
  flags to false. Any renderer feature that "needs" those flags set is
  the wrong architecture — the flag flip is a server-side atomic
  action, not a client state.

📌 Team update (2026-08-21T20-06-12Z): Calibration workspace reachable post-#739; step ladder intact. Deleted dead 'Start calibration print' button. Built lockedReasonMessages.ts with message translation. See .squad/orchestration-log/2026-08-21T20-06-12Z-dallas.md.

## 2026-08-22T15:43:27.611-07:00 — "Huge error on printer click" is faithful rendering of PrintFarmer refusal, not a renderer bug

Vasquez asked me to trace why "clicking a printer" produces the huge error message. Root cause is NOT in the renderer — it is a faithful render of PrintFarmer's own rejection reason codes.

**Vasquez's stated hypothesis (evaluatePrinterEligibility called against empty context) is falsified.** That function exists in `src/renderer/calibration/domain/eligibility.ts:165` but has **zero call sites under src/**. Only tests/calibration.domain.test.ts imports and calls it. Control-verified with same predicate on same corpus: renderer=1 hit (definition), tests=4 hits (real usages). The predicate can find call sites when they exist; there are none in the renderer.

**The real message source is `candidateEligibilityBlockers` in `projectEligibility.ts:26-61`.** On radio-click, `NewCalibrationProject.tsx:159-167` sets `highlightedPrinterId`; render recomputes `highlightedBlockers` and the `<ul className="cal-blocker-list">` at line 787-794 dumps one `<li>` per rejection code. If PrintFarmer sent 25 codes, you get ~26 bullets. That IS "the huge error message about missing details."

**And the wizard was designed to do exactly that.** PR #733 replaced a single "eligibility incomplete" sentence with the per-code catalogue precisely because operators complained the old sentence named no field. Removing the volume would be a regression on that fix.

**Concrete lessons for future sessions:**

1. **Vasquez's `PrinterEligibilityContext` trace was for a code path that does not exist in production.** Always run a call-graph check _first_ — `export` in `domain/index.ts` is not proof of use. Confirm with a control (search corpus that DOES call the function) before proposing a fix against a suspected hot path.
2. **`describeRejectionReasonCode` + `describeMissingInputs` are the actual "huge error" source.** These live in `refusalMessages.ts`; the ~100-entry `REASON_MESSAGES` record produces the bullet list.
3. **PR #742's own commit message names upstream `OlyForge3D/PrintFarmer#1851` "emulator seeder NULL calibration columns"** as an already-filed issue. That is the concrete shape of "every printer is refused because the server has null columns." The desktop renderer cannot fix that — Bishop's territory (main + IPC), or upstream.
4. **No inert class-field seam in calibration renderer.** All `?:` in that tree are interface fields, which are erased at emit. The `useDefineForClassFields` trap does not apply here.
5. **Test-gap: no wizard test walks the "every printer refused" path.** Every existing test uses an eligible fixture. That is why three green PRs failed to catch the user's observed behavior.

Wrote `.squad/decisions/inbox/dallas-calibration-rootcause.md` with the full file:line trace and handoff notes for Bishop (main-process capture) and Hicks (integration test against a fully-refused fixture).

---

## 2026-08-22 — Calibration safety-gate fix (commit a45fae54)

**Requested by:** Vasquez, after Fact Checker corrected my earlier root-cause finding.

**Correction accepted:** In my earlier trace I noted the wizard has three safety checkboxes but did not follow through to `bindingFromContext`'s signature. Fact Checker showed the checkboxes are gathered into `form.emergencyStop/thermalProtection/ventilation` and used only as wizard blockers before being DROPPED — the binding call at `NewCalibrationProject.tsx:460` admits no channel for them, and `projectEligibility.ts:325` copies `context.safety` verbatim from the wire's hardcoded `false` triple. So `INCOMPLETE_SAFETY_CONTEXT` fires unconditionally the moment the operator clicks Create. Lesson recorded in `.squad/agents/dallas/reflect/`.

**What I shipped (commit `a45fae54`, 7 files, 370/+ 44/-):**

- `src/renderer/calibration/projectEligibility.ts` — new `OperatorSafetyAcknowledgements` interface, extended `bindingFromContext` with 5th arg, overlay operator's booleans into `snapshot.safety` while preserving server-published limits.
- `src/renderer/calibration/NewCalibrationProject.tsx` — `submit()` passes `form.emergencyStop/thermalProtection/ventilation`.
- `src/renderer/calibration/ProjectOverview.tsx` — `rebase()` carries operator's prior confirmations from `state.binding.snapshot.safety`; `rebaseBlockers` no longer reads `context.permissions` or the three interlock booleans (they are always wire absent-evidence defaults and were permanently blocking rebase).
- `src/main/calibrationWire.ts` — `doesCalibrationWorkspacePayloadMatchContext` no longer compares the three interlock booleans field-by-field. They are operator-owned in the binding; comparing an operator attestation against the wire's hardcoded `false` would have marked every operator-attested workspace as drifted against every context.
- `tests/calibrationOperatorSafetyAttestation.test.ts` (new) — 3 tests: fixture control, positive (confirmations → zero `INCOMPLETE_SAFETY_CONTEXT`), matching-predicate control (no confirmations → 1 diagnostic).
- `tests/calibration.workspace-ipc.test.ts` — updated the single `bindingFromContext` call site; added a targeted drift-detection test with a build-volume control.
- `tests/fixtures/calibrationWorkspacePayload.ts` — updated comment to reflect the new architecture (interlock booleans are operator-owned, drift excludes them).

**Why Option B (wire-through) over Option A (relax the check):** the operator IS the authoritative source for a physical interlock — no server assertion can substitute for a human confirming the E-stop is within reach. The checkboxes exist for exactly this reason. Dropping them at the wizard boundary was the actual bug; the diagnostic was correct. Option A silently weakens the check and lets a workspace claim compliance it never verified. Option B preserves the safety semantics.

**Fact Checker's drift-detection concern was real.** They warned Option B would collide with `doesCalibrationWorkspacePayloadMatchContext` — which it did. I verified empirically: my new drift-detection test failed with `CALIBRATION_PRINTER_CONTEXT_MISMATCH` before I updated the predicate. The fix ended up requiring both the wire-through AND the drift-predicate change; either alone would have left a live bug.

**Machine-moving action gate preserved.** `calibrationActionGate.ts:346-360` still requires `input.operatorAcknowledgement === true` (a live main-process bed-clear ledger record). My changes do NOT modify that file. Verified with `calibrationActionGate.test.ts` (58 tests, all pass).

**CI gate results:** all static checks pass (provenance, target-profiles, script-reachability, inert-class-field-seams, typecheck, lint, format). Test suite: 5418 passed / 15 failed / 7 skipped; every failure is pre-existing or WIP by other agents (2× snapshotProvenanceGuard pfarm1 drift, 9× Hicks profile-selection-flow WIP intended-fail, 1× Hicks refused-environment WIP intended-fail, 2× orcaProfileInstall pre-existing 5000ms timeouts). None of my staged files are involved.

**Concrete lessons for future sessions:**

1. **Always follow a signature all the way to its call site.** In my earlier root-cause investigation I identified the checkboxes existed and stopped there — I did not trace `bindingFromContext`'s signature to see they had no way in. Fact Checker's empirical test through the real chain caught this. Repo rule: every predicate needs a matching control, and every "the UI does X" needs the corresponding call site verified.
2. **Fact Checker's warnings about downstream collisions are worth taking seriously.** They flagged that Option B could break workspace persistence drift detection at `calibrationWire.ts:1547-1560`. It did. Verifying with a targeted test caught it before the commit.
3. **Parallel-agent git activity requires atomic staging.** During this session another agent's `git add` operations kept overwriting the index — I committed Bishop's WIP by mistake once and had to `git reset --soft HEAD~1`. Fixed by scripting stage+verify+commit as a single ps1 that checks the file count and forbidden-file list before running `git commit`.

Wrote `.squad/decisions/inbox/dallas-calibration-safety-gate-fix.md` with the full explanation of Option B vs A, the drift-detection collision, and handoff notes for Bishop and Hicks.

## 2026-08-22T21:00 — Path C profile-selection cascade (renderer half)

Bishop's main-process half of Path C landed as `54e0d022`. My job: build the cascading profile-selection UI in the renderer so operators can actually populate `CalibrationMachineProfileId` / `CalibrationProcessProfileId` / `CalibrationFilamentProfileId` on the Printer row — the NULLs that have been dead-ending every real user since day one.

**What I built:**

- `src/renderer/calibration/ProfileSelectionSection.tsx` — cascade component, three dropdowns, `<optgroup>` for system-vs-user origin, `noModelAlias` UX (dedicated message when the OrcaSlicer catalog has no alias for a printer model, plus a fallback to the catalog-wide `/extended` list so the operator isn't stranded), 412-conflict handling with refetch-and-reprompt (never a silent retry), epoch-guarded async loads so late replies for stale printer selections don't overwrite fresh state.
- `src/renderer/calibration/profileSelection.ts` — pure filter/decode helpers. The load-bearing one is `filterCustomFilamentsForMachine`, which enforces `compatiblePrinters.includes(chosenMachineName)`. This is THE TRAP the owner called out: `/for-machines` filters server-side, but `/custom` returns everything unfiltered — a client that renders custom filaments unfiltered offers print-ruining incompatible profiles to the operator.
- `src/renderer/calibration/api.ts` — added Bishop's 6 new channels to the `CalibrationApi` type.
- `src/renderer/calibration/NewCalibrationProject.tsx` — mounted the cascade AFTER the printer-choice fieldset but BEFORE the legacy Step-2 fieldset. Renamed the legacy legend "Base OrcaSlicer profile and mode" → "Baseline slicer profile bundle and mode" so the refused-environment test's regex resolves to the new cascade, not the legacy fieldset.
- `tests/calibrationProfileSelectionFlow.test.tsx` — populated Hicks's `profileSelectionApi()` stub with 6 new channel mocks and sentinel fixtures (applicable + inapplicable custom filament, custom machine, custom process). Deleted scaffolding control per Hicks's TODO. Added `waitFor`-based helpers so tests see settled state after async catalog loads — assertions preserved.
- `tests/calibrationRefusedEnvironment.test.tsx` — same treatment (empty-data mocks; refused-env test only asserts reachability). Deleted scaffolding control.
- `tests/calibration.workspace.test.tsx` — empty/neutral mocks for the 6 new channels so the legacy stub still satisfies `CalibrationApi`.

**The `printerModelId` gap:** `CalibrationPrinterCandidate` doesn't carry `printerModelId` today (verified in `src/shared/ipc.ts` and `RemoteCalibrationCandidateDto` in `calibrationWire.ts`). My component accepts it as a prop and the parent passes `null` for now. When null, custom machine/process filtering falls back to "show all" (permissive) — safe because a wrong machine/process pick fails at the slicer worker, never generating G-code, never moving hardware. Filament customs are always filtered strictly. Recommended follow-up for Bishop: add `printerModelId` to the candidate schema; my component is already coded to use it.

**CI gate:** all static checks pass. 5464 tests pass, 3 fail (all known-acceptable: 2× snapshotProvenanceGuard pfarm1 blob drift, 1× orcaProfileInstall 5000ms timeout). All 10 tests in `calibrationProfileSelectionFlow` and the 1 in `calibrationRefusedEnvironment` GREEN — the acceptance gate is satisfied.

**Two small test-side changes I want to flag, both preserving the assertion:**

1. `openWizardAndPickPrinter` and a new `pickMachineAndAwaitProcess` helper now `waitFor` the affected dropdown to become populated after each state-triggering action. The originals returned before the cascade's async catalog load settled, so every test past "selector exists" raced state. Assertions unchanged; the tests now sample settled state, which was Hicks's intent.
2. The "proceed action" query in test 6 changed from `queryByRole` to `queryAllByRole`. The permissive regex `/save calibration|create calibration|start calibration|.../i` matches BOTH my new "Save calibration setup" button and the legacy "Create calibration project" button, and `queryByRole` throws on multi-match. `queryAllByRole` with `.length > 0` + `.some(!disabled)` preserves the exact proposition (at least one enabled proceed action).

**Lessons for future sessions:**

1. **When a test author writes `queryByRole` for an action name that could match multiple buttons, that's a timing bomb.** The legacy wizard and the new cascade coexist during migration; both have proceed-adjacent buttons. Use `queryAllByRole` when the regex is deliberately permissive.
2. **React 18 + RTL `fireEvent` does NOT drain all microtasks from an `async/await` chain triggered by the event.** State updates from `Promise.all` continuations inside a useEffect callback land AFTER the fireEvent returns, so any synchronous `queryByRole` immediately after loses the race. `waitFor` around each triggering action is the correct discipline; don't rely on "one `await` flushes everything".
3. **Test scaffolding controls (assertions that pin the buggy state) should be surgical and clearly marked.** Hicks's two scaffolding controls had explicit `TODO(hicks/dallas): delete this ... when the flow lands` comments; that made the removal step obvious and auditable.

Wrote `.squad/decisions/inbox/dallas-calibration-profile-selection-cascade.md` with full details, files-changed table, and follow-up notes.

## 2026-08-23T07:30 — LAST INCH: printerModelId wired end-to-end (commit 9bdd7a45)

Bishop's `9f62a958` threaded `printerModelId` from `GET /api/printers/{id}/details` through the `CalibrationPrinterCandidate` schema, closing the gap I flagged in the previous session. But the JSX prop in `NewCalibrationProject.tsx:874-877` still hardcoded `printerModelId={null}` with a stale comment saying the field wasn't yet available. That silently defeated the whole enrichment: every printer looked model-unknown to the cascade, `/extended` was the machine catalog source for every case, and custom machine/process profiles were never filtered by model. Vasquez called this out explicitly as the "test-green / user-wrong gap" the three prior PRs died from — the acceptance tests mock at the IPC boundary so they can't see which channel fires.

**Fix (1 line + stale comment removed):** `printerModelId={highlightedCandidate?.printerModelId ?? null}`. Preserves Bishop's `null` vs Guid distinction — coercing to `''` would collapse the "model unknown → permissive fallback" case into the "model known → strict filter" case.

**Matched-predicate test (`tests/calibrationPrinterModelIdWiring.test.tsx`, 2 tests):** same fixture, same mount, same operator action, only `printerModelId` differs between arms. Positive arm asserts `listCalibrationMachineProfilesForModel` is called with `{ profileId, printerModelId: <Guid> }`; matching-predicate control asserts it is NOT called when the field is `null` (and that `/extended` fills the machine list instead). Verified empirically: reverting the JSX to `null` makes the positive arm fail with `expected "spy" to be called 1 times, but got 0 times`; the control still passes. That is the pair the repo rule requires.

**CI gate all green modulo the known-acceptable residuals:**

- `check:provenance`, `verify:target-profiles`, `check:script-reachability`, `check:inert-class-field-seams`, `typecheck`, `lint`, `format` — all pass.
- `test`: 5473 passed / 5 failed / 7 skipped. All 5 failures are known-acceptable: 2× `snapshotProvenanceGuard` (pfarm1 blob drift, `it.skipIf` in CI), 3× `orcaProfileInstall`-family 5000ms timeouts (pre-existing since before this thread — includes `orcaProfileInstall.test.ts:restores…` × 2 and `calibrationMaliciousInputCorpus.test.ts > symlinkJunctionEscape × orcaProfileInstall`).
- Acceptance suites: `calibrationProfileSelectionFlow` (9/9), `calibrationRefusedEnvironment` (1/1), `calibrationPrinterModelIdWiring` (2/2) — all green.

**Candid end-to-end blockers between the user and a working calibration run:**

1. **Operator token scope (out-of-band, Bishop's flag).** First `PUT /api/printers/{id}/calibration-setup` needs the token to carry the `Calibration.Update` scope or it returns 403. If a farm was provisioned before that scope was added to the operator role, existing tokens will fail even though the UI works. This is a server-side ops task, not a desktop bug.
2. **G-code generation path (`startCalibrationGeneration`, `getCalibrationOrchestrationStatus`, `getCalibrationQueueState`, `startCalibrationPrint`) is not exercised by the acceptance suite — those channels return `notImplemented` sentinels in the fixture.** The path is presumed already-working from before the profile-selection redesign — a user who successfully completes the cascade and setup PUT gets handed back to the pre-existing wizard for those steps. I did not re-verify that end-to-end path today; the pre-existing tests around `CalibrationStepWorkflow` and `calibrationActionGate` still pass, but nothing here proves the setup PUT → context refetch → generate → queue → print chain works as a single flow on a real printer. First real-hardware run may surface something.
3. **Machine-moving-action gate preserved.** `calibrationActionGate.ts:346-360` still requires `input.operatorAcknowledgement === true` (a live main-process bed-clear ledger record). Not touched today; verified with `calibrationActionGate.test.ts` still passing.

**Handoff:** Bishop is now the only person likely to touch this cascade — server-side enrichment cleanup, or if the `startCalibrationGeneration` chain needs work when the first real farm exercises it. Hicks's acceptance suite is stable and covers the profile-selection contract. My decision file at `.squad/decisions/inbox/dallas-calibration-profile-selection-cascade.md` has been extended with the LAST INCH section.

## 2026-08-24: Filament calibration wizard — implementation

Built the end-to-end filament calibration wizard Vasquez requested on top
of Bishop's five new IPC channels (PR #752). Full write-up:
`.squad/decisions/inbox/dallas-filament-calibration-wizard.md`.

Headline: src/renderer/calibration/FilamentCalibrationWizard.tsx`n(and its state model `filamentWizardState.ts`) walks the OrcaSlicer wiki
loop from picker -> clone -> per-method slice/poll/send/measure/write-back.
The `ProfileSelectionSection`cascade I built for #747 is reused (extended
with a new optional`onSelectionChange`callback). Step sequencing is
proven by`tests/filamentCalibrationWizard.test.tsx`-`cloneCalibrationFilamentProfile`fires exactly once, both write-backs
target the same`customProfileId`. Bishop's 23-test acceptance suite
stays green.

Gaps I did NOT paper over: (1) restart resilience is in-memory only -
the existing `saveCalibrationWorkspaceState` surface is bound to
printer-calibration `projectId`/`printerId` and won't accept a
filament clone id; Vasquez's brief said 'say so rather than working
around it' and I did. Fix path is either extending that surface or
adding a `listSliceJobs` verb. (2) Non-UUID printer IDs would fail
Zod on `submitCalibrationSlice` because the wire requires
`z.string().uuid()` while `CalibrationPrinterCandidate.printerId` is
only `.min(1).max(256)` - not caused by this PR, but noted.

`startPrint` is a typed 'START' confirmation gate next to a physical-
consequence sentence, next to a distinct 'Upload gcode only' button.
Errors surface as catalogued `errorCopy()` copy - raw wire codes and
Zod field paths never render at the operator.

Repo rules: renderer stays presentation-only (no browser storage, no
filesystem, no capability except Zod IPC - verified by the
forbidden-imports control in `calibration.workspace.test.tsx`);
`calibrationActionGate.ts` untouched; no new IPC channels; no
`--no-verify`. Coordinator (Vasquez) will open the PR.
