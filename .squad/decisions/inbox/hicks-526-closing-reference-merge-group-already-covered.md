# #526 verified already resolved: the guarded step it names no longer exists, and its replacement already reports under `merge_group`

**By:** Hicks, QA/contract-testing review dispatched for #526 ("The closing-reference contract is
unenforceable for `merge_group` entries, and the obvious remedy is #122's deadlock").

## What #526 claims, quoted exactly

The issue quotes `ci.yml` as containing, at the time of filing (2026-08-05):

```
L46:  - name: Closing-reference declaration
L47:    if: github.event_name == 'pull_request'
L50:    run: npm run check:closing-references -- ${{ github.event.pull_request.number }}
```

and states the consequence: a queued `merge_group` entry never has its closing-reference contract
checked, because the step is guarded to `pull_request` and cannot be unguarded without repeating
#122's deadlock (an unguarded step inside a required context that always fails under `merge_group`).

## What is measured on `development` today

That step **does not exist in `ci.yml` any more, in any form.** A full-text search for
`github.event.pull_request.number` and `check:closing-references` in
`.github/workflows/ci.yml` returns zero matches. The step was moved to its own workflow file,
`.github/workflows/closing-reference-declaration.yml`, by **PR #578** ("Fix closure check context
attribution"), which **merged 2026-08-07T18:30:49Z — two days after #526 was filed (2026-08-05T15:56:12Z)**,
without referencing #526. #526 is not stale by drift or by a reviewer's mistaken coordinates (the
failure mode it opens by naming in its own preamble); it is stale because an independent PR closed
the gap it describes after the issue was opened and before this session started.

`closing-reference-declaration.yml`, as it exists now:

```yaml
# merge-queue: reports
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  merge_group:
...
- name: Compare declared and armed closing references
  env:
    GH_TOKEN: ${{ github.token }}
  run: npm run check:closing-references
```

No step in this job is guarded to `github.event_name == 'pull_request'` — the **only** place that
condition still appears anywhere is on the `actions/checkout` `ref:` input (pin to the PR head SHA
on `pull_request`; fall back to `github.sha`, which is the queue's own merge commit, on
`merge_group`). The check itself, `npm run check:closing-references`, runs unconditionally and
resolves the pull request number via `resolvePullRequestNumber` (`scripts/check-pr-closure-scope.mjs`),
shared with the closure-scope check, which parses `event.merge_group.head_ref` —
`refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>` — into the PR number when
`event.pull_request.number` is absent.

## Acceptance criterion 1 — checked, not just declared

Live on `development`'s branch protection right now (`gh api
repos/OlyForge3D/PrintFarmerDesktop/branches/development/protection/required_status_checks`):

```
"contexts": ["Desktop (windows-latest)", "Desktop (macos-latest)", "Sidecar (windows-latest)",
"Sidecar (macos-latest)", "Release package (windows-latest)", "Release package (macos-latest)",
"Dependency advisories", "Closing-reference declaration"]
```

`"Closing-reference declaration"` is already required, and `scripts/check-protection-assumptions.mjs`'s
`REQUIRED_CONTEXT_NAMES` already pins that exact 8-name set (this was decided in #388's remedy 1,
recorded in `.squad/decisions.md`: "the eighth is `Closing-reference declaration` ... a
`merge_group`-subscribing workflow that already mechanises the closure-scope control ... added to
the required set separately"). A queued entry's closing-reference contract is therefore already
checked, mechanically, every time — not deferred to a recorded exception.

## Acceptance criterion 2 — the `pull_request` guard is preserved, and nothing new can block a required context

The original `pull_request`-only guard this issue is protective of is exactly the one that survives,
narrowed to a `checkout` ref selection rather than the whole step (see quoted YAML above) — it was
never removed, only relocated to the one line that genuinely needs it (picking the commit to check
out). No new guard, no new step, and no new workflow are added by this decision: the mechanism
`#526` asks for was already built, by #578, and this record only verifies and documents it. There is
therefore nothing here that could newly deadlock a required context the way #122 did.

## Acceptance criterion 3 — the positive control already exists, and is distinguishable from the guard it must never fire under

Two independent fixtures already exercise this, both on `development` today:

1. **Unit-level, on the shared resolver** — `tests/prClosureScope.test.ts`, `describe('resolvePullRequestNumber')`:
   asserts `resolvePullRequestNumber({ GITHUB_EVENT_PATH })` returns the correct PR number from a
   crafted `{ merge_group: { head_ref: 'refs/heads/gh-readonly-queue/<base>/pr-<N>-<sha>' } }`
   payload, with no `pull_request` field present at all.
2. **End-to-end, on the actual check** — `tests/closingReferences.test.ts`, `describe('main
staleness witness')`, `it('passes the merge-queue PR number through to every gh read')`: builds a
   real `event.json` containing only `merge_group.head_ref` (no `pull_request` key), invokes the
   script's own `main()`, and asserts every `gh pr view` and `gh api .../pulls/<N>/commits` call it
   makes carries the resolved number (`398`) — i.e. the check genuinely executes its real logic
   under a `merge_group` payload, not merely "does not throw".

This is distinguishable from the guard #526 warns must never fire in that regime:
`tests/ciWorkflowTriggers.test.ts` and `tests/citationReachability.test.ts` independently assert that
**no** workflow in this repository is allowed to declare a bare, unconditional
`if: github.event_name != 'merge_group'`-shaped skip on a required context — the two fixtures above
are the ones the file's own comment says would fire in this regime, and they do, provably, while the
`ci.yml` guard-removal hazard #122 named stays permanently un-reintroduced.

## Verification run for this record

```
npm run test -- tests/closingReferences.test.ts tests/prClosureScope.test.ts \
  tests/mergeQueueReadiness.test.ts tests/ciWorkflowTriggers.test.ts tests/protectionAssumptions.test.ts
```

`5 test files, 273 tests, all passed`, against `development` HEAD at the time of this review.

## What this decision does and does not do

**Does:** records, with live evidence (branch protection API read, git history of PR #578, and the
existing test suite), that all three of #526's acceptance criteria are already satisfied by
infrastructure already on `development`; ships no code or workflow change, because none is needed.

**Does not:** touch `.github/workflows/**` (no change was found to be necessary there), reopen
#388's or #480's separate findings about `Sequencing hold` / `PR closure scope` (those workflows are
a different, still-`pull_request`-only case, decided on their own terms and unaffected by this
record), or claim a live merge-queue entry has been observed — no merge queue is enabled on this
repository, per #526's own falsifier condition, so this record relies on the two fixtures above
(a crafted `merge_group` event payload driven through the real script and resolver) exactly as #526's
own text anticipates ("you will need to construct a synthetic/simulated `merge_group` event payload
... to prove the new step is reachable and correct").

## The trigger to revisit

If a future change to `closing-reference-declaration.yml`, `check-closing-references.mjs`, or
`check-pr-closure-scope.mjs`'s `resolvePullRequestNumber` removes the `merge_group.head_ref` parsing
path, or removes `"Closing-reference declaration"` from `required_status_checks.contexts`, this
record's conclusion no longer holds and #526's gap reopens.
