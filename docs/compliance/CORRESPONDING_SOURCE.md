# Corresponding Source Policy

PrintFarmer Desktop (PFD) is distributed under `AGPL-3.0-only`. This policy
defines how an official binary and any network-accessible modified deployment
remain connected to their exact Corresponding Source.

## Official desktop releases

Every official Windows or macOS binary release must:

1. Be built by `.github/workflows/release.yml` from the same immutable `v*` Git
   tag shown on the GitHub Release.
2. Keep the tag's source `.zip` and `.tar.gz` downloads available beside the
   binary artifacts at
   `https://github.com/OlyForge3D/PrintFarmerDesktop/releases/tag/<tag>`.
3. Include the source files, dependency lockfiles, build and packaging scripts,
   provenance manifest, notices, and modification records needed to reproduce
   and modify the released work.
4. Package `PFD_LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, the provenance manifest
   and schema, this document, `ELECTRON_LICENSE.txt`, and
   `LICENSES.chromium.html` below the application's `resources/compliance/`
   directory.

The release tag, not the moving default branch, identifies the exact source.
Distributors of modified binaries must publish the complete corresponding
modified source with equally prominent access and update the source location
and notices to match their build.

## Network interaction

PFD is a desktop client, while PrintFarmer is a separate service and repository.
If a modified PFD version is made remotely interactive, its operator must offer
that version's Corresponding Source to remote users as required by AGPL section 13. A PFD source link does not satisfy source obligations for separately
modified PrintFarmer components.

The confirmed product direction requires PrintFarmer to adopt GNU AGPL v3.0 in
its own repository. That work is tracked by
[PrintFarmer #902](https://github.com/OlyForge3D/PrintFarmer/issues/902). Until
it establishes the backend license, notices, corresponding-source delivery, and
provenance controls, no source-derived calibration code may enter PrintFarmer
and [PrintFarmer #899](https://github.com/OlyForge3D/PrintFarmer/issues/899)
remains blocked.

## Recovery

Release managers must never move or replace a published tag. If a release's
source download becomes unavailable, restore the exact tagged Git objects and
source archives before restoring binary downloads. If the exact source cannot
be restored, withdraw the binary release. Verify recovery by resolving the tag
to its original commit and rebuilding from a fresh checkout using the committed
lockfiles and scripts.

The approved calibration source pin has a separate recovery and update process
in `docs/adr/0001-printer-calibration-source-provenance.md` and
`docs/CONTRIBUTING.md`.
