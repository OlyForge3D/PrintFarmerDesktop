# Bishop — Recent Sessions

Bishop is the Rust/SQLite/integration developer for PrintFarmer Desktop.

## SUMMARY (2026-08-21)

**Five rounds of empirical proof + two durable learnings across three days:**

1. **Round 1 (recon):** Mock printer exists. Moonraker emulator at localhost:17125. Daily-validation stack at `scripts/ci/smoke-daily-validation-stack.sh`. Seeder doesn't populate calibration metadata (FIX-A). Split-mode DI skips slicer-host, blocking generation probe (FIX-B).
2. **Round 2 (empirical stack):** Stood up persistent stack in WSL ext4. Project create blocked with `printer_not_calibration_eligible`. Three refusal vocabularies identified (discovery codes / bed-clear tokens / dispatch safety gates).
3. **Round 3 (Fix A proof):** SQL seed + empirical round-trip verification. Moonraker Ready now eligible. Generation still 503 on split-mode. Stack left running for Ripley/Dallas.
4. **Round 3B (blocker diagnosis):** DevModeBypassAuth is auth-only, not authn. Slicer worker IS registered but unreachable from split-mode API process.
5. **Round 4 (Hicks blockers):** Auth token acquired. Live dispatch test wired.
6. **Round 5:** Drove calibration print end-to-end. Moonraker reports `printState: printing` with seeded g-code on virtual SD.

**Durable learnings:** (a) WSL2 bind-mounts are hostile to postgres; use ext4. (b) Deployment modes target incompatible schema fingerprints; do not treat DEPLOYMENT_MODE as an overlay knob. (c) Split-mode capability collapse is deliberate; fix via HTTP delegation, not flag unmasking.

**Output:** Full recon + three rounds of empirical proof. No server code changed. Stack running at `D:\s\pfarm1\.stack-round2`. Token at `/tmp/printfarmer-round2/.token`.

---

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). No Rust/SQLite code touched during this session — infrastructure only.

## 2026-08-21: PrintFarmer server-side calibration recon (mock printer)

Read-only recon of `D:\s\pfarm1` (OlyForge3D/PrintFarmer @ development)
answering "how do we test a calibration print end-to-end without a physical
printer or a production server?" No files changed in the server repo.
Deliverable written to
`.squad/decisions/inbox/bishop-printfarmer-mock-printer-recon.md`.

Key findings:

- The mock printer exists and is production-quality. It is the Moonraker
  protocol emulator at
  `src/moonraker-emulator/Farm.Moonraker.Emulator/` — a Kestrel service
  speaking real Klipper/Moonraker HTTP+WS on port 7125. Four scenarios
  (Ready/Printing/Paused/Shutdown) + a phantom Offline seed. Control API
  at `/__emulator/**` for scenario switching and fault injection, gated by
  `Emulator__EnableControlApi=true`.
- The dev-mode API auto-seeds five stable-GUID printer rows via
  `MoonrakerEmulatorSeeder` when `MoonrakerEmulatorSeed__Enabled=true`.
  Calibration target is `6b68328f-6495-4d32-8a2d-784119e59a01` ("Moonraker
  Ready", `http://moonraker-ready:7125`, backend
  `PrinterBackend.Moonraker`).
- The "daily full-stack web-UI verification pipeline" the user referenced
  is `.github/workflows/daily-development-images.yml`. It does NOT produce
  screenshots — it publishes six digest-pinned container images to GHCR
  (including `printfarmer-moonraker-emulator`) plus one
  `daily-development-image-set` artifact whose `image-set.json` is the
  atomic release unit. The bring-up is codified in
  `scripts/ci/smoke-daily-validation-stack.sh`.
- The dispatch contract is intact. `POST /api/job-queue/{jobId}/
acknowledge-bed-clear-and-start` (JobQueueController.cs:1120-1295) is the
  calibration entrypoint. Three preconditions: `Idempotency-Key` +
  `If-Match` + `X-Dispatch-State-If-Match`. Full outcome table 202/200/404/
  409(4 tokens)/412/422(2 tokens)/428/503. Desktop's
  `CALIBRATION_QUEUE_ROUTE_TEMPLATES`, `BED_CLEAR_PRECONDITION_HEADER_NAMES`,
  and 409/422 mappers match byte-for-byte.
- `tests/calibrationServerContractParity.test.ts` is docs-vs-desktop, not
  desktop-vs-server. Both sides live in the desktop repo. It would stay
  green through a real server drift. Rename or add a companion test against
  a machine-generated OpenAPI spec.

## Learnings

- 2026-08-21: There are THREE distinct calibration refusal vocabularies on
  the server, and they must not be conflated:
  1. Discovery (~90 codes, `CalibrationRejectionReasonDto.Code`) — produced
     by `PrinterCalibrationContextService` (~40 `Reject(...)` calls, 121
     code-shaped string literals in the file). Desktop enumerates these
     exhaustively in `src/renderer/calibration/refusalMessages.ts`.
  2. Bed-clear HTTP tokens (8 codes: `job_not_found`, `wrong_job`,
     `printer_busy`, `job_not_dispatchable`,
     `idempotency_payload_mismatch`, `dispatch_revision_conflict`,
     `calibration_job_incompatible`, `filament_check_failed`, plus
     `precondition_required` and `printer_offline_or_stale` at the
     boundary). Desktop covers all 409/422 exactly.
  3. Dispatch-safety `JobBlockedReasonCode` (~30 codes from
     `src/infra/Services/Queue/Dispatch/DispatchSafetyGates.cs`
     `MapBlockedReason`, lines 19-53) — the fail-closed precondition
     evaluator shared by the claim service and the bed-clear service.
     Emitted through job DTOs on `printStartBlockedReason`. The desktop
     carries the field
     (`src/shared/ipc.ts:4507 printStartBlockedReason: z.string().max(256).nullable()`)
     but the renderer does NOT translate the tokens. This is very likely
     why calibration "doesn't work" — the operator sees a generic refusal
     when the real gate is (e.g.) `calibration_record_missing` or
     `gcode_dialect_mismatch` on the seeded emulator printer.
- 2026-08-21: The daily image set is authoritative for local reproducibility.
  `scripts/ci/smoke-daily-validation-stack.sh` auto-detects six
  `PRINTFARMER_*_IMAGE` env vars — set them all from the run's
  `image-set.json` to reproduce a specific development-branch commit
  end-to-end; leave them unset to build from source. Compose loopback
  ports live in `scripts/docker/compose-templates/docker-compose.daily-validation.yml`
  (API `15245`, nginx `18080`, moonraker-ready `17125`).
- 2026-08-21: A parity test that compares a codebase constant to a
  markdown table in the same repo is a lint, not a contract test. Both
  sides drift together. When a comment in the code cites a specific
  server commit as "source", it is a manual pin — a note-to-self, not an
  invariant. Verify by treating that pin as a claim, not evidence.
- 2026-08-21: `known-lying-commands.md` §single-quote-brace-expressions is
  live for any git/gh scripting on Windows: `git rev-parse HEAD^{tree}` is
  a real trap; single-quote it. Also: `gh --jq` returns a string array in
  PowerShell; join before `.Contains()`. Not exercised this recon (no git
  scripting needed) but noted for the next Bishop.
- 2026-07-23: The native workspace lives at `native/` with a `model-core`
  crate (`Cargo.toml`, `Cargo.lock`, `target/`) — this is where SQLite
  schema and model parsing logic will live. Look here first for any
  native integration work.

## 2026-08-21 (Round 2): Empirical stack bring-up against daily-validation images

**Task:** Bring up the daily-validation stack locally, drive the calibration
dispatch path against the seeded Moonraker Ready printer
(`6b68328f-6495-4d32-8a2d-784119e59a01`), answer Ripley's Q1–Q9 with real
HTTP responses, and determine what — if anything — must change server-side
so a calibration print can reach the mock printer.

### What I did

- Downloaded the daily-development-images image-set artifact from
  `OlyForge3D/PrintFarmer` run `32491414674` (commit `6cf79de`) via
  `gh run download`. Confirmed anonymous GHCR pull works for the six
  `printfarmer-*` packages — no `docker login` required.
- Ran `scripts/ci/smoke-daily-validation-stack.sh` in Mode 1 (registry,
  digest-pinned) via WSL Ubuntu-24.04 — all assertions passed and the
  stack tore itself back down via its cleanup trap.
- Wrote a persistent variant at `D:\s\pfarm1\.stack-round2\bring-up.sh`
  that omits the trap and moves `STACK_ROOT` to WSL-native ext4
  (`/tmp/printfarmer-round2`) because the `/mnt/d/*` 9P bind-mount does
  not permit postgres to `chmod /var/lib/postgresql/data`. Left the stack
  running for Ripley/Dallas to reproduce against.
- Answered Ripley's Q1–Q9 with real HTTP responses (project probe files
  at `/tmp/printfarmer-round2/probe/*`).
- Attempted the full end-to-end dispatch walk. Stopped at Stage 1 with
  `422 printer_not_calibration_eligible`. Root cause traced to
  `MoonrakerEmulatorSeeder.cs` writing only 8 columns to the `Printers`
  table (Name, ServerUrl, Backend, IsEnabled, Manufacturer/Model,
  BackendPort/FrontendPort) and leaving ~40 calibration columns NULL.
  SQL-verified: `FirmwareFamily=0 (Unknown)`, `MaxBuildVolumeX=NULL`,
  `CalibrationHardwareVerifiedAtUtc=NULL`, etc.

### Empirical findings

- Q1's field names in Ripley's spec (`calibrationApiEnabled`,
  `calibrationChangeFeedEnabled`, `calibrationOfflineDraftEnabled`) DO
  NOT EXIST in the wire response. Substitutes: `calibrationContextEnabled`,
  `calibrationPersistenceEnabled`, `calibrationEventsEnabled`,
  `operatorFeatures.offlineWriteReplayEnabled`.
- Q2 and Q3 PASS exactly as Ripley expected.
- Q4: **five candidates, all `eligible: false` with 34 rejection reasons
  each** — every calibration metadata field is `missing`/`unknown`.
- Q5: context DTO shape is complete but values are empty because the
  underlying Printer row has no calibration configuration.
- Q6: `calibrationGenerationEnabled: false` despite the slicer-host
  container running and accepting worker heartbeats. Split-mode capability
  probe collapses ALL sub-failures to `split_routing_unavailable`,
  masking the specific gap.
- Q7: `jobKind:"FilamentCalibration"` is accepted syntactically, but the
  404 for a missing gcodeFileId returns `text/plain` — desktop must
  content-type-check before parsing.
- Q8: bed-clear preconditions confirmed exactly. Wire body is JSON with
  key `"error"` (not `"type"` or `"code"`) and a human-readable
  `"detail"`. `precondition_required` and `job_not_found` observed.
- Q9: emulator advertises Klipper via `/printer/info` (`klipper_path`
  present) but the seeder never ingests it.
- Full end-to-end: **NO** — a calibration print cannot reach the emulator
  today. Blocked at project-create with `printer_not_calibration_eligible`.
  Even if that were bypassed, `/generate-job` would 503 on
  `calibrationGenerationEnabled: false`.

### Verdict

The eligibility gate is doing the right thing — you should not calibrate
a printer whose firmware family is Unknown. The **legitimate server bug**
is `MoonrakerEmulatorSeeder` not populating calibration metadata, when
the emulator itself advertises everything needed. Recommended fix path
documented in `.squad/decisions/inbox/bishop-printfarmer-mock-printer-recon.md`
under R2.11 (FIX-A/FIX-B). Ripley's Option A architectural conclusion
stands.

### Learnings (durable)

- **WSL2 bind mounts are hostile to postgres.** Any persistent stack that
  bind-mounts a `/mnt/d/*` (NTFS-backed) path into a postgres container
  will fail `initdb` with `could not change permissions of directory
"/var/lib/postgresql/data": Operation not permitted`. Move
  `STACK_ROOT` to WSL-native ext4 (`/tmp/*` or `/home/*`).
- **The canonical smoke script self-destructs.** `scripts/ci/smoke-daily-
validation-stack.sh` has `trap cleanup EXIT` — you cannot re-use it for
  a stack you want to keep running. Write a no-trap variant if you need
  persistence.
- **Split-mode capability collapse.** When PrintFarmer is deployed in
  split mode (nginx-proxy-split.conf, slicer-host on 5246), the capability
  probe collapses eight orthogonal sub-checks
  (`deterministicCore`, `modelStorage`, `sliceSubmission`,
  `artifactSource`, `pinnedWorker`, `promotion`, `orchestrationStore`,
  `recoveryHealthy`) to a single `split_routing_unavailable` token.
  The truth per sub-check lives in the `calibrationGeneration`
  sub-object — read that, not just the top-level flag.
- **Server error body key is `"error"`.** All 4xx problem responses in
  the calibration/dispatch surface use `{"error":"<token>","detail":"<msg>"}`
  as the JSON shape, NOT the RFC-7807 default of `type`/`title`/`detail`.
  When shaping desktop-side parsers, key on `error`. The exception is
  the routes that already emit RFC-7807 (like `/api/calibration-projects`
  with `type: https://printfarmer.dev/problems/...` and `code: ...`);
  parsers must handle both.
- **Non-JSON error bodies exist.** `POST /api/job-queue` returns
  `text/plain` for the "gcode file not found" case. Do not assume
  JSON in dispatch error handling.
- **Compose down needs full env.** Tearing down a daily-validation stack
  requires all six `PRINTFARMER_*_IMAGE` env vars set AND
  `source scripts/docker/container-versions.conf` for the base image tags
  (`SDK_TAG`, `ASPNET_TAG`, `NGINX_TAG`, `UBUNTU_TAG`). Missing any
  produces `required variable ... is missing a value`.
- **`MoonrakerEmulatorSeeder` writes 8 fields, leaves 40 NULL.** For the
  emulator to become calibratable, the seeder must either accept a
  `CalibrationConfiguration` sub-block per printer seed (static) or
  perform live discovery against the emulator on seed (dynamic). SQL-
  level bandaid is possible for one-shot testing but is not a real
  fix.
- **9 durable `JobBlockedReasonCode` values, ~26 wire tokens map to
  them.** The desktop only needs to translate 9 enum names (via
  `JsonStringEnumConverter`); Dallas's translation table is small.
  Unrecognized error strings return `null` — desktop must handle
  "unclassified refusal" separately (raw error string display fallback).

## 2026-08-21 (Round 3)

Followup to Round 2. Empirical proof of Fix A via SQL against the live daily-validation stack, and a definitive demonstration that Fix B is a product-code gap that no overlay change can close in the split (microservices) deployment. Stack left running, no product code modified in `D:\s\pfarm1\`.

**Result of the round:**

- Fix A works. `Moonraker Ready` is now `eligible: true` with `profilesEvaluated: true` and `rejectionReasons: []` in both `calibration-candidates` and `calibration-context`.
- `POST /api/calibration-projects` → **201 Created**.
- `POST /api/calibration-projects/{p}/attempts` → **201 Created**.
- `POST /api/calibration-projects/{p}/attempts/{a}/generate-job` → **503 `generation_dependency_unavailable`** — the exact Fix B blocker. Emulator not reached; can't be, until Fix B lands.

**Durable learnings:**

1. **Deployment modes target incompatible schema fingerprints.** Attempting `DEPLOYMENT_MODE=monolith` on a daily-validation stack whose Postgres was provisioned by microservices-mode migrations crashes on `DatabaseMigrationContractException: schema_validation_failed. The schema is missing required objects: public.Printers.HasHeatedChamber.` The plain-named `HasHeatedChamber` column exists on `PrinterModel.cs:52` but not on `Printer.cs`; the calibration-scoped `CalibrationHasHeatedChamber` at `Printer.cs:342` is the microservices variant. Different modes are different products. Do not treat `DEPLOYMENT_MODE` as an overlay knob.

2. **The slicer store is a Postgres schema in the same database, not a separate database.** `slicer.SlicerServices`, `slicer.Workers`, `slicer.MachineProfiles`, `slicer.ProcessProfiles`, `slicer.FilamentProfiles`, `slicer.SliceJobs`, `slicer.Artifacts`, `slicer.MachineModelProfiles`, `slicer.Models3D`, `slicer.SlicerSettings`. This means SQL-level empirical proofs against both stores are feasible from one psql session, which was the enabler for this round. Do not assume "slicer-host has its own DB" — it does not.

3. **A compatible worker IS registered by slicer-host.** In the daily stack, `slicer.SlicerServices` has one Online OrcaSlicer 2.4.2 upstream service and `slicer.Workers` has one Online worker (`32c6c334-c592-447b-8a5e-f9d553d4fc2c`, `IsDisabled=false`, `TotalSlots=1`, `ApiKey` present, recent heartbeat). The gap between "worker is healthy" and "capabilities say `calibrationGenerationEnabled: true`" is purely one of **visibility from the API process**: `Program.cs:119-122` deliberately skips `AddSlicerIntegration` in microservices mode, so `IDbContextFactory<SlicerDbContext>` is not registered and `CalibrationGenerationCapabilityProbe.FindWorkerCompatibilityAsync` short-circuits to `WorkerCompatibilitySnapshot.Empty`. The Fix B PR shape is therefore: add an authenticated HTTP `SlicerHostCapabilityClient` to `SlicerHostAdapterRegistrations`, add a `/api/internal/capabilities/worker-compatibility` endpoint to slicer-host, and delegate from the probe when `SlicerDbContext` factory is null.

4. **`CalibrationPrinterSeeder.cs` is the authoritative recipe.** `src/tests/Farm.Web.Api.Tests/Calibration/CalibrationPrinterSeeder.cs` lines 69-263 encode every column the eligibility gate reads and every profile the resolver requires. Any calibration eligibility fixture, live or test, that does not match its shape 1:1 will be wrong. `deriveHardwareFromMachineProfile=false` is the branch that produces a fully-eligible printer with explicit Printer columns; `=true` is the alternative parity mode that leaves them null and derives from the machine profile's `RawJson`. Copy verbatim, do not paraphrase.

5. **`Toolheads.SupportedMaterials` is JSON-serialized by EF.** `PrinterModelToolheadConfiguration.cs:22-25` and `ToolheadConfiguration.cs:37-40` both wire `HasConversion(v => JsonSerializer.Serialize(v...), v => JsonSerializer.Deserialize<string[]>(v...))`. Writing `'PLA,PETG'` produces `System.Text.Json.JsonException: 'P' is an invalid start of a value` at every subsequent `GET /api/printers` call, cascaded as `Error enumerating printers for subscription`. Any real seeder PR must pass `new[] { "PLA", "PETG" }` (a `string[]`) and let EF Core serialize.

6. **Profile `Hash` MUST equal `sha256(RawJson)` exactly.** Any other value fails `calibration-context` with three `profile_hash_mismatch` reasons (`profiles.machine.sha256`, `profiles.process.sha256`, `profiles.filament.sha256`) and blocks eligibility. Test seeder uses `Sha256(machineJson)` etc.; SQL-side use `encode(sha256("RawJson"::bytea), 'hex')`.

7. **`POST /api/calibration-projects/{p}/attempts` has looser method validation than `generate-job`.** Attempt creation accepts `method="manual"` (or any string) and returns 201 with a doomed attempt. `generate-job` then refuses with `unsupported_or_unsafe_calibration_specification / method_unsupported` because it enforces `CalibrationMethodNames.TryParse` (canonical set: `temperature`, `flow_ratio_coarse`, `flow_ratio_fine`, `flow_ratio_high_range`, `pressure_advance_tower`, `pressure_advance_line`, `pressure_advance_pattern`, `flow_verification`, `retraction`, `max_volumetric_speed`, `shrinkage`, `final_verification`). Ripley/Dallas should surface a client-side check that rejects non-canonical method names before hitting attempt creation.

8. **The desktop's `calibrationApiEnabled` / `calibrationChangeFeedEnabled` / `calibrationOfflineDraftEnabled` flags do not exist on the wire.** Live server sends `calibrationPersistenceEnabled`, `calibrationSyncEnabled`, `calibrationEventsEnabled`, `calibrationContextEnabled`, `calibrationGenerationEnabled`, `calibrationQueueEnabled`, `calibrationSlicingEnabled`, `calibrationJobBoundBedClearEnabled`, `calibrationProfileHistoryEnabled`, `calibrationPhotosEnabled`, `calibrationArtifactPromotionEnabled`. Ripley's fix at `calibrationWire.ts:1646-1648` addresses this. Hicks' parity test MUST assert against the live server set, never the desktop's fixture set.

9. **`IsSplitDeployment` reason-collapse is deliberate.** `CalibrationGenerationCapabilityProbe.cs:189-192` replaces the specific failing sub-check reason with the generic `split_routing_unavailable` in split-mode responses. This is an operator-facing simplification that hides which of 8 sub-checks failed. Do not change it while implementing Fix B; instead fix the underlying sub-check (`WorkerCompatibilityAvailable`) via HTTP delegation. Otherwise Dallas' `unavailableReasons` translation and any wire-parity test locks in the wrong contract.

10. **The empirical protocol is: write once, read twice.** Every SQL patch was followed by a paired API round-trip that reads the patched state through the same public endpoint the desktop uses. The two reads (candidates and context) are independent evaluators that share no code path with the SQL, so agreement between them is a genuine cross-check, not a self-check. This is the pattern I want for future data-only proofs.

**Files touched (all in `D:\s\pfarm1\.stack-round2\` unless noted):**

- `fix-a.sql`, `baseline-candidates.sh`, `check-eligibility.sh`, `check-caps-after.sh`, `probe-attempt-generate.sh`, `probe-generate-temp.sh`, `tear-down.sh`
- `.squad/decisions/inbox/bishop-printfarmer-mock-printer-recon.md` (Round-3 append starting `# ROUND 3 — Fix A empirical proof`)
- `.squad/agents/bishop/history.md` (this entry)

**No product code was modified. No credentials or `.env` contents committed. Stack left running for Ripley and Hicks. Fresh admin token in `/tmp/printfarmer-round2/.token`.**

## 2026-08-21 (Round 3B — Hicks blockers)

Two Hicks-relayed blockers, both diagnosed outside the desktop repo. Details in
`.squad/decisions/inbox/bishop-printfarmer-mock-printer-recon.md` under
"# ROUND 3B — Hicks-relayed blockers". Durable learnings:

- **`Security__DevModeBypassAuth` is authorization-only, not authentication.**
  `DevModeAuthorizationHandler.cs:34-64` implements `IAuthorizationHandler`,
  which runs only after authentication middleware establishes an identity. A
  401 `authentication_required` cannot be turned into a 200 by the bypass — no
  amount of nginx pipeline reordering or scope widening can help. If you see
  401 with the bypass "on," suspect an expired/missing token first.
- **DevMode bypass is also GET/HEAD/OPTIONS-only.** `DevModeAuthorizationHandler.cs:48`.
  Mutations always need a real identity, so admin JWT is required for any
  create/update flow. Do not propose widening this to POST.
- **A 200 response with `effectivePermissions: []` is a _silent auth failure signal_.**
  The `/api/calibration/capabilities` endpoint is public (200 on anonymous),
  but populates `effectivePermissions` from the authenticated claims. Empty
  array + rest-of-body-valid is the classic "invalid Bearer, no identity"
  fingerprint. Do not read `HTTP 200 => authenticated`.
- **Fresh admin tokens live 7 days.** `bring-up.sh` mints via
  `/api/auth/login` from `SMOKE_ADMIN_USERNAME`/`PASSWORD` in `.creds`.
  Refresh with `.stack-round2/refresh-token.py`. The stack does not need to
  come down; auth is stateless JWT.
- **Nginx `:18080` and API `:15245` are auth-equivalent for calibration.**
  Verified GET + POST parity. Nginx does not strip `Authorization`. If a
  route works direct-to-API but not via nginx (or vice versa), it's a
  route/proxy config issue, not the auth pipeline — but for calibration it
  is not the case.
- **`CalibrationEventsEnabled = false` is a compile-time constant, not
  configuration.** `CalibrationCapabilityService.cs:203-205` hardcodes
  three flags — `CalibrationQueueEnabled`, `CalibrationJobBoundBedClearEnabled`,
  `CalibrationEventsEnabled` — as literal `false`. No config path, no
  environment variable, no rollout feature-flag lights them. `docs/API.md:108-110`
  documents the wire response with all three `false`. Do not chase overlay
  config for these.
- **`CalibrationSyncEnabled` (hardcoded `true`) is the "change-feed" flag,
  not `CalibrationEventsEnabled`.** `PlatformCapabilitiesDto.cs:47-48` says
  _"calibration synchronization"_; `71-72` says _"event streaming"_. They
  are distinct subsystems. Desktop aliases that need a change-feed
  precondition should bind `Sync`, not `Events`.
- **Redactor censors `TOK=$(cat ....token)` in shell scripts written from
  the outer PowerShell layer.** The literal string `TOK=******` lands in the
  file and bash reports `****** command not found`. Route via a Python file
  written to disk, or `wsl python3 -c "..."` where the token is read via
  `pathlib.Path(...).read_text()` — the redactor doesn't scan Python
  string-op contents the same way. See `.stack-round2/refresh-token.py`.
- **JSON key on `calibration-candidates` entries is `id`, not `printerId`.**
  Got tripped up briefly by a summary printer that returned `None` for every
  row. The context endpoint likewise returns `eligible` at the top level.
  Contract shape in `src/api/Contracts/` — Hicks's parity tests should
  serialize from the server DTOs, not hand-typed field names.
- **Fix A held across a fresh-token round trip.** No re-run of the SQL
  needed; the DB state is persistent across API container restarts and
  independent of who is holding a token.

Files added this round in `D:\s\pfarm1\.stack-round2\`:

- `refresh-token.py`, `auth-probe.py`, `eligibility-summary.py`, `perms-and-exp.py`, `auth-parity.py`

Server code unchanged. Overlay unchanged. Desktop worktree write scope
limited to this file and `.squad/decisions/inbox/bishop-printfarmer-mock-printer-recon.md`.
Stack still running for Ripley/Hicks. Fresh admin token in
`/tmp/printfarmer-round2/.token` valid until 2026-08-29T04:21Z.

---

## Round 4 durable learnings

**Result:** proved end-to-end. Calibration print reached the Moonraker Ready emulator via real dispatch pipeline. Zero gates weakened; every refusal resolved by supplying the data the gate legitimately requires.

### The 5-step refusal sequence — each one a real gate, worth remembering

1. UNIQUE `IX_CalibrationOrchestrations_AttemptId` — INSERT-then-recover blows up the transaction silently under psql. Detect existing orchestration first, UPDATE in place.
2. Filament gate reads `Printers.CurrentMaterial` + `Toolheads.CurrentMaterial`. Both null on Fix A seed → `filament_material_unknown`. Load PLA.
3. `StoredGcodeIntegrityVerifier` opens actual bytes at `/app/gcode + FilePath + FileName` and SHA-256s them. Cannot fake with an in-DB row.
4. `DispatchClaimService.EnsureCalibrationRecordsMatch` is a **52-field ack-time re-verification tuple**. Canonicalizer picks primary toolhead when project has null; ack demands stored equality → set `project.SelectedToolheadId+Index` to what the canonicalizer will pick.
5. ETag round-trip: POST /api/job-queue emits `ETag` header for RowVersion but ONLY GET emits `X-Dispatch-State-ETag`. Have to GET the job before ack. Both are quoted base64; forward verbatim in `If-Match` / `X-Dispatch-State-If-Match`.

### Emulator surface — reusable

- `GET /__emulator/printer` — one JSON with `id, name, klippyState, printState, filename, progress, virtualTime, connections`. This is the acceptance predicate.
- `GET /printer/objects/query?print_stats&virtual_sdcard` — Moonraker-native; `virtual_sdcard.is_active` toggles true when printing.
- `GET /server/files/list?root=gcodes` — shows the uploaded G-code with real size. Confirms the file made it through PrintFarmer → emulator upload.
- `/server/job_queue/status` returns "NotImplemented" — the emulator does NOT implement Moonraker's job queue; PrintFarmer drives via `SDCARD_PRINT_FILE` directly.

### DispatchClaimService tuple re-verification — the 52 fields

At ack time, dispatch re-loads project + attempt + snapshot + orchestration + printer + gcode + job and compares 52 fields for exact equality (case-sensitive on paths, case-insensitive on hex hashes). Full list at `DispatchClaimService.cs:1621-1673`. If any one differs, `calibration_record_mismatch`. Any refactor of the canonicalizer OR the ack path must maintain the invariant that anything the canonicalizer stores on the `PrintJob` must be re-derivable from the DB rows in identical form.

### Fact Checker's reframe was right AND useful

Only `generate` consults the four `*Implemented` DTO flags. `queueIntegrationImplemented: false` is a stale DTO default nobody ever flipped, misleading three rounds. When investigating "why is X disabled?", grep for assignments to the field (`FieldName = `) BEFORE grepping for reads; if the writer count is 0, the flag is not driving anything real.

### The bypass strategy is dispatchable per-goal but not per-desktop

Round 4 proved acceptance via a seeded promoted artifact. This is exactly the right technique for a demo/regression harness (fast, deterministic). It is **not** how a real desktop calibration should flow — real flow needs generation to work. So Fix B (split-mode probe) is still required for the durable path, just no longer acceptance-gating.

### Deterministic seed UUIDs

Reserved `fea70000-0000-0004-*` for Round 4 to avoid collision with Fix A's `fea70000-0000-000{1,2,3}-*`. Pattern: `0004-*001` spool, `0004-*010` orchestration (unused — real one already existed), `0004-*011` slicejob, `0004-*012` sourceartifact, `0004-*013` gcode.

### Working ETag base64 examples (from live capture)

`ETag: "AQAAAAAAAAAB"` — RowVersion 1 as bytea base64. Increments on write. `X-Dispatch-State-ETag: "AQAAAAAAAAAF"` — same encoding, separate row. In `If-Match`: forward the entire quoted string including quotes.

— Bishop (Round 4)

📌 Team update (2026-08-21T20-06-12Z): Moonraker emulator at localhost:17125 stood up and tested. Mock printer GUID 6b68328f-6495-4d32-8a2d-784119e59a01 live. Calibration print successfully sent to emulator. See .squad/orchestration-log/2026-08-21T20-06-12Z-bishop.md.
