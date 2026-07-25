# ADR 0001: Printer Calibration source provenance

- **Status:** Proposed; authorized maintainer licensing approval required
- **Date:** 2026-07-24
- **Issue:** https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51

## Context

PFD will provide Printer Calibration as a native workspace based on upstream
OrcaSlicer behavior and the official OrcaSlicer calibration wiki. Selected
domain logic may later be adapted from an AGPL source, but PFD currently claims
a proprietary/`UNLICENSED` boundary and has no file-level provenance control.
Source-derived work cannot begin until the repository license and source
availability approach are approved by maintainers who are authorized to
relicense the existing PFD work.

This ADR proposes `AGPL-3.0-only` for the PFD repository and distribution.
Adding the metadata in this PR records the proposed implementation; it does not
itself claim that the required maintainer decision occurred. The machine
manifest remains `pending-maintainer-approval`, and CI rejects every derived
file until that state is changed with reviewer identity, date, and decision
reference. Approval must identify the verified repository administrator
`@jpapiez` and the approving PrintFarmerDesktop pull request.

`.github/CODEOWNERS` protects the licensing, provenance, checker, and enforcement
test files. GitHub reported that the `development` branch was not protected
during this review, so CODEOWNERS is not yet an enforceable approval gate. A
repository administrator must enable required Code Owner review before this ADR
can move to Approved or any source-derived file can merge.

## Approved source boundary

Issue #51 establishes the first source snapshot eligible for file-by-file
review:

| Evidence                | Pinned value                                                                             |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| Canonical repository    | `https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard`                     |
| Tag                     | `v1.3.2`                                                                                 |
| Release                 | `https://github.com/tayloraaron078-tech/Filament_Calibration_Wizard/releases/tag/v1.3.2` |
| Commit                  | `057d6117b9ab31747ede3a5684a009cb6079ad11`                                               |
| Git tree                | `4197589b91376c485e57a28ca6281d54a2358f7b`                                               |
| Commit archive SHA-256  | `a7f985d44d4188d600ead0b916eec98a14bfba9f53079aea659cbaaa8adc5047`                       |
| License path / blob     | `License` / `be3f7b28e564e7dd05eaf59d64adba1a4065ac0e`                                   |
| Package metadata blob   | `package.json` / `61c87aad217483c34b8ca4d40560d02edd4cfff6`                              |
| Declared source license | `AGPL-3.0-only`                                                                          |

The tag directly references the pinned commit. The release and package metadata
both identify version `1.3.2`; the repository license and package metadata
identify AGPL v3, and the pinned `License` blob contains the GNU AGPL v3 text.
The manifest contains the canonical URLs and archive size so this evidence can
be recovered without relying on a branch name.

The source-revision decision is distinct from the pending PFD relicensing
decision. Eligibility never grants blanket approval to copy a file. Every
adaptation requires an exact source path/blob decision and destination record.

## Explicit exclusions

- Every revision except the exact tag, commit, and tree above is excluded.
  `v1.3.0` is commit `d475cf8382524c9d128d85aff4391b810311dca9`,
  tree `039bd6e8db74bb29eeccd0ef351dc3fbcc4fd5a9`, and has a
  differently licensed `License` blob
  `0b7572d98ffe3ff83c53242a3042f7661f55e260`. A `v1.3.1` tag did not
  resolve during this review. Branches, forks, local history, and recreated or
  moved tags are not substitutes.
- The workbook, generated printer database, printer tables, generator, and
  desktop printer catalog are excluded. PrintFarmer printer instances and
  sanitized immutable configuration snapshots are authoritative.
- Data tables, fixtures, icons, screenshots, styles, model manifests, model
  links, and all other non-code assets are excluded unless a later independent
  provenance review explicitly approves an exact blob. Third-party calibration
  models remain linked or user-imported and are never bundled.
- Imperative UI, product prose, branding, browser lifecycle, Tauri shell,
  browser persistence, filesystem integration, printer ownership, sync,
  queueing, authorization, and safety orchestration are rewrite-only PFD code.
- Product- or vendor-specific adapters outside the upstream OrcaSlicer path are
  outside PFD's initial Printer Calibration scope.

Pure TypeScript domain formulas, validation, backup-schema parsing, Orca profile
logic, framework-independent utilities, and their tests are only
`eligible-for-review` candidates in the manifest. Ported tests remain attributed
derived files and do not replace independent PFD architecture and behavior
tests.

## Enforcement

Source-derived code is restricted to the manifest's `derivedRoots`. The
provenance checker:

- validates the manifest against its versioned JSON Schema;
- compares the source identity to an immutable checker allowlist;
- rejects derived code while repository licensing approval is pending;
- rejects files in a derived root that lack a manifest record;
- rejects source paths/blobs that are not eligible in the pinned manifest;
- requires original attribution, an AGPL SPDX identifier, modification and
  reviewer records, and exact source identifiers in each derived file; and
- verifies each destination file's SHA-256.

CI and release workflows run the same offline check. Updating the checker,
manifest, schema, and this ADR is a visible policy change requiring maintainer
review. Branch protection must require the compliance CODEOWNER; arbitrary text
in the manifest is not evidence of approval.

## Corresponding Source and repository boundary

PFD release source is delivered from the immutable release tag as described in
`docs/compliance/CORRESPONDING_SOURCE.md`; compliance files are also copied into
packaged applications.

The separate PrintFarmer repository currently declares MIT. MIT code is
license-compatible as input to an AGPL work, but an affected PrintFarmer
component cannot incorporate AGPL-derived source and continue to be distributed
only as MIT. The generation code-owning issue,
[PrintFarmer #899](https://github.com/OlyForge3D/PrintFarmer/issues/899), must
record one of two decisions before implementation: establish an approved AGPL
licensing and corresponding-source boundary for every affected component and
distribution, or independently implement the upstream OrcaSlicer behavior
without copying the pinned source. Until then, no pinned source blob may be
copied into PrintFarmer. This repository does not modify or approve that backend
decision.

## Advancing or recovering the pin

To advance the pin:

1. Review a canonical release tag and resolve it to one commit and tree.
2. Confirm license continuity from the exact license and package blobs.
3. Hash a commit-addressed source archive and audit all candidate code, data,
   fixtures, and assets independently.
4. Update source decisions, destination mappings, tests, checker constants,
   notices, and this ADR in one compliance PR.
5. Record authorized maintainer approval before any derived file uses the new
   source.

Never retag, follow a moving branch, or silently replace hashes. For recovery,
fetch the archive by commit, verify its SHA-256 and Git tree, and compare every
used source blob with the manifest. If any check fails, stop derived work and
restore the reviewed snapshot rather than substituting another revision.
