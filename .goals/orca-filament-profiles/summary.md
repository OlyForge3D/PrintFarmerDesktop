# Upstream Orca filament profiles — completed

## What was achieved

- Integrated profile discovery, generation, install/export/restore actions into
  the #53 calibration workspace through narrow #52-compatible typed IPC.
- Added bounded canonical-root OrcaSlicer discovery, inheritance resolution,
  compatibility checks, traversal/link/escape defenses, and typed summaries.
- Added selected-completed-observation patching for the supported calibrated
  field set with unknown-field and array-shape preservation, stable canonical
  JSON, SHA-256, safe identity, filename, and review confirmation.
- Added immutable generated-profile request lineage and exact/normalized
  reconciliation behavior with idempotent replay and conflict checks.
- Added transactional Windows installation with running-process refusal,
  fingerprint revalidation, durable backup, same-directory temporary write,
  flush/readback/hash verification, atomic replacement, post-discovery
  verification, and explicit restore.
- Added truthful macOS export-only behavior using a native save dialog and exact
  JSON/hash verification.
- Preserved renderer privilege isolation: no arbitrary path, filesystem,
  process, shell, network, credential, or slicer primitive crosses the bridge.
- Added 115 focused profile tests; the complete 1,174-test suite and all Windows
  and macOS desktop, sidecar, and package-smoke CI jobs passed.
- Kept the work independently authored and passed the provenance gate with no
  derived files.
- Opened non-draft PR #131 from `jpapiez-issue-55-orca-profiles` to
  `development` with `Closes #55`; the PR is open, mergeable, and unmerged.

## Iteration history

| Iteration | Verdict | Result |
| --- | --- | --- |
| 1 | PASS | All 20 criteria passed independent inspection; all six CI jobs passed. |

## Inspector findings

The Inspector found no required corrections. It verified the IPC privilege
boundary, platform-specific behavior, deterministic serialization and hashing,
immutable/idempotent revision behavior, transaction and recovery paths,
provenance, scope boundaries, commit metadata, and PR targeting.

## Recommendations

- Keep the profile-format/version allowlist and fixture corpus current as
  upstream OrcaSlicer evolves.
- Add new platform fixtures and failure-injection cases whenever installation
  mechanics or canonical profile roots change.
- Preserve the narrow IPC boundary and immutable generated-revision authority
  in follow-up work for #54, #56, and #57.
