# Ralph reference — the durable round cache

> Loaded when the round is about to reuse or invalidate a prior conclusion. `.squad/agents/ralph/loop.md`
> §2 remains in force: **the cache is never authorization.**

Implementation: `scripts/squad-cache.mjs`. Tests: `tests/squadCache.test.ts`.

---

## Why the old state file never worked

`.squad/agents/ralph/.state.json` lived inside the checkout that wrote it. Every scheduled round runs
in a fresh, ephemeral worktree, so the file was absent on arrival **every round**, which drove the
"full deep rescan only when `.state.json` is missing" branch on 100% of rounds. The delta scan was
written, reviewed, and shipped, and it never once took its cheap path. A cache placed inside the
thing that is destroyed between uses is not a cache.

The store therefore lives **outside any worktree**.

## Location

Resolution order, in `resolveCacheRoot()`:

| Condition                | Root                                                         |
| ------------------------ | ------------------------------------------------------------ |
| `SQUAD_CACHE_DIR` is set | that path, resolved absolute                                 |
| Windows                  | `%LOCALAPPDATA%\PrintFarmerDesktop\squad-cache`              |
| macOS                    | `~/Library/Caches/PrintFarmerDesktop/squad-cache`            |
| otherwise                | `${XDG_CACHE_HOME:-~/.cache}/printfarmerdesktop/squad-cache` |

The file is `<root>/<repo-slug>/<machine-slug>/<workflow-slug>.json` — scoped by **repository,
machine, and workflow**, because a conclusion drawn on one machine's clock, about one repo's board,
by one workflow's rules is not a conclusion about another's.

`resolveCachePath()` **refuses a root inside the repository** when given `repoRoot`. A cache that
lands back in the worktree reintroduces the entire defect silently, and the comparison is segment-
wise so `/repo-cache` is not mistaken for a child of `/repo`.

## Reading — a corrupt cache is an empty cache

`loadCache()` **never throws.** Every failure resolves to a usable empty cache carrying a `status`:

| status            | meaning                                              |
| ----------------- | ---------------------------------------------------- |
| `ok`              | parsed, schema-current, scope matches                |
| `missing`         | no file for this scope                               |
| `corrupt`         | unparseable, or an entry fails validation            |
| `schema-mismatch` | `schemaVersion` is not the version this reader knows |
| `scope-mismatch`  | the document names a different repo/machine/workflow |

All four non-`ok` statuses are ordinary and non-fatal: the round does a full deep rescan and says
which status it saw. The failure being closed off is a half-parsed file answering questions about
items it never saw.

## Writing — atomic, and guarded against overlap

`saveCache()` validates the document, writes a sibling temp file, `fsync`s it, and renames it over
the target. A reader sees the whole previous document or the whole new one, never a truncated prefix
of either. A failed write removes its temp file and rethrows.

`acquireCacheLock()` / `releaseCacheLock()` implement the overlap guard: a `<cache>.lock` record
carrying pid, host, workflow, `acquiredAt` and `ttlMs` (default 15 minutes). Two rounds overlapping
on an hourly schedule is normal when one runs long; two rounds **writing the same cache file** is
not. `evaluateLock()` is pure over a parsed record, so both arms are drivable: a live lease is not
reclaimable, an expired one is, and an unreadable record is reclaimable rather than a permanent
wedge — a corrupt lock that blocked forever would be worse than the overlap it guards.

## Invalidation — by fingerprint, never by age

Nothing expires on a clock. An entry is fresh only while every observation it was derived from still
hashes the same. `fingerprintInputs()` fixes that set. The members that matter most are the ones that
look like they could not:

| Input                                                                             | Why omitting it produces a confidently wrong cache                                                                                                                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dependencyClosure` **including closed members**                                  | A closed blocker is the event that makes a blocked issue READY. A fingerprint over open blockers only does not move when the last one closes, so the issue stays cached as `blocked` forever — silent and self-sustaining. |
| `verdictComments`                                                                 | A verdict can be posted, corrected, or superseded with **no push**, so `headRefOid` does not move and nothing else changes. Verdict-only invalidation must work on its own.                                                |
| `checks`                                                                          | A run can go red or green with no verdict change and no push. Check-only invalidation must work on its own.                                                                                                                |
| `state`, `updatedAt`, `labels`, `assignees`, `sessionClaim`, `linkedPullRequests` | Every READY clause reads one of these.                                                                                                                                                                                     |
| `headRefOid`, `baseRefOid`, `isDraft`                                             | The PR's own identity and mergeability premises.                                                                                                                                                                           |
| `codeqlConfiguration`                                                             | The repository's **actual** configuration only. If the repo configures none, this is `null` and stays `null`. Nothing here invents a CodeQL requirement or infers one from an alert list.                                  |
| `holdsVersion`, `policyVersion`                                                   | A hold applied or lifted, or a policy edit, changes what a previously-correct conclusion means.                                                                                                                            |

`changedInputs()` reports **which** members moved, so a round can say "verdict changed at an
unchanged head" rather than "cache miss". A cache that can only say something changed cannot be
audited, and an unauditable cache is one nobody can prove is wrong.

`planReuse()` partitions a round's observations into `reuse` and `inspect`. **Items blocking a
dispatch slot are always re-inspected**, fingerprint or not: an item that has not changed is exactly
the item most likely to be wedged.

## The cache is never authorization

`requiresFreshCheck(action)` returns `true` for `claim` and `merge`, unconditionally. It takes no
cache, no entry, and no options — there is no argument shaped like "but this one is recent", because
the only way to keep a rule like this true is to give callers nothing to pass.

- **Before a claim:** re-fetch the issue live. A cached READY verdict does not claim.
- **Before a merge:** re-read `headRefOid` and re-run `check:squad-verdict` live. A cached exit 0
  does not merge.

Converting "verified a moment ago" into "verified some round ago" is precisely the #536 shape: six
rounds gating a PR on a head SHA that had moved hours earlier, every round re-confirming its own
memory.

## Operating it

```bash
npm run squad:cache -- --repo OlyForge3D/PrintFarmerDesktop --workflow ralph-round
npm run squad:cache -- --repo OlyForge3D/PrintFarmerDesktop --workflow ralph-round --purge
```

The first prints path, status, reason, entry count and last-updated. `--purge` removes the cache and
its lock — the correct response to a status nobody can explain, and never a substitute for fixing an
invalidation gap.
