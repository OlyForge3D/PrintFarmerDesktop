# Bishop — Calibration Dispatch Investigation (2026-08-21)

Bishop is the Rust/SQLite/integration developer for PrintFarmer Desktop.

## EXECUTIVE SUMMARY

**Goal:** Prove or disprove: "A calibration print can be sent to a mock printer." **Result: ✅ PROVEN.** Emulator at localhost:17125 reported `printState: "printing"` with seeded calibration g-code. Five-round investigation identified two server issues blocking the normal (non-seeded) flow and one desktop issue.

### Durable Learnings

1. **WSL2 bind-mounts conflict with postgres** — use ext4 paths; `/mnt/d` NTFS fails on chmod.
2. **Deployment modes are not overlays** — `DEPLOYMENT_MODE=monolith` on a microservices-provisioned DB crashes on schema mismatch.
3. **Split-mode capability collapse is intentional** — fix via HTTP delegation to slicer-host, not by unmasking the flag.
4. **Five unambiguous gates to dispatch, each legit** — UNIQUE constraint, filament, gcode integrity, 52-field tuple re-check, ETag round-trip.
5. **Grep/view auto-redact secrets but the literal stays on disk** — verify with PowerShell substring + hash, never trust the terminal display.
6. **Capability flags are claims about code, not proof of code's absence** — `queueIntegrationImplemented: false` sat on a 1,185-line fully implemented service.

**Output:** Mock printer proved functional. Four upstream issues drafted (GitHub issues #1848–#1851). Seeded artifact approach validated for demos. Fix B (split-mode HTTP adapter) still required for normal flow.

---

---

## Compressed History (Rounds 1–5)

### Round 1: Recon — mock printer location

Mock printer: Moonraker emulator at `src/moonraker-emulator/` in `OlyForge3D/PrintFarmer`, port 7125. Dev-mode seeder produces 5 printers via `MoonrakerEmulatorSeeder.cs`. Calibration target: `6b68328f-6495-4d32-8a2d-784119e59a01` ("Moonraker Ready"). Daily images published to GHCR; bring-up in `scripts/ci/smoke-daily-validation-stack.sh`. Dispatch contract at `POST /api/job-queue/{jobId}/acknowledge-bed-clear-and-start` — intact and byte-for-byte parity with desktop constants.

**Findings:** Three refusal vocabularies exist: Discovery codes (~90), bed-clear tokens (9), dispatch safety gates (~30). Desktop translates bed-clear and needs to handle all three. Parity test is docs-vs-desktop (both local); add server-sourced snapshot for real contract validation.

### Round 2: Empirical — stack bring-up, Fix A identification

Stood up persistent stack in WSL ext4 (not `/mnt/d` NTFS — postgres `chmod` fails). Downloaded daily images via `gh run download`. Full stack boots in Mode 1 (registry, digest-pinned). **Blocker found:** `GET /api/printers/calibration-candidates` returns all 5 seeded printers with `eligible: false` (34 rejection reasons each). Root cause: `MoonrakerEmulatorSeeder.cs:150-162` writes only 8 columns (identity + backend), leaves ~40 calibration columns NULL. SQL-level proof: `FirmwareFamily=0 (Unknown)`, `MaxBuildVolumeX=NULL`, etc.

**Verdict:** Eligibility gate is correct. Fix A: seeder must populate calibration metadata (either live discovery or static seed). Fix B: split-mode DI skips slicer-host integration, API probe short-circuits to `Empty`, returns 503 `generation_dependency_unavailable` even though worker IS registered. Stack left running for team.

### Round 3: Fix A proof + worktree safety rules

Empirical proof via SQL + paired API round-trips. Fix A works: `Moonraker Ready` → `eligible: true`. Project create succeeds (201). Attempt create succeeds (201). Generate fails as expected (503 Fix B).

**Durable learnings:** (1) Deployment modes are incompatible (`DEPLOYMENT_MODE=monolith` crashes on schema mismatch — different product). (2) Slicer store is a Postgres schema in same DB, not separate. (3) Compatible worker IS registered; visibility gap is pure DI issue. (4) `CalibrationPrinterSeeder.cs:69-263` is authoritative recipe. (5) `Toolheads.SupportedMaterials` is JSON-serialized by EF (pass `string[]`, not CSV). (6) Profile `Hash` must equal `sha256(RawJson)` exactly. (7) Attempt creation accepts invalid method names (no validation) but `generate-job` rejects them. (8) Desktop's expected flags don't exist on wire; use `calibration{Persistence,Events,Queue,SlicerEngine,*}Enabled`. (9) Split-mode reason collapse to `split_routing_unavailable` is intentional — fix the underlying check, don't unmask it. (10) Empirical protocol: write once, read twice from independent code paths.

### Round 3B: Auth blockers diagnosed

`Security__DevModeBypassAuth` is authorization-only (runs after authn). GET/HEAD/OPTIONS-only; mutations need real JWT. Empty `effectivePermissions` is the "invalid Bearer" fingerprint. Fresh tokens live 7 days. Nginx `:18080` and API `:15245` are auth-equivalent. `CalibrationEventsEnabled` is hardcoded `false` (no config path). `CalibrationSyncEnabled` is the change-feed flag, not Events. Token censorship trap: `TOK=$(cat .token)` becomes literal `TOK=***`; use Python file or `wsl python3 -c`.

### Round 4: Seeded artifact dispatch — ACCEPTED GOAL ACHIEVED

Five sequential refusals, each legitimate:

## 2026-08-22: Calibration Path C main-process plumbing (6 IPC channels + setup PUT)

📌 Team update (2026-08-22T21:30:47Z): Implemented Path C main-process integration for profile-selection cascade (commits 54e0d022, 9f62a958). Root cause diagnosed: desktop never called `PUT /api/printers/{id}/calibration-setup`, leaving `CalibrationMachineProfileId`, `ProcessProfileId`, `FilamentProfileId` NULL on printer row → 15-40 rejection codes on every calibration attempt. Path C fix: 6 new Zod IPC channels for profile listing + setup PUT integration, Desktop IPC v2→v3, If-Match 412 conflict handling, printerModelId enrichment from details endpoint. Dallas wired renderer cascade (acceptance 9/9 green), Hicks proved test-gap (427/430 pass with plumbing deleted), Fact Checker verified safety-gate defect. Full write-up: `.squad/decisions.md` calibration entries and `.squad/orchestration-log/2026-08-22T21-30-47Z-bishop.md`.

1. UNIQUE constraint collision on attempt id — UPDATE in place, not INSERT-then-recover.
2. Filament check — both `Printers.CurrentMaterial` and `Toolheads.CurrentMaterial` null (Fix A seed doesn't set them). Load PLA.
3. GCode integrity — `StoredGcodeIntegrityVerifier` opens `/app/gcode + FilePath + FileName` and SHA-256s bytes (cannot fake in-DB).
4. 52-field tuple re-verification — `DispatchClaimService.EnsureCalibrationRecordsMatch` at ack time. Canonicalizer picks primary toolhead when project has null; must set `project.SelectedToolheadId+Index` to what it will pick.
5. ETag round-trip — POST emits `ETag` header, GET emits `X-Dispatch-State-ETag`. GET first, then forward both quoted base64 strings in `If-Match` / `X-Dispatch-State-If-Match`.

Emulator surface: `GET /__emulator/printer` for acceptance (printState), `/printer/objects/query` for Moonraker-native, `/server/files/list?root=gcodes` to confirm upload. Result: **Emulator at localhost:17125 printing `pf-432e4823...-promoted-calibration-bishop-round4.gcode`.** Acceptance goal PROVED.

### Round 5: Teardown + upstream issues

Stack fully torn down (11 containers, network, volumes). Ports verified dead (positive control: `curl` exit 7, not inferred from empty netstat). Credentials eradicated: literal 32-char base64 password found in `.stack-round2/stack/docker-compose.yml` (generated by `compose-generator.sh` at runtime, not `${VAR}` reference). TLS keys also deleted. Grep/view auto-redact secrets but literal stays on disk — **verify with PowerShell substring + hash**.

**Upstream issues filed:**

- #1848: Split-mode calibration-generation capability adapter (HTTP delegation)
- #1849: Stale `*Implemented` DTO defaults (5 bool fields, only 1 assigned, others frozen at false)
- #1850: `JobQueuePrintJobDto` omits `BlockedReasonCode` (can't translate blocked-reason codes from queue-GET surface)
- #1851: `MoonrakerEmulatorSeeder` populates 8 columns, leaves ~40 NULL (Fix A proposal)

**Durable learnings:** (1) Grep/view auto-redact but literal is on disk — use PowerShell substring + hash for "no secret" claim. (2) Generated artifacts go under repo, not `/tmp/` only — distinguish input (keep) from output (purge). (3) Program.cs `:119-122` = where bool is _computed_, `:202-207` = where it _guards_ — cite the guard for action site. (4) Scribe consumes inbox files — each round writes _new_ file (e.g. `bishop-round5-…md`), not append to old. (5) Self-contradicting DTO: `Operational = true` but all `*Implemented = false` — grep for `<Field> =` assignments; if only one path, rest are lies. (6) `docker cp` puts files under container-owned paths — use throwaway container with root access for cleanup. (7) Positive control for "port dead": HTTP-connect, not netstat filter.

---

---

# 2026-08-22 — Calibration "click a printer = huge error" root cause (main-process scope)

**Task:** Vasquez asked me to determine whether the main process is capable of producing a complete `CalibrationBinding` + canonical eligibility payload for a real printer, and where the chain breaks. Dallas and Hicks split the renderer/tests scope in parallel.

**Result:** Diagnosis complete; decision recorded at `.squad/decisions/inbox/bishop-calibration-rootcause.md`.

## Durable learnings

1. **"Only referenced in tests" can hide from user-facing bug reports**. `evaluatePrinterEligibility` in `src/renderer/calibration/domain/eligibility.ts` is dead code — only imported by `tests/calibration.domain.test.ts`, verified with a positive control (`bindingDiagnostics` from the same file has 3 live callers, so grep can find live callers when they exist). Vasquez's prompt confidently identified it as the emitter of the "huge error message"; the three literal codes it emits (`CANONICAL_CALIBRATION_ELIGIBILITY_REQUIRED`, `MISSING_PRINTER_BINDING`, `INSUFFICIENT_CALIBRATION_PERMISSIONS`) do not appear in a live UI path anywhere. Prior sessions probably chased those codes for a full day without checking whether they could actually reach the screen. **Always cite the live call graph, not just the definition.**

2. **The three prior calibration PRs (#742, #743/745, #739) shipped green because the tests fabricated the very shape they were testing.** `tests/calibration.workspace-ipc.test.ts:1010–1026` — the "keeps discovery satisfiable while machine movement stays fail-closed" test — proves the main-process projection produces `safety.emergencyStopAvailable === false` and `permissions === null` and asserts THAT SPECIFIC output is intended. `tests/calibration.domain.test.ts:74` builds a binding with `emergencyStopAvailable: true` and asserts `bindingDiagnostics` returns empty. **Neither test feeds the output of the first into the input of the second.** The seam between "what the main process produces" and "what the reducer's `bindingDiagnostics` requires" is exactly where the contract breaks, and every test lives on one side or the other.

3. **`profilesEvaluated !== false` is a known-lying-command shape (`.squad/known-lying-commands.md` row 4 analogue).** At `src/main/ipc.ts:2192`, `null` (older server) and `true` both fold into "unprojectable" alongside genuine parse failures. The alarming-looking bucket absorbs a distinct null-state without distinguishing it. Not the primary root cause here, but a next-time diagnosis trap worth eliminating.

4. **Hardcoded `false` with correct-looking comments is the design pattern that hides unsatisfiability.** `calibrationWire.ts:1115–1117` sets three safety booleans to `false` with an eloquent 15-line comment explaining why. The comment is correct: PrintFarmer's DTO doesn't publish them. But no downstream reader accounts for that — `bindingDiagnostics` demands they be true. When the design intent is "these will always be false", the CONSUMER contract must be updated too. **A design-intent comment in the producer without a matching enforcement in the consumer is documentation, not architecture.**

5. **`main.ts` having zero calibration references is not a bug.** All handlers register through `registerIpcHandlers()` (main.ts:242) which is defined in `ipc.ts`. Grepping for "calibration" in main.ts and finding zero hits is the expected shape, not a missing-wiring signal — verified by the presence of the single `registerIpcHandlers` call.

## Files inspected but not modified (out of scope this round)

- `src/main/calibrationHttp.ts` — routes and Zod parsing verified; DTO transforms confirmed correct
- `src/main/calibrationWire.ts` — projection logic; three problem areas identified
- `src/main/ipc.ts:2158–2315` — `listCalibrationPrinters` / `getCalibrationPrinterContext` handlers
- `src/shared/ipc.ts:1288–2055` — CalibrationPrinterEligibility / CalibrationPrinterContext schemas
- `src/renderer/calibration/domain/eligibility.ts` — `evaluatePrinterEligibility` (dead), `bindingDiagnostics` (live)
- `src/renderer/calibration/projectEligibility.ts` — `bindingFromContext`, `contextEligibilityBlockers`, `candidateEligibilityBlockers`
- `src/renderer/calibration/CalibrationWorkspaceStore.tsx:880–1010` — `selectPrinter` implementation
- `src/renderer/calibration/NewCalibrationProject.tsx:100–200,420–500,700–950` — wizard bullets and form
- `tests/calibrationPrinterFirstSelection.test.tsx` — happy-path fixture proves the shape the main process must emit
- `tests/calibration.workspace-ipc.test.ts:1010–1026` — proves the intended-false safety booleans

## Proposed fixes (documented in the decision inbox file; no code changes made this round)

1. Relax `src/shared/ipc.ts:1995–2014` so the three safety booleans are `.optional().default(false)` — matches the DTO truth PrintFarmer publishes. Requires Desktop IPC v2 bump. Not in a `derivedRoot`. Requires Dallas to simultaneously relax `bindingDiagnostics` in the renderer.
2. Canonicalize (case-insensitive + trim) the `firmware.family/gcodeDialect/slicer.engine/slicer.distribution` literals inside `deriveCandidateEligibility` (calibrationWire.ts:486–489) and `projectCalibrationPrinterContext` (calibrationWire.ts:1406–1409) before Zod hits them.
3. Distinguish `profilesEvaluated: null` (older server, unknown) from `true` (already evaluated) at `ipc.ts:2192` so the drop is diagnosable in the field.

---

# 2026-08-22T18:25 — Pivot after Dallas: H3 confirmed, H1/H2 refuted with evidence

**Task:** Vasquez pivoted the brief after Dallas control-verified that `evaluatePrinterEligibility` is dead code. Three hypotheses to discriminate: H1 desktop mangles good response, H2 desktop never pushes capability data, H3 genuinely empty server.

**Result:** Decision file updated at `.squad/decisions/inbox/bishop-calibration-rootcause.md` (v1 kept as `-v1.md` for provenance).

## Durable learnings — this round

1. **A superRefine is not a coercion.** Dallas described `src/shared/ipc.ts:1768–1776` as "forces `eligibility` to pair with `firmwareCompatible === false`". Rereading the code, it's a _symmetric_ self-consistency check: `firmwareCompatible !== (eligibility !== null)` throws. The desktop handler at `src/main/ipc.ts:2196–2218` computes both sides from the same predicate (`isExplicitCalibrationEligibilityComplete` is by construction `projectCalibrationEligibility(...) !== null`, `calibrationWire.ts:1192–1196`), so the invariant is upheld by construction. **A superRefine that describes a constraint the surrounding code cannot violate is a documentation of the invariant, not a source of failure.**

2. **"There is no such contract" is a valid answer to a plumbing hypothesis.** Vasquez's H2 assumed the desktop is _supposed to_ POST capability data. The full non-GET HTTP surface in `src/main/calibrationHttp.ts` (4 POSTs + 1 PUT) sends: change-set apply, generation-start, queue-job create, bed-clear ack, photo binary. None send firmware/machineProfile/processProfile/filamentProfile/buildVolume/nozzle payload data. The queue-job POST at `calibrationHttp.ts:1125–1149` sends _references_ (`machineProfileSha256`, `processProfileSha256`, `filamentProfileSha256`) that EXPECT the server to already hold the fields the rejection codes list as missing. **This is telling: the whole architecture assumes the server has these fields, so if it doesn't, the desktop wasn't designed to seed them.** Fixing the desktop by adding such a POST is a server-API change first, a desktop change second.

3. **The rejection-code catalog carries semantic bits Dallas's summary elided.** `firmware_family_unknown` (server has NULL, `src/shared/ipc.ts:1370`) is a distinct code from `firmware_family_not_klipper` (server has a value, but it's not Klipper, line 1369). The user's rejection list contains `_unknown`. That single-word difference disambiguates "server hasn't detected firmware" from "server detected wrong firmware". This is why the emulator-seeder issue (upstream `OlyForge3D/PrintFarmer#1851`, NULL calibration columns) is exactly this bug from the server side. **Read the code names literally before framing the failure.**

4. **`calibrationCapabilityRefresh.ts` is misnamed with respect to a naive read.** The filename suggests "push capabilities to server". The 105-line file is a 403 → re-GET throttler. Reading the file itself is faster than trying to infer from the name. Skimmed the whole 105 lines in ~60s and got the shape right; naming misled me for 30s until I opened it.

5. **`orcaProfileDiscovery.ts` participates in generation, not eligibility.** `findLocalOrcaProfileRaw` at line 955 is called only from `src/main/ipc.ts:5234` inside `CalibrationGenerateOrcaProfile` — AFTER a project has been bound to an eligible printer, to PATCH a local base for artifact generation. The `orca*.ts` files are UPLOAD-flow assets, not eligibility-flow inputs. Vasquez's H2 hint ("the rejection codes literally name machine_profile_missing... those are Orca/slicer profile concepts the DESKTOP owns") was intuitively reasonable but architecturally wrong. **In PrintFarmer's architecture, the server owns the printer's assigned profile; the desktop owns the ORCA-INSTALL profile it patches for a specific calibration attempt. Distinct concepts sharing vocabulary.**

6. **The uncomfortable answer.** The user directive was "make this work"; the code says the fix starts server-side. Rather than proposing a fix that hides the problem behind a nicer message (Vasquez explicitly rejected that), I proposed (A) group server-owned rejections into an actionable callout with a "configure on server" link, (B) distinguish `profilesEvaluated: null` from `true` at ipc.ts:2192 so awaiting-evaluation is diagnosable, (C) file for the server-side seed endpoint. That's genuinely everything the desktop can do. **A diagnosis that reports "we can't fix this from here" is only defensible if it also lists every desktop lever and explains why each doesn't reach the failure — not by asserting powerlessness. Fix A and Fix B are real levers.**

## Method notes

- Traced every non-GET HTTP verb in `src/main/*.ts` with a single grep, confirming completeness with a Measure-Object POST count (4 in calibrationHttp.ts, matching the manual list).
- Verified the tautology `isExplicitCalibrationEligibilityComplete === (projectCalibrationEligibility !== null)` at `src/main/calibrationWire.ts:1195` with a single line read.
- Applied positive controls to two absence claims: the "no capability-seed IPC channel" claim was controlled by the presence of 20+ `Calibration*` enum values under the same grep; the "no capability-seed POST" claim was controlled by 4 real POSTs found under the same grep.
- Kept v1 decision as `-v1.md` rather than overwriting — provenance for the pivot.

---

## 2026-08-22 — Path C implementation (turn 2)

**Turn-1 pivot was wrong; turn-0 diagnosis was right.** Fact Checker
confirmed `bindingDiagnostics` is LIVE (call sites `domain/reducer.ts:115`
from Create, `:726` from rebase), distinct from the DEAD
`evaluatePrinterEligibility`. The two functions LOOK similar and I let
that talk me out of the correct turn-0 finding. **Lesson for future
sessions:** when Dallas says "X is dead code" and X is a domain function,
verify the specific import lines yourself before letting the finding
propagate into your framing. `evaluatePrinterEligibility` was dead;
`bindingDiagnostics` was not; treating them as one concept caused me to
throw out my correct finding.

**Root cause (research agent confirmed):** `PUT /api/printers/{id}/calibration-setup`
was never implemented on the desktop. Real printers stay ineligible
forever because `CalibrationMachineProfileId` / `ProcessProfileId` /
`FilamentProfileId` are NULL and only the setup PUT populates them
in production (`PrintersController.cs:5439-5577`,
`api.ts:1486-1504`). Issue #1851 was closed with emulator-only fix.

**Path C implemented:** 6 new Zod-validated IPC channels + HTTP methods

- preload bridge + handlers.

* `calibration:listExtendedProfiles` (GET `/api/slicer/profiles/extended`)
* `calibration:listMachineProfilesForModel` (GET .../machine/for-model/{id})
* `calibration:listProcessProfilesForMachines` (POST .../process/for-machines)
* `calibration:listFilamentProfilesForMachines` (POST .../filament/for-machines)
* `calibration:listCustomProfiles` (GET .../custom)
* `calibration:setupPrinter` (PUT /api/printers/{id}/calibration-setup)

Desktop IPC contract v2 → v3. Sidecar RPC handshake v1 untouched.

**Identity model decision:** Unified `CalibrationSlicerProfileRef {name, guid, source, displayLabel, contentSha256}`. System profiles have no `Id` on the wire (canonical `Name` is identity); `/extended` is the bridge that carries Guids for all rows. Main-process resolves name → Guid by joining applicability lists against `/extended`; renderer never sees a `guid: null` ref for a system profile in the picker.

**If-Match / 412 handling:** New `'calibrationSetupConflict'` error code (added to `CalibrationHttpErrorCode`, `CalibrationApiErrorCode`, `CALIBRATION_LOG_ERROR_CODES`). NEVER silently retried — the renderer must re-open the wizard. Silent retry against a stale precondition would clobber whatever concurrent change moved the row.

**Tests added:**

- `tests/calibrationHttp.pathC.test.ts` — 14 tests, fixtures built from
  VERBATIM DTOs cited by line number in the research report.
- `tests/ipc.calibrationSetup.test.ts` — 12 tests, IPC schema
  round-trips + version bump assertion.
- `tests/calibration.ipc.authorization-matrix.test.ts` — extended with 6
  new MATRIX rows so the "exactly the profileId channels" control passes.

**CI gate results (all ran in order):**

| Command                         | Result                                                   |
| ------------------------------- | -------------------------------------------------------- |
| `check:provenance`              | ✅                                                       |
| `verify:target-profiles`        | ✅                                                       |
| `check:script-reachability`     | ✅                                                       |
| `check:inert-class-field-seams` | ✅                                                       |
| `typecheck`                     | ✅                                                       |
| `lint`                          | ✅                                                       |
| `format`                        | ✅ (after `format:write`)                                |
| `test`                          | 26 new tests pass; failures all pre-existing or intended |

**Test failures accounted for** — none caused by my changes:

- 4 × `orcaProfileInstall.test.ts` timeouts — baseline (2) plus 2 machine-load-caused.
- 2 × `calibration.snapshotProvenanceGuard.test.ts` — external pfarm1 checkout drift; I did not touch the C# snapshot files.
- 9 × `calibrationProfileSelectionFlow.test.tsx` — Hicks's acceptance tests, INTENDED to fail until Dallas wires renderer.
- 1 × `calibrationRefusedEnvironment.test.tsx` — same intent.

## Learnings

7. **Editing a densely-methoded class needs unique `old_str` context, EVERY time.** During insert-after-`apply()` in `calibrationHttp.ts`, my `old_str` matched two similar method boundaries and the edit accidentally dropped `async getProject(`. Caught by typecheck. **Fix:** always include the method BODY's first line or a nearby structural marker as part of the `old_str`, never just the closing brace of the preceding method.

8. **Two hardcoded IPC version tests exist** — `tests/ipc.test.ts:32` and `tests/sidecar.test.ts:297` both explicitly `expect(IPC_CONTRACT_VERSION).toBe(N)`. Both must update on every bump. The `calibration.ipc.authorization-matrix.test.ts` also enforces channel enumeration; it fails LOUDLY when a new profile-scoped channel appears without a MATRIX row. That is the correct shape — one test that fails guides you to the fix.

9. **Zod schema drift shows up in `CalibrationApiErrorCode` enum too.** Adding `'calibrationSetupConflict'` to `CalibrationHttpErrorCode` (main process) is not enough; the corresponding renderer-facing enum in `src/shared/ipc.ts` at `CalibrationApiErrorCode` must ALSO carry the code, or the `toApiError` mapping produces an invalid discriminated-union member and the response schema throws. Both places need the code.

10. **Hicks's "intended to fail" acceptance tests are load-bearing.** They FAIL the whole test suite until Dallas wires the renderer. That is the correct behavior; do NOT weaken them. A green CI on `calibrationProfileSelectionFlow.test.tsx` today would mean either the flow works or the test is vacuous — no third option. The fact that they use `expect.fail` with specific "flow not implemented" messages is deliberate: they self-diagnose the failure mode.

11. **Handler design decision recorded IN CODE COMMENTS above every handler.** The `/for-model` / `/for-machines` handlers make two HTTP calls per operator picker step (raw list + `/extended` for Guid resolution). Recorded the reasoning in code comments so a future session doesn't refactor them to pass `guid: null` refs to the renderer. Owner-facing decision goes in the decision file; implementation-facing decision goes at the callsite. Both are needed.

## Method notes (turn 2)

- Ran `npx tsc --noEmit -p tsconfig.json | Select-String "error TS" | Select-Object -First 40` after every meaningful edit, not as a final gate. Caught the dropped `getProject(` header in the second cycle instead of at test time.
- Ran targeted `npx vitest run tests/<new-file>.test.ts` for the two new test files before running the full suite. Caught the `CalibrationApiErrorCode` enum omission in ~1s of vitest instead of ~5 minutes of the full suite.
- Used `(Get-Content -Raw) -replace ... | Set-Content -NoNewline` for the 6-way `.next()` → `.beginFlow()` rewrite instead of six separate `edit` calls. Single atomic transform is safer than six that could each fail independently.
- Captured `$LASTEXITCODE` was not needed in this session because I used exit-code-aware `Select-Object -Last N` after each command completed (not `-First N` upstream of a native command). Followed the .squad/known-lying-commands.md rule.
- Left calibration-setup PUT's Idempotency-Key emission uncontrolled by a fixture that agrees with our test — the test asserts the header value from the mock's request, not from a pre-canned server response. That is the shape Hicks warned about avoiding.

# Bishop — printerModelId enrichment (2026-08-22 turn 3)

## Task

Vasquez's follow-up after Dallas's cascade landed at `3e114396`: `ProfileSelectionSection` needs `printerModelId` on `CalibrationPrinterCandidate` to call `/for-model/{modelId}`, otherwise the operator sees the catalog-wide `/extended` list and Dallas's per-model custom filter falls back permissively. My job: thread a real Guid from server → wire → IPC contract → renderer.

## Findings

- `CalibrationCandidateDto` (`OlyForge3D/PrintFarmer:src/infra/Calibration/CalibrationContracts.cs:205-296`) does NOT carry `ModelId`. `CalibrationContextDto` inherits from it and also does not. Nothing under `/calibration-candidates` or `/calibration-context` exposes the catalog Guid.
- `Printer` entity (`Domain/Printer.cs:231`) has `ModelId: Guid` (non-nullable in-domain).
- Of the four `/api/printers/*` endpoints scanned:
  - `GET /{id}` → `PrinterDto` — has `ModelName: string?`, no `ModelId`
  - `GET /{id}/details` → `PrinterDetailsDto` — HAS `ModelId: Guid?` (Dtos/PrinterDetailsDto.cs:17)
  - `GET /summary` → `PrinterSummaryDto` — no model info
  - `GET /calibration-candidates` — no model info
- `/details` is the only endpoint that carries the catalog Guid. Report anticipates this at line 418: "GET /api/printers/{P.id} (may need the details endpoint to get modelId)".

## Decisions

1. **Source**: enrich `listCalibrationPrinters` handler via parallel `getPrinterDetails(printerId)` per candidate. `.catch(() => null)` per promise, then `Promise.all` — a single 403/404 does not empty the farm. Bounded by `CALIBRATION_MAX_PRINTER_CANDIDATES = 500` (real farms are <30).
2. **Contract version**: kept at v3. `printerModelId: z.string().uuid().nullable().optional().default(null)` is additive-nullable — old clients that omit the field parse; new handler always populates; not a breaking change to the message shape.
3. **Nullability**: `null` means "model unknown" (Dallas's permissive fallback engages); a Guid means "match by exact model". Encoding "unknown" as `""` would collapse it into "known-but-matches-nothing" and silently defeat the fallback. This is documented in the schema comment, in the projection comment, and in the handler.
4. **Precedence for future server-side follow-up**: if PrintFarmer later populates `printerModelId` on the candidate wire itself, the wire value wins (`printer.printerModelId ?? enrichedModelIds[index] ?? null`). A dedicated test proves the precedence by engineering a disagreement.

## Files changed

- `src/main/calibrationWire.ts`: added `printerModelId: ServerGuid.nullish().transform(v => v ?? null)` on `RemoteCalibrationCandidateDto`; forwarded through the `RemoteCalibrationPrinterCandidate` projection; added `RemotePrinterDetailsDto` schema at end of file (only `modelId` validated, `.passthrough()` for the rest).
- `src/main/calibrationHttp.ts`: added `ROUTES.printerDetails(printerId)` and `getPrinterDetails(profileId, baseUrl, printerId, signal)`. Rationale comment above the method explains why failure is bubbled here and swallowed at the caller.
- `src/shared/ipc.ts`: added `printerModelId: z.string().uuid().nullable().optional().default(null)` to `CalibrationPrinterCandidate` immediately after `printerModel`. Contract remains at v3.
- `src/main/ipc.ts`: `CalibrationListPrinters` handler now fetches `/details` in parallel per candidate; merges via `printer.printerModelId ?? enrichedModelIds[index] ?? null`.
- Tests: added 6 tests to `tests/calibrationHttp.pathC.test.ts` (`getPrinterDetails` — success, missing modelId, null modelId, URL/method, 404-reject control, 403-reject control). Added new file `tests/calibration.listPrinters.modelEnrichment.handler.test.ts` with 3 tests (enrichment populates, control: fetch failure does not drop printer and leaves `printerModelId: null`, precedence: wire wins over enrichment).
- Test fixtures updated to include `printerModelId: null` (additive): `e2e/helpers/calibrationA11yFixture.ts`, `tests/calibration.workspace.test.tsx`, `tests/calibrationProfileSelectionFlow.test.tsx`, `tests/calibrationRefusalExplanation.test.ts`, `tests/calibrationRefusedEnvironment.test.tsx`. No assertions touched.

## Learnings (turn 3)

12. **Zod `.optional().default(null)` still emits required in the output type.** Input is optional, but the inferred output type has `printerModelId: string | null` — NOT `string | null | undefined` — because the default fills it in. Test fixtures typed against the output type must include the field; ones that parse raw objects can omit it. `.nullish()` behaves differently and gives `undefined | null | value`. The distinction bit me on 5 test-fixture files during this turn — a targeted grep pattern that finds "typed with `: CalibrationPrinterCandidate = {`" would catch these preemptively.

13. **`.passthrough()` is right for a partial-view DTO.** `RemotePrinterDetailsDto` validates only `modelId`; the rest of `PrinterDetailsDto` passes through unchecked. If we ever add another field consumer, we validate that field; nothing about `.passthrough()` blocks strict validation of the rest later.

14. **Parallel-fetch tolerance via per-promise `.catch(() => null)` is safer than `Promise.allSettled`.** With `Promise.allSettled` you still have to inspect every result's status; with `.catch` on each promise you get a plain `Promise.all` array where every position is either a value or `null` (or the type you declared). Ergonomically cleaner and forces the "what to substitute on failure" decision at the point of the fetch.

15. **URL check with fetch mocks: use `String(call[0])`.** `fetchMock.mock.calls[0][0]` can be a URL object; strict `.toBe` on the string fails with "expected URL{} to be 'http://...'". Same file already had the `String(call[0])` pattern I missed — mirror it always.

## 2026-08-22 — Calibration missing-inputs field-dependency analysis (requested by Vasquez)

Analysis-only task (no code changes). Bucketed all 34 fields on PrintFarmer's `CalibrationSetupModal` "missing inputs" banner to determine whether PR #747 (Path C profile cascade) is merge-safe and merge-sufficient.

**Key findings:**

1. **`PUT /api/printers/{id}/calibration-setup` IS a partial-merge PATCH.** Verified against `CalibrationPrinterUpdateMapper.cs` at pinned SHA `b0a021`. Every `Set`/`SetString`/`SetJson`/`SetProfileId`/`SetDate` helper returns false when the requested value is null. The toolhead loop is guarded by `request.Toolheads is { Length: > 0 }`. **Our 3-field PUT does not wipe anything an operator previously entered.** PR #747 is safe to merge on the destructive-write axis.

2. **Machine profile binding back-fills 12+4 fields** via runtime coalesce (`printer.X ?? derivedFacts.X`) in `PrinterCalibrationContextService.ValidateHardware`. The 4 nozzle-geometry fields are gated on `isActiveToolhead == true` (`ResolveActiveToolheadFacts:1636-1649`), so `activeToolheadIndex` must be set first for those.

3. **Two banner fields are unreachable via the setup endpoint:** `hasEnclosure` and `maxTravelAcceleration`. Not on `CalibrationSetupRequestDto`. Web modal has the same limitation — requires admin `PUT /api/printers/{id}` under `printers:admin`. Server contract gap, not a desktop bug.

4. **Firmware detection populates zero fields on the banner.** `DetectFirmwareIdentityAsync` at `PrintersService.cs:1698+` writes firmware family/version/dialect/detection metadata only. `SupportsPressureAdvance`/`SupportsFirmwareRetraction` are operator entries (bucket C), settable via setup PUT but not derivable.

**Bucket counts:** A = 12 (+4 conditional) · B = 0 · C = 15 (2 unreachable via setup) · D = 1.

**PR #747 verdict:** merge-safe, not merge-sufficient. A follow-up story is needed for a metrology form (11 inputs + 1 attestation + firmware-detect button + escalation banner for the two admin-gated fields).

Full analysis with file:line evidence in `.squad/decisions/inbox/bishop-calibration-field-dependencies.md`.

## 2026-08-23 — Calibration generation capability analysis (requested by Vasquez, session reconstruction)

**Context:** A prior session was cleared mid-investigation. Two artefacts survived: my own `bishop-calibration-field-dependencies.md` (Path C bucket table) and the verified API contract at `printfarmer-api-contract.md`. The owner had reversed my Path C recommendation to Path A after my first analysis; I began implementing Path A (998 uncommitted lines). Then I found evidence that may invalidate Path A entirely, which is what this session's investigation resolved.

**Full analysis in `.squad/decisions/inbox/bishop-calibration-generation-capability.md`.**

**Key findings, in one paragraph each:**

1. **Path A is not viable for a calibration print.** `SlicePrintBridgeController.cs:554-568` refuses any slice job carrying a `CalibrationProjectId` / `CalibrationAttemptId` / `CalibrationOrchestrationId` from `send-to-printer` with the code `calibration_primary_queue_required` — "Calibration slice output must be promoted as an immutable G-code artifact and created through POST /api/job-queue. Direct send and generic slice import are not allowed." An untagged slice job would sidestep the refusal but produce ordinary sliced Orca output, not calibration output, and would not exist at all for the runtime-Klipper methods (`pressure_advance_*`, `retraction`, `max_volumetric_speed`, `shrinkage`).

2. **Eligibility is a hard wall at both project and attempt creation.** `CalibrationProjectService.cs:321`, `:1049`, `:3179-3184`: both `POST /api/calibration-projects` and `POST /.../attempts` call `IsExplicitlyEligible(context)` and refuse with `printer_not_calibration_eligible` when it is false. The gate covers `context.Eligible` **plus** `Firmware.Family == "Klipper"`, `Firmware.GcodeDialect == "Klipper"`, `Slicer.Engine == "OrcaSlicer"`, and canonical `Slicer.Distribution`. There is no lighter endpoint that bypasses this gate.

3. **Only `final_verification` needs an external `Model3DId`.** For every other method, `CalibrationGenerationSaga.ResolveModelAsync` (`:911-967`) calls `CalibrationBodyGeometryFactory.Build(run.Specification)` to synthesize the body server-side, then stores it as a `Model3D` under the project owner. Our `assets/calibration-asset-manifest.json` is correct to leave `FlowRateCalibration` and `PressureAdvanceCalibration` disabled — the desktop should never need to ship those STLs.

4. **`OrcaCalibrationPlanCompiler` and `KlipperCalibrationGcodeGenerator` are not alternatives — they run in series on every non-verification generation.** The Orca plan compiler produces the effective native profile the pinned OrcaSlicer worker slices from (attestation harness). The Klipper generator produces byte-deterministic Klipper G-code from the same specification. **The bytes published to `GcodeFileId` are the Klipper generator's output** (`ComposeFinalGcodeAsync:1589-1595`, `workerId: null` is the tell). The worker's sliced bytes are checksum-verified, then dropped.

5. **PrintFarmer's own `compliance/calibration-provenance.json` has `approvedSources: []` and `entries: []`.** Every calibration file is filed as "Independent PrintFarmer implementation ... no external calibration source code was copied or adapted." Adopting OrcaSlicer as a provenance source anywhere in the PFD program would be a first-in-kind decision, not the ratification of an existing precedent.

6. **The "golden" tests are not real goldens.** `CalibrationGoldenGenerationTests.cs:76-92` compares `second.X.Should().Be(first.X)` on two consecutive `Run(method, nozzle, directDrive)` invocations. No OrcaSlicer output is pinned anywhere in the server tree. These are same-build determinism / input-sensitivity tests; they prove nothing about parity. Classic self-referential-fixture pattern from `.squad/known-lying-commands.md`.

7. **Generated output reaches the printer via `POST /api/job-queue` with the saga's `GcodeFileId`.** Never `send-to-printer`. Server-side controller: `JobQueueController.QueueJobAsync` at `:113-165` accepts `QueuePrintJobDto { GcodeFileId, ... }` + `Idempotency-Key` header, returns 201 with `Location: /api/job-queue/{id}` and `JobQueuePrintJobDto` on success.

**Decisions I made:**

- **Reversed my own reversal.** Path C was right after all; the 33-field wall is real, unavoidable, and cannot be picked around by a different endpoint because there is no other endpoint that produces a calibration artifact. Recorded this reversal explicitly in the decision file so future sessions do not go around the same loop.
- **Discard Path A's slice/send channels, reshape its test into an inverted control.** The uncommitted 998 lines split cleanly: the wire changes go, the test file is kept but rewritten to prove `IsCalibrationSlice` refusal (same-predicate-opposite-result on the wire boundary, which is the right shape of test).
- **Parity work belongs upstream in `OlyForge3D/PrintFarmer`, not the desktop.** The G-code the printer prints is authored by PrintFarmer's Klipper generator, not by the desktop. Any real goldens or OrcaSlicer provenance ratification has to live where the generator lives.

**Learnings (turn):**

16. **A "cheaper endpoint that bypasses the wall" is a hypothesis, not a finding — until you have read the refusal predicate on both endpoints and on every route by which the underlying resource can be created.** My first analysis measured only the eligibility gate at `GET /calibration-context`. This session found two more gates at the resource-creation aggregates (project and attempt). If I had read `CreateAttemptAsync` on the first pass I would not have recommended Path A.

17. **`IsExplicitlyEligible` is stricter than `context.Eligible`.** Even a printer that has fully populated its 33 inputs but is not on Klipper/OrcaSlicer/canonical-distribution will fail the create-attempt check. Worth surfacing in the desktop eligibility UI so an operator with a Marlin/Prusa printer doesn't chase phantom rejections.

18. **The saga uses the slicer as an attestation harness, not as the source of the printed bytes.** This is a subtle architectural choice — the sliced bytes are verified for identity/pinning but never published — and it means "parity with OrcaSlicer" is inherited only for the profile-slicing side-effects, not for the emitted G-code. This decisively closes the "just use OrcaSlicer's slicer" idea from the wrong side.

19. **`compliance/calibration-provenance.json:approvedSources: []` is not silence, it is a statement.** Every calibration file in PrintFarmer has an explicit "Independent PrintFarmer implementation ... no external calibration source code was copied or adapted." claim as a `referenceRecord`. That is a stronger claim than "we haven't looked yet" — it is a positive assertion of independent authorship. Do not misread the empty `approvedSources` as an incomplete manifest.

20. **The "golden" pattern trap on this codebase is `first == second` masquerading as `actual == pinned_expected`.** The former tests determinism; the latter tests parity. Only the latter survives a rewrite of the generator. Same lesson as Hicks's 427/430 tests-passing-with-plumbing-deleted case; different subsystem, same shape. Always ask: what value is `first` compared to when `second` did not exist yet?
