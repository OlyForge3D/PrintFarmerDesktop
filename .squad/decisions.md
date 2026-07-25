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

**Why:** Jeff asked "are we not monitoring PRs for CI gate completion and closing them when they are?" after PRs #59/#60/#62 (his own direct commits on epics #42/#44) sat unmonitored because those epics are excluded from active _sequencing/triage_ scope. Clarified: epic-sequencing exclusion (#42/#44) is about not scheduling new _squad_ work there, not about withholding routine CI-gate merge monitoring from PRs that already exist.

## 2026-07-25: Incident — back-to-back squash-merges raced and silently dropped PR #59's content

**By:** Ripley

**What:** While completing the newly-expanded all-PR CI-gate monitoring, PR #59 ("Add native Snapmaker U1 retarget engine") and PR #60 ("Establish Printer Calibration licensing and provenance") were squash-merged via two `gh pr merge` calls fired only ~3 seconds apart. GitHub reported **both as `MERGED`**, but PR #59's merge commit (`074e1f23`) was never actually made reachable from `development` — a race where both merges resolved against the same stale base tip, and the ref update from the second merge silently orphaned the first. The result: `development` was missing the entire `native/model-core/src/retarget/*.rs` engine (~6000 lines) for several hours, invisible because downstream PR #62's tests mock the sidecar interface rather than exercising the real Rust binary, so CI stayed green throughout. The gap was caught only because PR #64 ("Add and harden native Snapmaker U1 workflow") independently re-added the same engine code as its first commit, and its size (13k+ additions) prompted a manual diff audit before merging rather than a blind green-CI merge. Merging PR #64 restored the missing engine plus its own new work; closed issues #46-#50; no further action needed on PR #59 itself (its GitHub "MERGED" status is now harmless/stale, since the code is back via #64).

**New rule:** Never fire two `gh pr merge` calls back-to-back without confirming, between them, that the first merge's commit is actually an ancestor of the target branch (e.g. `git merge-base --is-ancestor <merge-commit> origin/<branch>`, or re-fetching and checking `git log` before merging the next PR). Merges against a shared base must be serialized with a verification step in between — batching/parallelizing squash-merges of independent PRs targeting the same branch is not safe.

**Why:** Self-identified during routine PR monitoring; recorded so future sessions (Ripley/Ralph) don't reintroduce silent data loss by merging multiple PRs against the same base without verifying each one lands before starting the next.

## 2026-07-25: Backlog reconciliation — stale epics closed, sequencing chain shortened, Ralph re-enabled read-only

**By:** Ripley

**Trigger:** Jeff observed "seems like work has stalled." Root cause was not blocked work — it was that the scheduled backlog driver (Ralph) had been **disabled** for main-checkout safety, and nothing replaced it, so nothing scanned the board between manual asks. A secondary cause was **stale tracking**: several epics and issues stayed open long after their work shipped, hiding how much was actually done.

**What was reconciled:**

- **Issues #25 and #26 closed.** Both were fully implemented and merged in `development` via PR #33, but stayed open because that PR carried no `Closes #N` reference. Verified against `development` before closing, with evidence comments on each.
- **Epic #7 (Desktop PrintFarmer connection & upload workflows) closed.** All tracked children (#24, #25, #26) complete; blockers `PrintFarmer#833`/`#834` closed.
- **Epic #8 (Bi-directional metadata sync & conflict resolution) closed.** Children #27 (PR #37) and #28 (PR #31) complete; cross-repo blocker `PrintFarmer#835` closed. Noted that #28 shipped as a conflict-resolution center _shell_ — residual depth should be filed as new child issues rather than holding the epic open.
- **Epic #5's checklist corrected.** It still showed `[ ]` for the long-closed #18, #19 and #30 (and the markdown had collapsed into a single unrendered line). Only #20 genuinely remains.

**Sequencing chain is now `#4 -> #5 -> #6`** (was `#4 -> #5 -> #7 -> #6 -> #8`). Epics #3, #7 and #8 are closed. Epic #6 (#21/#22/#23) stays blocked until #4 and #5 finish.

**Ralph re-enabled (hourly) with an explicitly read-only charter.** The workflow runs _in-place in the main checkout_ `D:\s\PrintFarmerDesktop`, which is why it had been disabled. Rather than leave the board unattended, its prompt now hard-codes: main checkout is **strictly read-only** (read-only `git`/`gh` inspection only; no edit/add/commit/checkout/branch/merge/rebase/stash/reset/push/pull/fetch/clean), and **all** code work must be delegated through `create_session`, which provisions an isolated worktree. The prompt also carries the merge-safety rule from the 2026-07-25 incident and an explicit duplicate-delegation check (`list_sessions_and_chats` before spawning), since concurrent sessions previously collided on the same PR.

**Convention established (third application):** an epic whose tracked children are all closed gets **closed**, not left open as a container. Precedent set by epic #3 at Jeff's direction, now applied to #7 and #8. If new scope emerges under a closed epic, file new child issues and open a fresh epic rather than reopening.

**Why:** Recorded so future sessions treat stale-tracking cleanup as part of routine monitoring (Ralph's Step 1 scan now includes it), and so nobody re-disables Ralph without also arranging a replacement driver — an unattended board is what stalls, not the work itself.

## 2026-07-25: Incident — treating a slow session as dead put two concurrent writers in one worktree

**By:** Ripley

**What:** Two delegated sessions (Dallas on issue #15, Bishop on issue #20) were created and then showed **zero turns, zero commits, and no pushed branch for roughly 20 minutes**, and did not respond to a re-kick message. I concluded both were dead and started parallel background implementations of the same issues **inside those sessions' own worktrees** to unblock the board. Both sessions were in fact alive — merely slow to register activity — and subsequently completed the work themselves. The result was **two concurrent writers in a single git worktree** for each issue.

Both cases converged on a coherent outcome (one PR each, #68 and #69, with identical or compatible content, clean working trees, and green CI), but that was **luck, not design**. Concurrent writers in one worktree can trivially produce a garbled interleaved commit, a half-staged index, or a lost-update force-push.

**Correction (filed by Bishop, verified against the repository):** an earlier version of this entry claimed that "PR #69's commit carries the wrong author identity and the other instance's `Copilot-Session` trailer." **That was false, and it was my error.** Both commits on that branch (`10a3078` and `4042e61`) carry the _same_ trailer, `Copilot-Session: 2659ecbd-…` — Bishop's own — and neither carries the trailer of the parallel writer I launched. Identical trailers on both commits are positive evidence of a **single** author, and `Jeff Papiez <jpapiez@live.com>` is simply the repo's local git identity, which every commit made in that worktree carries regardless of which agent authored it. So it was never evidence of a second writer at all.

The corrected finding is narrower and worth stating precisely: **the parallel writer I launched never landed a commit.** The danger was real and the rule below stands on its own — I did start a second writer inside a live session's worktree, and that could have corrupted the branch — but no damage actually reached the history, and I should not have asserted forensic detail I had not verified. Recording the correction rather than quietly editing it, because a decision log that silently rewrites its own evidence is worth less than one that shows where it was wrong.

**New rule:** **Never start work inside a worktree owned by another live session.** A session that looks idle may simply be slow to report — absence of turns/commits is not proof of death. If a session appears stalled: wait, ask again, or create a **new, separate** worktree. Never write into theirs. Before delegating, check for an existing owner (`list_sessions_and_chats`). If a takeover has already happened, verify the worktree is clean and the branch history coherent before trusting anything in it.

**Related rule (same root cause — stale state):** **freeze a PR branch while it is under review.** Reviews are pinned to an exact commit SHA; a push mid-review means the verdict no longer describes the commit that would be merged. PR #69's head moved from `10a3078` to `4042e61` while both reviewers were running. That delta happened to be test-only and additive (a ZIP64 entry-ceiling regression), so it was handled as a cheap delta review rather than a restart — but any production change forces a full re-review.

**Why:** Recorded so future leads do not repeat the takeover, and so "the session is not responding" is treated as a coordination problem to be resolved by asking, not by racing.

## 2026-07-25: `.github/skills/` never existed — squad skills now live in `.squad/skills/`

**By:** Ripley (defect reported by Bishop)

**What:** Assignment briefs — including my own — had for some time instructed squad members to read `.github/skills/agent-collaboration/SKILL.md`, `.github/skills/git-workflow/SKILL.md`, `.github/skills/test-discipline/SKILL.md` and `.github/skills/testing/SKILL.md` before starting work. **None of those files, nor the `.github/skills/` directory, have ever existed in this repository.** `.github/` contains only `CODEOWNERS`, `workflows/ci.yml` and `workflows/release.yml`. A `.squad/skills/` directory existed but contained nothing but a `.gitkeep`.

Bishop caught this while working issue #20 and correctly fell back to `.squad/decisions.md` conventions. Every prior delegate had silently absorbed four dead references without flagging them.

**Resolution:** rather than delete the references, the skills were **actually written**, at `.squad/skills/{git-workflow,test-discipline,testing,agent-collaboration}/SKILL.md`, capturing the conventions this squad has been operating by — most of them learned from incidents already recorded in this file (stacked-PR breakage, the merge race, missing `Closes #N`, `prettier --check` CI failures, mocks concealing missing production code, reviewer evidence standards, and the worktree-takeover incident above). Assignment briefs should now point at `.squad/skills/`, not `.github/skills/`.

**Why:** Recorded because the failure mode is more general than the specific paths: delegates were told to read documentation that did not exist and none reported it. If an instruction cannot be followed, **say so** rather than quietly working around it.

## 2026-07-25: Review verdicts must live on the pull request; blocked PRs are converted to draft

**By:** Ripley

**What:** Two PRs (#68 and #69) were independently reviewed and **rejected**, yet on GitHub both showed `reviewDecision: ""`, **zero reviews, zero comments**, `isDraft: false`, and **6/6 green CI**. The verdicts existed only inside the lead's chat session. Ralph — the hourly autonomous backlog driver — is instructed to merge PRs that are "green and approved". Nothing in the repository distinguished these two rejected PRs from genuinely mergeable ones, so the next scheduled run could have merged code carrying a reproduced two-tab-stop accessibility defect and a reproduced archive-limits bypass. This was caught before it happened; it was luck of timing, not a control.

**Root cause:** review state was held in volatile session memory rather than on the artifact being gated. Compounding it, cross-session messages were repeatedly lost or delivered late — Dallas twice never received the rejection and pinged asking why #68 had no reviews after 25 minutes, while the fix list sat undelivered in a chat channel.

**New rules:**

1. **Every review verdict is posted as a comment on the pull request**, naming the exact head SHA it was pinned to, before it is communicated anywhere else. A verdict that is not on the PR does not exist.
2. **A PR blocked by review is converted to draft** (`gh pr ready <n> --undo`). Draft is a mechanical merge block that no automation can bypass, and it is reversible when the fixes land. Draft here means "blocked by review", not "unfinished work".
3. **Green CI is necessary but never sufficient to merge.** Automation must read `isDraft`, `reviewDecision`, `reviews` and `comments` before merging, and must treat a PR with no recorded verdict as **unreviewed** regardless of CI colour.
4. **Verdicts are pinned to a SHA.** An approval recorded against an older head does not authorize merging a newer one.

Ralph's standing prompt was amended with a "merge evidence rule" encoding all four.

**Why:** Recorded because the failure was not in anyone's reasoning — the reviews were correct and both defects were real — but in where the conclusion was _stored_. Gating state belongs on the artifact being gated, in a form that survives the session that produced it. The PR is also a delivery channel that does not drop messages, which the chat channel demonstrably did.

## 2026-07-25: An empty `reviews: []` does not mean "no review is running"

**By:** Ripley

**What:** Because this squad posts verdicts as **issue comments** rather than through GitHub's formal review API, `gh pr view --json reviews` returns `[]` for the entire duration of a review — before it starts, while it runs, and after a verdict has been posted as a comment. Two independent misreadings of that empty array occurred within about twenty minutes of each other:

1. **Dallas** read `reviews: []` on PR #68 as "no review is in flight, so amending is cheap right now" and proposed a force-push-with-lease to correct a cosmetic commit trailer. Two reviewers were mid-pass at the time. He asked before acting, which is the only reason it cost nothing.
2. **A monitoring session** read the same signal on the same PR, concluded no review was running, and performed its own — against the **stale** head `bb57000` rather than the live `1c80bdb`. It produced two confidently-argued blocking findings. Both were **false**: the first conflated the global `resolved` set with a path-local `seen` that correctly walks a single ancestor chain; the second was structurally impossible, since `firstKey` already resolves to the first focusable row. It withheld from posting, which is the only reason it cost nothing.

**Both near-misses were caught by the agent choosing to ask rather than act.** That is not a control; it is good manners. The control is the rule below.

**New rules:**

1. **`reviews: []` carries no information about whether a review is running.** Verdicts arrive as comments at the _end_ of a pass, so the array is empty throughout. To determine review state, read the PR **comments**, and treat the absence of a verdict comment as "unknown", never as "none in flight".
2. **Re-read the live `headRefOid` immediately before stating any conclusion about a PR** — a verdict, a finding, a merge decision, or a status report. A finding against a stale SHA is not a weaker finding; it is a **wrong** one, and acting on it sends an author to re-fix code that is already fixed.
3. **Dispatching reviewers is the lead's exclusive act.** A session that notices an unreviewed PR reports it; it does not self-assign. Two agents reviewing the same SHA is wasted effort; two agents reviewing _different_ SHAs produces contradictory verdicts on the same PR.

Ralph's standing prompt was amended with all three.

**Why:** Recorded because both agents reasoned correctly from a signal that does not mean what its name implies. The fix is not "be more careful" — it is knowing that this particular field is uninformative under this squad's conventions.

## 2026-07-25: `Copilot-Session` trailers are the reliable evidence of concurrent writers — committer identity is not

**By:** Ripley

**What:** Following up the worktree-takeover incident above, the question of "did two writers touch this branch" came up again on PR #68, and this time the forensics held. Stating the method explicitly, since I previously got it wrong on #69 and had to retract:

- **Committer identity proves nothing.** It is set per-worktree from local git config, so it is neither stable across agents nor reliably distinct between them: commits on `squad-name-audit` carry `Ripley <ripley@squad.local>` while others in this repository carry `Jeff Papiez <jpapiez@live.com>`. Inconsistent, not invariant — useless as evidence for the same reason `author` is, and misleading in the opposite direction, since an unexpected committer looks like an anomaly when it is only a different worktree's config.
- **The `Copilot-Session` trailer is the discriminator.** _Divergent_ trailers within one branch are positive evidence of two writers; _identical_ trailers across all commits are positive evidence of one.
- On #69 all commits carried Bishop's own trailer — one writer, and my earlier claim was false. On #68, `741459d` carried `8dd289e7` (the parallel instance I launched) while `1c80bdb` carried `032c3f16` (Dallas's own) — two writers, confirmed.

**A rebase does not remove a trailer.** Dallas reported that rebasing #68 had re-authored the commits and cleared the bad trailer. It had not: rebase rewrites the SHA and the committer date, but reproduces the commit **message** verbatim, and the trailer lives in the message. Nor did the squash clear it — the squash commit `5eef0d7` on `development` carries **both** session trailers today, alongside `Co-authored-by: Dallas <dallas@squad.local>`. The forensic trace is on the default branch right now. Correcting a trailer requires an explicit message rewrite (`--amend` or `filter-branch`/`filter-repo`), and is almost never worth the force-push.

**One further caution on identity fields.** The rule above concerns _committer_, but _author_ is the field a future session is more likely to misread, and it is set inconsistently across branches: #68's commits carry `Dallas <dallas@squad.local>` while #69's carry `Jeff Papiez`. On #68 it happened not to distinguish the two writers — both commits shared the same author while their trailers diverged — so it corroborated nothing. Treat neither author nor committer as evidence; use the trailer.

**Ruling that followed:** leave incident trailers alone. On #68 the divergent trailer was the only durable forensic trace of the takeover recorded in this log, and amending it mid-review would have invalidated two pinned reviews to erase evidence of a mistake worth remembering.

**Why:** Recorded so this is not re-derived — twice now the question has come up mid-incident, under time pressure, and the first answer was wrong.

## 2026-07-25: Review lessons from PRs #68 and #69 — reachability, shadowed controls, and corpora built from spellings

**By:** Ripley

**What:** Three findings from the round-2 reviews generalize past the code that produced them, and have been written into `.squad/skills/test-discipline/SKILL.md`.

**1. A shared diagnostic code can hide an unreachable control.** Bishop self-reported, _after_ reporting his fix round complete and green, that his aggregate-decompression regression tripped the declared-total preflight rather than the running accumulator it was written for. Both **emitted** `limit.total_decompressed_bytes` (`limits.rs:96` at `1b8884b`, #69's open head), so his assertion — which correctly named the specific code, per existing skill guidance — could not distinguish them. **#69 split them before it merged**, and the fix is the recommendation this lesson arrives at: `check_declared_archive_total` now returns a distinct `DeclaredTotalDecompressedBytes` variant carrying `limit.declared_decompressed_bytes` (`limits.rs:98`, `:308` as of `8c0b4ba`), and the doc comment above it records why — _"a shared code leaves the caller unable to tell them apart. It also leaves a test unable to say which control it reached."_ Recorded here because a reader who checks the premise will find the codes already unique, and needs to know that means the lesson was acted on rather than that it was wrong.

The structural reason is the general lesson: **when two guards defend the same budget, the cheaper one usually shadows the stricter one on all honest input.** The preflight sums every declared entry; the accumulator counts only entries actually read; so declared >= charged and the preflight always wins. The accumulator can fire only when an entry **lies**, which is precisely the attacker-controlled case it exists for. It was live, correct, and unreachable through the public API. Closing it needed a forged central-directory size field declaring 1 KB for a 1.5 MB entry, with the forged declaration asserted to sit orders of magnitude under budget so the preflight demonstrably could not be the rejecter.

"Usually" is doing real work in that sentence — shadowing is not a structural law. It holds only where the cheap guard's quantity is an upper bound on the strict guard's over all honest input, and it fails wherever the preflight inspects only part of the input or the accumulator counts bytes the preflight never sees (nested archives, streaming expansion, re-reads). In this specific case it depends on **no entry being read twice**: the charge is `max(declared, actual)` per entry, so a part read twice is charged twice and could exceed the declared total on an honest archive. That invariant is held by one deliberate guard — `referenced_parts.remove(&root_part_key)`, which removes the root model part from `referenced_parts` before the second pass (`threemf.rs:635` as of `8c0b4ba`) — plus three accidents of structure: the relationship parts are distinct by construction (`_rels/.rels` vs `3D/_rels/3dmodel.model.rels`), `[Content_Types].xml` is read once, and `Metadata/model_settings.config` is read once, at the single production call site of `read_plate_layout`. Anyone auditing whether the invariant still holds would check the deliberate guard and stop, which is why the incidental ones are worth naming.

That third one arrived after this paragraph was written, and it is the clearest evidence for the paragraph's own thesis. #78 added a new entry read routed through `read_text_entry_limited`, which charges **both** counters the shadowing analysis depends on (`charge_entry` and `charge_decompressed`). The paragraph landed on `development` at `f1e1bb0` (11:38); the read landed at `8c0b4ba` (13:39) the same day. Nothing marks the single call site as load-bearing, and a second consumer of the plate layout — a retry, a pre-scan, a second panel wanting the same data — would break the precondition silently, with no test failing. The dependency list for a security argument is not a fact you record once; it grows every time someone adds a read, and there is no mechanism that tells you.

**Grep for the expression, not the line.** That citation originally read `threemf.rs:560`, which was correct at `1b8884b` and was falsified by the merge of the very PR it describes: `085d91a` grew the file by 137 lines and moved the guard to 601, then `8c0b4ba` moved it to 635, where line 560 is an unrelated struct field. A bare line number in a security precondition is a citation that decays on every merge, and this is the one an auditor is told to check.

Asserting the specific diagnostic is therefore **necessary but not sufficient — the diagnostic must be unique to the control.**

**2. A corpus built from spellings has a hole.** The non-finite float corpus listed `"NaN"`, `"inf"`, `"Infinity"` and so on. `1e999` contains none of those substrings, yet `f32::from_str` returns `Ok(inf)`. Enforcement was correct throughout — `is_finite()` — but nothing pinned it, so a regression to substring blocklisting would have passed the whole suite and failed an independent reviewer's harness. Found by Vasquez fuzzing the property rather than reusing the examples.

**3. Prove a cap still admits the legitimate maximum.** Reviewing #68's 20,000-row part-tree budget, the check that carried weight was rendering a 5,001-object scene — the sidecar's _documented_ mesh-object ceiling — and showing it produced 5,001 rows with no truncation. That is what distinguishes a cap from blanket denial, and it is not visible from reading the constant.

**Process note:** both #68 round-2 reviewers extracted the **pre-fix** function from the superseded commit and ran the new tests' hostile shapes against it, producing a before/after table (a 29-object diamond DAG at 49,150 rows vs 43; an 18-level DAG at 1,048,573 rows vs linear). **That is the evidentiary standard for a fix round**: a test that cannot fail against the old code is not a regression test, and demonstrating the failure costs minutes.

**Why:** Recorded because all three are cases where a control was correct and the _test_ was the defect — the hardest class to find by reading either one alone.

## 2026-07-25 — Reviewers ruling on different axes are not in disagreement

**Decision:** When two reviewers reach opposite verdicts, first establish whether they are ruling on the same axis. If they are not, **both verdicts stand and the axes are additive** — any one of them can block. The TL does not "break the tie," because there is no tie.

**Context:** On PR #69 the security reviewer returned APPROVE and the correctness reviewer returned REJECT on the same finding. It looked like a contradiction requiring adjudication. It was not. The security reviewer had ruled on _security severity_: no memory-unsafety, no cross-object mis-attribution, because the appearance state resets per object. That was correct. The correctness reviewer blocked on _availability, contract accuracy and test discipline_: a file with one unparseable cosmetic attribute opened before the PR and failed to open after it. Also correct.

Nothing had to be overridden. A security reviewer finding no vulnerability has established that a change is **not a vulnerability** — not that it is safe to ship. Reading APPROVE as "clear to merge" silently promotes one axis over every other.

**What made it legible:** the correctness reviewer named the split himself rather than arguing severity — in his words, he did not dispute the severity judgement and blocked on the axes that were his. Reviewers should state the axis they are ruling on when they know another reviewer has ruled differently. Adjudicating a disagreement that does not exist wastes a round and teaches reviewers to soften findings that sit outside the loudest reviewer's remit.

**Corollary:** a reviewer who has already approved should supersede their own earlier verdict rather than leave two contradicting comments on the PR, as happened correctly here when a delegated question turned an earlier APPROVE into a REJECT.

**Guardrail — the axis must be one the reviewer was assigned or the project has committed to.** Additivity without this lets anyone block anything by naming a new axis, which converts review from a set of known conditions into an open-ended veto. A blocking finding has to land on either the reviewer's assigned remit or a written project contract — a documented behaviour, a stated limit, an accessibility or compatibility guarantee. B3 qualified on both counts: test discipline is the correctness reviewer's remit, and the availability regression contradicted the PR's own documented graceful-degradation contract. "I have concerns" is not an axis. If a reviewer finds something real but outside every established axis, it is escalated as a scope question rather than asserted as a blocker — to the TL, or, where the TL is the author of the artifact under review, to a non-author adjudicator per the weak-point note below.

**Known weak point in the guardrail:** the escalation path routes a novel finding to the TL, and the TL is sometimes also the author of the artifact under review — as on both docs PRs this week. Every entry in this file exists because someone found something not yet written down, so the _first_ instance of any new failure class is by construction unblockable under the guardrail. That is probably the right trade, but it makes the escalation path load-bearing, and it is weakest exactly where authorship and adjudication coincide.

So the escalation is **reviewer-initiated, not TL-granted**. A reviewer who judges a finding real but outside every established axis routes it to a non-author adjudicator themselves; they do not need the TL to agree it is worth escalating. This matters more than the routing rule it replaces: an earlier draft of this clause governed only _who adjudicates after_ escalation, which left the prior question — whether to escalate at all, and whether the finding is "real" — with the TL, who in this exact case is the author. Closing the second door while leaving the first open is not a guardrail. A TL who wanted a finding to disappear would never have to breach the routing rule.

"Author" here means the agent that wrote the artifact, identified by the `Copilot-Session` trailer rather than by `author`/`committer` — see the identity entry above, where those fields proved unreliable across branches.

**Why:** Merge gating is not a vote. It is a conjunction of independent conditions, and the reviewers are the ones who know which condition they checked.

## 2026-07-25 — Order merges by measured overlap, not by PR number or age

**Decision:** Before publishing a merge order, run `git diff --name-only base...head` for each PR and order by **actual measured overlap**. Do not infer a dependency from issue numbering, PR age, or which epic something belongs to.

**Context:** I published the order #69 → #77 → #78 and told three sessions to work to it. #77 turned out to have **zero** file overlap with #69 — I had assumed the constraint rather than measured it, and reordering cost nothing once measured.

The rule then paid for itself in the other direction, twice over. I flagged on #78 at 18:41 that `threemf.rs` was modified by both it and #69 — 77 minutes before #69 landed. After the merge I re-ran the measurement rather than assuming the flag still described the situation, and the known overlap had hardened into a real conflict: `git merge-tree --write-tree 085d91a ca224a1` returned `CONFLICT (content)` on that file. It was then resolved by rebasing #78 directly onto `085d91a`, and `git merge-tree --write-tree 085d91a b9f1dea` returned no conflict. So the early measurement caught the risk, the second caught it hardening, and the third caught it clearing. **Confirming a known overlap is worth as much as discovering one** — an overlap that was harmless at one head can be a hard conflict at the next and clean again at the one after, and only re-measuring tells you which of the three you have.

**The second class, which `--name-only` cannot see** — which I twice claimed this repo demonstrates, wrongly, and then got wrong a third time in the retraction itself. All three were rejected in fact-check. Recorded here rather than deleted, because the error is more instructive than the rule I was trying to write.

Round 1 I wrote that #78's fix rewrites `partTreeModel.ts`. False: as of `8b5698d`, #78 did not touch that file. (By `b9f1dea` it did — `11df144` added 62 lines to it — which is precisely why the pin is load-bearing rather than pedantic.) Round 2 I "corrected" it to say #78 **imports** `isObjectHidden` from it (`plateSelection.ts:15`, true) and so is a consumer of a module #77 rewrote. Also false, in three ways I did not check:

- **The consumed contract never changed.** `isObjectHidden` is byte-identical before and after #77 (368 bytes, both revisions), as is its whole call closure down through `ancestorObjectIds` to `indexObjects`. Every hunk #77 made landed in `flattenPartTree` or `partTreeKeyAction`.
- **The timing inverted it.** As of `8b5698d` — the head under review at the time — #78's fix was authored 27 minutes _before_ #77 merged, on a branch then based at `f1e1bb0` and not at that point rebased onto #77. The branch has been rebased since; this claim is pinned to `8b5698d` because that is the only state it was ever true of, and stating anything about the branch's _current_ base would go stale again before it was read.
- **The prescribed remedy could not have fired.** I prescribed the import pass "before publishing a merge order." At that moment #78 was at `38024db`, which does not import `isObjectHidden` at all — the fix _created_ that import later. An import-boundary check run when the decision was taken would have reported exactly what `--name-only` reported.

**The lesson is the shape of the error, and it took three rounds to see because it changed level each time.** Round 1 named a file that was never touched. Round 2 named a symbol that never changed. Round 3 — this paragraph, in the correction itself — asserted a branch had "never been rebased" when it had been rebased **17 minutes before I wrote the sentence.** Three claims about the same relationship, each rejected, each one level further out: file, then symbol, then branch.

The common shape is not carelessness about facts. Every one of the three was checked, and every one was checked against a snapshot that had already expired. So: **pin claims about moving objects to the SHA they were true of**, in this file as strictly as on a PR review. If a sentence cannot name the commit it holds at, it does not belong here.

**Round 4 corrected the rule itself, and the correction matters more than the rule did.** I first wrote the hazard as the _present-perfect negative_ — "has never been," "does not touch," "is not a consumer of." That is where the first three instances happened to land, so it looked like the pattern. It is not. Fact-check found two unpinned claims left in this very entry, and only one of them was a negative; the other was a present-tense **positive** — "`merge-tree` **returns** `CONFLICT`" — which had gone stale by the identical mechanism when #78 was rebased. Worse, I had changed that sentence from _returned_ to _returns_ **in the same commit that added the pinning rule**, converting a true historical statement into a false standing one. The rule and its counterexample arrived together, and as written the rule would have let a future session keep the bad sentence in good conscience.

So the operative property is **tense, not negation**: any unpinned present-tense claim about a mutable object — branch, PR, working tree, or the repo as a whole — ages badly, positive or negative alike. The negation was a red herring. Write the measurement in the past tense with both operands named (`git merge-tree --write-tree 085d91a ca224a1` returned …), because a statement about two immutable SHAs stays true forever, while the same statement about "#78" stops being true the moment someone rebases.

Round 7 supplied the controlled experiment, and it is the single best piece of evidence in this file for the rule. The same fact was written twice, in **the same commit** (`f1e1bb0`), in the two files this entry governs:

- `decisions.md:176` — "Both **emit** `limit.total_decompressed_bytes`." Falsified by `085d91a`, 80 minutes later.
- `SKILL.md:37` — "On PR #69 both … **emitted** `limit.total_decompressed_bytes`." Still true, and permanently so.

Identical claim, identical evidence, written in one sitting by one author. One survived and one did not, and **the only difference between them is tense and scope**. Nothing about care, checking, attention or subject-matter knowledge can separate the two sentences — there was no interval in which to become careless. That is why the rule cannot be replaced by trying harder, and why it belongs in a file rather than in someone's habits.

That the error **recurred across four rounds and was caught on every one**, and was then reintroduced _by the fix for it_, is the strongest argument in this file for external review. Nothing survived the check — each instance was rejected on the pass it appeared, including the round whose entire subject was making claims that do not expire. A fifth pass then found two further instances in paragraphs written the same morning and untouched since, using the rule this entry had just added — one of them in a citation that had itself been cleared across three rounds of an earlier review. A sixth pass then found this very paragraph overstating that interval as "days," and found the enumeration in the paragraph above it had gone stale within the hour.

**Both searches are load-bearing, and neither replaces the other.** Six of the first seven rounds had a defect in their own new text, including the round whose entire subject was making claims that do not expire; the seventh had a clean delta and its only finding came from the old-text sweep. Across two such sweeps, three defects were found in paragraphs nobody was editing — all three falsified by merges, two by the merge of the very PR the paragraph described. An earlier draft of this entry claimed the newest text is where a defect is most likely but not where it is most costly. That over-claimed on the strength of a single pass — in the very next round the newest text was both. A later draft then asserted that _every_ round had a defect in its new text, an unpinned universal over a set still growing, which the next round falsified by coming back clean. The plainer statement is what the evidence supports: new text is where defects appear, old text is where they persist, and re-auditing untouched paragraphs has no natural trigger, which is the only reason it needs writing down.

Fixing a citation while inheriting its inference is the sub-case that survives review, because the corrected fact is verifiable and draws the eye. `git log -S` and a byte comparison of the consumed function are about ninety seconds — the same "measure it, don't assume it" this entry is about, applied one level down, and then one level down again.

It then happened a second time, to the fix for the first. Round 6 found the corrected citation pointing at exactly the right line, pinned to the right commit, sitting inside an enumeration that had gone stale between the review and the fix. **Correcting an address does not re-verify the sentence around it** — and pinning cuts both ways, because the pin asserts the whole sentence was checked at that commit, which turns a vague claim into a falsifiable one that can now fail its own check. That is still the right trade. A sentence that can be proven wrong is worth more than one that cannot be evaluated, but it does oblige you to re-read the sentence, not just the footnote.

So: semantic coupling is a real hazard in principle, and **no instance of it was found on `development` at `085d91a`**. That is narrower than "this repo" and deliberately so — every candidate considered here lived on open PR branches, which is where such an instance would appear first and where this search did not reach. When one occurs, record it then, pinned, per the rule above. A decision log that carries a rule nobody can reproduce from the cited evidence is worse than one that stays silent, because the unreproducible rule is what future sessions cite.

**Cost of getting it wrong in the other direction:** telling an author to rebase onto a branch that is still under revision makes them do the work twice. "Do not rebase onto a PR that is in a fix round" is the companion rule.

**Also:** when a merge lands under an author who is actively editing a file it touches, tell them within minutes and name the file. A clean textual merge is _more_ dangerous here, not less, when the two changes touch the same semantics rather than adjacent lines.

**Why:** A published order is load-bearing — sessions serialize their work against it. An unmeasured one costs more than no order at all, because it is followed.

## 2026-07-25 — A freeze overrides a standing instruction

**Decision:** When a branch is frozen for review, an outstanding standing instruction to "fold in-scope findings without asking" is **suspended** for the duration. Any find, however correct, is reported and not pushed.

**Context:** I had issued both — a standing instruction to fold in-scope work without asking, because head movement is my cost to bear, and later an absolute freeze so two reviewers could finally sit on one head. An author pushed a correct, reviewer-requested, CI-green change under the freeze. That was an ambiguity I authored, not an order ignored, and the record says so.

I accepted the push rather than reverting it: the content was right, and reverting good work to make a procedural point costs the project more than the breach did. Reverting would also have been the wrong lesson — the fault was in the instructions, not the judgement.

**Mitigating factor worth noting:** the push **appended** rather than force-pushed, so the reviewers' pinned SHA remained an ancestor and no completed review was invalidated. An append costs a re-pin; a rewrite costs the round. If a frozen branch must move, appending is the cheap failure.

**The unambiguous half:** the push was not announced on the PR. Status lives on the PR because chat is lossy — two reviewers sat pinned to a SHA they had been told was final, discoverable only by polling.

**Why:** Rules that contradict each other are worse than either rule alone, because the delegate has to guess and will be blamed either way.
