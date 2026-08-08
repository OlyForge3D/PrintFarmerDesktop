# `check:setup-files` — pending workflow wiring

## What this is

`scripts/check-setup-files.mjs` (#539) reads the committed `setupFiles` list
from `vitest.config.ts` the same way vitest itself resolves it —
`createVitest` from `vitest/node`, in a context whose `process.argv` and
`process.env` are made to look like a real `vitest run` invocation, so a
committed config cannot answer differently to "am I being inspected, or
actually run?" — and refuses anything not on the explicit
`EXPECTED_SETUP_FILES` allowlist. `tests/checkSetupFiles.test.ts` drives that
logic against the live `vitest.config.ts` and against fixtures reproducing
every bypass found in PR #642 review (argv-gated, env-gated, and
plugin-injected `setupFiles`), and is enforced by `npm run test` today.

## Why there is no workflow file wiring it up yet

This is not a design choice — it is a measured constraint of the environment
this change was authored in, recorded here rather than worked around
silently, and it is the identical constraint already documented in
`docs/closed-head-dispatch.md` for `check:closed-head-dispatch`:

The session's git credential helper is bound to a fixed OAuth App token.
Pushing a branch that creates or modifies any file under
`.github/workflows/` with that token is rejected server-side by GitHub
itself:

```
! [remote rejected]   <branch> -> <branch> (refusing to allow an OAuth App to
create or update workflow `.github/workflows/setup-files-allowlist.yml`
without `workflow` scope)
```

That message comes from GitHub, not from this repository's own push-guard
tooling. The judgement is enforced by `tests/checkSetupFiles.test.ts` today;
the automatic trigger is not yet wired, and `check:setup-files` is recorded
in `scripts/check-script-reachability.mjs`'s `UNENFORCED_CHECKS` for exactly
that reason.

`tests/checkSetupFiles.test.ts` also pins the exact command line and
classification this file promises below, by reading this document's fenced
block directly off disk — so a divergence between what this doc says a
maintainer should paste and what the test suite actually expects is caught
the moment either one changes, rather than discovered the day the file is
finally added.

## Discharge path

A maintainer with a token or session carrying the `workflow` scope should add
the following file as `.github/workflows/setup-files-allowlist.yml`
verbatim. It has already been written, is exercised end-to-end by
`tests/checkSetupFiles.test.ts`, and needs no further change — only a push
from a credential this session does not have:

```yaml
name: Setup files allowlist

# merge-queue: advisory
#
# This workflow does not subscribe to merge_group and MUST NOT be added to a
# ruleset's required contexts while that remains true: a required context
# that no workflow emits stays Pending forever and blocks the entry rather
# than failing it. tests/mergeQueueReadiness.test.ts checks this declaration
# against the trigger list, so the classification above is read by a machine
# rather than trusted.
#
# #539's own acceptance criteria says the same thing in different words: this
# gate must run green on `development` for a while before it becomes
# required, so it must not be wired into a required CI status context yet.

# Deliberately a separate workflow rather than a step in ci.yml's `desktop`
# job. ci.yml's `Test` step already runs `npm run check:setup-files`'s own
# assertions from INSIDE a vitest worker (see tests/checkSetupFiles.test.ts),
# which is exactly the position #539 says not to trust: a committed
# `setupFiles` entry executes before any test module and can redefine the
# very platform witnesses a test -- including this gate's own worker-side
# assertions -- would use to notice it. Review on PR #642 (Ripley) found that
# gap directly: the fixture-driven vitest test proved the CHECKER's logic is
# correct, but nothing ran `node scripts/check-setup-files.mjs` against the
# REPOSITORY'S OWN committed `vitest.config.ts` from outside any vitest
# worker, so the live tree never actually got the outside-worker guard #539
# asked for. This workflow is that missing outside-worker run: its own job
# never starts a vitest worker itself (no `npm test` here), only
# `node scripts/check-setup-files.mjs`, invoked the same way a human would
# from a shell that has never touched vitest.
on:
  pull_request:
    types: [opened, synchronize, reopened]
  push:
    branches: [development]

permissions:
  contents: read

jobs:
  setup-files-allowlist:
    name: Setup files allowlist
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      # The checker imports `vitest/node` to resolve `vitest.config.ts` the
      # same way `vitest run` itself would (createVitest, not a bespoke
      # re-implementation), so unlike the no-dependency checks elsewhere in
      # this directory, it genuinely needs node_modules installed.
      - name: Install dependencies
        run: npm ci

      - name: Verify the committed setupFiles list matches the allowlist
        run: npm run check:setup-files
```

Once this file is added, remove the `check:setup-files` entry from
`UNENFORCED_CHECKS` in `scripts/check-script-reachability.mjs` — the
reachability check will then find it invoked by a real workflow and the
allowlist entry becomes a false claim rather than an honest one.
