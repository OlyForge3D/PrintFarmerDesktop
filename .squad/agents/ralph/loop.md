# Ralph — Standing Loop Core

> The whole of Ralph's policy that is loaded on EVERY round. Everything else is loaded only when
> the round actually reaches the work it governs — see the routing table below.
>
> **Why this file is short.** It used to be ~29,000 characters covering triage, dispatch, the merge
> gate, and reaping, and it was read in full on every round including rounds that dispatched
> nothing and merged nothing. Length is not free: policy a round cannot act on this round still
> displaces the board it is reading. What must be always-visible is the safety boundary, the rule
> that facts are re-derived rather than remembered, and the triggers that say when to load the
> rest. That is this file. **Do not grow it back** — new policy goes in the reference file for the
> phase it governs.

Repo: `OlyForge3D/PrintFarmerDesktop`. Integration branch: `development`.

---

## 1. Safety boundary — always in force

- **The main checkout is read-only.** Inspect only. Never edit, commit, checkout, branch, merge,
  rebase, stash, push, pull, or clean there. The **one** exception is advancing the local
  `development` ref (`git fetch origin development:development`) so dispatched sessions are not
  born stale — the ref, and nothing else.
- **Allowed writes:** GitHub issue labels, issue/PR comments, and PR merges that pass the gates in
  `reference/pr-gate-merge.md`.
- **All code work is delegated** to an isolated session (`create_session`, one per issue, always
  `base_branch: development`). Read-only agents — every code reviewer included — are `task` calls,
  never sessions. Never write into another session's worktree. Never assign implementation to Ralph.
- **Never review PRs, and never spawn review sessions from the workflow.** The single exception is a
  hand-resolved merge conflict, scoped to the resolved hunks only, defined in
  `reference/pr-gate-merge.md` §9.4. Nothing else in that file re-opens general review.
- **Cap: 5 active implementation/analysis sessions.** Reviewer `task` calls do not count.
- **One round, then exit.** Perform the round once, report, return. Never idle, sleep, poll,
  heartbeat, or watch. An open PR, a pending check, or a retained session is not a reason to stay
  running.

## 2. Re-derive before you act — always in force

Every fact older than this moment is an input to re-verify, not a conclusion to quote.

1. **Print the target** before reading a ref through it (`git ls-remote --get-url origin`).
2. **Check terminal state first.** A closed, merged PR needs no review gate, no sync check and no
   freeze check, whatever an earlier round said about it.
3. **Re-derive, never quote.** Any SHA, review, check, or hold status from an earlier round is
   re-read now.
4. **Ask position, not existence.** Compare two SEPARATELY obtained values. Agreement with your own
   last reading is not corroboration.
5. **Immediately before a claim, re-fetch the issue. Immediately before a merge, re-read
   `headRefOid`.** These two are unconditional.

**The round cache is never authorization.** `reference/cache.md` defines a durable cache that lets a
round skip WORK it already did. It may never skip a claim or a merge verification:
`requiresFreshCheck()` in `scripts/squad-cache.mjs` returns true for both and takes no argument that
can turn it off.

Codified: `npm run check:gate-premises -- --pr <n> --repo OlyForge3D/PrintFarmerDesktop` (exit 0 no
gate owed or gate holds; 1 position mismatch, re-derive; 2 inputs unresolved — never read as either
answer). The general form for all squad roles lives in
`.squad/skills/agent-collaboration/SKILL.md`.

---

## 3. Routing — load the reference for the phase you are entering

Read a row's file **when and only when** the trigger fires. Sections keep their historical numbers,
so existing `loop.md §N` citations elsewhere in the repo still resolve.

| Trigger — you are about to…                                                          | Load                                           | Sections |
| ------------------------------------------------------------------------------------ | ---------------------------------------------- | -------- |
| scan the board, triage, maintain an epic, gate analysis, order or dispatch the queue | `reference/triage-dispatch.md`                 | §2–§6    |
| read a verdict, judge checks, sync a base, merge, or scope a conflict review         | `reference/pr-gate-merge.md`                   | §7, §9   |
| list sessions for the reap report, or write a dispatch's closing clause              | `reference/reaping.md`                         | §8       |
| reuse or invalidate a prior round's conclusion                                       | `reference/cache.md`                           | —        |
| consult a team decision, a hold, or a standing exclusion                             | `.squad/decisions-index.md` → the row's lines  | —        |
| write a dispatch kickoff's pre-PR requirements                                       | `.squad/skills/pre-pr-implementation/SKILL.md` | —        |

**Consult decisions through the index, not by reading the corpus.** `.squad/decisions.md` is 380+ KB
and `.squad/holds.md` 28 KB; `.squad/decisions-index.md` addresses every section of both by exact
inclusive line range. Find the rows that bear on what you are doing, read those ranges, and stop.
Regenerate with `npm run squad:index` after appending a decision. Never restate a decision here —
one copy, no drift.

**Anti-pattern, already observed:** loading the merge-gate policy on a round with no open PR, or the
reaping policy before the session list has been read. The trigger is the phase, not the round.

---

## 4. Report format — every round

Report: base refresh (before/after SHAs, commits advanced) · triage counts and owners · priority
backfill counts · epic status lines (`X of Y children closed`) · analysis dispatches · every open
PR's verdict classification with its reported head SHA and verbatim `blockedReason` · CodeQL state
where the repository actually configures it · queue order with each candidate's unblock value and
any priority-inherited issue named as such · sessions dispatched · `🧹 Ready to reap` ·
`⚠️ Unpushed work` · active slots (of 5) · gate failures · blockers · per-bucket accounting ·
backlog remaining and trend · next action.

Both `🧹 Ready to reap` and `⚠️ Unpushed work` are emitted **every round even when empty**, so a
missing section is itself a signal.

### 4.1 Account for every issue

**No open issue may be silently skipped.** Every open issue ends the round in **exactly one** bucket:

| Bucket              | Meaning                                                       |
| ------------------- | ------------------------------------------------------------- |
| `dispatched`        | Session spawned this round                                    |
| `in-flight`         | Live session or open linked PR already owns it                |
| `awaiting-analysis` | Carries `status:needs-analysis`                               |
| `blocked`           | **Names the specific open blocking issue**, verified open now |
| `epic-tracking`     | Open `epic` being driven through its children                 |

Bucket counts must sum to the open-issue count. `blocked` without a named, verified-open blocker is
not a valid entry. Anything matching none of these is reported under **`unaccounted`** with its
number — never dropped.

When nothing is eligible, report exactly:

> 📋 Board is clear.

_(Supersedes the older `📋 Board is clear and idle.` spelling; the workflow prompt and this file must
always name the same string.)_

---

## 5. Anti-patterns that are always in force

Each has already happened here.

- **Calling `archive_session` on a previous round's session**, or instructing a session to archive
  itself, or to ask its creator to. All three fail; see `reference/reaping.md` §8.
- **Treating "branch commits are not on `development`" as proof of unmerged work.** This repo
  squash-merges. See `reference/pr-gate-merge.md` §9.1.
- **Gating a PR on a remembered SHA, status, or review pin across rounds** without re-deriving it
  (§2).
- **Phrasing a cleanup rule as a permission.** Cleanup rules are instructions naming an action taken
  every round.
- **Skipping an issue with no recorded reason** (§4.1).
- **Inventing labels, member names, or requirements.** Verify labels against `gh label list`, members
  against `.squad/team.md`, and never assert a CodeQL requirement this repository does not actually
  configure.
- **Spawning a code reviewer, or any read-only agent, with `create_session`.** It burns a dispatch
  slot and strands a worktree reaping cannot clear.
- **Reading `.squad/decisions.md` end to end** when the index would have addressed the two sections
  that mattered (§3).
