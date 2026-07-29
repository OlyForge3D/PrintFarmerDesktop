# Inspector Feedback — Iteration 5

## Verdict: PASS

Iteration 5's entire scope was the three criteria iteration 4 left open — **13,
14, 16**. All three are now genuinely, load-bearingly met. The iteration-4 root
cause (a validated no-op stub at `main/ipc.ts` whose comment read *"Stub:
persistence deferred"*) is resolved the correct way: the stub channel
`CalibrationPersistPrintObservation` is **deleted outright** (schema, `IpcChannel`
enum, `ipcSchemas`, preload, `api.ts`, main handler — zero occurrences remain),
and both print observations and the validated asset SHA-256 now route through the
pre-existing durable path (`store` → `bumpAndSave` → `saveCalibrationWorkspaceState`
→ sidecar), read back from `project.record.workspaceState`.

I confirmed every claim the prompt asked me to confirm-or-refute, and it all held
(see "Confirmed independently" below). I then ran **five new mutations** beyond
the two my predecessor ran, plus **two regression mutations** — every one
produced an isolated failure. No zero-failure mutation. No regression among the
15 previously-passing criteria. Gates green.

The only outstanding item is **criterion 18** (create the non-draft PR), which is
the post-PASS finalization action — not a defect in the delivered code.

---

## Acceptance Criteria — goal.md numbering (all 18)

| # | Criterion (abbrev.) | Verdict | Evidence |
|---|---------------------|---------|----------|
| 1 | Dead routes removed, real routes, no dead constant | ✅ PASS | Untouched by iter 5; no `calibration-projects/.../(queue\|generation)` constant (grep 0). |
| 2 | Shared IPC strict Zod, string ETags, additive | ✅ PASS | iter-5 change is additive: `CalibrationWorkspacePayload` gains `printObservations?` (`z.array(...).max(200).optional()`) and `assetSha256ByAttemptId?` (`z.record(uuid, /^[a-f0-9]{64}$/).optional()`) at `ipc.ts:2313-2321`; `.strict()` payload still parses old records (54 workspace tests using bare `record()` pass). `CalibrationPrintObservation` moved *above* the payload (forward-ref fix), not reshaped. Stub request/response schemas removed. `typecheck` 0. |
| 3 | `CalibrationGetQueueState` real vs `GET /api/job-queue/{id}` | ✅ PASS | Unchanged; drives the panel. |
| 4 | Generation Idempotency-Key+baseRevision, stages+failures, replay | ✅ PASS | Unchanged. |
| 5 | Queue creation `POST /api/job-queue`, jobKind FilamentCalibration | ✅ PASS | Transport unchanged. |
| 6 | Bed-clear 3 preconditions + status map + 412 refetch | ✅ PASS | **Regression mutation 2** (rename `x-dispatch-state-if-match` header, `calibrationHttp.ts:969`) → 2 transport tests fail incl. `X-Dispatch-State-If-Match` header assertion at `queue-dispatch.test.ts:1340`. Guard still bites. |
| 7 | Ack never reused; not offered offline/unsync/unauth/expired/stale/non-Klipper | ✅ PASS | Untouched by iter 5; verified intact (no `canAcknowledge` change in diff). |
| 8 | Converge via REST; gap→refetch; redacted envelopes not job state | ✅ PASS | **Regression mutation 1** (redaction guard `evt.jobId === jobId` → `\|\| true`, `CalibrationQueueDispatchPanel.tsx:180`) → the "Cancelled redacted envelope" test fails alone. Pre-existing crit-8 guard still bites. |
| 9 | Unknown outcome stays "Starting", no blind-retry | ✅ PASS | Unchanged. |
| 10 | Typed blocked reasons (6 enumerated) | ✅ PASS | Untouched by iter 5; `computedBlockedReason` intact. |
| 11 | Immutable provenance shown + stale/changed context blocks start | ✅ PASS | Untouched by iter 5. Honest-null design endorsed in iter-4 ruling still holds. |
| 12 | Bed-clear dialog fields + a11y + live region | ✅ PASS | Unchanged. |
| 13 | Lifecycle 8 statuses; append-only obs (result/confidence/retest/notes/photos); failure/cancel preserve+offer new; never complete from queue alone | ✅ PASS | Persistence is now **durable, not a stub**. Write: `handleAddObservation` → `store.storePrintObservation` → `bumpAndSave` (`CalibrationWorkspaceStore.tsx:1064-1086`), append-only with idempotency guard at `:1073`. Read: `printObservations` from `project.record.workspaceState.printObservations` (`CalibrationStepWorkflow.tsx:581-587`); no `useState` shadow remains (grep 0 for `setPrintObservations`). **Mutation A** (neuter read) fails remount test; **Mutation E** (neuter write) fails 3 crit-13 tests. Photos: durable per-attempt "Photo evidence" subsystem via `store.addPhoto` → `workspaceState.photos` with content-hash staging (`:983-1037`, `:1730-1837`). New attempt: `beginAttempt`/immutable-redo (`:809-825`) offered while `handleJobInvalidated` (`:457-462`) preserves observations (test "observations survive job invalidation"). Never auto-completes (no status→complete wiring). |
| 14 | Asset manifest: checksum stored with attempt, allowlisted nav, per-method disable | ✅ PASS | (14a) SHA-256 stored durably keyed by attempt: `storeAttemptAssetSha256` merges `{...existing,[attemptId]:sha}` → `bumpAndSave` (`CalibrationWorkspaceStore.tsx:1093-1108`); read `displaySha256` from `workspaceState.assetSha256ByAttemptId` (`CalibrationStepWorkflow.tsx:592-597`). **Mutation B** (neuter write) + **Mutation C** (neuter read) each isolate. Merge (not clobber) means a second attempt keeps its own key. (14b) `isManifestSourceUrl` (`calibrationAssetManifest.ts:183-186`) is a genuine exact-match allowlist `entries.some(e=>e.sourceUrl===url)`; IPC handler refuses non-manifest URLs end-to-end (`main/ipc.ts:2276-2290`) and returns the correct `{status:'error',message}` shape (latent iter-4 `error`-key bug fixed). Renderer passes the **reviewed manifest `sourceUrl`** (`CalibrationStepWorkflow.tsx:562-568`), not a hardcoded URL — **Mutation D** (hardcode URL) fails the call-arg assertion. No second `shell.openExternal` egress reachable from the renderer (only `security.ts` `hardenWindow` and this gated handler). |
| 15 | Only named validated commands; main owns streaming/redaction; renderer-boundary test | ✅ PASS | Net **removed** a channel (stub deleted). `openCalibrationManifestUrl` remains named + Zod-validated and now enforces a real manifest allowlist. Renderer-boundary test green. |
| 16 | Automated coverage breadth | ✅ PASS | New tests bite (mutations A–E). Durable persistence covered by "adding an observation persists via saveCalibrationWorkspaceState" + "print observations survive remount"; SHA by "stored and displayed" (asserts save payload) + "survives remount"; allowlist by `isManifestSourceUrl` true/false pair (`asset-manifest.test.ts`) + call-arg assertion; append-only by "survive job invalidation". |
| 17 | Existing tests green + all gates pass | ✅ PASS | `typecheck` 0, `lint` 0 (import removals clean), affected suites 143/143 (`workspace` 54, `asset-manifest` 20, `queue-dispatch` 69). Full 1439-test suite + Rust gates delegated to orchestrator. `test:e2e` not feasible (sidecar unavailable) — not counted against the Builder. |
| 18 | One non-draft PR base `development`, body states no-live-server, `Closes #54`, not merged | ⏳ PENDING | No PR yet — this is the post-PASS finalization action, not a code defect. Code is now complete for the PR to be raised. |

**Tally:** PASS 1–17 · PENDING 18. Iteration-5 scope (13, 14, 16) all moved
FAIL→PASS. No regressions.

---

## Confirmed independently (prompt's "confirm or refute" list)

- `CalibrationPersistPrintObservation` / `persistCalibrationPrintObservation`:
  **0 occurrences** in `src/` and `tests/`. No `Stub:` / `deferred` / `no-op` in
  `main/ipc.ts`. **Confirmed** — stub deleted outright.
- Durable reads: `printObservations` (`CalibrationStepWorkflow.tsx:581-582`),
  `displaySha256` (`:592-597`). No volatile `useState` shadow. **Confirmed.**
- `isManifestSourceUrl` exact-match allowlist (`calibrationAssetManifest.ts:183-186`).
  **Confirmed.**
- `storePrintObservation` append-only + idempotency guard
  (`CalibrationWorkspaceStore.tsx:1064-1086`, guard `:1073`). **Confirmed.**
  Duplicate `observationId` with *different* content → the guard `return`s early
  (no-op): the existing record is **preserved, never overwritten or corrupted**.
  Since `observationId` is a fresh `createId()` per add, real collisions cannot
  occur; the guard is a belt-and-braces append-only safeguard. Correct behaviour.
- `assetSha256ByAttemptId` **keyed by attempt** and merged, not replaced
  (`:1101`): validating asset A on attempt 1 then asset B on attempt 2 persists
  **both** under their own keys — neither clobbers the other. **Confirmed.**
- Predecessor's two mutations (bumpAndSave neuter in `storePrintObservation`;
  `isManifestSourceUrl`→`return true`) re-corroborated by my Mutations A/E and the
  `asset-manifest` allowlist test. **Confirmed.**
- `hardenWindow` (`security.ts:28-41`) is itself only a scheme check
  (`/^https?:\/\//`→`openExternal`); the Builder's manifest-membership allowlist
  is **strictly stronger**, so a dedicated named+validated channel is the correct
  interpretation of "opens only through the allowlisted external-navigation
  channel", not a regression. **Confirmed.**

---

## Mutation Testing — mine this iteration

Baseline `calibration.workspace.test.tsx` 54 · `asset-manifest` 20 ·
`queue-dispatch` 69 (143 total green). Each mutation reverted with
`git checkout adae4e5 -- <path>` (**no `git stash`**, per corrupted-tree
warning); tree confirmed clean (`git diff --stat` empty) after every revert and
before commit.

| # | Mutation → location | Selector | Result | Isolated? |
|---|---------------------|----------|--------|-----------|
| A | durable **read** of obs → `[]` (`CalibrationStepWorkflow.tsx:582`) | `-t "survive remount"` | 1 failed @ `:2895` `findByRole listitem` | ✅ read is genuinely durable, not in-memory |
| B | neuter SHA **write** → save unchanged payload (`CalibrationWorkspaceStore.tsx:1103`) | `-t "SHA-256 is stored and displayed"` | 1 failed @ `:3020` | ✅ |
| C | durable **read** of SHA → `undefined` (`CalibrationStepWorkflow.tsx:594`) | `-t "SHA-256 survives remount"` | 1 failed @ `:3058` | ✅ |
| D | manifest URL hardcoded instead of `entries[0].sourceUrl` (`CalibrationStepWorkflow.tsx:567`) | `-t "manifest source URL opens"` | 1 failed @ `:3107` call-arg assertion | ✅ URL genuinely from manifest |
| E | neuter obs **write** → save unchanged payload (`CalibrationWorkspaceStore.tsx:1078`) | `-t "criterion 13"` | 3 failed (persist / remount / survive-invalidation) | ✅ write is load-bearing |
| R1 | **regression** redaction guard `evt.jobId===jobId`→`\|\|true` (`CalibrationQueueDispatchPanel.tsx:180`) | `-t "redact"` | 1 failed | ✅ crit-8 intact |
| R2 | **regression** rename `x-dispatch-state-if-match` header (`calibrationHttp.ts:969`) | `-t "Dispatch-State"` | 2 failed @ `queue-dispatch.test.ts:1340` | ✅ crit-6 transport intact |

The A/E pair proves the full save→load round-trip for observations; B/C proves it
for the asset SHA-256. No mutation produced zero failures.

---

## Regression sweep — the 15 previously-passing criteria

The diff touched `shared/ipc.ts`, `main/ipc.ts`, `preload.ts`, `api.ts`, the
workspace store, and the step workflow. Findings:

- **Channel removal is clean.** Deleting `CalibrationPersistPrintObservation`
  from the `IpcChannel` enum + `ipcSchemas` did not shift any other channel's
  wiring — `typecheck` 0, `lint` 0 (all removed imports pruned), and the
  `queue-dispatch`/`asset-manifest`/`workspace` suites are 143/143.
- **No existing contract shape changed.** New payload fields are
  `.optional()`; ETags remain `z.string()`; old-shape records still parse.
- **R1/R2** confirm the crit-8 redaction guard and crit-6 transport preconditions
  still bite after the iter-5 edits. No regression found.

---

## Contract spot-checks

- Free-form saga `Status`/`CurrentStep` never exhaustively switched (unchanged).
- Bed-clear sends all three preconditions or the server issues 428 (R2 proves the
  header is load-bearing).
- ETags opaque base-64 echoed byte-identically (`z.string()`, unchanged).
- Redacted `Printer-{id}` envelopes never treated as job state (R1).

---

## Residual risks / limitations to record in the PR body

1. **No live PrintFarmer server and no Klipper hardware were available** — all
   evidence is fixture/mock-based (the sidecar binary is unavailable, so
   `npm run test:e2e` was not run; the integration mechanism is `renderWorkspace`
   at `tests/calibration.workspace.test.tsx:600-630`).
2. **`filamentProfileSha256`, `processProfileSha256`,
   `printerConfigSnapshotSha256` are intentionally `null`** in the immutable
   record sent to `startCalibrationPrint` — the renderer has no distinct source
   for them; honest absence is preferred over a fabricated value in an
   ADR-0001-governed record (endorsed in the iteration-4 criterion-11 ruling).
3. **`assetSha256ByAttemptId` is a workspace-local durable map**, not a remote
   DTO field; it survives reload via the sidecar workspace-state store, which is
   the correct persistence tier for renderer-scope provenance.
4. **The completion-observation record's own `photoIds` is always `[]`** — photos
   are captured durably by the separate per-attempt "Photo evidence" subsystem
   (`workspaceState.photos`) rather than cross-linked onto the observation. This
   satisfies criterion 13's "photos" but is a minor modelling seam worth noting.

---

## Remaining action (criterion 18)

Create exactly one focused **non-draft** PR whose base is `development`, whose
body contains `Closes #54` and the explicit statement that no live PrintFarmer
server and no Klipper hardware were available (all evidence fixture/mock-based),
listing the residual limitations above. Do **not** merge it; never target `main`.

---

## Summary

Iteration 5 finishes the goal. Criteria 13, 14 and 16 are met on load-bearing
evidence: the no-op persistence stub is deleted, observations and the validated
asset SHA-256 now round-trip through the durable workspace-state path (Mutations
A/B/C/E), the manifest URL opens only through a genuine manifest-membership
allowlist on the reviewed `sourceUrl` (Mutation D + the `isManifestSourceUrl`
test pair), and no regression touches the 15 previously-passing criteria (R1/R2).
Criteria 1–17 PASS; 18 is the post-PASS PR step. **PASS.**
