# Query results are not answers when the field cannot carry the distinction

A query that returns nothing is satisfied by two different states: the thing
does not exist, and the thing is not stored where the query looked. Nothing in
an empty result distinguishes them. Report what was observed — "no review
object found by `gh pr view --json reviews`" — rather than what it was taken to
mean — "no review yet". The first invites the follow-up that the second
forecloses.

The worked example is from this repository's own review process. Independent
reviewers here post verdicts as pull request **comments**, not as GitHub review
objects. So `gh pr view <n> --json reviews` returns `[]` and `reviewDecision`
returns `""` on a pull request that has been reviewed thoroughly and approved.
PR #147 was reported twice as awaiting review on that basis while an approval
sat in its comment thread. `gh pr view <n> --comments` finds it.

The general form is worth stating because the consequence scales past one
misread. An audit built on `reviews` — "list pull requests merged without
review" — returns clean forever, and returns clean most loudly when the
practice it audits is universal. The field cannot represent the thing being
asked about, so the check cannot fail.

That connects this to the rule about assertions that cannot fail, and the two
are the same defect reached from opposite ends. There, an assertion is placed
downstream of the code that already enforces its property, so it passes
regardless of the state of the world. Here, a query is aimed at a field that
never holds the property, so it comes back empty regardless of the state of the
world. Both produce a green result that is independent of the thing being
checked, and neither announces itself. Before trusting either, ask what
observation would make it come out the other way; if no reachable state would,
it is measuring nothing.

The practical test for a query is cheap. Construct the positive case and
confirm the query finds it. If a review is known to exist and `reviews` is
still `[]`, the query is wrong rather than the world being empty.

## The mirror case: a full result conceals better than an empty one

Emptiness is not the defect. The defect is asking a field that cannot carry the
distinction, and it can return everything just as easily as nothing.

Every pull request in this repository is authored by the same account, because
each squad member authenticates as it. So:

    gh pr list --author "@me" --state open   ->  N
    gh pr list                --state open   ->  N        (same N, always)
    distinct authors across open PRs         ->  one

The filter matches every row. It does not fail, and it does not look like it
failed — it returns a complete, correct list of open pull requests. The reader
asked _which of these are mine_ and received an answer to _which are open_, in
a shape that answers the first question plausibly.

The counts are written as `N` deliberately. When this was first measured the
answer was nine, and it was twelve a few hours later; the number is not the
finding and pinning it would date the note while teaching nothing. The finding
is that the two queries are equal for every N, and that there is one distinct
author.

This is worse than the empty case, and the reason is about the reader rather
than the query. A blank result is uncomfortable and invites a second look; a
plausible count, when a plausible count is what you expected, terminates the
inquiry. The empty-result failure is caught by the first person who expected
something. The full-result failure is caught by nobody, because there is no
state of the world in which the output looks wrong.

Both fail the same test. Ask what observation would make the result come out
the other way. For `--author "@me"` here, none would: no reachable state of
this repository produces a result that differs from the unfiltered list, so the
flag is measuring nothing while appearing to narrow. That it appears to narrow
is precisely the harm.

The remedy is the same and generalises across both cases. Do not ask whether
the result looks reasonable — make the query return something you control. Ask
it a question whose answer you already know and which the field could only get
right if it carried the distinction. A filter that cannot exclude anything is
not a filter, and the way to discover that is to give it something to exclude.

## A response that is not an answer, in a field typed to hold one

The two cases above are queries whose results cannot carry the distinction
being asked of them. There is a third shape, and it is closer to the surface:
a field that returns a value which is not an answer at all, in a position
where every other value is one.

`gh pr view --json mergeStateStatus` returns `UNKNOWN` when GitHub has not yet
finished computing mergeability. It sits in the same field that otherwise
holds `CLEAN`, `BEHIND`, `BLOCKED` — all of which are states of the pull
request. `UNKNOWN` is not a state of the pull request. It is "ask again",
wearing the shape of a value, and anyone who reads the field once and records
what it said has recorded a non-answer as a finding. The same is true of
`conclusion: null` on a check run, which means in progress and not failed.

`git merge-base --is-ancestor A B` is the same defect with worse consequences,
because the non-answer is an exit code and exit codes invite arithmetic. It
returns 0 for ancestor, 1 for not an ancestor, and 128 for cannot determine —
an absent object, an unfetched ref, a typo. The natural formulation
`if [ $? -ne 0 ]` collapses "refuted" and "could not measure" into one branch,
and the alarming reading wins: a SHA that was never fetched reports as a
history rewrite. The check most likely to produce 128 is the check run against
a ref someone else pushed, which is exactly when a false rewrite report is
most expensive.

What unites these with the empty and full cases is that the reader cannot tell
from the value alone that no measurement occurred. An empty list looks like a
measured absence, a full list looks like a measured match, `UNKNOWN` looks
like a state, and 128 looks like a difference. In all four the mechanism is
the same: the response occupies the same channel as an answer, so it inherits
an answer's authority without having done an answer's work.

The remedy differs from the remedy above, and the difference is worth stating.
The empty and full cases are repaired by making the query return something you
control. These are repaired by refusing to treat the channel as typed: test
for the specific non-answer values before reading the field as data, and
re-poll rather than record. Where the tool offers it, prefer moving the
assertion into the request, so the wrong answer is unreturnable rather than
merely detectable — `--match-head-commit` on a merge, `expected_head_sha` on a
branch update, and `head_sha` as a query selector rather than a field you
verify afterwards. A guard that refuses the write does not depend on the
caller remembering to look.

One near miss belongs here because it is the same defect in a field nobody
thinks of as a query. Under a ruleset requiring branches to be up to date,
every open pull request reports `BEHIND` after any merge, whatever its checks
did. A pull request with two failing jobs and a pull request with seven
passing ones return the same value in that field. It is not wrong — both were
behind — but it cannot carry health, and reading health off it is how a red
pull request sits unnoticed under a board that looks clean. Ask the checks by
`head_sha`; do not infer them from the summary.

## A broken instrument and a working one read too late

The four cases above share a mechanism, and there is a fifth failure that
looks identical from the outside and is not the same thing. A pointer that was
correct when taken and has since moved is a working instrument read too late.
A field that could never have answered the question is a broken instrument.
Both produce a confident wrong statement, and the remedies do not overlap:
re-reading fixes the first and does nothing at all for the second.

The tell is a counterfactual, and it is cheap. Ask whether reading the same
field again, right now, would have produced the right answer. If yes, it was
staleness. If no, the field was never carrying the distinction and re-reading
it a third time only produces the same wrong answer with more conviction.

The live example is worth recording because it was three readings with two
instruments, all of them measuring the wrong thing. To determine whether a
pull request had merged, `headRefOid` was read from the PR view. It is
invariant under merge: the head commit of the branch is the same object before
and after, so the field is correct and silent on the question asked. Reading
it again, and reading it from a second path, produced the same value for the
same reason. The question was never asked. `state`, `merged` and `mergedAt`
are the fields that can come out either way, and only a field that can come
out either way is evidence.

The remedy that generalises past all of this is to prefer the instrument that
makes a wrong answer unreturnable over the one that makes it detectable. A
detector is a check about correctness, and checks about correctness are the
first thing dropped on the day the work is heavy, which is the same day the
error arrives. A constraint carried in the request cannot be dropped, because
the operation fails without it: `--match-head-commit` on a merge,
`expected_head_sha` on a branch update, a SHA as a query selector rather than
a field inspected afterwards. That last one has a limit worth naming, since it
is easy to over-trust: selecting by a SHA guarantees the answer describes that
SHA, and guarantees nothing about whether that SHA is still the one anyone
cares about. It defends against a stale answer, not against a stale question.

The empty case has the last word here, because it caught the remedy itself.
`ls-remote refs/heads/<branch>` is the authoritative read for where a branch
points, and it was prescribed as the instrument to use in place of memory. Run
against a merged pull request whose branch has since been deleted, it returns
nothing — successfully, exit 0, no error. That empty result is
indistinguishable from a misspelled branch name, from a branch that never
existed, and from a network path returning a truncated advertisement. The
authoritative instrument answers the question "where does this branch point"
perfectly and cannot represent "it merged and was cleaned up", which is the
state most worth knowing. Nothing about being authoritative repairs a field
that has no value for the answer.
