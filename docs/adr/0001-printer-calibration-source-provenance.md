# ADR 0001: Printer Calibration source provenance

- **Status:** Superseded — 2026-08-23
- **Original Date:** 2026-07-24
- **Original Issue:** https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51
- **License decision reference:** https://github.com/OlyForge3D/PrintFarmerDesktop/issues/51#issuecomment-5075723583

## Standing decisions preserved by this ADR

Two records outlive the provenance apparatus. They are policy, not machinery.

### 1. PFD is licensed AGPL-3.0-only

On 2026-07-24, repository owner `@jpapiez` confirmed on issue #51
(comment `#issuecomment-5075723583`) that PFD and PrintFarmer adopt
GNU AGPL v3.0. This ADR was the original record of that decision and remains
the citation for it.

That decision is unchanged and still operative:

- `LICENSE` ships the AGPL v3 text (see `tests/licensing.test.ts`).
- `package.json` and `native/Cargo.toml` both declare `AGPL-3.0-only`.
- `THIRD_PARTY_NOTICES.md` carries the hand-authored notices required by AGPL
  §7.

Nothing in the removal below changes the licence. If the licence itself is
ever revisited, the new decision must supersede this ADR explicitly.

### 2. Two standing carve-outs on adaptation from OrcaSlicer

Independent of any provenance machinery, PFD must not adapt or bundle these
two subsets of OrcaSlicer, because they are not distributable under
`AGPL-3.0-only`:

**a. Do not port OrcaSlicer's PA Pattern generator**
(`CalibPressureAdvancePattern`, in `src/libslic3r/calib.cpp`).

It is **GPL-3.0**, not AGPL. It was adapted from Andrew Ellis' pressure-advance
pattern generator (`AndrewEllis93/Print-Tuning-Guide`), itself derived from
Sineos' Marlin generator. Attribution is documented in OrcaSlicer's `README.md`
only; `calib.cpp` carries no in-file attribution. Copying that file into an
AGPL-3.0-only codebase, or distributing a translated port, is not permitted by
the source licence.

**b. Do not bundle anything from OrcaSlicer's `resources/handy_models/`**

The tree contains 3DBenchy (CC BY-ND, and its Draco conversion is arguably a
prohibited derivative), the Stanford Bunny (research-use only), the Voron Cube
(GPL-3.0, not AGPL-compatible), and `calicat` and `ksr_fdmtest_v4` which
OrcaSlicer itself records no attribution for. None of them belong in a
distribution under this repository's licence.

Both carve-outs stand regardless of the source snapshot boundary defined by the
superseded provenance apparatus below.

## What was superseded, and why

The original ADR defined a source-derived file boundary (`derivedRoots`),
required per-file provenance headers, and was enforced by
`scripts/check-calibration-provenance.mjs` against a machine-readable manifest
at `compliance/printer-calibration-provenance.json`. `THIRD_PARTY_NOTICES.md`,
`docs/compliance/CORRESPONDING_SOURCE.md`, `tests/provenance.test.ts`,
`.github/CODEOWNERS` entries protecting those paths, and the `check:provenance`
CI step formed the surrounding enforcement.

That apparatus was removed on **2026-08-23** together with the printer-
calibration surface introduced by PR #747, because the desktop redistributes no
third-party calibration content:

- **The OrcaSlicer worker resolves calibration models from its own OrcaSlicer
  resources; PFD neither bundles nor transfers them.** The worker image
  contains `resources/calib/` from the OrcaSlicer distribution it is built on,
  and applies the per-object overrides at slice time. The desktop names a
  calibration step and the three profiles, and never sees the model bytes.
- At the time of removal, the manifest guarded **zero** derived files:
  `derivedRoots` referenced four directories, none of which existed in the
  repository, and every one of the 27 `sourceDecisions` entries had an empty
  `destinationPath`. The apparatus had no subject.
- With no third-party content redistributed by PFD, there is no corresponding-
  source obligation beyond the AGPL text and third-party notices already in the
  repository.

The two carve-outs above do not depend on that machinery for their force.
They are licence facts about upstream files.

## Contingency

If a future decision reintroduces bundled or adapted third-party source into
PFD's own distribution — for example, an approved fork of an OrcaSlicer
subsystem, a bundled calibration geometry, or any file whose upstream origin
imposes AGPL-incompatible obligations — **this ADR must be revisited**. The
provenance apparatus was removed on the express premise that PFD redistributes
none of that. A new ADR must record the new premise before any such source
lands, and either restore an enforcement machinery equivalent to what was
removed or justify a lighter one against the specific obligations of the
newly-bundled licence.

## References

- Removal: commit history on branch that lands this supersession
  (companion to the PR #747 revert, same session).
- Original apparatus (removed): `scripts/check-calibration-provenance.mjs`,
  `compliance/printer-calibration-provenance.json`,
  `compliance/printer-calibration-provenance.schema.json`,
  `docs/compliance/CORRESPONDING_SOURCE.md`, `tests/provenance.test.ts`,
  the `check:provenance` step in `.github/workflows/ci.yml` and
  `.github/workflows/release.yml`, and five `.github/CODEOWNERS` entries whose
  sole subject was the above.
- Where calibration models come from now: the OrcaSlicer worker, from its own
  `resources/calib/` tree. Model resolution and per-object override
  application both live server-side; the desktop names a step and three
  profiles and never handles the model bytes.
