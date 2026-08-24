# Third-Party Notices

## Printer Calibration source boundary

No source-derived Printer Calibration file is present in this repository. The
following upstream reviewed boundary is retained here so any future adaptation
of these sources begins with the attribution it must preserve:

- Source: `tayloraaron078-tech/Filament_Calibration_Wizard`
- Canonical tag: `v1.3.2`
- Commit: `057d6117b9ab31747ede3a5684a009cb6079ad11`
- Repository author attribution: Aaron Taylor (`package.json`; reviewed
  candidate blobs contain no file-level copyright notice)
- License: GNU Affero General Public License v3.0 only

The corresponding license text is included in `LICENSE`.

Revisions before this exact snapshot, unpinned branches or forks, static printer
data, third-party calibration models, and unverified fixtures or assets are not
approved sources.

## OrcaSlicer documentation

PFD Printer Calibration is a native PrintFarmer Desktop feature based on
upstream [OrcaSlicer](https://github.com/OrcaSlicer/OrcaSlicer) calibration
behavior and its official
[calibration guide](https://github.com/OrcaSlicer/OrcaSlicer/wiki/calibration_guide).
The guide and third-party calibration models are linked rather than copied or
bundled.

## Package dependencies

JavaScript and Rust dependencies retain their respective licenses and notices.
The full enumerated list of shipped dependencies and their SPDX licences is
generated from the CycloneDX SBOM into `third-party-licenses.md` (staged beside
this file under `resources/compliance/` in packaged builds). Exact dependency
versions are recorded in `package-lock.json` and `native/Cargo.lock`; packaged
Electron distributions also retain Electron and Chromium notices.
