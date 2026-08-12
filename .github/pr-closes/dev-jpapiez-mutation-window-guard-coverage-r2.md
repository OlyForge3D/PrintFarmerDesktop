# Closing-reference declaration — `dev/jpapiez/mutation-window-guard-coverage-r2`

This pull request closes nothing. The block below is intentionally empty,
which `scripts/check-closing-references.mjs` reads as the explicit assertion
"this PR closes no issues" rather than as an absent declaration.

```closes

```

## Why this file exists even though nothing is declared

Without it the checker falls back to `.github/PR_CLOSES.md`, the pre-#622
shared slot, which still carries a stale `#457`. Any branch lacking its own
file therefore inherits that declaration and fails the Closing-reference
declaration check with `DECLARED BUT NOT ARMED: #457` — as PR #724 did at
head `c19baeec`, which is why this file was added.

The work on this branch is test coverage for the mutation-window guard and
is a follow-up to the calibration work in PR #723. It resolves no tracked
issue on its own, so an empty block is the accurate declaration.
