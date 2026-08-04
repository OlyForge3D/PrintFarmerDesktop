# Ralph — Recent Sessions

Ralph is the work monitor for PrintFarmer Desktop.

## 2026-07-23: Squad Initialization

Team hired as part of Squad Phase 2 setup for `OlyForge3D/PrintFarmerDesktop` (requested by Jeff Papiez). Not yet activated — no scan run this session.

## 2026-07-24: Activated — driving all epics except #42 and #44

Jeff activated Ralph directly ("I want ralph to drive all epics except for 42 and 44"). Scope: continuous scan→act→re-scan loop over the full `OlyForge3D/PrintFarmerDesktop` backlog, filtering out epic #42 (Printer Calibration, separate track) and epic #44 (Snapmaker U1, explicitly held out of sequencing) and their child issues/PRs at the scan step. A recurring workflow was created to keep the loop running on a cadence; an immediate first scan/act round was also kicked off. See `.squad/decisions.md` (2026-07-24: Ralph activated) for the full rationale.

## 2026-08-03: Exclusion lifted — driving the whole backlog to zero

Ripley audited the open board at Jeff's request and found all 14 open issues untriaged and unassigned: none carried a `squad:{member}` label and none had a GitHub assignee. Only #42 and #57 were even in the `squad` inbox. Ripley triaged all 14 — Ripley #2/#42/#44/#57/#109, Bishop #80/#136/#138, Hicks #65/#122/#127, Vasquez #81, Fact Checker #119/#121, Dallas none yet.

Jeff then handed the board to Ralph with the instruction to drive until all issues are closed, and explicitly lifted the 2026-07-24 exclusion of epics #42 and #44. The "Ralph - Backlog Driver" hourly workflow was updated in place (not duplicated): the SCOPE EXCLUSION section was replaced with a no-exclusions mandate, and the stale backlog snapshot (epics #4/#5/#6, all now closed) was replaced with the post-triage state.

## Learnings

- 2026-07-23: Issues #24-#28 are the initial active backlog in `OlyForge3D/PrintFarmerDesktop`; first activation should scan these for `squad`/`squad:{member}` label state.
- 2026-07-24: Must exclude #42 and #44 (and their sub-issues) from every scan round until Jeff says otherwise. **Superseded 2026-08-03 — exclusion lifted.**
- 2026-08-03: Nothing is out of scope. #136 is a build-breaking `bug` (the `step` feature does not compile and CI never builds it) and should be unblocked early; #57 cannot be worked until Ripley decomposes it into per-member children.
- 2026-08-03: The workflow's embedded backlog snapshot went stale once already (it still named closed epics #4/#5/#6 weeks later). Verify the board from `gh` every round; never trust the snapshot.
