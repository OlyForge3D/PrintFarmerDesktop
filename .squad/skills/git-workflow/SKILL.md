---
name: git-workflow
description: Branching, PR, and merge rules for PrintFarmer Desktop. Read before creating a branch, opening a PR, or merging anything. Every rule here exists because breaking it cost this repo real work.
---

# Git workflow

Every rule below was written after an incident. None are stylistic.

## Never modify the main checkout

`D:\s\PrintFarmerDesktop` is the user's own working copy. Treat it as **strictly read-only**.

- Allowed: `git log`, `git status`, `git show`, `git ls-tree`, `git diff`, reading files, `gh` read commands.
- Forbidden: editing files, `git add`, `commit`, `checkout`, `switch`, `branch`, `merge`, `rebase`, `stash`, `reset`, `push`, `pull`, `fetch`, `clean` — anything that mutates the working tree, index, refs, or remote.

All real work happens in an isolated worktree. If you were not given one, ask for one; do not borrow the main checkout.

## Always branch fresh off `origin/development`

```powershell
git fetch origin development
git checkout -b squad/<issue>-<slug> origin/development
```

`development` is the base for every PR. `main` is not a target.

## Never stack PRs

Do not branch off another unmerged feature branch. This repo squash-merges, and squash-merging a base branch **breaks every child stacked on it**: git cannot equate the new squash commit with the original commits still in the child's history, so the child PR shows a huge bogus diff (thousands of phantom additions) and may auto-close when its base branch is deleted.

This happened with PR #62 stacked on PR #59, and again with PR #64. Both needed manual rescue.

If you genuinely must build on unmerged work, say so and get agreement first. The repair pattern, if you inherit a broken stack:

```powershell
git rebase --onto origin/development <old-base> <branch>
# verify the diff shrank to something sane before pushing
git push --force-with-lease
```

Always `--force-with-lease`, never bare `--force`.

## Every PR must contain `Closes #<N>`

A PR without a closing reference leaves its issue open forever. PR #33 fully delivered issues #25 and #26 and both sat open for weeks because the body had no closing keyword — the work looked unstarted on the board.

Put the literal line `Closes #20` (etc.) in the PR **body**. Verify it took:

```powershell
gh pr view <N> --repo OlyForge3D/PrintFarmerDesktop --json closingIssuesReferences
```

An empty array means it did not register.

## Merge one PR at a time, and verify each one landed

**This is the most expensive lesson in the repo.** Two `gh pr merge` calls fired ~3 seconds apart against the same base both reported `MERGED`, but one merge commit was silently orphaned — the second merge resolved against the same stale base tip and its ref update dropped the first. `development` lost ~6000 lines of native engine code for hours.

It stayed invisible because downstream tests mocked the sidecar instead of exercising the real binary, so CI stayed fully green with the entire engine missing.

After **every** merge, before starting another:

```powershell
$sha = gh pr view <N> --repo OlyForge3D/PrintFarmerDesktop --json mergeCommit --jq .mergeCommit.oid
git fetch origin development
git merge-base --is-ancestor $sha origin/development   # exit 0 = actually landed
```

Never batch or parallelize merges against a shared base.

## Audit suspicious diffs before merging

Green CI is necessary, not sufficient. If a PR's diff is much larger than its stated scope, or touches files unrelated to its description, read the diff before merging. The orphaned-merge incident above was caught only because a later PR's unexpected 13k-addition diff prompted a manual audit.

## Freeze a branch while it is under review

Reviews are pinned to an exact commit SHA. If you push while a review is running, the verdict no longer describes the commit that would be merged, and the round has to restart. Push your fix, report the new SHA, then stop until told to continue.

## `gh` authentication gotcha

The `GH_TOKEN` environment variable in this environment lacks the `workflow` scope. Any `gh` operation touching `.github/workflows/*` fails with _"refusing to allow an OAuth App to create or update workflow ... without `workflow` scope"_.

Drop it first, which falls back to the keyring credential that has full scope:

```powershell
Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
```

Each PowerShell call is a fresh process, so this must be repeated in **every** call that uses `gh` or `git push`.

## Commit messages

Conventional-commit style subject (`feat(model-core): ...`, `fix(viewer): ...`, `docs(squad): ...`), a body explaining _why_, and the required trailers:

```
Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
Copilot-Session: <session-id>
```

## Do not merge your own work

Authors do not merge. The Technical Lead owns review and merge, gated on unanimous reviewer approval plus green CI. See `../agent-collaboration/SKILL.md`.
