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
