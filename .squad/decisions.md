# Decisions Log

> Canonical, merged decision log for the team. Scribe merges entries from `.squad/decisions/inbox/` here. Append-only; do not edit past entries except to consolidate duplicates.

## 2026-07-23: Squad Phase 2 Initialization

**By:** Squad Coordinator

**What:** Initialized `.squad/` scaffolding for PrintFarmerDesktop with roster Ripley (Lead/Architecture), Dallas (React/Electron UI), Bishop (Rust/SQLite/Integration), Hicks (QA/Contract Testing), Vasquez (Security/Concurrency Review), plus built-ins Scribe, Ralph, Rai, and Fact Checker. Universe: Alien. State backend: `local`.

**Why:** Requested by Jeff Papiez to stand up Squad team infrastructure for this repo, tracking active issues #24-#28 in `OlyForge3D/PrintFarmerDesktop`.

## 2026-07-24: Epic-by-epic sequencing policy

**By:** Ripley

**What:** Backlog work must be driven epic-by-epic, not scattered issue-by-issue across multiple epics. Before starting a new epic, finish and close the current one (all child issues done, epic issue itself closed). Current dependency-respecting order for the MVP roadmap (#2): **#4 → #5 → #7 → #6 → #8**. Rationale: #4 (Rich 3D viewer, 1/4 done) and #5 (Model-format pipeline, 1/2 done) have no blockers and are already in progress but abandoned mid-way (e.g. epic #4 completed only #14, never returned for #15/#16/#17). #7 (Upload workflows) is unblocked — its only listed blockers (#3, and cross-repo `OlyForge3D/PrintFarmer#833/#834`) are all closed; #7's remaining work (#25/#26) is in flight as PR #33. #6 (Package/sign/release) genuinely needs #4 and #5 finished first. #8 (Bi-directional sync) genuinely needs #7 merged first. Newer epics #42 (calibration wizard, licensing-blocked) and #44 (Snapmaker U1) sit outside this dependency chain and should not be interleaved with it.

**Why:** Requested by Jeff Papiez after observing epic #4 sitting at 1/4 complete with no follow-up, and general backlog "random" distribution. Root cause: no issue/epic has an assignee, so squad sessions get launched ad hoc per-issue rather than being scoped to "finish epic X." This decision records the intended sequencing so future squad sessions pick up the next unclaimed issue within the _current_ epic before opening a new one.

**Amendment (2026-07-24):** Independent epics (e.g. a #4 track and a #5 track, once both are unblocked) may be worked concurrently by separate team members, each in their own worktree/branch — this is not a strict single-threaded rule, only a "don't scatter across an epic's own children" rule. Because multiple worktrees may be advancing `development` in parallel, every branch must `git merge origin/development` (or rebase, for branches with no prior merge commits of their own) to pick up the latest `development` **before** opening or updating a PR, so conflicts are caught and resolved by the branch owner rather than discovered later by a reviewer or blocking someone else's merge.

**Amendment (2026-07-24, later): epic #42 is out of scope — handled separately; epic #44 checked but explicitly kept out of the chain.** Per Jeff: epic **#42** (Printer Calibration) is being handled as its own separate track outside this backlog's sequencing — not ours to triage, block-check, or schedule against #4-#8. (For reference only: it also happens to have five open cross-repo backend prerequisites in `OlyForge3D/PrintFarmer#895/#896/#898/#899/#900`, but that's not why it's excluded — it's excluded because it's a separately-owned track.) Epic **#44** (Snapmaker U1) has no external blockers and already has active work (sub-issue #45 has an open, clean PR #43) — but per Jeff's explicit direction, **do not fold #44 into the core sequencing chain** either. Both #42 and #44 stay deliberately out-of-band; the chain remains **#4 → #5 → #7 → #6 → #8** unchanged. #7's remaining work (#25/#26) is in flight as PR #33, unanimously reviewed and green. PR #39 (epic #4/#5, lib3mf FFI for #18) is `DIRTY` again and needs the same origin/development rebase treatment PR #33 just got.

**Amendment (2026-07-24, later still): Ralph is not currently running.** `.squad/orchestration-log` has no run entries. No continuous scan→act→re-scan loop is driving this backlog; all triage/sequencing to date has been Ripley acting on direct request. If continuous autonomous backlog-driving is wanted, Ralph needs to be explicitly activated.

## 2026-07-24: Ralph activated — drives all epics except #42 and #44

**By:** Ripley (on Jeff's direct instruction)

**What:** Ralph (Work Monitor) is now active for `OlyForge3D/PrintFarmerDesktop`. Scope: **all epics and their child issues/PRs EXCEPT epic #42 (Printer Calibration — handled separately, not ours) and epic #44 (Snapmaker U1 — explicitly held out per Jeff's direction).** Ralph's scan step must filter out any issue/PR whose parent epic is #42 or #44 before categorizing or acting. Everything else — #4, #5, #6, #7, #8, and any newly-triaged `squad`-labeled issue not under #42/#44 — is in scope for Ralph's continuous scan→act→re-scan loop, respecting the existing epic-by-epic sequencing (#4→#5→#7→#6→#8) and the concurrency amendment above. A recurring workflow was set up to keep the loop running on a cadence; Ralph also ran (or will run) an immediate first scan round on activation.

**Why:** Requested by Jeff Papiez: "I want ralph to drive all epics except for 42 and 44." Epic #42 is owned/handled by a separate track outside this backlog; epic #44, while technically unblocked, was explicitly told to stay out of the sequencing chain in an earlier decision this same day — Ralph must honor both exclusions, not just #42's.

## 2026-07-24: Rejection-lockout policy DISMISSED — original authors fix their own rejected work

**By:** Ripley (on Jeff's direct instruction)

**What:** The rejection-lockout convention used during PR #33 and PR #39 review cycles — where a rejected commit's original author was barred from personally authoring the fix, and a different squad member had to revise it instead — is **dismissed, effective immediately**. Going forward, when Hicks or Vasquez (or any reviewer) rejects a commit, the **original author of that commit fixes it themselves**. Do not rotate to a different author. This applies to all in-flight and future review cycles (e.g. PR #39's round-3 review currently in progress: if Vasquez rejects Bishop's `53f962b`, Bishop fixes it directly, not a different member).

**Why:** Requested by Jeff Papiez: "Dismiss the lockout rule. Original owners are required to fix their own code changes." Unanimous-approval + green-CI still gates merge; only the "different author must revise a rejection" mechanic is removed.

## 2026-07-25: PR CI-gate monitoring expanded to ALL open PRs, regardless of epic

**By:** Ripley (on Jeff's direct instruction)

**What:** The standing "when PRs are all green in CI tasks, complete the PRs and close the associated issues" directive now applies to **every open PR** in the repo, including PRs on epics #42/#44 that are otherwise out of active sequencing scope, and PRs authored directly by Jeff (not just squad-delegated work). Squad sessions (Ripley/Ralph) should include these in routine CI-gate monitoring and merge them once green, without waiting for a separate ask each time.

**Why:** Jeff asked "are we not monitoring PRs for CI gate completion and closing them when they are?" after PRs #59/#60/#62 (his own direct commits on epics #42/#44) sat unmonitored because those epics are excluded from active *sequencing/triage* scope. Clarified: epic-sequencing exclusion (#42/#44) is about not scheduling new *squad* work there, not about withholding routine CI-gate merge monitoring from PRs that already exist.
