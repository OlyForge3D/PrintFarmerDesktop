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
