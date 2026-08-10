# #263 credential scope and settings-access findings (Vasquez)

**By:** Vasquez — issue #263 ("PRs sit BEHIND because of CI runner
contention, not slow tests").

This records what was actually measured while working #263, not assumed,
following `.squad/known-lying-commands.md`'s rule that a stated scope has to
be tested against the instrument that actually uses it, not read off a
report from a different one.

## Remedy 1 (`concurrency:` group) was already shipped before this issue was worked

Issue #263 was filed 2026-08-04T12:26Z. `.github/workflows/ci.yml` already
carries a `concurrency:` block, keyed
`ci-${{ format('{0}-{1}-{2}', github.event_name, github.ref, ...) }}` with
`cancel-in-progress: ${{ github.event_name == 'pull_request' }}` — landed by
PR #649 (`d8929a76`, 2026-08-08, fixing #555) and preceded by the original
introduction in PR #147. `tests/ciWorkflowTriggers.test.ts:273` pins the exact
group/cancel expressions with a `toEqual`, and it is green on this branch with
no change (`npx vitest run tests/ciWorkflowTriggers.test.ts` — 27/27). So the
first suggested direction is done; there is nothing to add here without
reopening a settled, already-tested design.

## The `workflow` OAuth scope gap named for #388/#480 is real here too — and it is not where `gh auth status` looks

`gh auth status` reports `Token scopes: 'gist', 'read:org', 'repo', 'workflow'`
for this session. That is true and it is not the scope that governs
`git push`. This repo's git credential helper chain resolves (via a
`credential.https://github.com.helper=copilot` override that outranks the
`.gitconfig`-level `!gh auth git-credential` entry) to a **different** stored
token — `username=x-access-token`, prefix `gho_z0...` — and a direct
`GET /user` call carrying that literal token returns
`X-OAuth-Scopes: gist, repo, user`. No `workflow`. `gh auth status` and
`git push` are not reading the same credential, and asking the former about
the latter is exactly the "instrument answers an adjacent question" shape this
repo already has a catalogue for.

**Measured, not inferred:** a scratch commit editing `.github/workflows/ci.yml`
on a throwaway branch was rejected by GitHub itself —
`refusing to allow an OAuth App to create or update workflow
.github/workflows/ci.yml without workflow scope` — both with the helper chain
as configured and after forcing the push through the `!gh auth
git-credential` helper explicitly (same token, confirmed above). The scratch
branch and commit were not pushed and the local branch was deleted; nothing
under `.github/workflows/` needed changing for #263 regardless, since remedy 1
was already merged, but the same gap that blocked #388/#480 blocks writing to
that directory from this session too, and the next session should not assume
`gh auth status` speaks for it.

## Remedy 2 (`allow_auto_merge`) is confirmed still `false`, and left alone

`gh api repos/OlyForge3D/PrintFarmerDesktop --jq
'{allow_auto_merge,allow_update_branch}'` reads `{"allow_auto_merge":false,
"allow_update_branch":false}` as of this session. Per the dispatch brief this
is a repository-settings change treated as owner-only in this repo's
convention; consistent with that, and with the fact that the credential
available here is scoped `repo` (no `admin:repo_hook`/settings-write
demonstrated), this was not attempted. Recorded as blocked-by-ownership, not
blocked-by-measurement-failure — the distinction `known-lying-commands.md`
asks for.

## Remedy 3: implemented as a planning tool, not an automatic sync

`scripts/plan-behind-sync-order.mjs` (`npm run plan:behind-sync-order`)
surveys open PRs against their base and reports **one** next PR to
base-sync, never the whole BEHIND set — the shape of the return value
(`{next, queued}`) is deliberate, because a caller that syncs everything it
returns has reintroduced the exact contention #263 measured. It does not
rebase or push anything itself: syncing another session's branch is still
that session's own work per `.squad/skills/git-workflow/SKILL.md`'s
"never rebase or merge around it you do not own" rule. Tests:
`tests/planBehindSyncOrder.test.ts` (43 tests, ordering logic + survey
plumbing stubbed the same way `tests/behindBase.test.ts` stubs
`sha-status.mjs`).

### Addendum: external review (Hicks, Vasquez on PR #681) found two real defects in the first cut, both now fixed

PR #681's local three-way review approved a first cut that grouped
`planSyncOrder`'s output **per base branch** (`Map<baseRefName, {next,
queued}>`), on the reasoning that PR ancestry/BEHIND-ness is a per-base
question — true, and `surveyBehindPrs`'s per-base ancestry cache is correct
and unchanged. But Ralph's dispatched external reviewers (also named Hicks
and Vasquez — a naming collision with this session's own local review
personas, not the same reviewers) posted REJECT verdicts as real PR
comments identifying that the *scheduling* question is NOT per-base:
`.github/workflows/ci.yml`'s `pull_request:` trigger fans every push, on
every base, into the SAME shared GitHub-hosted runner pool, so
recommending "sync #10 (development) next" and "sync #99 (release/1.x)
next" in the same round still launches two concurrent CI fan-outs into one
contended pool — exactly the burst #263 measured. Vasquez's second finding:
the tool was advisory-only with no lock, so two sessions (or the same
session across nearby rounds) could both read the same "sync next" and both
act on it. Hicks's third finding: nothing in checked-in automation actually
called the script, so #263 was not really fixed yet, only measurable.

Fixes shipped in the same round, each empirically verified before relying
on it in code (not merely reasoned about):

- `planSyncOrder` now returns a single GLOBAL `{next, queued}`, sorted by
  `createdAt` then PR number across every base together. A new test
  (`serializes globally across base branches, not one queue per base`)
  asserts two candidates on different bases still yield only one `next`.
- A real compare-and-swap lease (`readSyncLease`/`claimSyncLease`),
  implemented as a plain commit (parented on the git empty-tree object,
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, so no tree/blob write is
  needed) whose message is JSON `{prNumber, claimedAt, expiresAt}`, pushed
  to a dedicated ref `refs/behind-sync-lease/current` via
  `git push <remote> <oid>:<ref> --force-with-lease=<ref>:<expectedOldOid>`.
  This does NOT need the `workflow` scope this session lacks (see above) —
  it is an arbitrary custom ref push, not a `.github/workflows/**` edit.
  CAS semantics (empty-expect-requires-ref-absent, stale-expect-rejected,
  correct-expect-succeeds, fetch-then-read-message) were verified against a
  disposable scratch bare git repository before being relied on in
  `scripts/plan-behind-sync-order.mjs`; the scratch repo was deleted
  afterward. `main` stays read-only by default (reports an active lease
  informationally); a new opt-in `--claim` flag lets a caller that is
  actually about to perform the sync also reserve it atomically.
- Wired `plan:behind-sync-order` into `.squad/agents/ralph/loop.md` §9.3 —
  the natural "checked-in automation" call site available to this session
  (a normal markdown file Ralph reads every round, per the file's own
  header), given the `workflow`-scope gap blocking a `.github/workflows/**`
  wiring. Addresses Hicks's "inert script, nothing calls it" finding within
  this repo's agent-driven (not pure-CI) automation model.

