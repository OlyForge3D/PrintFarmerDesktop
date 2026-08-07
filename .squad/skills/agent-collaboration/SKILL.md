---
name: agent-collaboration
description: How PrintFarmer Desktop squad members hand work to each other, review, and merge. Read before delegating work, reviewing a commit, or acting on a review verdict.
---

# Agent collaboration

## Roles

- **Ripley** — Technical Lead. Owns triage, sequencing, review dispatch, and **all merges**.
- **Ralph** — Work Monitor. Scans the board, delegates, reports. Read-only in the main checkout.
- **Bishop** — Rust / SQLite / integration. **Dallas** — React / Electron UI.
- **Hicks** — QA / correctness reviewer. **Vasquez** — security reviewer.

Charters live in `.squad/agents/<name>/charter.md`. Standing decisions live in `.squad/decisions.md` and **override** anything here.

## The merge gate

A PR merges only with **unanimous reviewer approval** plus **green CI**. The author never merges their own work.

Reviews are run as independent agents against an **exact commit SHA and branch-contribution range**, not "the PR" and not a bare commit diff. Always pin both in the review request and require the reviewer to confirm them.

## Generate the review target; do not select one by hand

Immediately before every dispatch, run:

```powershell
npm run review:target -- --pr <number>
```

Dispatch only from an exit-0 brief, and copy its full head SHA, base SHA, merge base, and `merge-base..head` range. The command deliberately accepts no SHA argument: it reads the current pull-request head, draft state, and current base from GitHub, derives the range through the compare API, then re-reads the mutable inputs before emitting anything.

- **Exit 1 means wait and rerun; it is not a permanent rejection.** A draft PR is not ready for review dispatch, a newly pushed valid head can briefly have zero check runs, and the head, base, or draft state can move while the brief is being derived.
- **Never dispatch a draft PR merely to obtain merge clearance.** Mark it ready through the normal process first, then rerun the guard. A stable draft defers without deriving a range; movement into or out of draft discards every value derived from the earlier read.
- **Exit 2 means no target was established.** A CLI failure, API failure, empty response, or malformed count must never be interpreted as zero.
- **A multi-parent head is not invalid.** A sync merge can be the real current branch head. Its bare commit diff is first-parent scope and can show only trunk's changes, so review `merge-base(current base, current head)..current head` instead.
- **Do not cache or reuse a generated brief.** The command closes movement during its own reads; it cannot freeze the branch after it exits. Dispatch immediately, and the reviewer must re-read the live API head and draft state before returning a verdict.

This is an executable guard only for dispatches that use its output. The repository cannot intercept the session-dispatch API, so bypassing it remains a process breach rather than a mechanically impossible action.

## Record the verdict on the pull request

**A verdict that is not on the PR does not exist.** Post every review outcome as a comment on the pull request, naming the exact head SHA it was pinned to, before communicating it anywhere else.

This is not bookkeeping. Two rejected PRs once sat at `reviewDecision: ""`, zero reviews, zero comments, **6/6 green CI** — indistinguishable, to any automation, from mergeable work. The hourly backlog driver is told to merge "green and approved" PRs, and nothing in the repository marked those two as rejected. Both carried reproduced defects.

So, when a review blocks a PR:

- **Convert it to draft** — `gh pr ready <n> --undo`. Draft is a mechanical merge block no automation can bypass, and it is reversible when the fix lands. Here draft means "blocked by review", not "unfinished".
- **Green CI is necessary but never sufficient.** Before merging anything, read `isDraft`, `reviewDecision`, `reviews` and `comments`. A PR with no recorded verdict is **unreviewed**, whatever colour CI is.
- **Verdicts are pinned to a SHA.** An approval recorded against an older head does not authorize merging a newer one.

The PR is also a delivery channel that does not drop messages. Cross-session chat demonstrably does — a fix list once sat undelivered while its author pinged asking why the PR had no reviews. Put the durable copy where the work is.

## Freeze the branch during review

Once a review is dispatched, the branch is frozen. Any push invalidates the verdict, because the reviewer's conclusions no longer describe the commit that would be merged. Push your fix, report the new SHA, then stop until released.

If the head does move, do not silently merge the old verdict forward. Assess the delta: a purely additive test-only commit can be handled as a cheap delta review, but any production change forces a re-review.

Before reporting or acting on any PR state, **re-query the live endpoint**. A snapshot taken minutes ago may describe a head that no longer exists.

## Rejections go back to the original author

The rejection-lockout rule (requiring a _different_ author to revise rejected work) was **dismissed on 2026-07-24**. When a reviewer rejects, the **original author fixes their own commit**. Do not rotate.

## Reviewer standards

**Reject only what you can demonstrate.** A finding should name the file and line, the concrete trigger, and ideally include a reproduction. Vasquez's five consecutive rejections on PR #39 were valuable precisely because each shipped real evidence — culminating in an actual working exploit (`race loops=20000 good=19999 evil=1`) rather than a theory.

**Do not hold a PR hostage to unreproduced theoretical risk.** Real-but-speculative concerns are non-blocking observations accompanying an approval.

**Verify claims; do not accept them.** If an author says "no IPC changes", check the diff for `src/preload`, `src/shared`, `src/main`. If they claim a hash matches, recompute it.

**Go beyond the author's tests.** Their tests prove the cases they thought of. Your job is the ones they did not — craft hostile inputs yourself, in `$env:TEMP`, never in the repo.

Reviews are **read-only**. End with exactly one line: `VERDICT: APPROVE` or `VERDICT: REJECT`. A review without a verdict line cannot gate a merge and must be re-run.

## Delegating work

One issue → one branch → one PR → merged before the next starts. Never batch, never stack.

Give a delegate complete context — brevity rules do not apply to delegation prompts. State the worktree path, the read-only constraint on the main checkout, the environment traps (`GH_TOKEN`, `prettier --check`, fresh-process `cd`), the required `Closes #N`, the validation matrix, and that they must not self-merge.

**Check for an existing owner before delegating.** Duplicate delegation has caused real collisions here.

## Never take over a live session's worktree

If a delegated session appears stalled — no turns, no commits, no reply — **do not start a parallel implementation inside its worktree**. Sessions can be alive but slow to report. This was misjudged twice on 2026-07-25, putting two concurrent writers in one worktree; both converged only by luck, and either could have produced a garbled interleaved commit.

If you believe a session is dead: wait, ask again, or create a **new, separate** worktree. Never write into theirs. If you have already done so, verify the worktree is clean and the branch history is coherent before trusting anything in it.

## Close the loop on tracking

Work that ships but is not recorded looks like work that stalled. Every PR needs `Closes #N`. When an epic's tracked children are all closed, **close the epic** — do not leave it open as a container. Keep epic checklists current; a stale `[ ]` next to a long-closed issue makes a finished epic look half-done.
