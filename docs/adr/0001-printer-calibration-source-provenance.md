# ADR 0001: Printer Calibration source provenance

- **Status:** Accepted
- **Date:** 2026-07-24
- **Issue:** https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51
- **Approval:** https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51#issuecomment-5075723583

## Context

PFD will provide Printer Calibration as a native workspace based on upstream
OrcaSlicer behavior and the official OrcaSlicer calibration wiki. Selected
domain logic may later be adapted from an AGPL source. PFD previously claimed a
proprietary/`UNLICENSED` boundary and had no file-level provenance control.

On 2026-07-24, repository owner `@jpapiez` confirmed that PFD and PrintFarmer
shall adopt GNU AGPL v3.0. The decision is recorded on issue #51. This ADR adopts
`AGPL-3.0-only` for the PFD repository and distribution; the machine manifest
binds approval to that exact decision.

`.github/CODEOWNERS` protects the licensing, provenance, checker, workflow,
packaging, and enforcement-test files. The target branch should require Code
Owner review so future policy changes cannot bypass that ownership boundary.

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

Repository licensing approval does not grant blanket approval to copy a source
file. Every adaptation still requires an exact source path/blob decision and
destination record.

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
- rejects derived code if repository licensing approval is absent or regresses;
- rejects files in a derived root that lack a manifest record;
- rejects source paths/blobs that are not eligible in the pinned manifest;
- requires original attribution, an AGPL SPDX identifier, modification and
  reviewer records, and exact source identifiers in each derived file; and
- verifies each destination file's SHA-256.

CI and release workflows run the same offline check. Updating the checker,
manifest, schema, and this ADR is a visible policy change requiring maintainer
review. The checker binds repository approval to the exact owner decision rather
than trusting arbitrary manifest text.

## Corresponding Source and repository boundary

PFD release source is delivered from the immutable release tag as described in
`docs/compliance/CORRESPONDING_SOURCE.md`; compliance files are also copied into
packaged applications.

The separate PrintFarmer repository currently declares MIT, but the confirmed
product direction requires it to adopt GNU AGPL v3.0 as well. That repository
change is owned by
[PrintFarmer #902](https://github.com/OlyForge3D/PrintFarmer/issues/902).
Until #902 establishes the backend license, notices, source availability, and
provenance controls, no pinned source blob may be copied into PrintFarmer and
[PrintFarmer #899](https://github.com/OlyForge3D/PrintFarmer/issues/899) remains
blocked. This repository does not modify the backend.

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
