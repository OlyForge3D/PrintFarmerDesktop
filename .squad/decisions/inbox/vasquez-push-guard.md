# Branch ownership is asserted at the push, not at the assignment

**By:** Vasquez — closes issue #81 item 2.

**Decision.** Two sessions writing one branch is now caught by a `pre-push` hook
(`.githooks/pre-push` → `scripts/push-guard.mjs`, wired by the `prepare` npm
script) rather than by a rule about which flag to type. A push that would
destroy commits carrying a `Copilot-Session` trailer absent from the commits
being pushed is refused, naming the foreign session id and listing every commit
that would have been lost.

**Why the obvious answer was rejected.** #81 could have been closed by writing
"use `--force-with-lease=<branch>:<sha>`" into the git-workflow skill. That is a
commitment, not a control — `decisions.md` → _A commitment is not a control_ —
and it is a commitment whose only possible breacher is the person making it,
with nothing watching the ref. The two incidents on #81 were both committed by
people who knew the rule.

**What the guard actually rests on**, since the reasoning is easy to get wrong:

- **git hands the pre-push hook the tip the remote advertised**, not the
  remote-tracking ref. Verified by instrumenting a real push. So the guard's
  power is not in catching a stale ref — it is in treating _"this push destroys
  commits"_ as the thing needing authorisation, and computing the destroyed set
  against a live `git ls-remote`.
- **When a lease has already failed, git filters that ref out of the hook's
  stdin entirely.** The hook is therefore a check on pushes git is _willing_ to
  perform. That is exactly the #78 case: git was willing.
- **The `Copilot-Session` trailer is the discriminator**, per `decisions.md:152`.
  Committer and author identity are per-worktree config and prove nothing.
- **The acknowledgement must equal the live tip.** This is the second failure
  mode on #81 — a lease written from a SHA extended out of a short prefix by
  invention. A value that was never read cannot match.

**Honest limits.** `--no-verify` bypasses any hook, and a hook only binds clones
where `npm install` has run. The guard converts a silent accident into a
deliberate, legible act; it is not a server-side control. Real enforcement is a
branch-protection rule denying force-push on the remote, which is not
configurable from inside the repository — **filed as a follow-up rather than
claimed as done.** Ownership is also asserted at push time, not at assignment
time: nothing in a repo-local change can stop a coordinator from _assigning_ two
sessions the same branch. It makes the resulting collision fail closed.

**Evidence, not assertion.** `tests/pushGuard.test.ts` drives a real push through
the real hook against a real remote and pins the counterfactual: the identical
push with the hook removed succeeds and destroys the other session's commit. A
suite without that half would also pass against a hook git never runs.
