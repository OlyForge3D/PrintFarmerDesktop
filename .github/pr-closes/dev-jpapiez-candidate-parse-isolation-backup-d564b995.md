# Closing-reference declaration

Published from an append-only backup ref, so this declaration is keyed to that
branch slug. Without one the closing-reference check falls back to the legacy
shared `.github/PR_CLOSES.md` and reports `#457` as declared-but-not-armed — a
closure this PR never made.

**Carry this file forward whenever the publication ref moves.** That has now
been missed once and caught in review once; the ref changes on every round
because the push-guard freezes a branch as soon as its PR is closed.

Supersedes closed PRs #720 and #722, both closed under the
publish-only-when-ready policy rather than rejected.

No tracked issue exists for this work, so the empty block below is a deliberate
declaration that this PR closes nothing, per `.github/pr-closes/README.md`.

```closes

```
