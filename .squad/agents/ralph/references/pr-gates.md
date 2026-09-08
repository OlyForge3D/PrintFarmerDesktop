# Ralph PR gate reference

Use only for a changed or slot-blocking PR. Re-fetch terminal state, head, draft,
base, checks, holds, and mergeability immediately before acting. Never mutate
from the main checkout. A BEHIND PR follows the existing serialized sync lease
procedure; do not start a second sync.

Run the exact JSON verdict command in the core. Exit 0 is only current,
three-way unanimous approved content; exit 2 change request and exits 3/4
missing, invalid, superseded, or not-applicable are merge refusals. Preserve
the existing authentication, current-SHA, carry-forward, required-check, and
hold controls. Conflict review is exceptional and limited to resolved
combined-diff hunks—never a broad re-review.
