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
