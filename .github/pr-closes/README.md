# Per-PR closing-reference declarations (#622)

Each pull request declares the issues it closes in its own file here, named
after a sanitised slug of its head branch:

```
.github/pr-closes/<branch-slug>.md
```

`scripts/check-closing-references.mjs` derives `<branch-slug>` from the PR's
head branch name (lowercased, everything that is not `[a-z0-9]` collapsed to
a single `-`, leading/trailing `-` trimmed) via `slugifyBranchName`. For
example, branch `dev/jpapiez/squad-622-per-pr-closes-declaration` maps to
`dev-jpapiez-squad-622-per-pr-closes-declaration.md`.

## Why one file per PR

`.github/PR_CLOSES.md` used to be a single file every PR edited to declare
its own closure. Because it was one mutable slot shared by every open PR,
any two PRs open at the same time were guaranteed to conflict on it -- not
occasionally, structurally. Splitting the declaration into one file per PR,
keyed by branch, means concurrent PRs on different branches write to
disjoint paths and cannot conflict with each other here.

## Format

Identical to the old shared file. One fenced block per PR, info string
exactly `closes`, one bare `#<number>` per line:

```closes
#123
```

An empty block is a valid, meaningful declaration: it asserts the PR closes
nothing. No file at all, or a file with no fenced block, means nothing was
declared -- the check treats that as fail-closed: any armed closure is then
reported as a mismatch.

## Why this preserves the #415 guarantee

This file lives in the commit tree, exactly like the shared file it
replaces. It changes only when a commit changes it, so `synchronize` -- an
event every required-context workflow already receives -- re-runs the check
whenever it changes on the head commit. Editing only the PR body still
cannot affect this half of the check.

## Locating the file for a given PR

`scripts/check-closing-references.mjs` resolves the head branch name from
`GITHUB_HEAD_REF` (set by GitHub Actions on every `pull_request` event, no
API call needed) and falls back to `gh pr view --json headRefName` only when
that is unset, which happens on `merge_group` runs.

## Migration

A PR whose branch has no file here falls back to the legacy shared
`.github/PR_CLOSES.md`, so every PR opened before #622 keeps working
unmigrated. It is still subject to the old shared-file contention among the
other PRs that haven't moved, but never with a PR that has its own file
here. A PR migrates simply by adding its own file under this directory --
nothing needs to touch the legacy file to do so, because a PR's own file is
checked first and wins outright.

## Stale files after merge

Declaration files are not pruned on merge. A merged PR's file becomes
harmless history: nothing reads a branch slug that no open PR's head branch
produces, and leaving it costs nothing a cleanup step would meaningfully
recover. This mirrors how the legacy shared file was never truncated between
PRs either.
