# Goal Summary: Import legacy calibration backup v4

## Outcome

Issue #56 was implemented on `jpapiez-import-legacy-calibration-v4` and
delivered as non-draft PR #132 targeting `development` with `Closes #56`. The
PR remains open and unmerged; no work targeted or modified `main`.

## Acceptance Criteria

- Native selection uses a short-lived, single-use approval token; the renderer
  receives no path or generic filesystem capability, and no browser, hidden,
  other-application, static-printer, archive, script, G-code, profile, or model
  discovery/execution was introduced.
- Strict schema-v4 parsing and preflight enforce bounded file, JSON, string,
  array, depth, photo, decoded-byte, MIME/magic, decoder, and pixel constraints;
  duplicate keys, unsafe values, invalid IDs/dates/data URLs, broken
  relationships, credentials, corrupt profiles, and unsupported records fail
  closed with deterministic outcomes.
- Supported projects preserve ordered calibration history, attempts, events,
  observations, results, notes, confidence, retest/current-selection lineage,
  legacy IDs, and source/import provenance.
- Photos use stable collision-safe identities, repaired references,
  authenticated durable upload, retry-safe orchestration, sanitized capture
  metadata, and EXIF/GPS/path stripping.
- Generated-profile revisions validate and preserve exact JSON, normalized
  settings, and deterministic hashes without silently repairing corruption.
- Every imported project requires explicit mapping to an authoritative eligible
  PrintFarmer printer/config/toolhead/nozzle. Eligibility is explicit Klipper
  firmware, Klipper G-code dialect, and upstream OrcaSlicer support; ambiguous
  filament/SKU/spool identities require reconciliation.
- A stable operation key and canonical payload hash provide exact replay,
  changed-payload HTTP 409 behavior, collision-safe source-to-target maps, and
  duplicate-free concurrent/restart retries.
- The accessible workflow covers select, preflight, reconciliation, exact
  account/server/plan review, one backend operation, per-record copy/download
  reporting, and authoritative hydration before opening imported projects.
- Sixty focused import tests were added; the complete local suite passed
  1,234/1,234 tests along with typecheck, lint, format, provenance,
  target-profile, and SBOM checks. Repository Windows/macOS desktop, sidecar,
  and package-smoke CI was started and is reported according to its live status.
- Existing #52, #53, and #55 behavior remains compatible; #54 queue UI and #57
  release work were not added.

## Iteration History

| Iteration | Verdict | Result |
|-----------|---------|--------|
| 1 | PASS | Builder delivered the complete import workflow and Inspector independently verified all acceptance criteria. |

## Inspector Findings

The Inspector found no blocking defects. It independently confirmed the narrow
IPC and approval-token boundary, bounded fail-closed preflight, complete
migration mappings, explicit authoritative reconciliation, photo/profile
validation, deterministic idempotency, accessibility, scope boundaries,
provenance, local quality gates, PR target/body/state, and mergeability.

## Recommendations

- Merge only after the required Windows/macOS CI matrix is green.
- Keep import limits and schema-v4 fixtures versioned together when future
  backup formats are introduced.
- Preserve the approval-token pattern for any future native file workflows.
