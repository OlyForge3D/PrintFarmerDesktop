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
