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
