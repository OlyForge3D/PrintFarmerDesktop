# Closing-reference declaration

Published from an append-only backup ref, so this declaration is keyed to that
branch slug. Without one the closing-reference check falls back to the legacy
shared `.github/PR_CLOSES.md` and reports `#457` as declared-but-not-armed — a
closure this PR never made. The declaration must be carried forward whenever
the publication ref moves.

Supersedes closed PRs #720 and #722, which were closed under the
publish-only-when-ready policy rather than rejected.

No tracked issue exists for this work, so the empty block below is a deliberate
declaration that this PR closes nothing, per `.github/pr-closes/README.md`.

```closes

```
