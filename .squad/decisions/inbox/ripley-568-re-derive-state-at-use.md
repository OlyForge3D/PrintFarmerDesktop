# Re-derive state at the moment of use — routing, holding, reviewing, and publishing all decay the same way

**By:** Ripley, for issue #568.

## The worked example

PR #561 merged `2026-08-06T19:04:41Z` as squash commit `9991065e` (pre-merge branch tip
`14304447`). Within the following ninety minutes, three separate participants acted on it
as though it were still open, each anchored to a different, already-superseded head they
had fetched earlier in their own session and never re-checked:

| participant      | head held  | action taken                                                                   |
| ---------------- | ---------- | ------------------------------------------------------------------------------ |
| Ralph (backlog)  | `e3953ead` | routed a follow-up for publication; asserted the remote was still at this head |
| Vasquez (review) | `31d7d52e` | issued rulings and a residual-finding verdict; expected rework to land         |
| author (publish) | `14304447` | held for publication, reporting local green and awaiting a push                |

Every one of the three was accurate about the SHA it named. None of them re-fetched
before acting. Ralph's claim that the remote sat at `e3953ead` was falsified by a single live
`ls-remote`; the author's held branch was byte-identical to what had already shipped. The
cost: two follow-up scopes drafted for work already merged, one review verdict issued
against a superseded head, and a publication very nearly performed on a branch whose
contents were already on `development`.

## Why the standing rule ("anchor every classification to a SHA") did not prevent this

Naming a SHA in every message is necessary and it worked here — it is the only reason the
divergence was even detectable, since every message could later be checked against what it
claimed. But it only guards against **misquoting** a head. It does nothing to prevent
**holding** a stale one: all three participants named their SHA accurately and were still
wrong about the state of the world, because the value itself had decayed silently between
when it was fetched and when it was acted on. **Staleness has no local symptom** — a stale
read is internally consistent and passes every check run against it, which is precisely
why none of the three sessions caught it independently, and why cross-referencing between
them (rather than a live re-fetch) is what eventually surfaced the divergence.

## The correction, applied to all four squad actions this recurs across

Routing, holding, reviewing, and publishing are the same defect in four costumes: each
reads a PR or branch state once, then acts on it later without re-deriving it at the
moment of use. The fix, and the honest predicates for "did my work ship" on a squash-merge
repo, are now documented where every role reads them before acting —
`.squad/skills/agent-collaboration/SKILL.md`, "Re-derive state at the moment of use —
before routing, holding, reviewing, or publishing" — rather than only in Ralph's own
merge-safety checklist (`.squad/agents/ralph/loop.md` §9, §9.2), which predates this
issue and covers Ralph's merge gate specifically. That section documents, in full:

1. Fetch and re-read live state immediately before acting — never reason from a value
   read earlier in the session.
2. `gh pr view --json state,mergedAt,mergeCommit` first — a closed/merged PR needs no
   further routing, holding, review, or publish step regardless of what an earlier round
   believed.
3. `git merge-base --is-ancestor <held-sha> origin/development` is **dishonest** on this
   repo when `<held-sha>` is a branch's own pre-merge tip: a squash merge replays the
   branch's diff as a brand-new commit with no parent link back to the branch's commits,
   so no commit from the branch is _ever_ an ancestor of the target — shipped or not. The
   command fails in one direction only (a confident "never shipped"), which is worse than
   an inconclusive check.
4. The two honest predicates, **both anchored to the merge commit, never to the branch's
   moving tip**: ancestry against the **merge commit** GitHub actually produced
   (`gh pr view --json mergeCommit`) is durable forever once merged; content diff
   (`git diff <held-sha> <mergeCommit.oid> -- <paths>`, scoped to the paths actually owned)
   confirms exactly what landed. Diffing against `origin/<branch>` instead of the merge
   commit was tried in an earlier draft and rejected in review (Hicks, PR #671): as trunk
   keeps evolving, later unrelated commits touching the same paths make that version of the
   check falsely report "not shipped" for work that shipped intact and was never touched
   again. A fixed commit does not decay this way; a branch's tip does.
5. **Negative-control requirement:** before trusting either predicate's result, run it once
   against a SHA or path known to be unmerged and confirm it reports "not shipped." A check
   that always answers "not shipped" cannot be told apart, from a single reading, from one
   with real discriminating power.

The full worked example — PR #561's squash commit, the dishonest ancestor check on its
pre-merge tip (exit 1, wrong), the honest content-diff and merge-commit-ancestry checks
(both correctly report shipped), and the negative control against an unrelated path
(correctly reports not-shipped) — is reproduced in that section rather than duplicated
here, so there is exactly one canonical copy.

## Relation to #536

`.squad/decisions/inbox/hicks-536-merge-gating-stale-sha.md` documented the same root
cause — a remembered SHA read once and gated against for six rounds — for a single case
(Ralph's merge gate) and shipped `scripts/check-gate-premises.mjs` plus §9.2 of
`.squad/agents/ralph/loop.md` as the fix for that one path. #568 is the same failure
recurring simultaneously across three _different_ roles and actions (routing, review,
publish) in one afternoon, which is why the fix here lives in
`.squad/skills/agent-collaboration/SKILL.md` — the shared file every role reads — rather
than being added a second time to Ralph's own loop file. Ralph's loop.md §9/§9.2 remains
the authoritative merge-gate procedure for Ralph specifically and is cross-referenced from
the new SKILL.md section rather than restated.

## Scope

Documentation only — no code or workflow change. This is a coordination defect: the fix is
a written pre-action check every role now reads before routing, holding, reviewing, or
publishing, not a new script. (`scripts/check-gate-premises.mjs` and
`scripts/check-merge-landed.mjs`, both already documented in loop.md §9/§9.2, remain the
existing executable instruments for the merge-gate case specifically; #568 generalizes the
written procedure they encode to the other three actions, which do not have — and do not
obviously need — their own scripts, since a routing or holding decision is a judgment call
informed by these predicates rather than a mechanically gated action the way a merge is.)
