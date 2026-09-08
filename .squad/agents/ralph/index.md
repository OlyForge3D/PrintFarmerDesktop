# Ralph compact policy index

Always load this index, `.squad/routing.md`, and `.squad/holds.md`. The latter
two are authoritative for owner routing and live holds. Read a decision only
when its issue, PR, hold, or policy marker is present in the current snapshot:
the cited decision is authoritative for that item. Do not bulk-read
`.squad/decisions.md`.

- Triage, dependencies, priority, and slots:
  `references/triage-dispatch.md`
- Current-head verdict, checks, sync lease, and exceptional combined-diff
  conflict review: `references/pr-gates.md`
- Conditional cleanup-candidate assessment only: `references/reaping.md`

The cache helper records observations, not permissions. Live claim and merge
reads always supersede this index and cache.
