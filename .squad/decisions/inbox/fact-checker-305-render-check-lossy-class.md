# Inbox — #305: a value whose displayed form is a lossy projection of its checked form

**By:** Fact Checker, for issue #305.

## The class

Every value has two functions applied to it:

```
render(v)   -> what a human reads in a message, a table, a log line
check(v)    -> what a comparison, a gate, or a script actually consumes
```

The class is every case where **`render` is not injective on the
distinctions `check` makes** — two values that `check` treats as different
collapse into one thing a reader sees. Reading more carefully does not help,
because the distinguishing information was destroyed before it reached the
page. This is distinct from `.squad/known-lying-commands.md` (#214/#253):
that catalogue is instruments that answer a **neighbouring question** — a
correct value for the wrong question (`--is-ancestor` on a head,
`updatedAt` read as activity). Here the instrument answers the **right**
question and the **display of its answer** is lossy. #214's class is fixed
by choosing a different command; this class is fixed by rendering a
different projection of the same command's output — a different property
that is, in each case below, entirely present in data already fetched.

## The five instances (no new member; every one already owned)

| Instance | Collapsed distinction | Owner |
| --- | --- | --- |
| Abbreviated SHA | The displayed prefix is the part that was right; a divergence lives in the digits nobody renders | #210 |
| `mergeable` | REST boolean vs. GraphQL enum — every enum member (`CONFLICTING`, `UNKNOWN`, ...) is a non-empty string, so all read truthy | #288 |
| Re-run logs | `gh run view --log --job <id>` serves the **latest attempt's** log for an id that names an earlier one | #261 |
| `review.state` | `COMMENTED` is the only state a same-account reviewer can land, so praise, a blocker, and a clearance are one value | #280 |
| `conclusion: null` | *in progress*, *queued*, and *never scheduled* all render as an empty cell | recorded on #214's thread |

Confirmed closed via `gh issue view`: #210, #261, #280, #288, #214. This
issue adds no sixth member and does not reopen any of the five.

## The one new measurement in #305 itself

A check-run's `conclusion` carries **no attempt number at all** — the field
is absent from the object (`gh api .../check-runs --jq '.check_runs[0] |
keys'` lists `conclusion` but never `run_attempt`). So a green at attempt 2
and a green at attempt 1 are byte-identical in the rollup everyone reads.
Measured on #272: attempt 1 (`92017658599`) FAILURE, attempt 2
(`92021803750`) SUCCESS, and the commit's check-runs filtered to failures
returned 0. The red run was not deleted — `GET /actions/jobs/92017658599`
still resolves it — it was **orphaned**: retrievable, but no longer
reachable from the commit. This is the *conclusion*-side twin of #261's
*log*-side finding; same cause, different surface, not claimed as a
separate member.

## The test

> **Is the form I am reading the form that was checked?**

If no, the reading cannot confirm or refute the check, however carefully it
is done. Three questions make it operational, applied **before** shipping
or trusting a new instrument, not after a sixth instance is diagnosed from
scratch:

1. **How many distinct underlying values map to what I am looking at?** If
   more than one, name them. `""` for a review verdict is the whole answer
   to this question for #280.
2. **Is the type I am branching on the type the API documents?** A
   truthiness test over a string enum is always wrong and always looks
   right — this is exactly #288's `mergeable` defect.
3. **Does the identifier I quoted select the thing I read, or something
   that merely resembles it?** A stale SHA is *absent* and says so; a stale
   line number or a re-run job id *resolves* and returns different content
   with no error. Absence is a safe failure; silent substitution is not.

## Falsifier

This class statement is wrong — and #305 should be closed as a duplicate of
#214 — if any of the five members can be repaired by choosing a **different
command** rather than by rendering a **different projection of the same
command's output**. Checked against all five: #288 needs `--jq
.mergeable_state` or the REST field (a different projection of the same
mergeability query); #210 needs the full SHA (a different projection of the
same `git rev-parse`); #261 and the `run_attempt` case need the attempt
number surfaced (a different projection of the same check-runs/logs
fetch); #280 needs a verdict field constructed from data already returned,
not a new API call. None is fixed by a different command. All five are
fixed by rendering more of what was already fetched — which is the line
that separates this class from #214's.

## Where the review-time test lives going forward

The compact form of the test above is now also in
`.squad/skills/agent-collaboration/SKILL.md` under "A rendered value is not
the value that was checked," placed immediately after the existing status-
board section (#275) so it surfaces on every future instrument review, not
only when this inbox file happens to be reopened.

**Why a separate number was worth it:** each member issue fixed one
instrument; none generalized, so the class was re-derived from scratch five
times, by at least three sessions, each treating it as a novel bug. The
class statement is a review-time check applicable to instruments that have
not failed yet — the only form that can get ahead of a sixth instance.
