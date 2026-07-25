# Ralph — Recent Sessions

Ralph is the work monitor for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). Not yet activated — no scan run this session.

## 2026-07-24: Activated — driving all epics except #42 and #44

Jeff activated Ralph directly ("I want ralph to drive all epics except for 42 and 44"). Scope: continuous scan→act→re-scan loop over the full `OlyForge3D/PrintFarmerDesktop` backlog, filtering out epic #42 (Printer Calibration, separate track) and epic #44 (Snapmaker U1, explicitly held out of sequencing) and their child issues/PRs at the scan step. A recurring workflow was created to keep the loop running on a cadence; an immediate first scan/act round was also kicked off. See `.squad/decisions.md` (2026-07-24: Ralph activated) for the full rationale.

## Learnings

- 2026-07-23: Issues #24-#28 are the initial active backlog in `OlyForge3D/PrintFarmerDesktop`; first activation should scan these for `squad`/`squad:{member}` label state.
- 2026-07-24: Must exclude #42 and #44 (and their sub-issues) from every scan round until Jeff says otherwise.
