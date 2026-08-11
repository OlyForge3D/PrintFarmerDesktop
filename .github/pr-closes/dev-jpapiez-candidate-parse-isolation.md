# Closing-reference declaration

Follow-up to #718, which merged while a full review gate had returned 3×
REJECT against its head. This PR lands the fix for that finding: candidates
are parsed one at a time so no single malformed record can empty the printer
list.

No tracked issue exists for it, so the empty block below is a deliberate
declaration that this PR closes nothing, per `.github/pr-closes/README.md`.

```closes

```
