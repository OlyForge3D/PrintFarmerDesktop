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
npm run push:force
```

## Force-pushing: `--force-with-lease` is not the control you think it is

`--force-with-lease` with no argument compares against your **remote-tracking ref**, not against anything you read. It answers _"has anything changed since I last fetched?"_ — and any command that fetches in the background answers that question for you, silently.

On PR #78 that cost two commits (`254fd9e`, `b9f1dea`) written by a second session on the same branch. A fetch had advanced `origin/<branch>` to those commits, so the lease compared them against themselves, passed, and the push destroyed them unread. The explicit form is not automatically better: on `squad-name-audit` a lease was written from a full-length SHA invented out of a seven-character prefix, and only failed because the invented value happened not to match.

**Push with the wrapper:**

```powershell
npm run push:force            # current branch to origin
npm run push:force -- --yes   # after reading what it says will be destroyed
```

It resolves the tip with a live `git ls-remote`, prints every commit the push would destroy, and pushes with that value as the lease plus `--force-if-includes`.

**A `pre-push` hook backs it up** (`.githooks/pre-push` → `scripts/push-guard.mjs`, installed by the `prepare` npm script, so `npm install` wires it). It refuses:

| refusal                             | meaning                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------- |
| `push-guard.protected-ref`          | direct push to `development` or `main`                                    |
| `push-guard.foreign-session`        | the destroyed commits carry a `Copilot-Session` trailer that is not yours |
| `push-guard.unacknowledged-discard` | the push destroys commits and you named no tip                            |
| `push-guard.ack-mismatch`           | you named a tip that is not the one on the remote                         |
| `push-guard.stale-lease`            | the remote moved during the push                                          |
| `push-guard.unfetched-remote-tip`   | the remote tip is not in your object store — `git fetch` and look         |
| `push-guard.unverifiable-remote`    | the live query failed and the push is not provably non-destructive        |

One code is an **allow**, not a refusal: `push-guard.unverified-fast-forward`. The live query
failed, but the tip git advertised is an ancestor of what you are pushing, so the update provably
destroys nothing and it is let through with a warning. Nothing is asserted that was not measured —
if the ancestry cannot be established, the refusal above fires instead.

**Two properties of the installation to know before you rely on it.** `core.hooksPath` is written
**clone-wide**, so it applies to every worktree of the clone, while `.githooks/` is **per-worktree**
— a worktree on a branch without that directory is unguarded, silently, because git skips a
missing hook without error (#164). And setting `core.hooksPath` **disables every pre-existing
`.git/hooks/*`**, including your own personal hooks; move them into `.githooks/` if you need them.
The guard also makes `node` on `PATH` a precondition of pushing.

**Do not infer coverage from the setting — ask.** `npm run hooks:verify` reads the hook back off
disk in the worktree you are standing in and exits non-zero if it is not there:

```
npm run hooks:verify     # exit 0 = armed, exit 1 = this worktree is unguarded
```

`npm install` and `npm ci` run the same check and print the same warning, but exit 0 either way so
they cannot block work on a branch that predates the hook. When #164 was measured, **22 of 27
worktrees on this clone were unarmed** while the clone-wide setting asserted otherwise, and a
force-push discarding 45 commits went through one of them with no refusal and no message.

To proceed after actually reading the work you are overwriting, name it — the value has to be read, not remembered:

```powershell
$env:PF_PUSH_ACK = (git ls-remote origin refs/heads/<branch>).Split("`t")[0]
$env:PF_PUSH_ACK_FOREIGN = '<the other session id>'   # only for foreign-session
```

`--no-verify` bypasses the hook. It exists, it is not forbidden, and using it to skip this check is the one thing here that has already destroyed work twice.

**Read your push output either way.** The #78 clobber was noticed only because the output read `+ b9f1dea...5bf85dc` and `b9f1dea` was a SHA the pusher had never produced.

## Every PR must contain `Closes #<N>`

A PR without a closing reference leaves its issue open forever. PR #33 fully delivered issues #25 and #26 and both sat open for weeks because the body had no closing keyword — the work looked unstarted on the board.

Put the literal line `Closes #20` (etc.) in the PR **body**. Verify it took:

```powershell
gh pr view <N> --repo OlyForge3D/PrintFarmerDesktop --json closingIssuesReferences
```

An empty array means it did not register.

## Refuse to merge a PR that is BEHIND its base

**#397: `development` has `required_status_checks.strict: true` — require a branch up to date before merging — and it does not bind.** `enforce_admins: false` exempts every admin from that rule, and the sole collaborator here is an admin, so `strict` is configured, correctly reported by GitHub, and stops nobody (`scripts/check-protection-assumptions.mjs` calls this reading `bypassable`, not `binding`). PR #322 merged BEHIND under exactly that gap: it changed a function signature, the incompatible caller lived in a file #322 never touched, and `development` was red for ~3h. No diff-based check would have caught it — only re-testing the union of both changes would have, which is what `strict` exists for and never ran.

**This is not a call to flip `enforce_admins`.** That is a live, deliberate decision (#111, re-asserted by `check-protection-assumptions.mjs`) that is unsafe to reverse while `jpapiez` is the sole admin collaborator, and it belongs to #388, not to this rule. What binds the sole admin anyway is a client-side gate on the merge action itself — the same shape as the force-push guard above.

**Before every `gh pr merge`, alongside `check:required-contexts`, run:**

```powershell
npm run check:behind-base -- --pr <N>
```

- exit `0` — the base is an ancestor of the PR head; safe to merge on this ground.
- exit `1` — **BEHIND. Do not merge.** Sync by rebasing onto the latest base (not GitHub's "Update branch" button — that writes a merge commit, which `required_linear_history` forbids on this repo's normal squash-only path) and let CI re-run before merging.
- exit `2` — undetermined (no credential, no network, refs could not be fetched). Not a pass; do not treat it as one.

`scripts/check-behind-base.mjs` measures this with `git merge-base --is-ancestor <base> <head>` after refreshing the base — never the `mergeable`/`mergeStateStatus` API fields, which are documented elsewhere in this repo as flapping and going permanently stale.

## Merge one PR at a time, and verify each one landed

**This is the most expensive lesson in the repo.** Two `gh pr merge` calls fired ~3 seconds apart against the same base both reported `MERGED`, but one merge commit was silently orphaned — the second merge resolved against the same stale base tip and its ref update dropped the first. `development` lost ~6000 lines of native engine code for hours.

It stayed invisible because downstream tests mocked the sidecar instead of exercising the real binary, so CI stayed fully green with the entire engine missing.

After **every** merge, before starting another:

```powershell
$sha = gh pr view <N> --repo OlyForge3D/PrintFarmerDesktop --json mergeCommit --jq .mergeCommit.oid
git fetch origin development
git merge-base --is-ancestor $sha origin/development   # exit 0 = actually landed
```

**That recipe is correct, and it is load-bearing on a choice it does not state.** `$sha` comes from **`mergeCommit`**. Substitute the branch head — the commit you actually pushed, one field away in the same call — and the same command returns the opposite answer on every merged PR in this repository:

| PR   | `--is-ancestor mergeCommit` | `--is-ancestor headRefOid` |
| ---- | --------------------------- | -------------------------- |
| #332 | 0                           | 1                          |
| #251 | 0                           | 1                          |
| #309 | 0                           | 1                          |
| #237 | 0                           | 1                          |
| #249 | 0                           | 1                          |

**Five for five, no exceptions, all `state=MERGED`.** A squash merge writes a **new commit whose only parent is the base**, so the head you pushed is not an ancestor of anything **by construction** — and every merge in this repository is a squash. The `mergeCommit` column is the positive control proving the command works; the `headRefOid` column is what it does when handed the SHA a person naturally reaches for, because _"did my commit land"_ is the question actually being asked.

**Three instruments fail here in the same way, and a reader would treat them as independent:**

| instrument                           | on a merged PR              | why                                      |
| ------------------------------------ | --------------------------- | ---------------------------------------- |
| `--is-ancestor <head> development`   | exit 1                      | squash reparents                         |
| `git rev-list --merges`              | **0**, across 65 merged PRs | a squash is not a merge commit           |
| `refs/heads/<branch>` still resolves | reads unmerged              | `--delete-branch` does not always delete |

**They agree, and their agreement carries no information** — one cause, three readings. Do not treat two of them confirming each other as corroboration. (Control: `git rev-list --merges` over all history returns 232, so the flag works; the merge _practice_ changed underneath it.)

**What does separate merged from unmerged**, in decreasing convenience:

```powershell
gh pr view <N> --json state,mergedAt        # state=MERGED — the gh surface
gh api repos/OWNER/REPO/pulls/<N> --jq .merged   # true — REST only
git cat-file -e origin/development:<path>   # 0 = content is on trunk
```

**Both spellings are given deliberately, because they are not interchangeable and the obvious one does not exist:**

```
gh pr view <N> --json merged   ->  exit 1: Unknown JSON field: "merged"
```

`merged` is a **REST** field. On `gh pr view` the separating fields are `state` and `mergedAt`. A remedy naming the wrong surface fails at the moment it is followed, by someone who has no reason to doubt it — so a prescribed command belongs in the same category as a guard's suggested fix: **it has to be run before it is published.**

Never batch or parallelize merges against a shared base.

## Audit suspicious diffs before merging

Green CI is necessary, not sufficient. If a PR's diff is much larger than its stated scope, or touches files unrelated to its description, read the diff before merging. The orphaned-merge incident above was caught only because a later PR's unexpected 13k-addition diff prompted a manual audit.

## Freeze a branch while it is under review

Reviews are pinned to an exact commit SHA. If you push while a review is running, the verdict no longer describes the commit that would be merged, and the round has to restart. Push your fix, report the new SHA, then stop until told to continue.

That is a convention, and a convention is not a control — it restrains only an actor who has already decided to comply. When a freeze needs to be enforced rather than agreed, one server-side control exists and it has been measured on this repository: set `allow_force_pushes: false` on the held branch. A rebase or any other history rewrite is then refused with `GH006`, **including for the branch's own author and without `enforce_admins`**. Ordinary commits still push, so work continues and only rewriting is blocked — the freeze is on history, not on progress.

Two traps, both hit in practice:

- The `PUT` body must include `required_status_checks`, `enforce_admins`, `required_pull_request_reviews` and `restrictions` or it returns `422` and applies nothing. **On a lift that failure leaves the hold in place.**
- After lifting with `DELETE`, reading the field back returns `404 Branch not protected`, not `false`. **Confirm a lift by performing the rewrite, not by reading the setting.**

Exact commands, the permission required, and what this control deliberately does _not_ do are in `.squad/decisions/inbox/ripley-held-branch-force-push-control.md`. Read the last point before relying on it: anyone who can apply the hold can lift it, so it guards against an unconsidered rewrite, not a determined one.

## `gh` authentication gotcha

The `GH_TOKEN` environment variable in this environment lacks the `workflow` scope. Any `gh` operation touching `.github/workflows/*` fails with _"refusing to allow an OAuth App to create or update workflow ... without `workflow` scope"_.

Drop it first, which falls back to the keyring credential that has full scope:

```powershell
Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
```

Each PowerShell call is a fresh process, so this must be repeated in **every** call that uses `gh` or `git push`.

## Commit messages

Use a conventional-commit style subject (`feat(model-core): ...`, `fix(viewer): ...`, `docs(squad): ...`) and a body explaining _why_. Append the required trailers without placing a parseable `Key: value` example at the end of documentation:

```powershell
git commit --trailer "Co-authored-by=Copilot App <223556219+Copilot@users.noreply.github.com>" `
  --trailer "Copilot-Session=<cloud-copilot-session-uuid>"
```

The `Copilot-Session` value is the full UUID from the **cloud Copilot-session namespace**. It is not the local session-state directory UUID or the project-session UUID used by cross-session messaging. Never abbreviate or reconstruct it.

## Do not merge your own work

Authors do not merge. The Technical Lead owns review and merge, gated on unanimous reviewer approval plus green CI. See `../agent-collaboration/SKILL.md`.
