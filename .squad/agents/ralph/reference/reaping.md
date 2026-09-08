# Ralph reference — session lifecycle and reaping (§8)

> Loaded when the round is about to list sessions for the reap report, or write a dispatch's closing
> clause. Not loaded otherwise. `.squad/agents/ralph/loop.md` §1 and §2 remain in force.

---

## 8. Session lifecycle and reaping

Completed sessions do not clean themselves up, and **nothing can make them.** Five sessions across
two repos finished, had their PRs merged, and lingered with stale worktrees until reaped by hand —
this repo's PRs **#588** and **#575**, plus PrintFarmer's #1234, #1235 and #1245.

**Two hard platform limits, and together they close every automatic route:**

1. **`archive_session` only works on sessions the caller created.** Every Ralph round is a **new
   session**, so a round cannot archive a session spawned by a previous round.
   `list_sessions_and_chats` will show it and the archive call will still fail. **Ralph must never
   attempt it.**
2. **A session cannot archive itself.** The runtime refuses with exactly `Cannot archive the current
session.` A session that tries wastes a failing tool call as its last act. **Never instruct a
   session to archive itself, and do not reintroduce such an instruction** — this policy carried one
   and it was dead text for its whole life.

Therefore **there is no automated archival path.** Cleanup is the reap report (§8.3), performed by a
human.

### 8.1 The dispatch closing clause

Every dispatch kickoff prompt **must end with this clause, verbatim, as its final paragraph**:

> "When your work is complete — PR merged or definitively closed, or for analysis work your
> deliverable recorded on the issue — PUSH YOUR BRANCH FIRST if you have any commits, then report
> your final status as your last action and stop. Never leave committed work unpushed: an unpushed
> local branch is invisible on GitHub and will be lost when the worktree is reaped. Do NOT attempt to
> archive yourself — the runtime refuses `archive_session` on the current session and the call will
> fail. Do not attempt to archive any other session either. Cleanup is handled by Ralph's
> `🧹 Ready to reap` report."

This is **word-for-word identical to the clause in Ralph's workflow prompt.** Change one and you must
change the other; the two must never drift. `tests/ralphPolicyCore.test.ts` asserts the clause is
present here and is a single contiguous block, so a partial edit fails a check rather than shipping
two spellings.

### 8.2 Hand-off to the creator is not an alternative

The obvious repair — have the finished session message its creating session and ask to be archived —
**also fails, and is worse than the problem.** Do not add it.

- **The creator has exited.** The workflow prompt ends with a hard EXIT and a round terminates within
  2–6 minutes. Implementation sessions almost never finish inside that window — sessions reaped by
  hand were spawned by an 18:30 round and finished over three hours later. The request arrives at a
  session that is no longer running.
- **Messaging an idle session wakes it.** A completed round can be restarted by a cleanup request and
  may re-run its round logic — re-triaging or re-dispatching as a side effect. That is a worse
  failure than the stale worktree it was meant to clear.

### 8.3 The reap report is the whole mechanism

Because §8's two limits admit no automation, `🧹 Ready to reap` is **not a safety net behind
something else — it is the whole mechanism**, and **a human performs the removal.**

Each round, **call `list_sessions_and_chats` and produce the reap list.** This is an instruction, not
a permission: it runs every round whether or not anything looks stale.

Evaluate **every** session in this project against **both** reapable categories:

- **(a) PR-backed** — its PR is merged or definitively closed. Verify a merge the squash-safe way per
  `pr-gate-merge.md` §9.1; a deleted remote branch after a confirmed merge is expected and is not
  evidence of lost work.
- **(b) No-PR** — analysis, spike, decomposition and audit work produces child issues or a sign-off
  comment and **never opens a PR**, so it is invisible to a PR-based check and would otherwise
  accumulate forever. It qualifies when its linked issue is closed, OR its deliverable is recorded on
  the issue and no further work is expected.

List each with: session name, branch, linked issue, PR number (or `none`), and why it qualifies.

**Never list a session — in either category — holding uncommitted or unpushed work.** Check
`git status --porcelain`, and for a branch still on the remote check
`git log --oneline origin/<branch>..HEAD`, comparing against **the branch's OWN remote and never
`origin/development`** (this repo squash-merges, so merged branches always show commits relative to
`development`). A session holding unpushed work is reported under **`⚠️ Unpushed work`** with its
branch, commit count and linked issue, and that session is messaged to push.

**Emit both headings every round, even when empty** (`🧹 Ready to reap: none`), so a missing section
is itself a signal.

**On `delete_item`:** unlike `archive_session` it works across sessions regardless of who created
them — so the limits above are not what stops Ralph removing sessions. **Ralph must never call it
anyway.** Squash-merge verification is error-prone (§9.1), and a false positive destroys unpushed
work irreversibly. Reaping stays a human decision.
