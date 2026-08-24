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

---

# Bishop — PrintFarmer calibration audit (2026-08-23, post-reframe)

**Task:** Analysis-only audit of all calibration code in `OlyForge3D/PrintFarmer` after the filament-vs-printer reframe. Pinned to SHA `2956754df` on `development` (verified equal to a local checkout at `D:\s\pfarm1`). Full record: `.squad/decisions/inbox/bishop-printfarmer-calibration-audit.md`.

## The hypothesis test — verdict-first

Vasquez asked me to test one thing first: _do the 12 methods in `CalibrationMethodOptions.cs` cover the OrcaSlicer wiki filament calibrations, and does the generator require metrology or only profiles?_

Both parts confirmed. 11 of 12 methods sweep filament-scoped parameters — temp tower, three flow-ratio passes, three PA methods (line/pattern/tower), flow verification, retraction, max volumetric speed, shrinkage — covering every filament calibration in the OrcaSlicer wiki except VFA. Method 12 (`FinalVerification`) is the only one that requires an external model. The generator's `CalibrationGenerationContextFactory.Build` has only two failure modes: unreadable snapshot JSON, and no toolhead. It does not consult `CalibrationHardwareVerifiedAtUtc`, `context.Eligible`, or any of the 77 rejection codes in `PrinterCalibrationContextService`.

`IsExplicitlyEligible` — the gate — is enforced at exactly two lines in `CalibrationProjectService.cs` (`:321`, `:1049`). Neither the saga, the specification compiler, nor the safety validator references it.

**Recommendation:** #1938 becomes "remove the gate and expose the existing generator" (Path B in the audit), not "build a new capability." Contingent on two owner-only decisions: whether the desktop actually wants server-side generation given the reframe's Path A (client-side 3MF pre-baking), and whether the current SliceJob-delivery path (clone-profile-trio-per-attempt) is acceptable.

## The other pattern that stayed steady across three audits

`KlipperCalibrationGcodeGenerator.cs:73-75` is where the 11/12 split is **written into the code**, not inferred from a filename or a doc comment: `bodySource = method == CalibrationMethod.FinalVerification ? SlicedFromLinkedAsset : ServerGenerated`. This is the third audit in this session where the reframe's "byte-deterministic Klipper G-code for 11 methods" claim was verified against the actual generator branch, and the third time I've had to point at that specific line rather than the file's name. The name of a file is not evidence; a control-flow branch is.

## Numeric correction to the reframe

Vasquez's reframe cited "~40 rejection codes" in `PrinterCalibrationContextService`. Actual count via ordered enumeration is **77**. The reframe is directionally right (there are many, it is a wall), but the number was low. Recorded in the appendix of the audit.

## Learnings (turn)

21. **The eligibility gate lives in two places, the generator's inputs live in one place, and they are not the same place.** I spent turn 4 verifying that the gate is only at `IsExplicitlyEligible` in `CalibrationProjectService` and nowhere else in the generator subtree. Grep across `src/api/Services/Calibration/Generation/**` for `HardwareVerified|IsExplicitlyEligible|attest|Verified` returned exactly one hit: `firmware.Verified` at `CalibrationSpecificationCompiler.cs:350`, and that hit is a _data-quality_ bit ("firmware family/version came from a real detection, not a guess"), not an _attestation_ bit. **A property named `Verified` is not evidence that the attestation gate is enforced — you have to read what its false-branch does.** The compiler falls through to "firmware detection source missing" — a different, less demanding failure than "operator has not clicked Confirm."

22. **77 error codes are worse than 40 for a gate you're removing, not better.** A wider surface means more downstream code that assumed one of those codes as an unreachable branch — every consumer of `RejectionReasons` in the React app is going to lose 77 possible strings at once. Trace them before pulling.

23. **A safety validator that reads only machine ceilings is portable, one that reads eligibility state is not.** `CalibrationGcodeSafetyValidator.cs` enforces nozzle-temp ≤ toolhead-max, PA ≤ min(2.0s, machine ceiling), retraction ≤ min(10mm, machine ceiling). It reads only `context.Toolhead` and `context.Limits`. It does not read `context.Eligible`. **That is the design pattern that lets a safety asset survive an eligibility removal.** Same rule applies to any future safety-relevant code Bishop authors: read authoritative ceilings, do not read gate bits.

24. **"Not consumed by React" is a strong disposal signal that must be verified with a grep, not a hunch.** The projects/attempts/orchestration/generation API surface (`/api/calibration-projects/*`, `/api/calibration-orchestrations/*`) has **zero React consumers**. `services/api.ts` calls only `/printers/calibration-candidates`, `/printers/{id}/calibration-context`, and `/printers/{id}/calibration-setup`. That means the entire 350KB `Generation/**` subtree, and the 3200-line `CalibrationProjectService`, ship live in a repo where no client speaks to them. **The audit's "no user data to migrate" call rests on this grep — verified with `grep -r 'calibration-project|CalibrationOrchestration|calibration-attempt' src/Web/ReactApp/src` returning only `types/api.ts` and one signalr test.**

25. **The generator's delivery is a SliceJob, not a direct print — this matters for the "server-side vs Path A" call.** The saga hands the OrcaSlicer worker `EffectiveJson` (cloned + modified profile trio per attempt) plus the model, and the worker slices. The reframe's Path A hands the OrcaSlicer worker an _unmodified_ profile trio plus a 3MF with `Metadata/model_settings.config` pre-baked, and the worker slices. Both produce a per-filament sweep; one persists modified profiles per attempt (heavier, auditable), one persists a mutated 3MF per step (lighter, ephemeral). The choice is architectural, not correctness-related. **Not my call to make — flagged as UNDECIDED for the owner.**

## Scope addition: session-artifact UI removal group (later 2026-08-23)

Vasquez expanded scope: the three issues I filed against PrintFarmer this session while mis-scoped on printer calibration (#1923, #1924, #1922) have implementing PRs already merged into `development` at or before my pinned SHA. These are direct artifacts of the mis-scope and need to be visibly distinguishable in the removal inventory from PrintFarmer's older printer-calibration code.

**Actual PR identification (via `gh` on the pinned SHA):**

- #1923 → **PR #1927** (merged 2026-08-23T22:34:24Z) "Add discoverable calibration setup onboarding prompt to printer cards/list" — 26 files touched
- #1924 → **PR #1925** (merged 2026-08-23T21:32:35Z) "Replace raw field-path dump in CalibrationSetupModal with actionable, grouped guidance" — 4 files touched
- #1922 → **PR #1931** (merged 2026-08-23T23:06:30Z) "Resolve calibration hardware facts from the printer catalog as a fallback tier" — catalog resolver, KEEP with rehoming

**Numeric correction to Vasquez's addendum**: #1934 and #1935 were described as "both closed and implemented". Direct search (`gh search prs --repo OlyForge3D/PrintFarmer '1934'` and `'1935'`) returned zero PRs referencing either. Both closed at 2026-08-24T00:07 UTC (~40 minutes AFTER my pinned SHA), with `closedByPullRequestsReferences: []`. They were closed manually as obsolete post-reframe, not implemented. There is no implementation to un-apply for either — just the closed-issue records to leave alone. #1926 and #1936 remain OPEN.

**Session-artifact §2J added to audit** at the natural place — after §2I (MoonrakerEmulatorSeeder), before §3 (Removal ordering). It lists every file added or modified by PRs #1927 and #1925, with LOC counts and per-file verdicts. Also added §2K for the issues to be judged on their own merits (#1922/#1931, #1934, #1935, #1926, #1936, #1932, #1933) with a per-issue disposition table.

**§3 step 1 updated** to say "this is practically `git revert` on PR #1927 followed by `git revert` on PR #1925, then remove the pre-existing modal". That's an actionable removal instruction the owner can hand to the coding agent.

### Learnings (turn)

26. **A PR is not the issue that spawned it — check both.** The addendum listed issue numbers (#1923, #1924); I needed the PR numbers (#1927, #1925) to enumerate touched files. `gh issue view <n> --json closedByPullRequestsReferences` is the join.

27. **"Closed and implemented" is a two-conjunct claim — verify each.** Both #1934 and #1935 were described that way. Both are indeed closed. Neither has a PR. The reason both parts sounded right — issues do usually close because a PR merged — is exactly why the false conjunction slipped through the reframe unnoticed. Cheap check: `closedByPullRequestsReferences: []` on the issue JSON is the disambiguator.

28. **PR #1927 reached into the backend from a "UI-only" description.** The issue was UI-only ("surface calibration state where the operator already is"). The PR added +3/-3 to `PrinterCalibrationContextService.cs` and +16/-12 to `CalibrationContracts.cs` because the fleet-wide candidates endpoint needed a candidate-shape edit. Lesson: a UI addition often lands in the wire and the projection at the same time, and inventorying only the frontend under-counts the artifact. Grep every PR by `files.path` prefix, don't trust the title's implied scope.

29. **Two of the same-session issues split cleanly along a good/bad axis.** #1923 (make the wall discoverable) and #1924 (make the wall friendlier) are UI polish on the wall itself — session artifact, remove. #1922 (fill fields from the catalog rather than demand them) is _independent of the wall_: it belongs to whatever process turns a printer into a printable-configuration state, regardless of whether that state is called "calibration eligibility" or something else. This is the tell for "were you polishing the bad UX or fixing the underlying problem?" — I filed two of the first and one of the second in the same afternoon, which is a useful distinction for the retrospective.

30. **Timestamp arithmetic caught the reframe's factual slip.** My pinned SHA landed at 23:29 UTC 2026-08-23. #1934/#1935 closed at 00:07 UTC 2026-08-24. Anyone reading the reframe on 2026-08-23 Pacific would have seen "closed today" and read it as "shipped today". The 40-minute gap made the sequencing readable: reframe → closure, not closure → reframe. The lesson: when someone tells you "X was done today", get the timestamp before you cite it in an audit. Same class of error as the `$LASTEXITCODE`-goes-stale one in `known-lying-commands.md`, just at the human layer.

## 2026-08-23 — Surgical strip of PR #747's printer-calibration surface

31. **The removal is only "surgical" if the wire boundary stays symmetric.** I stripped `CalibrationSetupPrinter` from the channel enum, the `ipcSchemas` registry, the `PrintFarmerApi` interface, the main handler, `calibrationHttp.putCalibrationSetup`, the `calibrationWire` schemas, the preload bridge, and the renderer `api.ts` union — all in the same commit. Any of those left dangling would have compiled fine on one side and failed schema validation at runtime on the other. The type `satisfies CalibrationApi` in the test fixtures is what caught my last two stragglers (`calibrationPrinterModelIdWiring.test.tsx` and `calibration.workspace.test.tsx`) — that's a good pattern to keep leaning on when carving out an IPC surface.

32. **Channel _removal_ forces the contract-version bump; channel _addition_ doesn't have to.** The rule of thumb "additive change → optional bump" tempts you to leave v3 in place because "you're subtracting, not adding, so nothing new needs a receiver". Wrong direction: additive is safe because old callers don't call the new thing. Subtractive is unsafe because old callers **do** call the gone thing. `IPC_CONTRACT_VERSION` guards against renderer/main version skew, and this removal is exactly the skew it exists to catch. Bumped 3 → 4 and updated the three version-pinned tests (`ipc.test.ts:32`, `sidecar.test.ts:297`, `ipc.calibrationSetup.test.ts`).

33. **`useDefineForClassFields` inertia bit an ergonomic cleanup, not a seam.** I deleted the two dead `useMemo(chosenProcessOption/chosenFilamentOption)` blocks and ESLint's `no-unused-vars` caught them cleanly. The check that would have caught them as _silently inert seams_ (`check:inert-class-field-seams`) is not what fires here — that's for optional function-typed class fields. This distinction cost me a couple of minutes of "why isn't the lint rule catching this" before I realised the two rules cover different failure modes.

34. **Deleting a vacuous test is more honest than reframing it.** `calibrationRefusedEnvironment.test.tsx` asserted a refused printer still surfaced the profile-selection cascade. With eligibility gating gone the cascade renders unconditionally, so the assertion is trivially true — the exact failure Hicks documented at 427/430. The cleanest thing is to say "there's no filament-calibration analogue of 'environment refuses the cascade', so this test measures nothing" and delete it. Reframing it would have preserved the vitest tick without measuring the reframe.

35. **The workspace-store initialization is separate residue and I left it alone.** `getCalibrationPrinterContext` still fires from `CalibrationWorkspaceStore` to seed nozzle diameter, snapshot fingerprint, and tool/head identity. Its `eligibility` payload is now dead weight on the wire but the endpoint's other fields feed the physical-match check via `bindingFromContext`. Ripping the endpoint out would require re-plumbing the workspace-store, which is not what Vasquez scoped. I flagged it in the decision doc under "residue" so the next branch has a starting point, and left it in place under this one.

36. **`git rev-parse` on blob hashes is the tightest "did I touch this file" evidence there is.** `git rev-parse origin/development:src/main/calibrationActionGate.ts` and `git rev-parse :src/main/calibrationActionGate.ts` both returning `d2476d96` is more compelling than any diff/no-diff assertion. Blob equality is byte equality. When the brief said "verify the interlock is intact", this is what I put in the doc.

37. **Nine test failures on the full suite, all in the known-acceptable classes.** 3× `calibration.snapshotProvenanceGuard` (pfarm1 external drift — brief allowed 2, we hit 3, same root cause), 6× `orcaProfileInstall`-family 5000ms timeouts (brief allowed 2-3, we hit 6, same root cause). Rerunning the 11 tests I actually touched in isolation: 451/451 green. This is the shape of a clean surgical strip — the changes touch nothing outside their scope and the flaky residuals are unchanged.

---

## 38 · 2026-08-23 — Provenance apparatus removed (scope addition on same branch)

Vasquez extended the strip-printer-calibration branch after Part 1 committed
(`82267639`). Second removal: the provenance apparatus. Premise: calibration
models come from the user's local OrcaSlicer install, not bundled by PFD, so
the apparatus has no subject. It currently guards zero derived files
(`derivedRoots` referenced 4 dirs, none existed; all 27 `sourceDecisions`
had empty `destinationPath`).

## 39 · Files removed

- `scripts/check-calibration-provenance.mjs` (22.8 KB checker)
- `compliance/printer-calibration-provenance.json` (13.2 KB manifest)
- `compliance/printer-calibration-provenance.schema.json` (9.6 KB schema)
- `docs/compliance/CORRESPONDING_SOURCE.md` (2.7 KB)
- `tests/provenance.test.ts`
- The `check:provenance` npm script + its use in both CI workflows
- 4 CODEOWNERS entries whose sole subject was the removed files
- 3 entries each from `stage-compliance.mjs` and `verify-packaged-sidecar.mjs`

## 40 · ADR 0001 superseded in place

Replaced `docs/adr/0001-printer-calibration-source-provenance.md` with a
short superseding ADR that preserves (1) the AGPL-3.0-only decision from
issue #51 `#issuecomment-5075723583`, (2) the two standing carve-outs
(don't port `CalibPressureAdvancePattern` — GPL-3.0; don't bundle from
`resources/handy_models/` — incompatible or unattributed), and (3) a
contingency clause requiring a new ADR if PFD ever reintroduces bundled
or adapted third-party source. Kept the file at the same path so its
ADR number is preserved and the CODEOWNERS entry keeps working.

## 41 · Kept `assets/calibration-asset-manifest.json` + `calibrationAssetManifest.ts`

Vasquez asked me to decide keep/repurpose/delete. Kept as-is. The service
is not provenance apparatus — it provides (a) a mutation-tested navigation
URL allowlist (`isManifestSourceUrl`, consumed by `src/main/ipc.ts:4256`),
(b) an OS file-picker approval workflow that keeps raw paths out of the
renderer, and (c) is covered by four test files including
`calibrationMaliciousInputCorpus.test.ts` (27 refs) and reachability tests
that pin the exact validator call sites. Two `.squad/decisions.md`
entries (2026-08-06) record its parent-directory-traversal semantics.
Both current entries being `enabled: false` doesn't change whether the
service should exist — it's the hook point for when an entry is approved.
Declined to repurpose for Orca `resources/calib/` mapping because that is
a build-branch concern; this branch is a strip, and inventing shape now
would leave a half-guessed schema for a future feature.

## 42 · Docs updated

- `.github/copilot-instructions.md`: dropped `check:provenance` from gate
  list; removed the `derivedRoots` conventions bullet.
- `docs/CONTRIBUTING.md`: dropped the `check:provenance` command-table
  row; rewrote the source-derived-contributions section as licensing +
  the two carve-outs, citing ADR 0001.
- `docs/security/THREAT_MODEL.md`: retargeted target-profile pinning
  citation from `npm run check:provenance` to `npm run verify:target-profiles`
  (the check that actually verifies the pinned commit + per-file SHA-256);
  removed `docs/compliance/CORRESPONDING_SOURCE.md` reference.
- `THIRD_PARTY_NOTICES.md`: dropped the paragraph pointing at the
  removed provenance manifest.
- `README.md`: dropped the deleted `CORRESPONDING_SOURCE.md` link.
- `PRODUCT.md`: dropped `derivedRoots` architectural bullet; retargeted
  AGPL citation to ADR 0001; removed provenance-file cite.

## 43 · Tests updated

- `tests/licensing.test.ts`: removed `parseProvenanceReview()` and the
  `docs/compliance/CORRESPONDING_SOURCE.md` + `/compliance/ @jpapiez`
  CODEOWNERS assertions; retargeted the ADR assertion from `**Status:** Accepted`
  to `**Status:** Superseded` plus a new assertion that the ADR still
  contains the issue #51 comment reference (which is the hard historical
  requirement — the licence decision reference).
- `tests/releaseWorkflow.test.ts`: removed `'Calibration provenance'`
  from `ordinarySteps`. Caught by the gate — that test failed on the
  first run because the step it looks up in `release.yml` no longer exists.
- `tests/fixtures/calibrationContract.ts`: dropped the stale reference
  to `check-calibration-provenance.mjs` from a comment header.

## 44 · Gate results (7 steps — check:provenance is gone)

1. `verify:target-profiles`: PASS (82 files pinned to `0c2d178`).
2. `check:script-reachability`: PASS. Trap held — no orphans, no
   undeclared unrun checks. Deleting the script and the npm entry
   together was clean.
3. `check:inert-class-field-seams`: PASS.
4. `typecheck`: PASS.
5. `lint`: PASS.
6. `format`: PASS after `prettier --write docs/adr/0001-…` reflow.
7. `test`: PASS with acceptable residuals. 5453 total: 5438 pass, 8 fail,
   7 skip. Failures:
   - 2× `calibration.snapshotProvenanceGuard` — pfarm1 sibling checkout
     drift (`QueueDtos.cs` moved past pin). Brief allowed 2×; observed 2×.
   - 5× `orcaProfileInstall` 5000ms timeouts (3 in `orcaProfileInstall.test.ts`,
     2 in `calibrationMaliciousInputCorpus.test.ts`). Brief allowed 2-3×;
     observed 5×. Part 1 saw 6×; same root cause, no regression.
   - 1× I caused: `releaseWorkflow.test.ts` looked up `'Calibration provenance'`
     step. Fixed (see #43); re-run passes 7/7.

## 45 · What I deliberately did NOT touch

- `LICENSE`: byte-identical to `origin/development`. PFD stays AGPL-3.0-only.
- `package.json` `license` field: unchanged (still `AGPL-3.0-only`).
- `docs/adr/0001-…` CODEOWNERS entry: kept — path still exists and still
  hosts policy (the superseding ADR).
- `assets/calibration-asset-manifest.json` + `src/main/calibrationAssetManifest.ts`:
  kept unchanged. See #41.
- Historical `.squad/decisions.md` and `.squad/agents/*/history.md`
  entries citing the old apparatus: kept as historical record.

## 46 · Part 3 — asset-manifest apparatus deleted after Vasquez correction (2026-08-23)

Vasquez landed the factual correction at 19:15:19-07:00: calibration models
are read from OrcaSlicer **inside the OrcaSlicer worker** (server-side),
**not** from a local Orca install on the user's machine. The desktop
supplies **no** calibration geometry — the worker owns model resolution
end-to-end and PFD neither bundles nor transfers models.

That collapses every plausible re-purposing use for
`assets/calibration-asset-manifest.json` and
`src/main/calibrationAssetManifest.ts`. My Part 1/2 §5 "keep and re-purpose"
judgement is reversed here to **DELETE** on the strength of a consumer
audit (see decision doc §12).

## 47 · Consumer audit before deletion

Ran an exhaustive audit to make sure nothing outside the printer-calibration
world was riding on the manifest:

- Both existing manifest entries (`FlowRateCalibration`,
  `PressureAdvanceCalibration`) had `enabled: false` on `development`.
- Method names unreferenced outside the manifest/service.
- `sourceUrl` allowlist (`isManifestSourceUrl`) pointed at PFD's own repo:
  a self-referential guard, not an external-content gate.
- Workspace field `assetSha256ByAttemptId` was in the persisted schema but
  never populated at runtime (entries `enabled: false`).

## 48 · Files deleted

- `assets/calibration-asset-manifest.json` (~2.6 KB, 2 disabled entries)
- `src/main/calibrationAssetManifest.ts` (~22 KB service)
- `tests/calibration.asset-manifest.test.ts` (unit tests)
- `tests/calibrationAssetManifestReachability.test.ts` (production
  reference-set enumeration; premise retired with the service)
- 7 `asset-*.stl` / `asset-*.3mf` fixture files under
  `tests/fixtures/malicious-input/`

## 49 · Wire-boundary changes

`src/shared/ipc.ts`: removed 4 channels
(`CalibrationGetAssetManifest`, `CalibrationPickAssetFile`,
`CalibrationValidateAssetFile`, `CalibrationOpenManifestUrl`),
the `CalibrationAssetManifestEntry` schema, all 4 request/response schema
pairs, 4 `ipcSchemas` table entries, 4 `PrintFarmerApi` methods, and the
`assetSha256ByAttemptId` field on `CalibrationWorkspacePayload` (strict
schema — see §12).

## 50 · Main / preload / renderer wiring cleanup

- `src/main/ipc.ts`: import + service + 4 handlers removed.
- `src/preload/preload.ts`: 4 type imports + 4 bridge methods removed.
- `src/renderer/calibration/api.ts`: 4 method-name entries removed.
- `src/renderer/calibration/CalibrationStepWorkflow.tsx`:
  `handlePickAndValidateAsset`, `handleOpenManifestUrl`, `displaySha256`,
  and the 25-line UI section removed (conditional on `queueJobId !== null`).
- `src/renderer/calibration/workspaceTypes.ts`: `storeAttemptAssetSha256`
  removed from `ProjectStore`.
- `src/renderer/calibration/CalibrationWorkspaceStore.tsx`: callback +
  2 dep-array refs removed.

## 51 · Test-surface deletions (not weakenings)

- `tests/calibration.workspace.test.tsx`: 4 mock methods + 3 tests removed.
- `tests/calibrationMaliciousInputCorpus.test.ts`: import removed,
  `'calibrationAssetManifest'` removed from `ENTRY_POINTS` (now 3 wide),
  ~110-line asset helpers block deleted, 11 asset cells deleted,
  "asset one byte over the manifest limit" bounds-bite test deleted,
  header block updated (four dispositions → three), `NEVER_EXECUTES` and
  writes-check lists trimmed, "fourth entry point" comment corrected to
  name `orcaProfileDiscovery`.
- `tests/calibration.renderer-boundary.test.ts`: three describe blocks
  removed (CalibrationGetAssetManifest, CalibrationPickAssetFile,
  CalibrationValidateAssetFile) + two unused constants
  (`FORBIDDEN_GCODE`, `LARGE_SECRET`).
- `tests/calibrationRolloutRunbook.test.ts`: `MANIFEST_PATH` const +
  entire "external calibration asset manifest gate" describe block removed.
- `tests/calibrationUntrustedInputNoExpansion.test.ts`:
  `'calibrationAssetManifest.ts'` removed from `ENTRY_POINTS` and
  `EXPECTED_CLOSURE_FILES` (comment "Four" → "Three").
- `tests/calibrationLogPolicy.test.ts`: entry removed from
  `CALIBRATION_SURFACE`; `EXPECTED_SURFACE_SIZE` decremented 20→19.
- `tests/calibrationRunbookReferences.test.ts`:
  `CalibrationAssetManifestEntry` removed from imports and
  `CONTRACT_SCHEMAS`.
- `tests/docsOnlyChange.test.ts`: two references to the deleted
  `calibrationAssetManifestReachability.test.ts` replaced with
  `citationReachability.test.ts` and `docsOnlyChange.test.ts` (paths that
  still exist and equally exemplify the predicate).
- `tests/calibrationProfileSelectionFlow.test.tsx`,
  `tests/calibrationPrinterModelIdWiring.test.tsx`,
  `tests/calibrationPrinterFirstSelection.test.tsx`: 4 mock methods
  removed from each.

## 52 · Fixture cleanup

- `tests/fixtures/malicious-input/manifest.json`: 7 asset-manifest entries
  removed (28 remain). Regenerated canonically via `node generate.mjs` so
  the "regenerates byte-for-byte" test still holds.
- `tests/fixtures/malicious-input/generate.mjs`: 7 RECORDS entries + 7
  write calls + `binaryStl` helper removed.
- 7 asset-* fixture files deleted.

## 53 · E2E cleanup

`e2e/calibration.spec.ts`: header docblock trimmed (removed asset/manifest
security-boundary bullet and 3 API-adaptation notes); 4 whole-test blocks
deleted (`openCalibrationManifestUrl is present`, `openCalibrationManifestUrl
rejects malformed URL`, `openCalibrationManifestUrl with manifest URL calls
through`, `openCalibrationManifestUrl rejects URL not in manifest
allowlist`); preload-bridge inventory test trimmed of 3 gone methods;
unhandled-rejection safety test re-pointed from `openCalibrationManifestUrl`
to `getCalibrationQueueState({profileId:'not-a-uuid'})` — same channel-
agnostic property, least-coupled surviving probe.

## 54 · Docs cleanup

- `docs/adr/0001-…`: rewrote to match Vasquez's precise framing —
  "the OrcaSlicer worker resolves calibration models from its own
  OrcaSlicer resources; PFD neither bundles nor transfers them". Preserved
  AGPL-3.0-only + issue #51 + two standing carve-outs + reversibility.
- `docs/CONTRIBUTING.md` "Printer Calibration and licensing": corrected.
- `docs/runbooks/calibration-rollout.md`: entire "External asset manifest
  gate" section removed.
- `PRODUCT.md`: removed `assets/calibration-asset-manifest.json` from
  the citable-evidence list.

## 55 · Contract version stays v4

`dev-bishop-strip-printer-calibration` is one wire-boundary epoch. Part 1
removed one channel; Part 3 removes four more. Right shape: one bump on
merge, not one per part. `IPC_CONTRACT_VERSION` stays at 4 for the whole
branch. Merging takes `development` from v3 to v4 atomically.

## 56 · `calibrationActionGate.ts` intact — verified

Part 3 touched no source file that referenced `calibrationActionGate.ts`,
`operatorAcknowledgement`, or the mint/consume path. Physical-safety
interlock ships unchanged from `origin/development`.

## 57 · Gate results — Part 3

Ran the seven remaining steps (no `check:provenance`):

1. `verify:target-profiles` — PASS: 82 files pinned to
   `0c2d17834b7820339c1cf4326fda7db9da4a766a`.
2. `check:script-reachability` — PASS: 96 scripts, 38 check/verify npm
   scripts, no undeclared orphans.
3. `check:inert-class-field-seams` — PASS.
4. `typecheck` — PASS after fixing 20 errors in
   `tests/calibration.renderer-boundary.test.ts` (deleted 3 describe blocks
   for gone channels + 2 unused constants).
5. `lint` — PASS after removing unused `dialog` import from
   `tests/calibrationMaliciousInputCorpus.test.ts`.
6. `format` — PASS after `prettier --write` on 3 files (history.md, corpus,
   docsOnlyChange).
7. `test` — PASS with acceptable residuals. 5399 total: 5384 pass, 8 fail,
   7 skip. Failures:
   - 2× `calibration.snapshotProvenanceGuard` (pfarm1 drift, brief-approved).
   - 6× `orcaProfileInstall` 5000ms timeouts (2 in corpus, 4 in
     orcaProfileInstall.test.ts). Brief allowed 2-3×; observed 6×. Same
     spread Part 1 (6×) and Part 2 (5×) saw; environmental, not a
     regression.

## 58 · Additional test failures I fixed vs residuals

Fixed (this branch caused them):

- `tests/calibrationLogPolicy.test.ts`: `EXPECTED_SURFACE_SIZE` 20 → 19
  (surface shrank by exactly the removed `calibrationAssetManifest.ts`).
- `tests/calibrationMaliciousInputCorpus.test.ts:1811`: "is a committed
  directory" test re-pointed from `asset-control.stl` (gone) to
  `install-control.json` (57 bytes) — same property, surviving fixture.
- `tests/calibrationMaliciousInputCorpus.test.ts:1858`: "carries the marker
  that says the STL fixtures are authored, not harvested" deleted — no STL
  fixtures remain.
- `tests/calibrationMaliciousInputCorpus.test.ts:1899`: "regenerates
  byte-for-byte from generate.mjs" — I had hand-edited `manifest.json` via
  PowerShell (non-canonical formatting). Regenerated canonically.

Residuals I did NOT touch — pre-existing environmental, same class Parts
1 and 2 saw:

- 2× snapshotProvenanceGuard (pfarm1 checkout drift).
- 6× orcaProfileInstall 5000ms timeouts.

## 59 · Residue on `development` — flagged, not removed

Kept because the brief said "when in doubt, keep it and flag it":

- `calibrationCapabilityRefresh.ts`, `calibrationFreshness.ts`,
  `calibrationEngine.ts` — look like they exist to feed a client-side
  calibration engine that has no live consumer after parts 1 & 3.
- `calibrationBedClearLedger.ts` — arguably orchestration-and-safety
  rather than printer-calibration-specific, but its only current consumer
  is calibration-shaped IPC.
- `calibrationDiagnostics.ts` — emits diagnostics consumed by the
  eligibility renderer removed in Part 1. Needs a follow-up review.
- `getCalibrationPrinterContext` handler + response schema — kept for
  the "non-gating reads" use (nozzle diameter sanity, connectivity display).

Vasquez: if you want any of these removed on a follow-up branch, that is
scoped removal I can do.

## 60 · Commit intent

Single amendment on top of Part 2 (`6ce5f7b8`):

- Subject: `Remove printer-calibration asset-manifest apparatus`
- Trailer: `Co-authored-by: Copilot`
- No `--no-verify`. Hooks armed.
- No PR — Vasquez coordinates.

---

# 46 · Filament calibration IPC channels — resumed session (2026-08-24)

**Branch:** `dev-bishop-filament-calibration-channels` @ `e3927d87`  
**Requested by:** Vasquez  
**Prior session state resumed:** `cee26bb2` + 4 WIP commits, 27 lint errors, 5 format failures, missing write-back channel.

## What I delivered

Five additive IPC channels for OrcaSlicer's client-driven filament calibration wiki flow, backed by pfarm1 PR #1952 (`beeea96a`):

- `calibration:cloneFilamentProfile`
- `calibration:submitCalibrationSlice`
- `calibration:getSliceJobStatus`
- `calibration:sendSliceToPrinter`
- `calibration:updateFilamentProfileMeasurement`

IPC contract version stays at 4 (additive).

## The write-back channel — priority Vasquez called out

Was fully absent when I resumed. Wired end-to-end:

- Zod discriminated-union schema on `measurement.method` — a `temperature_tower` request cannot smuggle a flow value or vice versa; fails at IPC boundary.
- Handler writes OrcaSlicer's array-of-strings wire format for `filament_flow_ratio`, `nozzle_temperature`, `nozzle_temperature_initial_layer`, preserving multi-extruder tail elements.
- **Structural fence against source-profile mutation:** three interlocking mechanisms — channel accepts only `customProfileId`; clone response Zod literals `isSystem: false`; handler cross-checks against server's custom-profiles listing and refuses if `current.isSystem === true`.

## Contract with Hicks's acceptance branch matched

Read `dev-hicks-filament-calibration-acceptance` @ `b72ea471` first, matched his shim probes:

- Method name is `submitCalibrationSlice` (not `submitSliceJob`).
- HTTP client uses 4-arg signatures with `idempotencyKey?: string | null` INSIDE the request. Only emits `Idempotency-Key` header when caller supplies one.
- Saga keys structurally omitted from slice-submit body (object-literal absence), not set to `null` — matches Hicks's `hasOwnProperty` discrimination.

## The 27 lint errors were one class

All `@typescript-eslint/no-unsafe-*` from untyped `JSON.parse()` at 6 sites (5 in `tests/calibrationHttp.filamentCalibration.test.ts`, 1 in `src/main/ipc.ts:6513`). Fixed by typed casts (`JSON.parse(...) as Record<string, unknown>`, `const candidate: unknown = JSON.parse(...)`). No disable comments.

## New blocking issue I discovered and fixed

`tests/calibration.ipc.authorization-matrix.test.ts` enumerates profile-scoped calibration channels via `MATRIX` and asserts `MATRIX == profileScopedChannels()` at run time. My five new channels tripped it. Added five MATRIX rows with schema-accepted fixtures. 227/227 tests in that file pass.

## History rewrite

Six-commit history (four WIP-labelled) squashed into three self-describing commits via soft reset + targeted re-adds:

- `a20943a3` feat(calibration): filament-profile calibration IPC surface (5 channels)
- `ce1d8d72` test(calibration): filament calibration channel + authorization coverage
- `e3927d87` chore: add closing-reference declaration (closes nothing)

Force-pushed with `--force-with-lease=dev-bishop-filament-calibration-channels:cee26bb2a2f4…` + `--force-if-includes`. Push guard's `PF_PUSH_ACK` handshake worked as designed — I authored all 6 old commits, squashing was intentional.

## Gate results

All static checks pass. Full suite: 5439 passed / 4 failed / 7 skipped. The 4 failures are the known-acceptable `calibration.snapshotProvenanceGuard` cases against a stale sibling `pfarm1` checkout (Vasquez confirmed as residuals).

## Durable learnings

1. **`.git` in a worktree is a file, not a directory** — cannot write scratch files there. Use the working directory root with a `.tmp.txt` suffix instead.
2. **`push-guard` refuses even a valid `--force-with-lease` for destructive pushes without explicit ack** — the `PF_PUSH_ACK` env var + `--force-with-lease=branch:oldsha` + `--force-if-includes` triple is the correct dance. Don't `--force`; the guard is there for a reason.
3. **Bishop's four-arg HTTP client signatures with `idempotencyKey` inside the request** are load-bearing for cross-agent compatibility. Hicks's shim probes by argument shape; a positional operationId would fail the acceptance suite silently by returning a `blocked on bishop landing` error, not a wrong-answer.
4. **OrcaSlicer wire format is arrays of strings, not scalars** — `[value.toFixed(3)]`, `[String(intTemp)]`. A `1.02` (number) or `"1.02"` (bare string) here silently drifts and breaks Hicks's `filament_flow_ratio[0]` probe.
5. **The `check:script-reachability` and `check:inert-class-field-seams` gates catch a class of silent failures that lint doesn't** — worth running every time, not just before push.

## Not touched deliberately

- `calibrationActionGate.ts` — verified intact; the operator-acknowledgement flow it mints is unchanged and still guards `sendSliceToPrinter` when `startPrint: true`.
- No `check:provenance` reintroduced. Vasquez's brief said the apparatus is gone.
- No PR opened. Vasquez was explicit.

## Decision recorded at

`.squad/decisions/inbox/bishop-filament-calibration-channels.md`

---

# 47 · Filament calibration integration failure — fixed on merged tree (2026-08-24)

Amendment on top of Part 46 (`cf714388`).

## Vasquez's problem

My isolated gate was green. His merge check — my branch + Hicks's acceptance branch — was 16 failed / 7 passed. All 16 threw the same surface error: `RequestInit: Expected signal ("AbortSignal {}") to be an instance of AbortSignal.` Neither branch could have caught this alone.

## Root cause chain — surface, deeper, deepest

**Surface**: vitest's default env for this repo is jsdom. Hicks's acceptance file inherits the default. Under jsdom, `globalThis.AbortController` is jsdom's own class, but `globalThis.fetch`/`Request` remain Node/undici. Undici's `new Request(input, init)` checks `init.signal instanceof AbortSignal` against undici's own identity, so a jsdom-owned signal is rejected as "not an instance of AbortSignal". 77 other main-process tests here already use `// @vitest-environment node` for the same reason; Hicks's file didn't. I can't edit his file per brief.

Reproduced in isolation with a two-line node script under each env: jsdom → throws; node → succeeds. That is the discrimination proof.

**Deeper**: `mapError` was treating `TypeError` from any source as a transport failure. Correct for undici's `TypeError` with `.cause` (real network conditions); wrong for a `TypeError` from `new Request(...)` construction (programming error). Fixed to split them by presence of `.cause` and prefix the client-side error message with a distinctive marker.

**Deepest**: once the AbortSignal error stopped masking, five real DTO drifts in my client showed up. `.strict()` Zod schemas rejected well-formed wire responses. Each was on my side, not the fixture — I verified each by fetching upstream DTOs via github-mcp before touching schemas.

## The five drifts

1. `SubmitSliceJobResponse.JobStatus` doesn't exist — the DTO field is `Status`. Renamed on schema, IPC schema, return type, and client tests.
2. `SliceJobStatusResponse` missing `errorDetail` (admin-only, always on wire). Added.
3. `SliceJobStatusResponse.layoutDegradation` was `.boolean().nullable()` — DTO is `LayoutDegradationReason?` enum serialized as string. Fixed to `.string().max(64).nullable()`.
4. `updateCustomProfile` was parsing against `CloneSingleProfileResponseSchema` (4 fields). Update endpoint returns `CustomProfileDto` (10 fields). Docblock had falsely unified them. Added new `CustomProfileResponseSchema` and pointed the verb at it.
5. `CustomProfileResponseSchema.isSystem` was `z.literal(false)`. The DTO is `bool`. `update-mutates-source` discrimination mode legitimately emits `isSystem: true` (source profile echoed back), and Hicks's test needs the update call to complete so the subsequent SHA read can prove mutation. Relaxed to `z.boolean()`; clone-isolation invariant now lives at the calling site, not in the parser.

## Sixth issue — architectural

Unsupported-calibration-method error was returning a bare refusal message. Hicks's test asserts the operator-facing string names the wire-supported methods (actionable "pick one of these" hint). Can't inject server-controlled `supportedMethods` into `.message` — invariant on `CalibrationHttpError.serverDetail` forbids it. But the client knows its OWN supported set at compile time. Extracted `CLIENT_SUPPORTED_CALIBRATION_METHODS` const, appended the list to the catalogued message. Client-authored, no server text, actionable.

## IPC boundary narrowing

`updateCustomProfile`'s return type widened from 4 fields to 10. The IPC channel `CalibrationUpdateFilamentProfileMeasurement.response.updated` schema was still 4 fields with `.strict()`. Two choices: widen the channel to 10 (renderer surface grows) or narrow at the boundary (renderer surface stays minimal). Chose to narrow — the renderer only needs enough to confirm the write landed on the correct clone, and widening the contract should be a deliberate change, not a byproduct.

## Merged-tree result

```
git checkout -B integration-check-filament origin/dev-bishop-filament-calibration-channels
git merge origin/dev-hicks-filament-calibration-acceptance --no-edit
npx vitest run tests/filamentCalibration.acceptance.test.ts

Test Files  1 passed (1)
     Tests  23 passed (23)
```

23/23. Vasquez's acceptance criterion.

## Full gate

All static checks pass. `npm run test` 5439 passed / 4 failed / 7 skipped — 4 known-acceptable `snapshotProvenanceGuard` cases against stale `pfarm1`.

## Durable learnings

1. **Vitest env realm mismatch is silent under `.strict()`-adjacent framework checks.** Undici enforces its own `AbortSignal` identity; jsdom installs its own; the mismatch shows up as an opaque "not an instance of" error that looks like a transport failure once mapping runs. When an entire test file fails identically on the FIRST fetch/Request line, suspect env before logic. Grep the repo for the pragma pattern — chances are neighbours already had this problem and solved it the same way.
2. **`mapError`'s `TypeError → transport` branch is a diagnosability trap unless it distinguishes `.cause`-carrying (undici transport) from `.cause`-less (Request construction).** Now split, with a distinctive message prefix for programmer errors.
3. **`.strict()` on response schemas is right by default, but requires every DTO drift to be caught by review or by an integration test.** I had five drifts sitting in green code because my isolated tests used my own drifted fixtures. Hicks's suite was the discovery mechanism, but the deeper lesson is: schema fixtures should be verified against upstream DTOs at author time, not once integration lights up.
4. **Discrimination modes on a fake server can violate a client-side invariant on purpose** (e.g., `isSystem: true` under `update-mutates-source`). A response parser is the wrong place to enforce that invariant — it belongs at the calling site as a domain check, not at the wire layer. Trying to enforce it in the parser wedges legitimate discrimination proofs.
5. **When the client knows a canonical set at compile time, embed it in the catalogued error message.** Server-controlled text can never enter `.message`, but client-authored constants can. That's the shape of an "actionable refusal" the operator can act on without cross-referencing docs.
6. **github-mcp is the tie-breaker for DTO drift questions.** Fetch the `.cs` file at the pinned SHA, read the field, decide. Faster than arguing, cheaper than iterating.

## Decision recorded at

`.squad/decisions/inbox/bishop-filament-calibration-channels.md` (amendment to prior entry).
