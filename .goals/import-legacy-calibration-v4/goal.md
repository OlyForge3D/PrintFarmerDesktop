# Goal: Import legacy calibration backup v4

## User Request

Implement OlyForge3D/PrintFarmerDesktop issue #56 completely from the current
`development` baseline, which includes the merged #52 transport, #53 workspace,
#55 profile workflow, and PrintFarmer #898 persistence. Deliver one focused,
non-draft pull request targeting `development` with `Closes #56`; never write,
merge, or retarget anything to release-only `main`, and do not merge the PR.
Treat the complete issue body and comments as authoritative.

The import must use a narrow native file-picker/import IPC and must never scan
browser storage, another application's directories, hidden locations, or a
static printer database, nor expose generic renderer filesystem access. Any
adapted AGPL v1.3.2 schema/parser/migration code and tests from the approved #51
source must preserve exact file-level provenance and modification notices while
replacing source-specific persistence, collision, and ownership behavior.

Implement bounded fail-closed preflight, exact schema-v4 validation, complete
history/profile/photo migration, explicit authoritative printer/tool mapping,
transactional and resumable backend import with stable idempotency, and an
accessible end-to-end desktop workflow with deterministic reporting. Run the
focused and full TypeScript, Electron, Rust/model-core, typecheck, lint, format,
provenance, packaging/profile, Windows/macOS CI, and smoke gates. Commit, push,
open the PR, and report delivery, validation, provenance, security, idempotency,
CI/mergeability, and blockers to the coordinating session.

## Refined Goal

Add an explicit, secure schema-v4 legacy calibration backup import workflow to
PrintFarmer Desktop across the existing Electron main/renderer IPC, calibration
workspace, authenticated PrintFarmer transport, and native persistence
boundaries. Preflight and migration must be deterministic, bounded, fail-closed,
provenance-compliant, and truthful; imports must require explicit eligible
printer/tool mappings and preserve complete supported history, photos, exact
profiles, immutable snapshots, lineage, and source provenance. Backend mutation
must be authoritative, transactional, idempotent, resumable, and hydrate the
desktop only after completion.

## Acceptance Criteria

- [ ] A narrow native file picker selects exactly one legacy backup for a
  strictly validated import IPC; the renderer never receives arbitrary
  filesystem access and no browser storage, hidden paths, other-app directories,
  static printer database, archive escape, scripts, G-code, profiles, or model
  content are discovered or executed.
- [ ] Preflight happens before large allocation or mutation and enforces explicit
  limits for file size, JSON/string/array/photo/decoded bytes, nesting depth,
  decoder pixels, and bounded temporary storage. It detects duplicate keys where
  possible and rejects invalid markers, any non-exact schema/version/top-level
  shape, unsafe or non-finite numbers, invalid dates/IDs/base64/data URLs,
  dangling/cyclic relations, secrets in snapshots, invalid MIME/magic/decoder
  data, and corrupt generated profiles.
- [ ] Preflight produces deterministic counts and per-record
  importable/unsupported/corrupt/requires-action outcomes and never reports
  corrupt or unsupported data as successful. Offline preflight remains truthful
  and never claims completion or removes/changes the source.
- [ ] Minimal and full valid schema-v4 backups preserve supported project
  identity, mode, status, ordered steps and selections; immutable attempt plans,
  events, observations and results; notes, confidence, retest and current
  selection lineage; multiple projects, redo/history, and original legacy IDs
  plus source/import provenance.
- [ ] Photos receive deterministic collision-safe target IDs and repaired
  references while retaining captions, order, and sanitized capture metadata.
  MIME, magic, decoder and pixel constraints are enforced, EXIF/GPS and paths
  are stripped/redacted, and authenticated durable upload resumes after failure
  without duplicate rows or blobs.
- [ ] Generated-profile revisions preserve normalized and exact JSON plus the
  validated deterministic hash; malformed or mismatched exact/normalized/hash
  profiles are rejected or explicitly reported rather than silently repaired.
- [ ] Every legacy printer snapshot requires explicit user mapping to a current,
  authoritative, eligible PrintFarmer printer/config revision and physical
  toolhead/nozzle. Eligibility requires explicitly recorded Klipper firmware,
  Klipper G-code dialect, and upstream OrcaSlicer support; nothing is inferred
  from names, backend, or static data. Sanitized immutable legacy and current
  snapshots are retained.
- [ ] Filament, SKU, and spool mappings happen only when unambiguous; all
  ambiguity requires explicit reconciliation and is represented in preflight,
  plan, and per-record results.
- [ ] One stable import operation/idempotency key and one canonical payload hash
  cover the entire approved plan. Exact replay returns the original authoritative
  resources; changed payload returns HTTP 409; concurrent retries do not
  duplicate data.
- [ ] Authoritative rows and the change journal are staged transactionally, with
  photos handled through durable orchestration so mid-import process or network
  failure resumes deterministically. Source-to-target maps are stable and
  collision-safe, and owner/farm/profile identity, capabilities, schema, and
  unrelated-project boundaries are enforced without last-write-wins.
- [ ] The accessible workflow includes native selection, bounded preflight
  counts/warnings/errors, per-project printer/tool and ambiguity reconciliation,
  exact account/server/plan review, one authenticated backend operation,
  per-record result/report copy and download, and opening only authoritatively
  hydrated imported projects after completion.
- [ ] Strict Zod validation protects every IPC/request/response boundary;
  temporary data is bounded and deterministically cleaned up; source data remains
  unchanged; paths and sensitive photo metadata are absent from reports.
- [ ] Tests cover approved schema/parser parity, minimal/full v4 fixtures,
  malformed/oversize/deep/invalid/duplicate/dangling/cyclic data, photo repair,
  MIME/magic/pixel/EXIF/retry, complete history and notes/confidence, exact profile
  validation, printer/tool eligibility/mapping/snapshots, ambiguity handling,
  stable collision maps, replay/409/concurrent retry, restart, offline truth, and
  absence of hidden discovery/static data.
- [ ] Existing #52 transport, #53 workspace, and #55 profile workflows remain
  compatible. No #54 queue UI or #57 release work is added.
- [ ] Focused and full TypeScript/Electron and Rust/model-core tests, typecheck,
  lint, formatting, provenance, packaging/profile/SBOM verification, Windows and
  macOS CI, and an applicable desktop smoke test pass, or any genuinely
  unavailable external CI result is reported accurately without claiming it
  passed.
- [ ] Implementation is committed with required trailers, pushed, and delivered
  as exactly one non-draft PR with head `jpapiez-import-legacy-calibration-v4`,
  base `development`, and `Closes #56`; it is not merged and never targets or
  modifies `main`.
- [ ] The coordinator receives branch, commits, PR URL/head/base,
  CI/mergeability, validation, provenance, security/idempotency evidence, and
  blockers.

## Scope Boundaries

**In scope:**
- The complete issue #56 schema-v4 import contract and acceptance criteria.
- Electron native file selection and least-privilege IPC.
- Bounded parser/preflight and deterministic plan/report generation.
- Explicit authoritative printer, config revision, toolhead/nozzle, filament,
  SKU, and spool reconciliation.
- Complete supported calibration history, photo, profile, snapshot, lineage, and
  provenance mapping.
- Authenticated PrintFarmer import orchestration, persistence, idempotency,
  resume, hydration, reporting, and tests.
- Exact approved-source provenance notices for any adapted files.
- One non-draft PR targeting `development`.

**Out of scope:**
- Any change, merge, retarget, or PR against `main`.
- Merging the delivered PR.
- #54 queue/print-job controls and #57 release work.
- Generic renderer filesystem access or any implicit/discovery import.
- IndexedDB, localStorage, browser-storage, hidden-directory, other-app,
  printer-database, model, script, G-code, or unrelated profile scanning.
- Changes to unrelated projects, last-write-wins merges, source deletion, and
  unauthenticated or completion-shaped offline behavior.

## Applicable Project Conventions

**Quality gate commands:**
- `npm run check:provenance`
- `npm run typecheck`
- `npm run lint`
- `npm run format`
- `npm run test`
- `npm run pretest:e2e && npm run test:e2e`
- `npm run verify:target-profiles`
- `npm run verify:sbom`
- `node scripts/verify-packaged-sidecar.mjs`
- `npm run package`
- From `native`: `cargo fmt --check`
- From `native`: `cargo clippy --all-targets -- -D warnings`
- From `native`: `cargo clippy --all-targets --features sqlite -- -D warnings`
- From `native`: `cargo test`
- From `native`: `cargo test --features sqlite`
- Windows-specific from `native`: `cargo build --features lib3mf`
- Windows-specific from `native`: `cargo test --features lib3mf`
- Repository CI matrix on Windows and macOS, plus an applicable desktop smoke.

**Commit convention:**
- Conventional commits with Goal role marker:
  `type(scope): [B] description` for Builder commits and
  `chore(scope): [I] description` for Inspector commits, title at most 72
  characters.
- Builder trailer: `Assisted-by: Claude:Sonnet-4.6`
- Inspector trailer: `Assisted-by: Claude:Haiku-4.5`
- Required trailers:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>` and
  `Copilot-Session: 16afc1ec-bc60-4de2-8ac3-bdb52ff09f5f`

**Guidelines:**
- The full GitHub issue #56 body and comments are authoritative.
- `.github/workflows/ci.yml`
- `.goals/compliance/` and `compliance/printer-calibration-provenance.json`
- ADR 0001 for the approved AGPL v1.3.2 source boundary.

**Rules:**
- Electron main owns native dialogs, filesystem access, authenticated network
  transport, and import orchestration; renderer remains presentational and uses
  typed IPC only.
- `src/shared/ipc.ts` is the strict Zod-validated contract boundary.
- PrintFarmer is authoritative for owner/farm/printer/config/profile identity and
  persisted import resources.
- Preserve exact file-level provenance and modification notices for approved
  source-derived code/tests.
- Do not claim unavailable CI or smoke evidence as successful.
