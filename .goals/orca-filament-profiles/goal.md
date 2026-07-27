# Goal: Upstream Orca filament profiles

## User Request

Implement OlyForge3D/PrintFarmerDesktop issue #55 completely from the current
`development` branch, including the merged #52 transport/offline foundation and
#53 native calibration workspace. Deliver one focused, non-draft pull request
targeting `development` with `Closes #55`. Never write, merge, or retarget
anything to release-only `main`, and do not merge the pull request.

The authoritative issue contract is
https://github.com/OlyForge3D/PrintFarmerDesktop/issues/55. It requires durable
calibrated upstream-Orca filament profiles, immutable backend lineage, narrow
privileged Electron integration, transactional Windows installation, truthful
macOS export-only behavior, strict typed errors and cancellation, comprehensive
security and behavioral tests, provenance compliance, and all repository
quality gates.

## Refined Goal

Add an end-to-end upstream-Orca filament profile workflow to the existing
Printer Calibration workspace. A user selects a compatible local base profile,
reviews an exact field-level calibrated patch derived only from selected
completed observations, creates or replays an authoritative immutable
`GeneratedProfileRevision`, and then transactionally installs it on Windows or
exports its exact bytes on macOS. The implementation must preserve upstream
profile semantics and unknown data, strictly constrain privileged native
operations, remain compatible with offline/transport behavior, and produce a
focused non-draft PR against `development`.

## Acceptance Criteria

- [ ] The #53 calibration profile entry exposes discovery, base detail,
  preview, revision creation/reconciliation, and platform-appropriate
  install/export/restore actions through the #52 offline/transport model.
- [ ] Discovery scans only canonical current-OS upstream OrcaSlicer user and
  system roots, canonicalizes all paths, bounds traversal/file count/file size/
  JSON depth/inheritance depth, and rejects traversal, symlink, junction, cycle,
  root escape, malicious JSON, and unsupported distribution/version/format.
- [ ] Compatible machine/process/filament candidates are parsed and ranked
  against the exact immutable backend physical toolhead/nozzle context and a
  representable filament/tool slot; no nozzle, tool, slot, or base is silently
  substituted.
- [ ] Base inheritance is resolved with bounded files/depth/cycle checks while
  preserving inherited values, unknown/unowned fields, supported metadata and
  comments, and per-extruder array shape.
- [ ] Preview patches only completed explicitly selected observations and only
  supported calibrated fields: first/other-layer nozzle temperatures in Orca
  order, flow ratio, pressure-advance enable/value and supported smooth-time
  semantics, filament-owned retraction length/speed/related existing fields,
  maximum volumetric speed, and shrinkage compensation.
- [ ] Validation rejects wrong numeric types, units, ranges, arrays, required
  fields, tool/nozzle mismatches, unsupported pressure-advance/retraction
  semantics, unexpected mutations/deletions, and unstable semantic round trips.
- [ ] Generation creates collision-safe identity, display name, and safe
  filename without mutating the base; stable canonical serialization emits
  deterministic exact JSON and SHA-256 for semantically identical input.
- [ ] The generated revision submission contains complete project, source
  attempt, selected observation, optional parent revision, source
  machine/process/filament IDs, source/effective JSON and fingerprints,
  normalized settings, exact generated JSON/hash/schema/profile kind, generator
  version, and idempotency lineage.
- [ ] `GeneratedProfileRevision` remains immutable authoritative history:
  repeated identical generation requests replay the same backend revision,
  changed reuse of an idempotency key conflicts, exact and normalized content
  reconcile correctly online/offline, and install/export/restore outcomes are
  recorded against that immutable revision.
- [ ] Preview exposes only typed summaries, warnings, identity, filename, and
  calibrated before/after diffs, and explicit user confirmation is required
  after validation and before any write.
- [ ] Strict named Zod IPC covers discovery, detail, preview, revision
  create/fetch, Windows install/restore, and macOS export with cancellation,
  bounded input/output, and typed unsupported-version, profile-conflict,
  slicer-running, path, permission, write, verification, and rollback errors.
- [ ] The renderer receives no local path and no generic filesystem, process,
  shell, network, credential, slicer, or arbitrary native capability; main
  validates every request and uses narrow typed adapters.
- [ ] Windows installation is limited to canonical OrcaSlicer account/profile
  destinations, detects OrcaSlicer running and guarantees no write in that
  state, revalidates base and destination fingerprints immediately before
  writing, never overwrites unrelated profiles, and rejects untrusted links.
- [ ] Windows installation creates a durable timestamped backup with hash
  metadata, writes and flushes a same-directory temporary file, reads back,
  parses, semantically verifies exact expected settings/hash, atomically
  replaces, verifies post-install discovery, and records truthful outcome.
- [ ] Every Windows failure preserves diagnostics and either leaves or restores
  the prior profile; explicit rollback/restore is implemented and tested,
  including temp-write/readback/atomic-replace/crash-style failure paths.
- [ ] macOS truthfully offers export only, reconciles the immutable backend
  revision, uses a native save dialog and safe suggested name/destination,
  writes exact JSON, verifies exact bytes/hash, records the outcome, and never
  advertises or invokes direct install.
- [ ] Tests cover upstream-Orca fixtures, inheritance/cycles/limits, arrays,
  identities, unknown fields, versions, every supported patch field,
  units/order/partial calibration, deterministic hash/round trip, fingerprint
  races, tool/nozzle/slot mismatch, traversal/link/oversize/deep/malicious JSON,
  Windows transaction/rollback/restore/running no-write, macOS export/hash/
  no-install, backend immutability/idempotency, cancellation, and renderer
  privilege denial.
- [ ] Any source-derived pure profile module is limited to #51-approved source
  at the pinned revision, placed in approved derived roots, carries exact
  file-level provenance and modification notices, and passes the provenance
  gate; native IPC/UI/copy/state is independently authored.
- [ ] No #54 job controls, #56 legacy import, mutable slicer-row authority,
  generic native capability, or release-only `main` change is introduced.
- [ ] Focused and full TypeScript/Electron/Rust/model-core validation passes,
  including typecheck, lint, format, provenance, unit tests, Playwright smoke,
  target-profile and SBOM verification, packaged-sidecar verification, Rust
  fmt/clippy/tests with sqlite, relevant Windows lib3mf gates, and packaging on
  supported Windows/macOS CI.
- [ ] All implementation changes are committed with the required Copilot
  trailers, pushed on the issue branch, and represented by one non-draft,
  mergeable PR whose base is `development`, whose body includes `Closes #55`,
  and which remains unmerged.

## Scope Boundaries

**In scope:**
- Upstream OrcaSlicer profile discovery, bounded inheritance, ranking, patching,
  validation, deterministic serialization, hash, collision-safe identity, and
  exact/normalized immutable backend revision lineage.
- Narrow Electron main/preload/renderer integration with typed IPC,
  cancellation, explicit preview confirmation, and existing #52/#53 surfaces.
- Transactional and recoverable Windows install/restore.
- Native-dialog exact-hash macOS export-only flow.
- Behavioral, security, transport, native, model-core, renderer-boundary,
  packaging, smoke, and provenance tests required by issue #55.
- A focused non-draft PR targeting `development`.

**Out of scope:**
- Any write, merge, retarget, or PR against `main`.
- Merging the delivered PR.
- #54 print/job controls, #56 legacy-profile import, slicer launch/shell
  automation, arbitrary filesystem/process access, or unrelated refactors.
- Treating mutable slicer profile rows or cleanup-managed artifacts as
  authoritative immutable calibration history.
- Direct macOS installation in the initial release.

## Applicable Project Conventions

**Quality gate commands:**
- `npm run check:provenance`
- `npm run typecheck`
- `npm run lint`
- `npm run format`
- `npm run test`
- `npm run test:e2e`
- `npm run verify:target-profiles`
- `npm run verify:sbom`
- `node scripts/verify-packaged-sidecar.mjs`
- `npm run package`
- From `native`: `cargo fmt --check`
- From `native`: `cargo clippy --all-targets -- -D warnings`
- From `native`: `cargo clippy --all-targets --features sqlite -- -D warnings`
- From `native`: `cargo test`
- From `native`: `cargo test --features sqlite`
- On Windows from `native`: `cargo build --features lib3mf`
- On Windows from `native`: `cargo test --features lib3mf`

**Commit convention:**
- Conventional commits with goal role marker:
  `type(scope): [B] description` or `chore(scope): [I] description`, title no
  longer than 72 characters.
- Builder trailer: `Assisted-by: Claude:Sonnet-4.6`
- Inspector trailer: `Assisted-by: Claude:Haiku-4.5`
- Required repository trailers:
  `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>`
  and `Copilot-Session: 26d00ce6-4e63-4e38-ae12-efd709be78e2`.

**Guidelines:**
- `docs/CONTRIBUTING.md`
- `docs/ARCHITECTURE.md`
- `docs/adr/0001-printer-calibration-source-provenance.md`
- `.github/CODEOWNERS`
- `.github/workflows/ci.yml`
- `.squad/decisions.md`

**Rules:**
- Renderer isolation is mandatory. Define explicit Zod-validated channels in
  `src/shared/ipc.ts`; main validates requests and renderer remains
  presentation-only.
- Add tests for every product behavior change and preserve source/base
  immutability.
- Source-derived calibration logic may use only the approved
  `tayloraaron078-tech/Filament_Calibration_Wizard` v1.3.2 commit
  `057d6117b9ab31747ede3a5684a009cb6079ad11`, with provenance declarations.
- Never commit credentials or signing material.
- Work only in the current feature worktree and target `development`;
  release-only `main` is prohibited.

