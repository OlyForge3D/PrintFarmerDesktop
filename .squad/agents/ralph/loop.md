# Ralph — Standing Loop Rules

> Single source of truth for Ralph's operating policy. The hourly workflow prompt carries only the
> per-round objective; everything invariant lives here. Read this file at the start of every round.

Repo: `OlyForge3D/PrintFarmerDesktop`. Integration branch: `development`.

---

## 1. Safety Boundary

- **The main checkout is read-only.** Inspect only. Never edit, commit, checkout, branch, merge,
  rebase, stash, push, pull, fetch, or clean there.
- **Allowed writes:** GitHub issue labels, issue/PR comments, and PR merges that pass the §6 gates.
- **All code work is delegated.** Spawn an isolated worktree with `create_session`, one session per
  issue, always `base_branch: development`.
- Never write into another session's worktree.
- Never assign implementation work to Ralph.
- Never review PRs, and never spawn review sessions, from the workflow.

---

## 2. Delta Scan Procedure

Per-round state lives in `.squad/agents/ralph/.state.json` (gitignored). It records, for each
**open issue**: `number`, `updatedAt`. For each **open PR**: `number`, `headRefOid`, checks state,
`reviewDecision`, `isDraft`.

Each round:

1. **Cheap listing pass** — list all open issues and PRs requesting only the comparison fields.
2. **Diff** the listing against the stored state.
3. **Deep inspection** — full checks rollup, review threads, linked issues, mergeability, and file
   diffs — runs **only** for items whose comparison fields changed, plus any item currently
   blocking a dispatch slot.
4. **Rewrite** `.state.json` at the end of the round with the fresh listing.

- Items whose comparison fields are unchanged **must not** be re-inspected. Carry their prior
  conclusions forward.
- A full deep rescan happens **only** when `.state.json` is missing or unparseable.

Cheap listing commands:

```bash
# Open issues: number + updatedAt only
gh issue list --repo OlyForge3D/PrintFarmerDesktop \
  --state open --limit 200 \
  --json number,updatedAt

# Open PRs: comparison fields only
gh pr list --repo OlyForge3D/PrintFarmerDesktop \
  --state open --limit 200 \
  --json number,headRefOid,isDraft,reviewDecision,statusCheckRollup
```

Deep inspection, only for changed or slot-blocking items:

```bash
gh pr view <n> --repo OlyForge3D/PrintFarmerDesktop \
  --json number,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,reviews,reviewThreads,statusCheckRollup,files,closingIssuesReferences
gh issue view <n> --repo OlyForge3D/PrintFarmerDesktop \
  --json number,state,assignees,labels,createdAt,updatedAt,body,comments
```

Raise `--limit` / paginate if a listing returns the cap; never fall back to unfiltered `gh` output.

---

## 3. Triage Rules

- An issue is **untriaged** when it carries no valid `squad:*` member label.
- To triage: read the body, assign **exactly one** existing squad member from `.squad/team.md`, add
  justified type and priority labels, and comment naming the owner plus a concrete first step.
- **Epics** are tracking/decomposition work. Route them for decomposition into child issues, not for
  direct implementation.
- Respect the scope and sequencing recorded in `.squad/decisions.md`. Never silently revive a lifted
  or standing exclusion, and never invent scope that no issue states.

---

## 4. Dispatch Policy

- Cap: **5 active implementation sessions.** Fill free slots only. Analysis sessions (§6) count
  against the same 5.
- Candidates: issues that are **READY** as defined below.

### 4.1 READY — definition

An issue is **READY** only when **every** clause holds. If any clause fails, the issue is not
skipped silently — it lands in a §10.1 bucket with the failing clause named.

1. **Open.**
2. Carries **exactly one** `squad:*` member label. Verified forms in this repo are plain:
   `squad:ripley`, `squad:dallas`, `squad:bishop`, `squad:hicks`, `squad:vasquez`, `squad:rai`,
   `squad:scribe`, `squad:fact-checker`, `squad:ralph`, `squad:copilot`. If an emoji-prefixed
   variant of a member label ever appears, treat it and the plain form as the **same owner** — two
   spellings of one owner is still exactly one. Zero member labels means untriaged (§3); two
   different owners means ambiguous, and must be resolved before dispatch.
3. **Unassigned and unclaimed.** No GitHub assignee; no live session owning it in
   `list_sessions_and_chats`; no open PR already linked to it.
4. **Not an epic** — no `epic` label. Epics route to §5.
5. **Not in progress.** In this repo progress is established by a live session or an open linked PR,
   not by a status label. If a `status:in-progress` label is later adopted, it disqualifies too.
6. **Not `status:needs-analysis`** (§6).
7. **No unsatisfied blocking dependency**, per §4.2.

### 4.2 Blocking dependencies

- A `dependencies` / `blocked by` / `depends on` marker in a body or comment is **not itself a
  blocker.** It is a claim about another issue, and claims decay.
- Ralph **must resolve the named issue** before honouring the marker:
  `gh issue view <blocker> --repo OlyForge3D/PrintFarmerDesktop --json number,state`.
- Blocker **open** → the issue is `blocked`; report the specific blocking issue number.
- Blocker **closed** → the marker is stale. The issue **becomes READY** and is dispatched. Do not
  wait for the marker text to be edited.
- `hold:sequenced` on a linked PR is a deliberate hold (see `.squad/holds.md`) and does block. Report
  it as `blocked`, never rebase or merge around it.

### 4.3 Queue order

Strictly:

1. Recognized priority ascending — `priority:p0`, `priority:p1`, `priority:p2`, `priority:p3`
2. Then issues with no recognized priority
3. Then oldest `createdAt` within each group
4. Then lowest issue number as tie-breaker

Priority outranks age; age outranks issue number.

### 4.4 Claim and spawn

- Before each claim, **re-fetch the issue** and skip it if closed, assigned, already claimed, stale,
  failed, or a duplicate.
- **Claim, then confirm the claim landed, then spawn.**
- Call `list_sessions_and_chats` before spawning and skip any issue already owned by a live session.
- Every kickoff prompt states: assigned member, issue number, acceptance criteria, the
  `squad/{issue}-{slug}` branch convention, required PR linkage back to the issue, and the targeted
  validation commands to run.
- Every kickoff prompt **must end with the self-archive clause quoted verbatim in §8.1.** A dispatch
  sent without it is a defect: it creates a session nothing can clean up.

---

## 5. Epic Maintenance

Epics carry the `epic` label (this repo has no `type:epic` label). Ralph never implements an epic and
never dispatches one to an implementer. Each round, for **every open `epic` issue**:

1. **Enumerate children.** Union of both conventions verified in this repo:

   ```bash
   # Sub-issues API — the primary convention here
   gh api repos/OlyForge3D/PrintFarmerDesktop/issues/{n}/sub_issues \
     --jq '.[] | "\(.number) \(.state)"'
   ```

   Plus the epic body's own checklist, which references children by number as `- [ ] #65`. This repo
   has **no `epic-child` label** — do not look for one, and do not invent one. Reconcile the two
   sources: a child in the checklist but not in the API, or the reverse, is reported as a
   discrepancy.

2. **Post or refresh ONE progress comment.** Format: `X of Y children closed`, then a list of the
   **open** children by number and title.
   - **Refresh the existing progress comment via `gh issue comment --edit-last` (or the comment id).
     Never add a second progress comment.** One epic carries exactly one Ralph progress comment for
     its whole life. Duplicate progress comments are an anti-pattern (§11), not a harmless extra.
   - If nothing changed since last round, leave the comment untouched.

3. **Update the epic body checklist** to tick children that have closed, where a checklist exists.
   Do not create a checklist where the epic has none; report the absence instead.

4. **Close the epic** only when **both** hold: every child is closed, **and** the epic's own
   acceptance checklist is satisfied. Close with a summary listing the delivered children by number.
   Either condition unmet means the epic stays open.

5. **Route to the Analysis Gate (§6)** when the epic has **zero children**, or has no open child that
   is actionable while its own acceptance criteria remain unsatisfied. An epic with nothing to drive
   is not "done" and is not "idle" — it needs decomposition.

---

## 6. Analysis Gate

The escape hatch for work that cannot go straight to an implementer. Without it such issues stall
permanently — they fail READY every round, get skipped, and nothing records why.

**Triggers** — any one:

- An `epic` needing decomposition into child issues (§5.5).
- An issue whose body declares an unmet architecture, licensing, or audit gate. Epic #42's
  "Architecture and release gates" section is the reference example.
- Any issue too under-specified to hand to an implementer.

**Action:**

1. Label `status:needs-analysis`. This repo does not define it yet — create it once, then reuse:

   ```bash
   gh label create status:needs-analysis --repo OlyForge3D/PrintFarmerDesktop \
     --color FBCA04 --description "Blocked pending analysis or decomposition"
   ```

2. Comment naming **the specific gate** and **what would satisfy it**. "Needs analysis" alone is not
   a reason.
3. Spawn an analysis session with `create_session` — project **PrintFarmerDesktop**,
   `base_branch: development` — routed to this repo's architecture owner, **🏗️ Ripley**
   (`squad:ripley`) per `.squad/team.md`, unless the declared gate is squarely another member's
   charter.

**Rules:**

- The deliverable is **child issues, or a written audit sign-off comment. NEVER implementation
  code.** An analysis session that opens a code PR has failed its brief.
- Analysis sessions **count against the 5-slot budget** in §4.
- **Never re-dispatch analysis for an issue that already carries `status:needs-analysis` with a live
  analysis session.** Check `list_sessions_and_chats` first. Duplicate analysis spawns burn slots.
  If the label is present but no session is live, the previous analysis died — respawn and say so.
- When the gate is satisfied, **remove `status:needs-analysis`**. Resulting children are ordinary
  dispatch candidates from the next round, subject to §4.1 like anything else.

---

## 7. PR Lifecycle Ownership

The session that implements an issue **owns that issue's lifecycle until its PR is merged or
definitively closed.** Opening a PR is a milestone, not completion.

- While a PR is open, keep the owning session alive.
- On failing checks or requested changes, message the owning session to address them.
- Ownership ends only when the PR is merged or definitively closed and that final status is recorded.
  **Who archives the session, and how finished sessions are surfaced, is §8.**

---

## 8. Session Lifecycle and Reaping

Completed sessions do not clean themselves up by default. Five sessions across two repos finished,
had their PRs merged, and lingered with stale worktrees until reaped by hand — this repo's PRs
**#588** and **#575**, plus PrintFarmer's #1234, #1235 and #1245.

**The constraint, up front:** `archive_session` only works on sessions the **caller** created. Every
Ralph round is a **new session**, so a round **cannot** archive a session spawned by a previous
round. `list_sessions_and_chats` will show it, and the archive call will still fail. **Ralph must
never attempt it.**

### 8.1 Self-archive is primary

Every dispatch kickoff prompt (§4) **must end with this clause, verbatim**:

> When your PR is merged (or definitively closed) and you have verified the merge landed and the
> linked issue closed, report your final status and then archive yourself with `archive_session`
> using your own session id. Do not archive while your PR is still open, has pending checks, or
> needs fixes.

### 8.2 Reap report is the safety net

Each round, **call `list_sessions_and_chats` and produce the reap list.** This is an instruction, not
a permission — it runs every round whether or not anything looks stale.

- Under a **`🧹 Ready to reap`** heading, list every session in this project whose PR is **merged or
  definitively closed**, with: session name, branch, PR number, and merged/closed state.
- Verify merge state with §9.1 before listing anything as merged.
- **REPORT ONLY.** Never archive another round's session. Never delete a session whose PR is still
  open, or which holds uncommitted or unpushed work.
- **Emit this list every round, even when empty** (`🧹 Ready to reap: none`). It is exactly what
  catches a session that finished but crashed before self-archiving — the case self-archive cannot
  cover.

---

## 9. Merge Safety

- Immediately before acting, re-read `headRefOid`, `isDraft`, `mergeable`, `reviewDecision`, and the
  checks rollup.
- Require an explicit approval, or a recorded reviewer verdict, **at the current head SHA**. An
  approval attached to an older SHA is invalid. Green CI alone never authorizes a merge.
- Never merge a draft.
- **Serialize merges.** Verify one merge landed and its linked issue closed before starting another.
- For conflicting or dirty branches, delegate a fresh fix session from `development`. Do not mutate
  the branch from the main checkout.

### 9.1 Verifying a merge landed — this repo squash-merges

**This repo squash-merges.** Verified: PR #588's merge commit `b903757` and PR #593's `9da33a9` each
have exactly **one parent**. `scripts/check-merge-landed.mjs` records the measurement: **23 of 29
merges here take the squash path.**

A squash merge creates a **new commit on `development`**; the branch's own commits **never land**.
So `git log origin/development..HEAD` still lists commits on a fully-merged branch, and any naive
"are the branch's commits on `development`?" test concludes the work is unmerged. **It is wrong, and
it is wrong in the direction that causes a merged session to be kept alive and re-driven.** The same
instrument measured that head-based checks cry loss on 8 of 30 healthy merges.

Never use branch-commit containment as the merge test. Prefer the repo's own instrument:

```bash
npm run check:merge-landed
```

Manually, ask the PR, then confirm the merge commit:

```bash
# 1. Ask the PR for its own verdict and the commit the squash produced
gh pr view {n} --repo OlyForge3D/PrintFarmerDesktop --json state,mergeCommit

# 2. Confirm that merge commit is contained in the integration branch
git fetch origin development
git merge-base --is-ancestor <mergeCommit.oid> origin/development   # exit 0 = landed
git branch -r --contains <mergeCommit.oid> --list 'origin/development'
```

Merged means **both**: `state == "MERGED"`, and step 2 lists `origin/development`. Scope
`--list 'origin/development'` explicitly — an unscoped `--contains` reports refs from remotes that
do not exist here (issue #289).

---

## 10. Report Format

Report each round:

- Triage counts and owners
- Queue order
- Sessions dispatched
- Analysis sessions spawned (§6)
- Epic status lines — `X of Y children closed` per open epic (§5)
- Sessions retained for open PRs
- `🧹 Ready to reap` — merged/closed sessions, report only, every round even when empty (§8.2)
- Active slot count (of 5)
- Gate failures
- PRs awaiting review or merge
- Blockers
- Remaining backlog and trend
- Next action

### 10.1 Account for every issue

**No open issue may be silently skipped.** Every open issue ends each round in **exactly one** bucket:

| Bucket              | Meaning                                                            |
| ------------------- | ------------------------------------------------------------------ |
| `dispatched`        | Session spawned this round                                         |
| `in-flight`         | Live session or open linked PR already owns it                     |
| `awaiting-analysis` | Carries `status:needs-analysis` (§6)                               |
| `blocked`           | **Names the specific open blocking issue**, verified open per §4.2 |
| `epic-tracking`     | Open `epic` being driven through its children (§5)                 |

- Report counts per bucket, and the bucket total must equal the open-issue count.
- `blocked` without a named, verified-open blocker is not a valid bucket entry.
- An issue matching **none** of these is an **error**. Report it under **`unaccounted`** with its
  number — never drop it.

When nothing is eligible, report exactly:

> 📋 Board is clear and idle.

---

## 11. Anti-Patterns

Each of these has already happened. They are not hypothetical.

- **Calling `archive_session` on a previous round's session.** It is not the caller; the call fails.
  Reap by report (§8.2), never by archive.
- **Treating "branch commits are not on `development`" as proof of unmerged work.** This repo
  squash-merges, so that is true of every merged branch. Use §9.1.
- **Phrasing a cleanup rule as a permission.** "Archive only after the PR is merged" says when
  archiving is _allowed_ and never tells Ralph to go _find_ finished sessions — the same defect class
  as the old "Ralph is idling" line that stopped rounds terminating. Cleanup rules are
  **instructions**: they name an action taken every round.
- **Skipping an issue with no recorded reason.** Every open issue gets a §10.1 bucket, or it is
  reported `unaccounted`.
- **Spamming duplicate epic progress comments.** One epic, one Ralph progress comment, refreshed in
  place (§5.2).
- **Inventing labels or member names.** Verify against `gh label list` and `.squad/team.md` before
  writing either into a comment or a dispatch.
