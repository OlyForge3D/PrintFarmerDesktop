# Ralph PR gate reference

Use only for a changed or slot-blocking PR. Re-fetch terminal state, head, draft,
base, checks, holds, and mergeability immediately before acting. Never mutate
from the main checkout. Before dispatching any BEHIND base-sync work, run
`npm run plan:behind-sync-order` from the repository. It surveys every open PR
and yields one global (not per-base) oldest-first sync order. If it reports an
active sync lease, stand down: do not dispatch or start another sync. Otherwise,
dispatch only its single next PR; the owning author claims the lease with
`npm run plan:behind-sync-order -- --claim` immediately before pushing. This
procedure is advisory for scheduling only, never authorization: re-fetch the
selected PR's live state immediately before every action.

Run the exact JSON verdict command in the core. Exit 0 is only current,
three-way unanimous approved content; exit 2 change request and exits 3/4
missing, invalid, superseded, or not-applicable are merge refusals. Preserve
the existing authentication, current-SHA, carry-forward, required-check, and
hold controls. Conflict review is exceptional and limited to resolved
combined-diff hunks—never a broad re-review.

## Verifying a merge landed

Immediately before reporting a PR as merged, treating it as a cleanup candidate,
or taking any action based on its having landed, run:

```bash
npm run check:merge-landed
```

For a specific PR, use `npm run check:merge-landed -- <n>`. This is a fresh
pre-action check: do not reuse a prior result. It fetches the target and checks
the **merge commit** GitHub produced against `origin/development`. This repository
squash-merges, so never substitute the branch head or branch-commit containment:
a squash deliberately leaves the branch commits outside the target.

Exit 0 is the only landed result. Exit 1 means a merge did not land and must be
repaired from a current base; exit 2 is unverifiable and refuses the conclusion.
The checker validates the target with a positive control and treats a failed
fetch or unreadable object as unverifiable. It is a verification procedure, not
authorization for any cache, cleanup, or merge action.

## Re-deriving merge-gate premises

Immediately before gating, holding, routing, reviewing, publishing, or merging
an open PR, run:

```bash
npm run check:gate-premises -- --pr <n> --repo OlyForge3D/PrintFarmerDesktop
```

Never carry a SHA, state, review, or freeze result forward from a prior round.
The procedure prints the remote target, reads terminal state first, then compares
the current API head with a separately obtained `git ls-remote` branch head.
Closed PRs need no gate; for open PRs, a comparison against a remembered value
or against itself is not corroboration. Re-run on every pre-action decision.

Exit 0 means terminal state needs no gate or independently re-derived premises
agree. Exit 1 means the gate remains required because position mismatched;
re-derive rather than act on the mismatch. Exit 2 is unverifiable and is never
permission to proceed. This procedure only re-derives premises; it does not
replace the current-SHA verdict, required-check, draft, hold, or authorization
controls above.
