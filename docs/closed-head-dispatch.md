# `check:closed-head-dispatch` — pending workflow wiring

## What this is

`scripts/check-closed-head-dispatch.mjs` (#380) reads a closed pull request's
head SHA as an output of the close event itself, resolves it through
`commits/<sha>` the same way `actions:runs-for-sha` does (see
`docs/actions-run-query.md`), and fails loudly if that head has
`total_count: 0` Actions runs — exactly the shape #281 exhibited: two heads
closed with zero runs and nothing noticed. `tests/closedHeadDispatch.test.ts`
drives `normalizeSha`, `classifyDispatch`, and `evaluateControls` directly and
is enforced by `npm run test` today.

## Why there is no workflow file wiring it up yet

This is not a design choice — it is a measured constraint of the environment
this change was authored in, recorded here rather than worked around silently:

The session's git credential helper is bound to a fixed OAuth App token
(confirmed via `gh auth status` and independent of any local `gh auth switch`
— switching the active account changes which token `gh` reports, but not
which one the configured `credential.https://github.com.helper` actually
resolves to at push time). Pushing a branch that creates or modifies any file
under `.github/workflows/` with that token is rejected server-side by GitHub
itself:

```
! [remote rejected]   <branch> -> <branch> (refusing to allow an OAuth App to
create or update workflow `.github/workflows/closed-head-dispatch.yml`
without `workflow` scope)
```

That message comes from GitHub, not from this repository's own push-guard
tooling — it is the same class of authorization boundary as the missing
admin-scope endpoints already documented in
`scripts/check-script-reachability.mjs`'s `UNENFORCED_CHECKS` (branch
protection, rulesets, merge-queue required-context reads). The judgement is
enforced by tests today; the automatic trigger is not yet wired, and
`check:closed-head-dispatch` is recorded in `UNENFORCED_CHECKS` for exactly
that reason.

## Discharge path

A maintainer with a token or session carrying the `workflow` scope should add
the following file as `.github/workflows/closed-head-dispatch.yml` verbatim.
It has already been written, is exercised end-to-end by
`tests/closedHeadDispatch.test.ts`, and needs no further change — only a push
from a credential this session does not have:

```yaml
name: Closed head dispatch

# merge-queue: advisory
#
# Same constraint as lift-sequencing-hold.yml: this workflow's report does not
# exist until AFTER a pull request has already closed, so it MUST NOT be a
# required context — requiring it would leave every open pull request waiting
# on a context that cannot appear until the event it gates has already
# happened.
#
# #380: PR #281 closed unmerged at a head with total_count: 0 workflow runs —
# never tested, and nothing surfaced that. scripts/check-closed-head-dispatch.mjs
# reads the closed PR's head sha as an output of the close event itself (never
# a cached ref), queries total_count for it, and fails loudly when it is zero.
#
# This check depends on `pull_request: closed` dispatching reliably, the same
# assumption lift-sequencing-hold.yml already makes. It is a second,
# independent instrument for the #380 shape, not a guarantee that the shape
# cannot recur silently again.
on:
  pull_request:
    types: [closed]

permissions:
  contents: read

jobs:
  closed-head-dispatch:
    name: Verify the closed head was ever dispatched
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      # No `npm ci`: the check imports nothing outside node: builtins and one
      # sibling module, so it runs against the checkout alone.
      - name: Verify the closed pull request's head was dispatched
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: npm run check:closed-head-dispatch
```

Once this file is added, remove the `check:closed-head-dispatch` entry from
`UNENFORCED_CHECKS` in `scripts/check-script-reachability.mjs` — the
reachability check will then find it invoked by a real workflow and the
allowlist entry becomes a false claim rather than an honest one.
