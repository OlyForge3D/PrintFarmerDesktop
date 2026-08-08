# A shell that never runs is not a mitigation for the shells that could

`git rev-list --count $A..$B` typed unquoted in PowerShell is not one
argument, it is two. PowerShell's argument-mode parser splits on `..`
regardless of quoting intent, so the process actually receives `<sha>` and
`..<sha>` as separate revs. A range with an empty left side defaults to
`HEAD`, and git fills it in without complaint:

```
git rev-parse $A..$B      ->  5de53e13...
                              9119b5df...
                              ^01c8885e...     <- the WORKTREE'S HEAD, uninvited
```

The count that comes back is not wrong in a way that announces itself. It is
a plausible number, symmetric in both directions, and it depends on which
branch the calling worktree happens to have checked out — two sessions
running the identical command against the identical pair of commits get
different answers. See #467 for the full mechanism and the measured
before/after (`7/7` unquoted vs. `6/0` quoted on a genuine ancestor pair).

## What a sweep of this repository found

Every place in `scripts/` that builds a two-commit range invokes git through
`execFileSync('git', [...])` — the range is always a single array element
(`` `${sha}..${base}` ``), and `execFileSync` never spawns a shell to parse it
against. There is no `..` for a parser to split, in PowerShell or anywhere
else, because there is no parser in the path at all. The `.github/workflows/`
`shell: pwsh` blocks (Windows code-signing steps in `release.yml`) do not
build a git range either. **No call site in this repository is presently
exposed to the #467 mechanism.** This matches the issue's own scoping: it
does not propose a repo-wide sweep because the defect was caught during ad
hoc terminal investigation, not in shipped code, and mixing "prove the
mechanism" with "sweep for instances" would make it unreadable which a fix
was for.

A negative sweep is still worth recording, not skipping: the alternative to
writing this down is someone re-running the same sweep after the next
refactor and being unable to tell whether "found nothing" means "still
nothing" or "didn't look here."

## What was done anyway

`distanceToTip` in `scripts/sha-status.mjs` is the one call site that
computes a two-commit range and could plausibly grow a shell hop in a future
refactor (a wrapper script, a CI step that shells out instead of calling the
module directly, and so on). It now carries the cross-check the issue itself
suggests: when `isAncestor(sha, base)` is true, the reverse range `base..sha`
must count zero, or the forward count is discarded in favour of `null`
("unmeasured") rather than published. This is not a fix to a broken
measurement — nothing here was broken — it is the same instrument-agreement
discipline the rest of this codebase already applies to ancestry claims
(`hicks-count-assertions-over-external-sets.md`, `sha-reporting-rule.md`):
one lone count has nothing to disagree with, and a cheap second opinion is
what turns a silent, plausible wrong answer into a `null` a caller has to
handle instead of trust.

Regression coverage: `tests/shaStatus.test.ts` proves the cross-check passes
on a real ancestor/descendant pair built in a temp repository (independent of
`distanceToTip`'s own arithmetic — the reverse count is measured directly
against the fixture, not merely re-derived from the function under test).
`tests/shaStatusDistanceCrossCheck.test.ts` mocks the underlying git calls to
force the one state a real repository can never produce — an ancestor
relationship whose reverse count is nonzero — and confirms `distanceToTip`
reports `null` rather than the contaminated-looking count, because that
disagreement is exactly what #467's outward symptom (`7/7` where `6/0` was
true) looks like from the caller's side.

## The general rule

`$A..$B`, `$A...$B`, and any other range assembled from PowerShell variables
must be quoted as one argument before being handed to `rev-list`, `log`,
`diff`, or any other range-taking git subcommand — `"$A..$B"`, never
`$A..$B`. In this codebase that risk is structurally absent for every
existing call site because none of them pass through a shell; the discipline
that matters going forward is keeping it that way — a range stays one
`execFileSync` argv element, never assembled from separate array entries or
handed to a `shell: true` invocation — and, where a range's correctness
actually matters to a caller, pairing it with the ancestry check that would
catch a disagreement rather than trusting a single count in isolation.
