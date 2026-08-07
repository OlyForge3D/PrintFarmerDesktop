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

- Cap: **5 active implementation sessions.** Fill free slots only.
- Candidates: currently open, ready, unowned issues.
- **Queue order**, strictly:
  1. Recognized priority ascending — `priority:p0`, `priority:p1`, `priority:p2`, `priority:p3`
  2. Then issues with no recognized priority
  3. Then oldest `createdAt` within each group
  4. Then lowest issue number as tie-breaker

  Priority outranks age; age outranks issue number.

- Before each claim, **re-fetch the issue** and skip it if closed, assigned, already claimed, stale,
  failed, or a duplicate.
- **Claim, then confirm the claim landed, then spawn.**
- Call `list_sessions_and_chats` before spawning and skip any issue already owned by a live session.
- Every kickoff prompt states: assigned member, issue number, acceptance criteria, the
  `squad/{issue}-{slug}` branch convention, required PR linkage back to the issue, and the targeted
  validation commands to run.

---

## 5. PR Lifecycle Ownership

The session that implements an issue **owns that issue's lifecycle until its PR is merged or
definitively closed.** Opening a PR is a milestone, not completion.

- Archive a session only when **all three** hold: its PR is merged or definitively closed, that final
  status is recorded, and no active work remains.
- While a PR is open, keep the owning session alive.
- On failing checks or requested changes, message the owning session to address them.

---

## 6. Merge Safety

- Immediately before acting, re-read `headRefOid`, `isDraft`, `mergeable`, `reviewDecision`, and the
  checks rollup.
- Require an explicit approval, or a recorded reviewer verdict, **at the current head SHA**. An
  approval attached to an older SHA is invalid. Green CI alone never authorizes a merge.
- Never merge a draft.
- **Serialize merges.** Verify one merge landed and its linked issue closed before starting another.
- For conflicting or dirty branches, delegate a fresh fix session from `development`. Do not mutate
  the branch from the main checkout.

---

## 7. Report Format

Report each round:

- Triage counts and owners
- Queue order
- Sessions dispatched
- Sessions retained for open PRs
- Sessions archived
- Active slot count (of 5)
- Gate failures
- PRs awaiting review or merge
- Blockers
- Remaining backlog and trend
- Next action

When nothing is eligible, report exactly:

> 📋 Board is clear and idle.
